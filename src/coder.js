import { spawn } from 'child_process';
import { getLogger } from './utils/logger.js';

export class ClaudeCodeSpawner {
  constructor(config) {
    this.maxTurns = config.claude_code?.max_turns || 50;
    this.timeout = (config.claude_code?.timeout_seconds || 600) * 1000;
  }

  async run({ workingDirectory, prompt, maxTurns }) {
    const logger = getLogger();
    const turns = maxTurns || this.maxTurns;

    logger.info(`Spawning Claude Code in ${workingDirectory}`);

    return new Promise((resolve, reject) => {
      const args = ['-p', prompt, '--max-turns', String(turns), '--output-format', 'text'];

      const child = spawn('claude', args, {
        cwd: workingDirectory,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`Claude Code timed out after ${this.timeout / 1000}s`));
      }, this.timeout);

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 && !stdout) {
          reject(new Error(`Claude Code exited with code ${code}: ${stderr}`));
        } else {
          resolve({
            output: stdout.trim(),
            stderr: stderr.trim(),
            exitCode: code,
          });
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        if (err.code === 'ENOENT') {
          reject(new Error('Claude Code CLI not found. Install with: npm i -g @anthropic-ai/claude-code'));
        } else {
          reject(err);
        }
      });
    });
  }
}
