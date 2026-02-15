import { spawn } from 'child_process';
import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getLogger } from './utils/logger.js';

function ensureClaudeCodeSetup() {
  const logger = getLogger();
  const claudeJson = join(homedir(), '.claude.json');
  const claudeDir = join(homedir(), '.claude');

  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
    logger.info('Created ~/.claude/ directory');
  }

  if (!existsSync(claudeJson)) {
    const defaults = {
      hasCompletedOnboarding: true,
      theme: 'dark',
      shiftEnterKeyBindingInstalled: true,
    };
    writeFileSync(claudeJson, JSON.stringify(defaults, null, 2));
    logger.info('Created ~/.claude.json with default settings (skipping setup wizard)');
  }
}

function extractText(event) {
  // Try to find text in various possible event structures
  // Format 1: { type: "message", role: "assistant", content: [{ type: "text", text: "..." }] }
  // Format 2: { type: "assistant", message: { content: [{ type: "text", text: "..." }] } }
  // Format 3: { type: "assistant", content: [{ type: "text", text: "..." }] }

  const contentSources = [
    event.content,
    event.message?.content,
  ];

  for (const content of contentSources) {
    if (Array.isArray(content)) {
      const texts = content
        .filter((b) => b.type === 'text' && b.text?.trim())
        .map((b) => b.text.trim());
      if (texts.length > 0) return texts.join('\n');
    }
  }

  // Direct text field
  if (event.text?.trim()) return event.text.trim();
  if (event.result?.trim()) return event.result.trim();

  return null;
}

function extractToolUse(event) {
  // Format 1: { type: "tool_use", name: "Bash", input: { command: "..." } }
  // Format 2: content block with type tool_use
  if (event.name && event.input) {
    const input = event.input;
    const summary = input.command || input.file_path || input.pattern || input.query || input.content?.slice(0, 80) || JSON.stringify(input).slice(0, 100);
    return { name: event.name, summary: String(summary).slice(0, 150) };
  }

  // Check inside content array
  const content = event.content || event.message?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'tool_use' && block.name) {
        const input = block.input || {};
        const summary = input.command || input.file_path || input.pattern || input.query || JSON.stringify(input).slice(0, 100);
        return { name: block.name, summary: String(summary).slice(0, 150) };
      }
    }
  }

  return null;
}

function processEvent(line, onOutput, logger) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    // Not JSON — send raw text if it looks meaningful
    if (line.trim() && line.length > 3 && onOutput) {
      logger.info(`Claude Code (raw): ${line.slice(0, 200)}`);
      onOutput(`▹ ${line.trim()}`).catch(() => {});
    }
    return null;
  }

  const type = event.type || '';

  // Assistant thinking/text
  if (type === 'message' || type === 'assistant') {
    const text = extractText(event);
    if (text) {
      logger.info(`Claude Code: ${text.slice(0, 200)}`);
      if (onOutput) onOutput(`💬 *Claude Code:*\n${text}`).catch(() => {});
    }

    // Also check for tool_use inside the same message
    const tool = extractToolUse(event);
    if (tool) {
      logger.info(`Claude Code tool: ${tool.name}: ${tool.summary}`);
      if (onOutput) onOutput(`▸ ${tool.name}: ${tool.summary}`).catch(() => {});
    }
    return event;
  }

  // Standalone tool use event
  if (type === 'tool_use') {
    const tool = extractToolUse(event);
    if (tool) {
      logger.info(`Claude Code tool: ${tool.name}: ${tool.summary}`);
      if (onOutput) onOutput(`▸ ${tool.name}: ${tool.summary}`).catch(() => {});
    }
    return event;
  }

  // Result / completion
  if (type === 'result') {
    const status = event.status || event.subtype || 'done';
    const duration = event.duration_ms ? ` in ${(event.duration_ms / 1000).toFixed(1)}s` : '';
    const cost = event.cost_usd ? ` ($${event.cost_usd.toFixed(3)})` : '';
    logger.info(`Claude Code finished: ${status}${duration}${cost}`);
    if (onOutput) onOutput(`▪ done (${status}${duration}${cost})`).catch(() => {});
    return event;
  }

  // Log any other event type for debugging
  logger.debug(`Claude Code event [${type}]: ${JSON.stringify(event).slice(0, 300)}`);
  return event;
}

export class ClaudeCodeSpawner {
  constructor(config) {
    this.maxTurns = config.claude_code?.max_turns || 50;
    this.timeout = (config.claude_code?.timeout_seconds || 600) * 1000;
    this.model = config.claude_code?.model || null;
  }

