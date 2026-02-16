/**
 * Intent detector — analyzes user messages to identify web search/browse intents.
 *
 * When detected, the agent wraps the message with a structured execution plan
 * so the model follows through instead of giving up after one tool call.
 */

// Matches domain-like patterns (haraj.com.sa, example.com, etc.)
const URL_PATTERN = /\b(?:https?:\/\/)?(?:www\.)?([a-z0-9][-a-z0-9]*\.)+[a-z]{2,}\b/i;

// Explicit search/find verbs
const SEARCH_VERBS = /\b(?:search|search\s+for|find\s+me|find|look\s*(?:for|up|into)|lookup|hunt\s+for)\b/i;

// Info-seeking phrases (trigger browse intent when combined with a URL)
const INFO_PHRASES = /\b(?:what(?:'s| is| are)|show\s*me|get\s*me|check|list|top|best|latest|new|popular|trending|compare|review|price|cheap|expensive)\b/i;

// These words mean the user is NOT doing a web task — they're doing a local/system task
const NON_WEB_CONTEXT = /\b(?:file|files|directory|folder|git|logs?\b|code|error|bug|docker|container|process|pid|service|command|terminal|disk|memory|cpu|system status|port|package|module|function|class|variable|server|database|db|ssh|deploy|install|build|compile|test|commit|branch|merge|pull request)\b/i;

// Screenshot-only requests — just take a screenshot, don't force a deep browse
const SCREENSHOT_ONLY = /\b(?:screenshot|take\s+a?\s*screenshot|capture\s+screen)\b/i;

/**
 * Detect if a user message contains a web search or browse intent.
 *
 * @param {string} message — raw user message
 * @returns {{ type: 'search'|'browse', message: string } | null}
 */
export function detectIntent(message) {
  // Skip bot commands and screenshot-only requests
  if (message.startsWith('/')) return null;
  if (SCREENSHOT_ONLY.test(message)) return null;

  const hasSearchVerb = SEARCH_VERBS.test(message);
  const hasNonWebContext = NON_WEB_CONTEXT.test(message);
  const hasUrl = URL_PATTERN.test(message);
  const hasInfoPhrase = INFO_PHRASES.test(message);

  // Explicit search verb + no technical context = web search
  if (hasSearchVerb && !hasNonWebContext) {
    return { type: 'search', message };
  }

  // URL/domain + info-seeking phrase + no technical context = browse & extract
  if (hasUrl && hasInfoPhrase && !hasNonWebContext) {
    return { type: 'browse', message };
  }

  return null;
}
