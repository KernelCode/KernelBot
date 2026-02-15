import Anthropic from '@anthropic-ai/sdk';
import { toolDefinitions, executeTool, checkConfirmation } from './tools/index.js';
import { getSystemPrompt } from './prompts/system.js';
import { getLogger } from './utils/logger.js';
import { getMissingCredential, saveCredential } from './utils/config.js';

export class Agent {
  constructor({ config, conversationManager }) {
    this.config = config;
    this.conversationManager = conversationManager;
    this.client = new Anthropic({ apiKey: config.anthropic.api_key });
    this.systemPrompt = getSystemPrompt(config);
    this._pending = new Map(); // chatId -> pending state
  }

  async processMessage(chatId, userMessage, user, onUpdate, sendPhoto) {
    const logger = getLogger();

    this._onUpdate = onUpdate || null;
    this._sendPhoto = sendPhoto || null;

    // Handle pending responses (confirmation or credential)
    const pending = this._pending.get(chatId);
    if (pending) {
      this._pending.delete(chatId);

      if (pending.type === 'credential') {
        return await this._handleCredentialResponse(chatId, userMessage, user, pending);
      }

      if (pending.type === 'confirmation') {
        return await this._handleConfirmationResponse(chatId, userMessage, user, pending);
      }
    }

    const { max_tool_depth } = this.config.anthropic;

    // Add user message to persistent history
    this.conversationManager.addMessage(chatId, 'user', userMessage);

    // Build working messages from history
    const messages = [...this.conversationManager.getHistory(chatId)];

    return await this._runLoop(chatId, messages, user, 0, max_tool_depth);
  }

  _formatToolSummary(name, input) {
    const key = {
      execute_command: 'command',
      read_file: 'path',
      write_file: 'path',
      list_directory: 'path',
      git_clone: 'repo',
      git_checkout: 'branch',
      git_commit: 'message',
      git_push: 'dir',
      git_diff: 'dir',
      github_create_pr: 'title',
      github_create_repo: 'name',
      github_list_prs: 'repo',
      github_get_pr_diff: 'repo',
      github_post_review: 'repo',
      spawn_claude_code: 'prompt',
      kill_process: 'pid',
      docker_exec: 'container',
      docker_logs: 'container',
      docker_compose: 'action',
      curl_url: 'url',
      check_port: 'port',
      screenshot_website: 'url',
      send_image: 'file_path',
      browse_website: 'url',
      extract_content: 'url',
      interact_with_page: 'url',
    }[name];
    const val = key && input[key] ? String(input[key]).slice(0, 120) : JSON.stringify(input).slice(0, 120);
    return `${name}: ${val}`;
  }

  async _sendUpdate(text) {
    if (this._onUpdate) {
      try { await this._onUpdate(text); } catch {}
    }
  }

  async _handleCredentialResponse(chatId, userMessage, user, pending) {
    const logger = getLogger();
    const value = userMessage.trim();

    if (value.toLowerCase() === 'skip' || value.toLowerCase() === 'cancel') {
      logger.info(`User skipped credential: ${pending.credential.envKey}`);
      pending.toolResults.push({
        type: 'tool_result',
        tool_use_id: pending.block.id,
        content: JSON.stringify({ error: `${pending.credential.label} not provided. Operation skipped.` }),
      });
      return await this._resumeAfterPause(chatId, user, pending);
    }

    // Save the credential
    saveCredential(this.config, pending.credential.envKey, value);
    logger.info(`Saved credential: ${pending.credential.envKey}`);

    // Now execute the original tool
    const result = await executeTool(pending.block.name, pending.block.input, {
      config: this.config,
      user,
      onUpdate: this._onUpdate,
      sendPhoto: this._sendPhoto,
    });

    pending.toolResults.push({
      type: 'tool_result',
      tool_use_id: pending.block.id,
      content: JSON.stringify(result),
    });

    return await this._resumeAfterPause(chatId, user, pending);
  }

  async _handleConfirmationResponse(chatId, userMessage, user, pending) {
    const logger = getLogger();
    const lower = userMessage.toLowerCase().trim();

    if (lower === 'yes' || lower === 'y' || lower === 'confirm') {
      logger.info(`User confirmed dangerous tool: ${pending.block.name}`);
      const result = await executeTool(pending.block.name, pending.block.input, { ...pending.context, onUpdate: this._onUpdate, sendPhoto: this._sendPhoto });

      pending.toolResults.push({
        type: 'tool_result',
        tool_use_id: pending.block.id,
        content: JSON.stringify(result),
      });
    } else {
      logger.info(`User denied dangerous tool: ${pending.block.name}`);
      pending.toolResults.push({
        type: 'tool_result',
        tool_use_id: pending.block.id,
        content: JSON.stringify({ error: 'User denied this operation.' }),
      });
    }

    return await this._resumeAfterPause(chatId, user, pending);
  }

