/**
 * Persona Shield — graceful, user-friendly error responses.
 *
 * Instead of exposing raw system errors (e.g. "Reached maximum orchestrator depth")
 * to the user, this module returns clean, professional messages that hide
 * internal technical details from end users.
 */

const FRIENDLY_RESPONSES = {
  depth: [
    'I ran into a processing limit on that request. Let me try again.',
    'That request was a bit complex for one go. Could you try again?',
    'I hit a small snag processing that. Please try once more.',
  ],
  timeout: [
    'That took longer than expected. Please try again.',
    'The request timed out. Could you give it another try?',
  ],
  rateLimit: [
    'I\'m handling a lot of requests right now. Please try again in a moment.',
    'Things are a bit busy on my end. Give me a moment and try again.',
  ],
  context: [
    'That message was a bit too long for me to process. Could you shorten it?',
    'The request is quite large. Could we break it into smaller parts?',
  ],
  network: [
    'I\'m having a connectivity issue. Please try again shortly.',
  ],
  generic: [
    'I encountered a temporary issue. Please try again.',
    'Something went wrong on my end. Let me try that again.',
    'I hit a small technical snag. Please try once more.',
  ],
};

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Classify an error and return a user-friendly response.
 * @param {Error|string} err - The error object or message string
 * @returns {string} A clean, professional message
 */
export function personaShield(err) {
  const msg = (typeof err === 'string' ? err : err?.message || '').toLowerCase();

  if (msg.includes('depth') || msg.includes('maximum orchestrator')) {
    return pick(FRIENDLY_RESPONSES.depth);
  }
  if (msg.includes('timed out') || msg.includes('timeout')) {
    return pick(FRIENDLY_RESPONSES.timeout);
  }
  if (msg.includes('rate limit') || msg.includes('429') || msg.includes('quota')) {
    return pick(FRIENDLY_RESPONSES.rateLimit);
  }
  if (msg.includes('context length') || msg.includes('too long') || msg.includes('too large') || msg.includes('token limit')) {
    return pick(FRIENDLY_RESPONSES.context);
  }
  if (msg.includes('connection') || msg.includes('network') || msg.includes('fetch failed')) {
    return pick(FRIENDLY_RESPONSES.network);
  }

  return pick(FRIENDLY_RESPONSES.generic);
}

/**
 * Generate a user-friendly depth-limit message (for use in the orchestrator loop).
 * @returns {string}
 */
export function personaShieldDepthLimit() {
  return pick(FRIENDLY_RESPONSES.depth);
}
