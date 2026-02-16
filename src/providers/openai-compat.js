import OpenAI from 'openai';
import { BaseProvider } from './base.js';
import { REASONING_MODELS } from './models.js';

/**
 * OpenAI-compatible provider — works with OpenAI, Groq, and Google Gemini
 * via configurable baseURL.
 */
export class OpenAICompatProvider extends BaseProvider {
  constructor(opts) {
    super(opts);
    this.client = new OpenAI({
      apiKey: this.apiKey,
      ...(opts.baseUrl && { baseURL: opts.baseUrl }),
    });
    this.isReasoningModel = REASONING_MODELS.has(this.model);
  }

  // ── Format conversion helpers ──

  /** Anthropic tool defs → OpenAI function tool defs */
  _convertTools(tools) {
    if (!tools || tools.length === 0) return undefined;
    return tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
  }

  /** Anthropic messages → OpenAI messages */
  _convertMessages(system, messages) {
    const out = [];

    // System prompt as first message (skip for reasoning models)
    if (system && !this.isReasoningModel) {
      const systemText = Array.isArray(system)
        ? system.map((b) => b.text).join('\n')
        : system;
      out.push({ role: 'system', content: systemText });
    }

    for (const msg of messages) {
      if (msg.role === 'user') {
        // Could be a string, content blocks, or tool_result array
        if (typeof msg.content === 'string') {
          out.push({ role: 'user', content: msg.content });
        } else if (Array.isArray(msg.content)) {
          // Check if it's tool results
          if (msg.content[0]?.type === 'tool_result') {
            for (const tr of msg.content) {
              out.push({
                role: 'tool',
                tool_call_id: tr.tool_use_id,
                content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
              });
            }
          } else {
            // Text content blocks
            const text = msg.content
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('\n');
            out.push({ role: 'user', content: text || '' });
          }
        }
      } else if (msg.role === 'assistant') {
        // Convert Anthropic content blocks → OpenAI format
        if (typeof msg.content === 'string') {
          out.push({ role: 'assistant', content: msg.content });
        } else if (Array.isArray(msg.content)) {
          const textParts = msg.content.filter((b) => b.type === 'text');
          const toolParts = msg.content.filter((b) => b.type === 'tool_use');

          const assistantMsg = {
            role: 'assistant',
            content: textParts.map((b) => b.text).join('\n') || null,
          };

          if (toolParts.length > 0) {
            assistantMsg.tool_calls = toolParts.map((b) => ({
              id: b.id,
              type: 'function',
              function: {
                name: b.name,
                arguments: JSON.stringify(b.input),
              },
            }));
          }

          out.push(assistantMsg);
        }
      }
    }

    return out;
  }

  /** OpenAI response → normalized format with rawContent in Anthropic format */
  _normalizeResponse(response) {
    const choice = response.choices[0];
    const finishReason = choice.finish_reason;

    const stopReason = finishReason === 'tool_calls' ? 'tool_use' : 'end_turn';

    const text = choice.message.content || '';

    const toolCalls = (choice.message.tool_calls || []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      input: JSON.parse(tc.function.arguments),
    }));

    // Build rawContent in Anthropic format for message history consistency
    const rawContent = [];
    if (text) {
      rawContent.push({ type: 'text', text });
    }
    for (const tc of toolCalls) {
      rawContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
    }

    return { stopReason, text, toolCalls, rawContent };
  }

  // ── Public API ──

  async chat({ system, messages, tools, signal }) {
    const params = {
      model: this.model,
      messages: this._convertMessages(system, messages),
    };

    if (!this.isReasoningModel) {
      params.temperature = this.temperature;
    }

    params.max_tokens = this.maxTokens;

    const convertedTools = this._convertTools(tools);
    if (convertedTools) {
      params.tools = convertedTools;
    }

    const requestOpts = {};
    if (signal) requestOpts.signal = signal;

    const response = await this.client.chat.completions.create(params, requestOpts);
    return this._normalizeResponse(response);
  }

  async ping() {
    const params = {
      model: this.model,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'ping' }],
    };
    if (!this.isReasoningModel) {
      params.temperature = 0;
    }
    await this.client.chat.completions.create(params);
  }
}