  async _resumeAfterPause(chatId, user, pending) {
    // Process remaining blocks
    for (const block of pending.remainingBlocks) {
      if (block.type !== 'tool_use') continue;

      const pauseMsg = await this._checkPause(chatId, block, user, pending.toolResults, pending.remainingBlocks.filter((b) => b !== block), pending.messages);
      if (pauseMsg) return pauseMsg;

      const r = await executeTool(block.name, block.input, { config: this.config, user, onUpdate: this._onUpdate, sendPhoto: this._sendPhoto });
      pending.toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(r),
      });
    }

    pending.messages.push({ role: 'user', content: pending.toolResults });
    const { max_tool_depth } = this.config.anthropic;
    return await this._runLoop(chatId, pending.messages, user, 0, max_tool_depth);
  }

  _checkPause(chatId, block, user, toolResults, remainingBlocks, messages) {
    const logger = getLogger();

    // Check missing credentials first
    const missing = getMissingCredential(block.name, this.config);
    if (missing) {
      logger.warn(`Missing credential for ${block.name}: ${missing.envKey}`);
      this._pending.set(chatId, {
        type: 'credential',
        block,
        credential: missing,
        context: { config: this.config, user },
        toolResults,
        remainingBlocks,
        messages,
      });
      return `🔑 **${missing.label}** is required for this action.\n\nPlease send your token now (it will be saved to \`~/.kernelbot/.env\`).\n\nOr reply **skip** to cancel.`;
    }

    // Check dangerous operation confirmation
    const dangerLabel = checkConfirmation(block.name, block.input, this.config);
    if (dangerLabel) {
      logger.warn(`Dangerous tool detected: ${block.name} — ${dangerLabel}`);
      this._pending.set(chatId, {
        type: 'confirmation',
        block,
        context: { config: this.config, user },
        toolResults,
        remainingBlocks,
        messages,
      });
      return `⚠️ This action will **${dangerLabel}**.\n\n\`${block.name}\`: \`${JSON.stringify(block.input)}\`\n\nConfirm? (yes/no)`;
    }

    return null;
  }

  async _runLoop(chatId, messages, user, startDepth, maxDepth) {
    const logger = getLogger();
    const { model, max_tokens, temperature } = this.config.anthropic;

    for (let depth = startDepth; depth < maxDepth; depth++) {
      logger.debug(`Agent loop iteration ${depth + 1}/${maxDepth}`);

      const response = await this.client.messages.create({
        model,
        max_tokens,
        temperature,
        system: this.systemPrompt,
        tools: toolDefinitions,
        messages,
      });

      if (response.stop_reason === 'end_turn') {
        const textBlocks = response.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text);
        const reply = textBlocks.join('\n');

        this.conversationManager.addMessage(chatId, 'assistant', reply);
        return reply;
      }

      if (response.stop_reason === 'tool_use') {
        messages.push({ role: 'assistant', content: response.content });

        // Send Claude's thinking text to the user
        const thinkingBlocks = response.content.filter((b) => b.type === 'text' && b.text.trim());
        if (thinkingBlocks.length > 0) {
          const thinking = thinkingBlocks.map((b) => b.text).join('\n');
          logger.info(`Agent thinking: ${thinking.slice(0, 200)}`);
          await this._sendUpdate(`💭 ${thinking}`);
        }

        const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
        const toolResults = [];

        for (let i = 0; i < toolUseBlocks.length; i++) {
          const block = toolUseBlocks[i];

          // Check if we need to pause (missing cred or dangerous action)
          const pauseMsg = this._checkPause(
            chatId,
            block,
            user,
            toolResults,
            toolUseBlocks.slice(i + 1),
            messages,
          );
          if (pauseMsg) return pauseMsg;

          const summary = this._formatToolSummary(block.name, block.input);
          logger.info(`Tool call: ${summary}`);
          await this._sendUpdate(`🔧 \`${summary}\``);

          const result = await executeTool(block.name, block.input, {
            config: this.config,
            user,
            onUpdate: this._onUpdate,
            sendPhoto: this._sendPhoto,
          });

          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result),
          });
        }

        messages.push({ role: 'user', content: toolResults });
        continue;
      }

      // Unexpected stop reason
      logger.warn(`Unexpected stop_reason: ${response.stop_reason}`);
      const fallbackText = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      if (fallbackText) {
        this.conversationManager.addMessage(chatId, 'assistant', fallbackText);
        return fallbackText;
      }
      return 'Something went wrong — unexpected response from the model.';
    }

    const depthWarning =
      `Reached maximum tool depth (${maxDepth}). Stopping to prevent infinite loops. ` +
      `Please try again with a simpler request.`;
    this.conversationManager.addMessage(chatId, 'assistant', depthWarning);
    return depthWarning;
  }
}
