/**
 * Abstract provider interface.
 * Every provider must implement chat() and ping().
 */

export class BaseProvider {
  constructor({ model, maxTokens, temperature, apiKey }) {
    this.model = model;
    this.maxTokens = maxTokens;
    this.temperature = temperature;
    this.apiKey = apiKey;
  }

  /**
   * Send a chat completion request.
   * @param {object} opts
   * @param {string} opts.system - System prompt
   * @param {Array} opts.messages - Anthropic-format messages
   * @param {Array} opts.tools - Anthropic-format tool definitions
   * @returns {Promise<{stopReason: 'end_turn'|'tool_use', text: string, toolCalls: Array<{id,name,input}>, rawContent: Array}>}
   */
  async chat({ system, messages, tools }) {
    throw new Error('chat() not implemented');
  }

  /** Quick connectivity test — throws on failure. */
  async ping() {
    throw new Error('ping() not implemented');
  }
}
