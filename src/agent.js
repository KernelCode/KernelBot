import { createProvider, PROVIDERS } from './providers/index.js';
import { toolDefinitions, executeTool, checkConfirmation } from './tools/index.js';
import { selectToolsForMessage, expandToolsForUsed } from './tools/categories.js';
import { getSystemPrompt } from './prompts/system.js';
import { getLogger } from './utils/logger.js';
import { getMissingCredential, saveCredential, saveProviderToYaml } from './utils/config.js';

const MAX_RESULT_LENGTH = 3000;
const LARGE_FIELDS = ['stdout', 'stderr', 'content', 'diff', 'output', 'body', 'html', 'text', 'log', 'logs'];

export class Agent {
  constructor({ config, conversationManager }) {
    this.config = config;
    this.conversationManager = conversationManager;
    this.provider = createProvider(config);
    this.systemPrompt = getSystemPrompt(config);
    this._pending = new Map(); // chatId -> pending state
  }

  /** Return current brain info for display. */
  getBrainInfo() {
    const { provider, model } = this.config.brain;
    const providerDef = PROVIDERS[provider];
    const providerName = providerDef ? providerDef.name : provider;
    const modelEntry = providerDef?.models.find((m) => m.id === model);
    const modelLabel = modelEntry ? modelEntry.label : model;
    return { provider, providerName, model, modelLabel };
  }

  /**
   * Switch to a different provider/model at runtime.
   * Resolves the API key from process.env automatically.
   * Returns null on success, or an error string if the key is missing.
   */
  switchBrain(providerKey, modelId) {
    const logger = getLogger();
    const providerDef = PROVIDERS[providerKey];
    if (!providerDef) return `Unknown provider: ${providerKey}`;

    const envKey = providerDef.envKey;
    const apiKey = process.env[envKey];
    if (!apiKey) {
      return envKey; // caller handles prompting
    }

    this.config.brain.provider = providerKey;
    this.config.brain.model = modelId;
    this.config.brain.api_key = apiKey;

    // Recreate the provider instance
    this.provider = createProvider(this.config);

    // Persist to config.yaml
    saveProviderToYaml(providerKey, modelId);

    logger.info(`Brain switched to ${providerDef.name} / ${modelId}`);
    return null;
  }

  /**
   * Finalize brain switch after API key was provided via chat.
   */
  switchBrainWithKey(providerKey, modelId, apiKey) {
    const logger = getLogger();
    const providerDef = PROVIDERS[providerKey];

    // Save the key
    saveCredential(this.config, providerDef.envKey, apiKey);

    this.config.brain.provider = providerKey;
    this.config.brain.model = modelId;
    this.config.brain.api_key = apiKey;

    this.provider = createProvider(this.config);
    saveProviderToYaml(providerKey, modelId);

    logger.info(`Brain switched to ${providerDef.name} / ${modelId} (new key saved)`);
  }

  /**
   * Truncate a tool result to stay within token budget.
   */
  _truncateResult(name, result) {
    let str = JSON.stringify(result);
    if (str.length <= MAX_RESULT_LENGTH) return str;

    // Try truncating known large fields first
    if (result && typeof result === 'object') {
      const truncated = { ...result };
      for (const field of LARGE_FIELDS) {
        if (typeof truncated[field] === 'string' && truncated[field].length > 500) {
          truncated[field] = truncated[field].slice(0, 500) + `\n... [truncated ${truncated[field].length - 500} chars]`;
        }
      }
      str = JSON.stringify(truncated);
      if (str.length <= MAX_RESULT_LENGTH) return str;
    }

    // Hard truncate
    return str.slice(0, MAX_RESULT_LENGTH) + `\n... [truncated, total ${str.length} chars]`;
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

    const { max_tool_depth } = this.config.brain;

    // Add user message to persistent history
    this.conversationManager.addMessage(chatId, 'user', userMessage);

    // Build working messages from compressed history
    const messages = [...this.conversationManager.getSummarizedHistory(chatId)];

    // Select relevant tools based on user message
    const tools = selectToolsForMessage(userMessage, toolDefinitions);
    logger.debug(`Selected ${tools.length}/${toolDefinitions.length} tools for message`);

    return await this._runLoop(chatId, messages, user, 0, max_tool_depth, tools);
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
        content: this._truncateResult(pending.block.name, { error: `${pending.credential.label} not provided. Operation skipped.` }),
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
      content: this._truncateResult(pending.block.name, result),
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
        content: this._truncateResult(pending.block.name, result),
      });
    } else {
      logger.info(`User denied dangerous tool: ${pending.block.name}`);
      pending.toolResults.push({
        type: 'tool_result',
        tool_use_id: pending.block.id,
        content: this._truncateResult(pending.block.name, { error: 'User denied this operation.' }),
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
        content: this._truncateResult(block.name, r),
      });
    }

    pending.messages.push({ role: 'user', content: pending.toolResults });
    const { max_tool_depth } = this.config.brain;
    return await this._runLoop(chatId, pending.messages, user, 0, max_tool_depth, pending.tools || toolDefinitions);
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

  async _runLoop(chatId, messages, user, startDepth, maxDepth, tools) {
    const logger = getLogger();
    let currentTools = tools || toolDefinitions;

    for (let depth = startDepth; depth < maxDepth; depth++) {
      logger.debug(`Agent loop iteration ${depth + 1}/${maxDepth}`);

      const response = await this.provider.chat({
        system: this.systemPrompt,
        messages,
        tools: currentTools,
      });

      if (response.stopReason === 'end_turn') {
        const reply = response.text || '';
        this.conversationManager.addMessage(chatId, 'assistant', reply);
        return reply;
      }

      if (response.stopReason === 'tool_use') {
        messages.push({ role: 'assistant', content: response.rawContent });

        // Send thinking text to the user
        if (response.text && response.text.trim()) {
          logger.info(`Agent thinking: ${response.text.slice(0, 200)}`);
          await this._sendUpdate(`💭 ${response.text}`);
        }

        const toolResults = [];
        const usedToolNames = [];

        for (let i = 0; i < response.toolCalls.length; i++) {
          const block = response.toolCalls[i];

          // Build a block-like object for _checkPause (needs .type for remainingBlocks filter)
          const blockObj = { type: 'tool_use', id: block.id, name: block.name, input: block.input };

          // Check if we need to pause (missing cred or dangerous action)
          const remaining = response.toolCalls.slice(i + 1).map((tc) => ({
            type: 'tool_use', id: tc.id, name: tc.name, input: tc.input,
          }));
          const pauseMsg = this._checkPause(chatId, blockObj, user, toolResults, remaining, messages);
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

          usedToolNames.push(block.name);

          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: this._truncateResult(block.name, result),
          });
        }

        // Expand tools based on what was actually used
        currentTools = expandToolsForUsed(usedToolNames, currentTools, toolDefinitions);

        messages.push({ role: 'user', content: toolResults });
        continue;
      }

      // Unexpected stop reason
      logger.warn(`Unexpected stopReason: ${response.stopReason}`);
      if (response.text) {
        this.conversationManager.addMessage(chatId, 'assistant', response.text);
        return response.text;
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
