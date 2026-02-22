/**
 * Abstract provider interface.
 * Every provider must implement chat() and ping().
 */

export class BaseProvider {
  constructor({ model, maxTokens, temperature, apiKey, timeout }) {
    this.model = model;
    this.maxTokens = maxTokens;
    this.temperature = temperature;
    this.apiKey = apiKey;
    this.timeout = timeout || 60_000;
  }

  /**
   * Compute retry delay using exponential backoff with full jitter.
   * Formula: random(0, min(MAX_BACKOFF, BASE * 2^attempt))
   * This distributes retries across time and avoids thundering-herd
   * when multiple workers retry simultaneously after a service hiccup.
   *
   * @param {number} attempt - Current attempt (1-indexed)
   * @returns {number} Delay in milliseconds
   */
  _retryDelay(attempt) {
    const BASE_MS = 1000;
    const MAX_BACKOFF_MS = 30_000;
    const ceiling = Math.min(MAX_BACKOFF_MS, BASE_MS * Math.pow(2, attempt));
    return Math.round(Math.random() * ceiling);
  }

  /**
   * Wrap an async LLM call with timeout + retries on transient errors (up to 3 attempts).
   * Composes an internal timeout AbortController with an optional external signal
   * (e.g. worker cancellation). Either aborting will cancel the call.
   *
   * Uses exponential backoff with full jitter between retries to avoid
   * thundering-herd effects when services recover from outages.
   *
   * @param {(signal: AbortSignal) => Promise<any>} fn - The API call, receives composed signal
   * @param {AbortSignal} [externalSignal] - Optional external abort signal
   * @returns {Promise<any>}
   */
  async _callWithResilience(fn, externalSignal) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(
        () => ac.abort(new Error(`LLM call timed out after ${this.timeout / 1000}s`)),
        this.timeout,
      );

      // If external signal already aborted, bail immediately
      if (externalSignal?.aborted) {
        clearTimeout(timer);
        throw externalSignal.reason || new Error('Aborted');
      }

      // Forward external abort to our internal controller
      let removeListener;
      if (externalSignal) {
        const onAbort = () => {
          clearTimeout(timer);
          ac.abort(externalSignal.reason || new Error('Cancelled'));
        };
        externalSignal.addEventListener('abort', onAbort, { once: true });
        removeListener = () => externalSignal.removeEventListener('abort', onAbort);
      }

      try {
        const result = await fn(ac.signal);
        clearTimeout(timer);
        removeListener?.();
        return result;
      } catch (err) {
        clearTimeout(timer);
        removeListener?.();

        if (attempt < 3 && this._isTransient(err)) {
          const delay = this._retryDelay(attempt);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Determine if an error is transient and worth retrying.
   * Covers connection errors, DNS failures, timeouts, 5xx, and 429 rate limits.
   */
  _isTransient(err) {
    const msg = err?.message || '';

    // Network-level & connection errors
    if (
      msg.includes('Connection error') ||
      msg.includes('ECONNRESET') ||
      msg.includes('ECONNREFUSED') ||
      msg.includes('ECONNABORTED') ||
      msg.includes('EPIPE') ||
      msg.includes('ENETUNREACH') ||
      msg.includes('EHOSTUNREACH') ||
      msg.includes('socket hang up') ||
      msg.includes('ETIMEDOUT') ||
      msg.includes('ENOTFOUND') ||
      msg.includes('EAI_AGAIN') ||
      msg.includes('fetch failed') ||
      msg.includes('timed out') ||
      msg.includes('network socket disconnected') ||
      msg.includes('other side closed')
    ) {
      return true;
    }

    // Check top-level status (Anthropic, OpenAI)
    let status = err?.status || err?.statusCode;

    // Google SDK nests HTTP status in JSON message — try to extract
    if (!status && msg.startsWith('{')) {
      try {
        const parsed = JSON.parse(msg);
        status = parsed?.error?.code || parsed?.code;
      } catch {}
    }

    // Anthropic overloaded (529) is also transient
    return (status >= 500 && status < 600) || status === 429 || status === 529;
  }

  /**
   * Send a chat completion request.
   * @param {object} opts
   * @param {string} opts.system - System prompt
   * @param {Array} opts.messages - Anthropic-format messages
   * @param {Array} opts.tools - Anthropic-format tool definitions
   * @param {AbortSignal} [opts.signal] - Optional AbortSignal for cancellation
   * @returns {Promise<{stopReason: 'end_turn'|'tool_use', text: string, toolCalls: Array<{id,name,input}>, rawContent: Array}>}
   */
  async chat({ system, messages, tools, signal }) {
    throw new Error('chat() not implemented');
  }

  /** Quick connectivity test — throws on failure. */
  async ping() {
    throw new Error('ping() not implemented');
  }
}
