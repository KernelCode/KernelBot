import { GoogleGenAI } from '@google/genai';
import { BaseProvider } from './base.js';

/**
 * Native Google Gemini provider using @google/genai SDK.
 */
export class GoogleGenaiProvider extends BaseProvider {
  constructor(opts) {
    super(opts);
    this.client = new GoogleGenAI({ apiKey: this.apiKey });
  }

  // ── Format conversion helpers ──

  /** Anthropic tool defs → Google functionDeclarations */
  _convertTools(tools) {
    if (!tools || tools.length === 0) return undefined;
    return [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        })),
      },
    ];
  }

  /** Anthropic messages → Google contents array */
  _convertMessages(messages) {
    const contents = [];

    // Build a map of tool_use_id → tool_name from assistant messages
    // so we can resolve function names when converting tool_result blocks
    const toolIdToName = new Map();
    for (const msg of messages) {
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_use') {
            toolIdToName.set(block.id, block.name);
          }
        }
      }
    }

    for (const msg of messages) {
      if (msg.role === 'user') {
        if (typeof msg.content === 'string') {
          contents.push({ role: 'user', parts: [{ text: msg.content }] });
        } else if (Array.isArray(msg.content)) {
          // Check if it's tool results
          if (msg.content[0]?.type === 'tool_result') {
            const parts = msg.content.map((tr) => ({
              functionResponse: {
                name: toolIdToName.get(tr.tool_use_id) || tr.tool_use_id,
                response: {
                  result:
                    typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
                },
              },
            }));
            contents.push({ role: 'user', parts });
          } else {
            // Text content blocks
            const text = msg.content
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('\n');
            contents.push({ role: 'user', parts: [{ text: text || '' }] });
          }
        }
      } else if (msg.role === 'assistant') {
        const parts = [];
        if (typeof msg.content === 'string') {
          parts.push({ text: msg.content });
        } else if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === 'text' && block.text) {
              parts.push({ text: block.text });
            } else if (block.type === 'tool_use') {
              const part = { functionCall: { name: block.name, args: block.input } };
              // Replay thought signature for thinking models
              if (block.thoughtSignature) {
                part.thoughtSignature = block.thoughtSignature;
              }
              parts.push(part);
            }
          }
        }
        if (parts.length > 0) {
          contents.push({ role: 'model', parts });
        }
      }
    }

    return contents;
  }

  /** Google response → normalized format with rawContent in Anthropic format */
  _normalizeResponse(response) {
    // Access raw parts to preserve thoughtSignature and avoid SDK warning
    // (response.text logs a warning when there are only functionCall parts)
    const candidate = response.candidates?.[0];
    const parts = candidate?.content?.parts || [];

    // Extract text from raw parts instead of response.text
    const text = parts
      .filter((p) => p.text)
      .map((p) => p.text)
      .join('\n');

    const functionCallParts = parts.filter((p) => p.functionCall);
    const toolCalls = functionCallParts.map((p, i) => ({
      id: `toolu_google_${Date.now()}_${i}`,
      name: p.functionCall.name,
      input: p.functionCall.args || {},
      // Preserve thought signature for thinking models (sibling of functionCall)
      ...(p.thoughtSignature && { thoughtSignature: p.thoughtSignature }),
    }));

    const stopReason = toolCalls.length > 0 ? 'tool_use' : 'end_turn';

    // Build rawContent in Anthropic format for history consistency
    const rawContent = [];
    if (text) {
      rawContent.push({ type: 'text', text });
    }
    for (const tc of toolCalls) {
      rawContent.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input: tc.input,
        ...(tc.thoughtSignature && { thoughtSignature: tc.thoughtSignature }),
      });
    }

    return { stopReason, text, toolCalls, rawContent };
  }

  // ── Public API ──

  async chat({ system, messages, tools, signal }) {
    const config = {
      temperature: this.temperature,
      maxOutputTokens: this.maxTokens,
    };

    if (system) {
      config.systemInstruction = Array.isArray(system)
        ? system.map((b) => b.text).join('\n')
        : system;
    }

    const convertedTools = this._convertTools(tools);
    if (convertedTools) {
      config.tools = convertedTools;
    }

    const contents = this._convertMessages(messages);

    try {
      return await this._callWithResilience(async (timedSignal) => {
        const response = await this.client.models.generateContent({
          model: this.model,
          contents,
          config: {
            ...config,
            abortSignal: timedSignal,
            httpOptions: { timeout: this.timeout },
          },
        });
        return this._normalizeResponse(response);
      }, signal);
    } catch (err) {
      // Normalize Google SDK error: extract clean message from JSON
      if (err.message?.startsWith('{')) {
        try {
          const parsed = JSON.parse(err.message);
          err.message = parsed?.error?.message || err.message;
          err.status = parsed?.error?.code;
        } catch {}
      }
      throw err;
    }
  }

  async ping() {
    await this.client.models.generateContent({
      model: this.model,
      contents: 'ping',
      config: {
        maxOutputTokens: 16,
        temperature: 0,
      },
    });
  }
}
