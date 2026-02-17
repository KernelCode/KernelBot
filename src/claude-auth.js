import { spawn } from 'child_process';
import { getLogger } from './utils/logger.js';

/**
 * Run `claude auth status` and return parsed output.
 */
export function getClaudeAuthStatus() {
  const logger = getLogger();
  return new Promise((resolve) => {
    const child = spawn('claude', ['auth', 'status'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (code) => {
      const output = (stdout || stderr).trim();
      logger.debug(`claude auth status (code ${code}): ${output.slice(0, 300)}`);
      resolve({ code, output });
    });

    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        resolve({ code: -1, output: 'Claude Code CLI not found. Install with: npm i -g @anthropic-ai/claude-code' });
      } else {
        resolve({ code: -1, output: err.message });
      }
    });

    // Timeout after 10s
    setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ code: -1, output: 'Timed out checking auth status' });
    }, 10_000);
  });
}

/**
 * Run `claude auth logout`.
 */
export function claudeLogout() {
  const logger = getLogger();
  return new Promise((resolve) => {
    const child = spawn('claude', ['auth', 'logout'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (code) => {
      const output = (stdout || stderr).trim();
      logger.info(`claude auth logout (code ${code}): ${output.slice(0, 300)}`);
      resolve({ code, output });
    });

    child.on('error', (err) => {
      resolve({ code: -1, output: err.message });
    });

    setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ code: -1, output: 'Timed out during logout' });
    }, 10_000);
  });
}

/**
 * Return the current Claude Code auth mode from config.
 */
export function getClaudeCodeAuthMode(config) {
  const mode = config.claude_code?.auth_mode || 'system';
  const info = { mode };

  if (mode === 'api_key') {
    const key = config.claude_code?.api_key || process.env.CLAUDE_CODE_API_KEY || '';
    info.credential = key ? `${key.slice(0, 8)}...${key.slice(-4)}` : '(not set)';
  } else if (mode === 'oauth_token') {
    const token = config.claude_code?.oauth_token || process.env.CLAUDE_CODE_OAUTH_TOKEN || '';
    info.credential = token ? `${token.slice(0, 8)}...${token.slice(-4)}` : '(not set)';
  } else {
    info.credential = 'Using host system login';
  }

  return info;
}
