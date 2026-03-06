import { getLogger } from '../utils/logger.js';

/**
 * Embedding provider abstraction for BrainDB.
 * Factory selects provider based on config + available API keys.
 */

// ── Base ─────────────────────────────────────────────────────────

class BaseEmbedder {
  get dimensions() { return 0; }
  get name() { return 'none'; }

  /** @param {string} text @returns {Promise<Float32Array|null>} */
  async embed(_text) { return null; }

  /** @param {string[]} texts @returns {Promise<(Float32Array|null)[]>} */
  async embedBatch(texts) {
    const results = [];
    for (const text of texts) {
      results.push(await this.embed(text));
    }
    return results;
  }
}

// ── OpenAI ───────────────────────────────────────────────────────

class OpenAIEmbedder extends BaseEmbedder {
  constructor(apiKey, model = 'text-embedding-3-small') {
    super();
    this._apiKey = apiKey;
    this._model = model;
    this._dimensions = 1536;
    this._client = null;
  }

  get dimensions() { return this._dimensions; }
  get name() { return 'openai'; }

  async _getClient() {
    if (!this._client) {
      const { default: OpenAI } = await import('openai');
      this._client = new OpenAI({ apiKey: this._apiKey });
    }
    return this._client;
  }

  async embed(text) {
    const logger = getLogger();
    try {
      const client = await this._getClient();
      const res = await client.embeddings.create({
        model: this._model,
        input: text.slice(0, 8000), // safety truncate
      });
      return new Float32Array(res.data[0].embedding);
    } catch (err) {
      logger.warn(`[Embeddings] OpenAI embed failed: ${err.message}`);
      return null;
    }
  }

  async embedBatch(texts) {
    const logger = getLogger();
    const results = [];
    // OpenAI supports batch input — chunk at 100
    for (let i = 0; i < texts.length; i += 100) {
      const chunk = texts.slice(i, i + 100).map(t => t.slice(0, 8000));
      try {
        const client = await this._getClient();
        const res = await client.embeddings.create({
          model: this._model,
          input: chunk,
        });
        for (const item of res.data) {
          results.push(new Float32Array(item.embedding));
        }
      } catch (err) {
        logger.warn(`[Embeddings] OpenAI batch embed failed: ${err.message}`);
        for (let j = 0; j < chunk.length; j++) results.push(null);
      }
    }
    return results;
  }
}

// ── Google ────────────────────────────────────────────────────────

class GoogleEmbedder extends BaseEmbedder {
  constructor(apiKey, model = 'text-embedding-004') {
    super();
    this._apiKey = apiKey;
    this._model = model;
    this._dimensions = 768;
    this._client = null;
  }

  get dimensions() { return this._dimensions; }
  get name() { return 'google'; }

  async _getClient() {
    if (!this._client) {
      const { GoogleGenAI } = await import('@google/genai');
      this._client = new GoogleGenAI({ apiKey: this._apiKey });
    }
    return this._client;
  }

  async embed(text) {
    const logger = getLogger();
    try {
      const client = await this._getClient();
      const res = await client.models.embedContent({
        model: this._model,
        contents: text.slice(0, 8000),
      });
      return new Float32Array(res.embeddings[0].values);
    } catch (err) {
      logger.warn(`[Embeddings] Google embed failed: ${err.message}`);
      return null;
    }
  }

  // Google doesn't support batch natively — sequential
}

// ── Null (graceful degradation) ──────────────────────────────────

class NullEmbedder extends BaseEmbedder {
  get dimensions() { return 0; }
  get name() { return 'none'; }
}

// ── Factory ──────────────────────────────────────────────────────

export class EmbeddingProvider {
  /**
   * Create the best available embedder based on config.
   *
   * Selection logic:
   * 1. Explicit config.brain_db.embedding_provider → use it
   * 2. 'auto' → match brain provider
   * 3. Anthropic/Groq → fallback to whichever key exists
   * 4. No keys → NullEmbedder
   */
  static create(config) {
    const logger = getLogger();
    const brainDbConfig = config.brain_db || {};
    const explicit = brainDbConfig.embedding_provider || 'auto';

    // Explicit provider selection
    if (explicit === 'openai') {
      const key = process.env.OPENAI_API_KEY || config.brain?.api_key;
      if (key) {
        logger.info('[Embeddings] Using OpenAI embedder (explicit config)');
        return new OpenAIEmbedder(key, brainDbConfig.embedding_model || undefined);
      }
      logger.warn('[Embeddings] OpenAI selected but no API key — falling back to none');
      return new NullEmbedder();
    }

    if (explicit === 'google') {
      const key = process.env.GOOGLE_API_KEY || config.brain?.api_key;
      if (key) {
        logger.info('[Embeddings] Using Google embedder (explicit config)');
        return new GoogleEmbedder(key, brainDbConfig.embedding_model || undefined);
      }
      logger.warn('[Embeddings] Google selected but no API key — falling back to none');
      return new NullEmbedder();
    }

    if (explicit === 'none') {
      logger.info('[Embeddings] Embeddings disabled by config');
      return new NullEmbedder();
    }

    // Auto: match brain provider
    const brainProvider = config.brain?.provider;

    if (brainProvider === 'openai') {
      const key = process.env.OPENAI_API_KEY || config.brain?.api_key;
      if (key) {
        logger.info('[Embeddings] Using OpenAI embedder (auto — matches brain provider)');
        return new OpenAIEmbedder(key);
      }
    }

    if (brainProvider === 'google') {
      const key = process.env.GOOGLE_API_KEY || config.brain?.api_key;
      if (key) {
        logger.info('[Embeddings] Using Google embedder (auto — matches brain provider)');
        return new GoogleEmbedder(key);
      }
    }

    // Anthropic / Groq don't have embeddings — try fallback keys
    if (process.env.GOOGLE_API_KEY) {
      logger.info('[Embeddings] Using Google embedder (auto — fallback from available key)');
      return new GoogleEmbedder(process.env.GOOGLE_API_KEY);
    }

    if (process.env.OPENAI_API_KEY) {
      logger.info('[Embeddings] Using OpenAI embedder (auto — fallback from available key)');
      return new OpenAIEmbedder(process.env.OPENAI_API_KEY);
    }

    logger.info('[Embeddings] No embedding provider available — vector search disabled');
    return new NullEmbedder();
  }
}
