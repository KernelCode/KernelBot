/**
 * Provider & model catalog — single source of truth.
 */

export const PROVIDERS = {
  anthropic: {
    name: 'Anthropic (Claude)',
    envKey: 'ANTHROPIC_API_KEY',
    models: [
      // Latest generation
      { id: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
      // Previous generation
      { id: 'claude-opus-4-5-20251101', label: 'Claude Opus 4.5' },
      { id: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5' },
      { id: 'claude-opus-4-1-20250805', label: 'Claude Opus 4.1' },
      { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
      { id: 'claude-opus-4-20250514', label: 'Claude Opus 4' },
    ],
  },
  openai: {
    name: 'OpenAI (GPT)',
    envKey: 'OPENAI_API_KEY',
    models: [
      { id: 'gpt-4o', label: 'GPT-4o' },
      { id: 'gpt-4o-mini', label: 'GPT-4o Mini' },
      { id: 'o1', label: 'o1' },
      { id: 'o3-mini', label: 'o3-mini' },
    ],
  },
  google: {
    name: 'Google (Gemini)',
    envKey: 'GOOGLE_API_KEY',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    models: [
      // Gemini 3 series
      { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' },
      { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash' },
      { id: 'gemini-3-pro-preview', label: 'Gemini 3 Pro' },
      // Gemini 2.5 series
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite' },
    ],
  },
  groq: {
    name: 'Groq',
    envKey: 'GROQ_API_KEY',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: [
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B' },
      { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B' },
      { id: 'mixtral-8x7b-32768', label: 'Mixtral 8x7B' },
    ],
  },
};

/** Models that don't support system prompts or temperature (reasoning models). */
export const REASONING_MODELS = new Set(['o1', 'o3-mini']);

export function getProviderForModel(modelId) {
  for (const [key, provider] of Object.entries(PROVIDERS)) {
    if (provider.models.some((m) => m.id === modelId)) return key;
  }
  return null;
}
