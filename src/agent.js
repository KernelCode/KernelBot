import Anthropic from '@anthropic-ai/sdk';
import { toolDefinitions, executeTool, checkConfirmation } from './tools/index.js';
import { getSystemPrompt } from './prompts/system.js';
import { getLogger } from './utils/logger.js';

export class Agent {
  constructor({ config, conversationManager }) {
    this.config = config;
    this.conversationManager = conversationManager;
    this.client = new Anthropic({ apiKey: config.anthropic.api_key });
    this.systemPrompt = getSystemPrompt(config);
    this._pendingConfirmation = new Map(); // chatId -> { block, context }
  }

  async processMessage(chatId, userMessage, user) {
    const logger = getLogger();

    // Handle pending confirmation responses
    const pending = this._pendingConfirmation.get(chatId);
    if (pending) {
      this._pendingConfirmation.delete(chatId);
      const lower = userMessage.toLowerCase().trim();

      if (lower === 'yes' || lower === 'y' || lower === 'confirm') {
        // User approved — execute the blocked tool and resume
        logger.info(`User confirmed dangerous tool: ${pending.block.name}`);
        const result = await executeTool(pending.block.name, pending.block.input, pending.context);

        // Resume the agent loop with the tool result
        pending.toolResults.push({
          type: 'tool_result',
          tool_use_id: pending.block.id,
          content: JSON.stringify(result),
        });

        // Process remaining blocks if any
        for (const block of pending.remainingBlocks) {
          if (block.type !== 'tool_use') continue;

          const dangerLabel = checkConfirmation(block.name, block.input, this.config);
          if (dangerLabel) {
            // Another dangerous tool — ask again
            this._pendingConfirmation.set(chatId, {
              block,
              context: pending.context,
              toolResults: pending.toolResults,
              remainingBlocks: pending.remainingBlocks.filter((b) => b !== block),
              messages: pending.messages,
            });
            return `⚠️ Next action will **${dangerLabel}**.\n\n\`${block.name}\`: \`${JSON.stringify(block.input)}\`\n\nConfirm? (yes/no)`;
          }

          logger.info(`Tool call: ${block.name}`);
          const r = await executeTool(block.name, block.input, pending.context);
          pending.toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(r),
          });
        }

        // Continue the agent loop
        pending.messages.push({ role: 'user', content: pending.toolResults });
        return await this._continueLoop(chatId, pending.messages, user);
      } else {
        // User denied
        logger.info(`User denied dangerous tool: ${pending.block.name}`);
        pending.toolResults.push({
          type: 'tool_result',
          tool_use_id: pending.block.id,
          content: JSON.stringify({ error: 'User denied this operation.' }),
        });
        pending.messages.push({ role: 'user', content: pending.toolResults });
        return await this._continueLoop(chatId, pending.messages, user);
      }
    }

    const { max_tool_depth } = this.config.anthropic;

    // Add user message to persistent history
    this.conversationManager.addMessage(chatId, 'user', userMessage);

    // Build working messages from history
    const messages = [...this.conversationManager.getHistory(chatId)];

    return await this._runLoop(chatId, messages, user, 0, max_tool_depth);
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

        const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
        const toolResults = [];

        for (let i = 0; i < toolUseBlocks.length; i++) {
          const block = toolUseBlocks[i];

          // Check if this tool requires confirmation
          const dangerLabel = checkConfirmation(block.name, block.input, this.config);
          if (dangerLabel) {
            logger.warn(`Dangerous tool detected: ${block.name} — ${dangerLabel}`);

            // Store state and pause for user confirmation
            this._pendingConfirmation.set(chatId, {
              block,
              context: { config: this.config, user },
              toolResults,
              remainingBlocks: toolUseBlocks.slice(i + 1),
              messages,
            });

            return `⚠️ This action will **${dangerLabel}**.\n\n\`${block.name}\`: \`${JSON.stringify(block.input)}\`\n\nConfirm? (yes/no)`;
          }

          logger.info(`Tool call: ${block.name}`);

          const result = await executeTool(block.name, block.input, {
            config: this.config,
            user,
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

  async _continueLoop(chatId, messages, user) {
    const { max_tool_depth } = this.config.anthropic;
    return await this._runLoop(chatId, messages, user, 0, max_tool_depth);
  }
}
