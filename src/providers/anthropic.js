import Anthropic from '@anthropic-ai/sdk';
import { BaseProvider } from './base.js';

export class AnthropicProvider extends BaseProvider {
  constructor(opts) {
    super(opts);
    this.client = new Anthropic({ apiKey: this.apiKey });
  }

  async chat({ system, messages, tools }) {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      system,
      tools,
      messages,
    });

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
  }

  async ping() {
    await this.client.messages.create({
      model: this.model,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'ping' }],
    });
  }
}
