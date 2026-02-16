import Anthropic from '@anthropic-ai/sdk';
import { BaseProvider } from './base.js';

export class AnthropicProvider extends BaseProvider {
  constructor(opts) {
    super(opts);
    this.client = new Anthropic({ apiKey: this.apiKey });
  }

  async chat({ system, messages, tools, signal }) {
    const params = {
      model: this.model,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      system,
      messages,
    };

    if (tools && tools.length > 0) {
      params.tools = tools;
    }

    return this._callWithResilience(async (timedSignal) => {
      const response = await this.client.messages.create(params, { signal: timedSignal });

      const stopReason = response.stop_reason === 'end_turn' ? 'end_turn' : 'tool_use';

      const textBlocks = response.content.filter((b) => b.type === 'text');
      const text = textBlocks.map((b) => b.text).join('\n');

      const toolCalls = response.content
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, input: b.input }));

      return {
        stopReason,
        text,
        toolCalls,
        rawContent: response.content,
      };
    }, signal);
  }

  async ping() {
    await this.client.messages.create({
      model: this.model,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'ping' }],
    });
  }
}
