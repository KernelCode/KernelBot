import { exec } from 'child_process';

/**
 * Escape a string for safe use as a shell argument.
 * Wraps the value in single quotes and escapes any embedded single quotes.
 *
 * @param {string} arg - The value to escape
 * @returns {string} Shell-safe quoted string
 */
export function shellEscape(arg) {
  if (arg === undefined || arg === null) return "''";
  return "'" + String(arg).replace(/'/g, "'\\''") + "'";
}

/**
 * Run a shell command and return { output } on success or { error } on failure.
 * Resolves (never rejects) so callers can handle errors via the result object.
 *
 * @param {string} cmd - The shell command to execute
 * @param {number} [timeout=10000] - Max execution time in milliseconds
 * @param {{ maxBuffer?: number }} [opts] - Optional exec options
 * @returns {Promise<{ output: string } | { error: string }>}
 */
export function shellRun(cmd, timeout = 10000, opts = {}) {
  return new Promise((resolve) => {
    exec(cmd, { timeout, maxBuffer: opts.maxBuffer, ...opts }, (error, stdout, stderr) => {
      if (error) return resolve({ error: stderr || error.message });
      resolve({ output: stdout.trim() });
    });
  });
}
