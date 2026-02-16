import { AnthropicProvider } from './anthropic.js';
import { OpenAICompatProvider } from './openai-compat.js';
import { PROVIDERS } from './models.js';

export { PROVIDERS } from './models.js';

/**
 * Create the right provider based on config.brain.
 * @param {object} config - Full app config (must have config.brain)
 * @returns {BaseProvider}
 */
export function createProvider(config) {
  const { provider, model, max_tokens, temperature, api_key } = config.brain;

  const providerDef = PROVIDERS[provider];
  if (!providerDef) {
    throw new Error(`Unknown provider: ${provider}. Valid: ${Object.keys(PROVIDERS).join(', ')}`);
  }

  const opts = {
    model,
    maxTokens: max_tokens,
    temperature,
    apiKey: api_key,
  };

  if (provider === 'anthropic') {
    return new AnthropicProvider(opts);
  }

  // OpenAI, Google, Groq — all use OpenAI-compatible API
  return new OpenAICompatProvider({
    ...opts,
    baseUrl: providerDef.baseUrl || undefined,
  });
}