  async run({ workingDirectory, prompt, maxTurns, onOutput }) {
    const logger = getLogger();
    const turns = maxTurns || this.maxTurns;

    ensureClaudeCodeSetup();

    const args = [
      '-p', prompt,
      '--max-turns', String(turns),
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
    ];
    if (this.model) {
      args.push('--model', this.model);
    }

    const cmd = `claude ${args.map((a) => a.includes(' ') ? `"${a}"` : a).join(' ')}`;
    logger.info(`Spawning: ${cmd.slice(0, 300)}`);
    logger.info(`CWD: ${workingDirectory}`);

    // --- Smart output: consolidate tool activity into one editable message ---
    let statusMsgId = null;
    let activityLines = [];
    let flushTimer = null;
    const MAX_VISIBLE = 15;

    const buildStatusText = (finalState = null) => {
      const visible = activityLines.slice(-MAX_VISIBLE);
      const countInfo = activityLines.length > MAX_VISIBLE
        ? `\n_... ${activityLines.length} operations total_\n`
        : '';
      if (finalState === 'done') {
        return `░▒▓ *Claude Code Done* — ${activityLines.length} ops\n${countInfo}\n${visible.join('\n')}`;
      }
      if (finalState === 'error') {
        return `░▒▓ *Claude Code Failed* — ${activityLines.length} ops\n${countInfo}\n${visible.join('\n')}`;
      }
      return `░▒▓ *Claude Code Working...*\n${countInfo}\n${visible.join('\n')}`;
    };

    const flushStatus = async () => {
      flushTimer = null;
      if (!onOutput || activityLines.length === 0) return;
      try {
        if (statusMsgId) {
          await onOutput(buildStatusText(), { editMessageId: statusMsgId });
        } else {
          statusMsgId = await onOutput(buildStatusText());
        }
      } catch {}
    };

    const addActivity = (line) => {
      activityLines.push(line);
      if (!statusMsgId && !flushTimer) {
        // First activity — create the status message immediately
        flushStatus();
      } else if (!flushTimer) {
        // Throttle subsequent edits to avoid Telegram rate limits
        flushTimer = setTimeout(flushStatus, 1000);
      }
    };

    const smartOutput = onOutput ? async (text) => {
      // Tool calls, raw output, warnings, starting → accumulate in status message
      if (text.startsWith('▸') || text.startsWith('▹') || text.startsWith('▪')) {
        addActivity(text);
        return;
      }
      // Everything else (💬 text, errors, timeout) → new message
      await onOutput(text);
    } : null;

    if (smartOutput) smartOutput(`▸ Starting Claude Code...`).catch(() => {});

    return new Promise((resolve, reject) => {
      const child = spawn('claude', args, {
        cwd: workingDirectory,
        env: { ...process.env, IS_SANDBOX: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let fullOutput = '';
      let stderr = '';
      let buffer = '';
      let resultText = '';

      child.stdout.on('data', (data) => {
        buffer += data.toString();

        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          fullOutput += trimmed + '\n';

          try {
            const event = JSON.parse(trimmed);
            if (event.type === 'result') {
              resultText = event.result || resultText;
            }
          } catch {}

          processEvent(trimmed, smartOutput, logger);
        }
      });

      child.stderr.on('data', (data) => {
        const chunk = data.toString().trim();
        stderr += chunk + '\n';
        logger.warn(`Claude Code stderr: ${chunk.slice(0, 300)}`);
        if (smartOutput && chunk) {
          smartOutput(`▹ ${chunk.slice(0, 300)}`).catch(() => {});
        }
      });

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        if (smartOutput) smartOutput(`▸ Claude Code timed out after ${this.timeout / 1000}s`).catch(() => {});
        reject(new Error(`Claude Code timed out after ${this.timeout / 1000}s`));
      }, this.timeout);

      child.on('close', async (code) => {
        clearTimeout(timer);

        if (buffer.trim()) {
          fullOutput += buffer.trim();
          try {
            const event = JSON.parse(buffer.trim());
            if (event.type === 'result') {
              resultText = event.result || resultText;
            }
          } catch {}
          processEvent(buffer.trim(), smartOutput, logger);
        }

        // Flush any pending status edits
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        await flushStatus();

        // Final status message update — show done/failed state
        if (statusMsgId && onOutput) {
          const finalState = code === 0 ? 'done' : 'error';
          try {
            await onOutput(buildStatusText(finalState), { editMessageId: statusMsgId });
          } catch {}
        }

        logger.info(`Claude Code exited with code ${code} | stdout: ${fullOutput.length} chars | stderr: ${stderr.length} chars`);

        if (code !== 0) {
          const errMsg = stderr.trim() || fullOutput.trim() || `exited with code ${code}`;
          logger.error(`Claude Code failed: ${errMsg.slice(0, 500)}`);
          reject(new Error(`Claude Code exited with code ${code}: ${errMsg.slice(0, 500)}`));
        } else {
          resolve({
            output: resultText || fullOutput.trim(),
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
