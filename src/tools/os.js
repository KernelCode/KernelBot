import { exec } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { dirname, resolve, join } from 'path';
import { homedir } from 'os';
import { getLogger } from '../utils/logger.js';

/**
 * Expand a file path, resolving `~` to the user's home directory.
 * @param {string} p - The path to expand.
 * @returns {string} The resolved absolute path.
 */
function expandPath(p) {
  if (p.startsWith('~')) return join(homedir(), p.slice(1));
  return resolve(p);
}

/**
 * Check whether a file path falls within any blocked path defined in config.
 * @param {string} filePath - The path to check.
 * @param {object} config - The bot configuration object.
 * @returns {boolean} True if the path is blocked.
 */
function isBlocked(filePath, config) {
  const expanded = expandPath(filePath);
  const blockedPaths = config.security?.blocked_paths || [];
  return blockedPaths.some((bp) => expanded.startsWith(expandPath(bp)));
}

export const definitions = [
  {
    name: 'execute_command',
    description:
      'Execute a shell command and return its stdout and stderr. Use for running programs, scripts, git commands, package managers, etc.',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute',
        },
        timeout_seconds: {
          type: 'number',
          description: 'Max execution time in seconds (default 30)',
          default: 30,
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Read the contents of a file. Returns the text content and total line count.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute or relative file path',
        },
        max_lines: {
          type: 'number',
          description: 'Maximum number of lines to return (default: all)',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description:
      'Write content to a file. Creates parent directories if they do not exist. Overwrites existing content.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute or relative file path',
        },
        content: {
          type: 'string',
          description: 'The content to write',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_directory',
    description:
      'List files and subdirectories in a directory. Returns entries with name and type.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path',
        },
        recursive: {
          type: 'boolean',
          description: 'Whether to list recursively (default false)',
          default: false,
        },
      },
      required: ['path'],
    },
  },
];

/** Maximum recursion depth for directory listing to prevent stack overflow. */
const MAX_RECURSIVE_DEPTH = 10;

/**
 * Recursively list all files and directories under a given path.
 * @param {string} dirPath - Absolute path to the directory to list.
 * @param {string} [base=''] - Relative path prefix for nested entries.
 * @param {number} [depth=0] - Current recursion depth (internal).
 * @returns {Array<{name: string, type: string}>} Flat array of entries.
 */
function listRecursive(dirPath, base = '', depth = 0) {
  if (depth >= MAX_RECURSIVE_DEPTH) return [];
  const entries = [];
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const type = entry.isDirectory() ? 'directory' : 'file';
    entries.push({ name: rel, type });
    if (entry.isDirectory()) {
      entries.push(...listRecursive(join(dirPath, entry.name), rel, depth + 1));
    }
  }
  return entries;
}

export const handlers = {
  execute_command: async (params, context) => {
    const logger = getLogger();
    const { command, timeout_seconds = 30 } = params;
    const { config } = context;
    const blockedPaths = config.security?.blocked_paths || [];

    // Simple check: if the command references a blocked path, reject
    for (const bp of blockedPaths) {
      const expanded = expandPath(bp);
      if (command.includes(expanded)) {
        logger.warn(`execute_command blocked: command references restricted path ${bp}`);
        return { error: `Blocked: command references restricted path ${bp}` };
      }
    }

    logger.debug(`execute_command: ${command.slice(0, 120)}`);

    return new Promise((res) => {
      let abortHandler = null;

      const child = exec(
        command,
        { timeout: timeout_seconds * 1000, maxBuffer: 10 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (abortHandler && context.signal) context.signal.removeEventListener('abort', abortHandler);
          if (error && error.killed) {
            return res({ error: `Command timed out or was cancelled after ${timeout_seconds}s` });
          }
          const result = {
            stdout: stdout || '',
            stderr: stderr || '',
            exit_code: error ? error.code ?? 1 : 0,
          };

          // Send output summary to Telegram
          if (context.onUpdate) {
            const output = (result.stdout || result.stderr || '').trim();
            if (output) {
              const preview = output.length > 300 ? output.slice(0, 300) + '...' : output;
              context.onUpdate(`📋 \`${command.slice(0, 60)}\`\n\`\`\`\n${preview}\n\`\`\``).catch(() => {});
            }
          }

          res(result);
        },
      );

      // Wire abort signal to kill the child process
      if (context.signal) {
        if (context.signal.aborted) {
          child.kill('SIGTERM');
        } else {
          abortHandler = () => child.kill('SIGTERM');
          context.signal.addEventListener('abort', abortHandler, { once: true });
        }
      }
    });
  },

  read_file: async (params, context) => {
    const logger = getLogger();
    const { path: filePath, max_lines } = params;
    if (isBlocked(filePath, context.config)) {
      logger.warn(`read_file blocked: access to ${filePath} is restricted`);
      return { error: `Blocked: access to ${filePath} is restricted` };
    }

    try {
      const content = readFileSync(expandPath(filePath), 'utf-8');
      const lines = content.split('\n');
      const total_lines = lines.length;

      if (max_lines && max_lines < total_lines) {
        return { content: lines.slice(0, max_lines).join('\n'), total_lines };
      }
      return { content, total_lines };
    } catch (err) {
      return { error: err.message };
    }
  },

  write_file: async (params, context) => {
    const logger = getLogger();
    const { path: filePath, content } = params;
    if (isBlocked(filePath, context.config)) {
      logger.warn(`write_file blocked: access to ${filePath} is restricted`);
      return { error: `Blocked: access to ${filePath} is restricted` };
    }

    try {
      const expanded = expandPath(filePath);
      mkdirSync(dirname(expanded), { recursive: true });
      writeFileSync(expanded, content, 'utf-8');
      logger.debug(`write_file: wrote ${content.length} bytes to ${expanded}`);
      return { success: true, path: expanded };
    } catch (err) {
      logger.error(`write_file error for ${filePath}: ${err.message}`);
      return { error: err.message };
    }
  },

  list_directory: async (params, context) => {
    const logger = getLogger();
    const { path: dirPath, recursive = false } = params;
    if (isBlocked(dirPath, context.config)) {
      logger.warn(`list_directory blocked: access to ${dirPath} is restricted`);
      return { error: `Blocked: access to ${dirPath} is restricted` };
    }

    try {
      const expanded = expandPath(dirPath);
      if (recursive) {
        return { entries: listRecursive(expanded) };
      }

      const entries = readdirSync(expanded, { withFileTypes: true }).map(
        (entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file',
        }),
      );
      return { entries };
    } catch (err) {
      return { error: err.message };
    }
  },
};
