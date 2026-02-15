import Anthropic from '@anthropic-ai/sdk';
import { toolDefinitions, executeTool } from './tools/index.js';
import { getSystemPrompt } from './prompts/system.js';
import { getLogger } from './utils/logger.js';

export class Agent {
  constructor({ config, conversationManager }) {
    this.config = config;
    this.conversationManager = conversationManager;
    this.client = new Anthropic({ apiKey: config.anthropic.api_key });
    this.systemPrompt = getSystemPrompt(config);
  }

  async processMessage(chatId, userMessage, user) {
    const logger = getLogger();
    const { model, max_tokens, temperature, max_tool_depth } = this.config.anthropic;

    // Add user message to persistent history
    this.conversationManager.addMessage(chatId, 'user', userMessage);

    // Build working messages from history
    const messages = [...this.conversationManager.getHistory(chatId)];

    for (let depth = 0; depth < max_tool_depth; depth++) {
      logger.debug(`Agent loop iteration ${depth + 1}/${max_tool_depth}`);

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

        // Save assistant reply to persistent history
        this.conversationManager.addMessage(chatId, 'assistant', reply);
        return reply;
      }

      if (response.stop_reason === 'tool_use') {
        // Push assistant response as-is (contains tool_use blocks)
        messages.push({ role: 'assistant', content: response.content });

        // Execute each tool_use block
        const toolResults = [];
        for (const block of response.content) {
          if (block.type !== 'tool_use') continue;

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

        // Push all tool results as a single user message
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
      `Reached maximum tool depth (${max_tool_depth}). Stopping to prevent infinite loops. ` +
      `Please try again with a simpler request.`;
    this.conversationManager.addMessage(chatId, 'assistant', depthWarning);
    return depthWarning;
  }
}
