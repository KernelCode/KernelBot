import { createProvider, PROVIDERS } from './providers/index.js';
import { toolDefinitions, executeTool, checkConfirmation } from './tools/index.js';
import { selectToolsForMessage, expandToolsForUsed } from './tools/categories.js';
import { getSystemPrompt } from './prompts/system.js';
import { getUnifiedSkillById } from './skills/custom.js';
import { detectIntent, generatePlan } from './intents/index.js';
import { getLogger } from './utils/logger.js';
import { getMissingCredential, saveCredential, saveProviderToYaml } from './utils/config.js';

// Browser tools — used by completion gate to check if the model did enough work
const BROWSER_TOOLS = new Set(['web_search', 'browse_website', 'interact_with_page', 'extract_content', 'screenshot_website']);

const MAX_RESULT_LENGTH = 3000;
const LARGE_FIELDS = ['stdout', 'stderr', 'content', 'diff', 'output', 'body', 'html', 'text', 'log', 'logs'];

export class Agent {
  constructor({ config, conversationManager }) {
    this.config = config;
    this.conversationManager = conversationManager;
    this.provider = createProvider(config);
    this._pending = new Map(); // chatId -> pending state
  }

  /** Build the system prompt dynamically based on the chat's active skill. */
  _getSystemPrompt(chatId) {
    const skillId = this.conversationManager.getSkill(chatId);
    if (skillId) {
      const skill = getUnifiedSkillById(skillId);
      if (skill) return getSystemPrompt(this.config, skill.systemPrompt);
    }
    return getSystemPrompt(this.config);
  }

  setSkill(chatId, skillId) {
    this.conversationManager.setSkill(chatId, skillId);
  }

  clearSkill(chatId) {
    this.conversationManager.clearSkill(chatId);
  }

  getActiveSkill(chatId) {
    const skillId = this.conversationManager.getSkill(chatId);
    return skillId ? getUnifiedSkillById(skillId) : null;
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
   * Returns null on success, the envKey string if the key is missing,
   * or an object { error: string } if the provider fails validation.
   */
  async switchBrain(providerKey, modelId) {
    const logger = getLogger();
    const providerDef = PROVIDERS[providerKey];
    if (!providerDef) return `Unknown provider: ${providerKey}`;

    const envKey = providerDef.envKey;
    const apiKey = process.env[envKey];
    if (!apiKey) {
      return envKey; // caller handles prompting
    }

    // Validate the new provider before committing changes
    try {
      // Build a temporary config to test
      const testConfig = { ...this.config, brain: { ...this.config.brain, provider: providerKey, model: modelId, api_key: apiKey } };
      const testProvider = createProvider(testConfig);
      await testProvider.ping();

      // Ping succeeded — commit changes
      this.config.brain.provider = providerKey;
      this.config.brain.model = modelId;
      this.config.brain.api_key = apiKey;
      this.provider = testProvider;
      saveProviderToYaml(providerKey, modelId);

      logger.info(`Brain switched to ${providerDef.name} / ${modelId}`);
      return null;
    } catch (err) {
      // Validation failed — keep everything as-is
      logger.error(`Brain switch failed for ${providerDef.name} / ${modelId}: ${err.message}`);
      return { error: err.message };
    }
  }

  /**
   * Finalize brain switch after API key was provided via chat.
   * Returns null on success, or { error: string } on failure.
   */
  async switchBrainWithKey(providerKey, modelId, apiKey) {
    const logger = getLogger();
    const providerDef = PROVIDERS[providerKey];

    try {
      // Build a temporary config to validate before saving anything
      const testConfig = { ...this.config, brain: { ...this.config.brain, provider: providerKey, model: modelId, api_key: apiKey } };
      const testProvider = createProvider(testConfig);
      await testProvider.ping();

      // Ping succeeded — save the key and commit changes
      saveCredential(this.config, providerDef.envKey, apiKey);
      this.config.brain.provider = providerKey;
      this.config.brain.model = modelId;
      this.config.brain.api_key = apiKey;
      this.provider = testProvider;
      saveProviderToYaml(providerKey, modelId);

      logger.info(`Brain switched to ${providerDef.name} / ${modelId} (new key saved)`);
      return null;
    } catch (err) {
      // Validation failed — don't save anything
      logger.error(`Brain switch failed for ${providerDef.name} / ${modelId}: ${err.message}`);
      return { error: err.message };
    }
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

    // Detect search/browse intent
    const intent = detectIntent(userMessage);
    if (intent) {
      logger.info(`Detected intent: ${intent.type} for message: ${userMessage.slice(0, 100)}`);
    }

    // Add ORIGINAL user message to persistent history
    this.conversationManager.addMessage(chatId, 'user', userMessage);

    // Build working messages from compressed history
    const messages = [...this.conversationManager.getSummarizedHistory(chatId)];

    // If intent detected, replace last message with the planned version
    // History stores the original; the model sees the plan
    if (intent) {
      const plan = generatePlan(intent);
      if (plan) {
        messages[messages.length - 1] = { role: 'user', content: plan };
      }
    }

    // Select relevant tools based on user message
    const tools = selectToolsForMessage(userMessage, toolDefinitions);
    logger.debug(`Selected ${tools.length}/${toolDefinitions.length} tools for message`);

    return await this._runLoop(chatId, messages, user, 0, max_tool_depth, tools, !!intent);
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
      web_search: 'query',
      browse_website: 'url',
      extract_content: 'selector',
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

  /**
   * Completion gate — check if the model did enough work for a web intent.
   * Requires at least 2 distinct browser tools used (e.g., browse + interact).
   * A single browse_website call is NOT enough for a search/browse intent.
   */
  _isIntentSatisfied(allUsedTools) {
    const uniqueBrowserTools = new Set(allUsedTools.filter((t) => BROWSER_TOOLS.has(t)));
    return uniqueBrowserTools.size >= 2;
  }

  async _runLoop(chatId, messages, user, startDepth, maxDepth, tools, hasIntent = false) {
    const logger = getLogger();
    let currentTools = tools || toolDefinitions;
    const allUsedTools = []; // track tools across all iterations
    let gateTriggered = false; // completion gate pushes only once

    for (let depth = startDepth; depth < maxDepth; depth++) {
      logger.debug(`Agent loop iteration ${depth + 1}/${maxDepth}`);

      const response = await this.provider.chat({
        system: this._getSystemPrompt(chatId),
        messages,
        tools: currentTools,
      });

      if (response.stopReason === 'end_turn') {
        const reply = response.text || '';

        // Completion gate: if an intent is active and the model hasn't done enough, push once
        if (hasIntent && !gateTriggered && !this._isIntentSatisfied(allUsedTools)) {
          gateTriggered = true;
          logger.info(`Completion gate: model stopped too early (used ${allUsedTools.length} tools), pushing to continue`);
          messages.push({ role: 'assistant', content: response.rawContent || [{ type: 'text', text: reply }] });
          messages.push({ role: 'user', content: 'Continue with the task. Navigate into the relevant section, search or click within the site, and show me the actual results.' });
          continue;
        }

        this.conversationManager.addMessage(chatId, 'assistant', reply);
        return reply;
      }

      if (response.stopReason === 'tool_use') {
        messages.push({ role: 'assistant', content: response.rawContent });

        // Log thinking text but don't send to user — tool summaries are enough
        if (response.text && response.text.trim()) {
          logger.info(`Agent thinking: ${response.text.slice(0, 200)}`);
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
          allUsedTools.push(block.name);

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
