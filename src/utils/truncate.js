/**
 * Shared tool-result truncation logic.
 * Used by both OrchestratorAgent and WorkerAgent to cap tool outputs
 * before feeding them back into the LLM context window.
 */

const MAX_RESULT_LENGTH = 3000;

const LARGE_FIELDS = [
  'stdout', 'stderr', 'content', 'diff', 'output',
  'body', 'html', 'text', 'log', 'logs',
];

/**
 * Truncate a serialized tool result to fit within the context budget.
 *
 * Strategy:
 *   1. If JSON.stringify(result) fits, return it as-is.
 *   2. Otherwise, trim known large string fields to 500 chars each and retry.
 *   3. If still too large, hard-slice the serialized string.
 *
 * @param {string} _name - Tool name (reserved for future per-tool limits)
 * @param {any} result - Raw tool result object
 * @returns {string} JSON string, guaranteed ≤ MAX_RESULT_LENGTH (+tail note)
 */
export function truncateToolResult(_name, result) {
  let str = JSON.stringify(result);
  if (str.length <= MAX_RESULT_LENGTH) return str;

  if (result && typeof result === 'object') {
    const truncated = { ...result };
    for (const field of LARGE_FIELDS) {
      if (typeof truncated[field] === 'string' && truncated[field].length > 500) {
        truncated[field] = truncated[field].slice(0, 500) + `\n... [truncated ${truncated[field].length - 500} chars]`;
      }
    }
    str = JSON.stringify(truncated);
    if (str.length <= MAX_RESULT_LENGTH) return str;
  }

  return str.slice(0, MAX_RESULT_LENGTH) + `\n... [truncated, total ${str.length} chars]`;
}
