import { createProvider } from './providers/index.js';
import { executeTool } from './tools/index.js';
import { getMissingCredential } from './utils/config.js';
import { getWorkerPrompt } from './prompts/workers.js';
import { getUnifiedSkillById } from './skills/custom.js';
import { getLogger } from './utils/logger.js';

const MAX_RESULT_LENGTH = 3000;
const LARGE_FIELDS = ['stdout', 'stderr', 'content', 'diff', 'output', 'body', 'html', 'text', 'log', 'logs'];

/**
 * WorkerAgent — runs a scoped agent loop in the background.
 * Extracted from Agent._runLoop() with simplifications:
 * - No conversation persistence
 * - No intent detection or persona extraction
 * - No completion gate
 * - Checks cancellation before each iteration and tool execution
 * - Reports progress via callbacks
 */
export class WorkerAgent {
  /**
   * @param {object} opts
   * @param {object} opts.config - Full app config (opts.config.brain used for LLM)
   * @param {string} opts.workerType - coding, browser, system, devops, research
   * @param {string} opts.jobId - Job ID for logging
   * @param {Array} opts.tools - Scoped tool definitions
   * @param {string|null} opts.skillId - Active skill ID (for worker prompt)
   * @param {object} opts.callbacks - { onProgress, onComplete, onError }
   * @param {AbortController} opts.abortController - For cancellation
   */
  constructor({ config, workerType, jobId, tools, skillId, callbacks, abortController }) {
    this.config = config;
    this.workerType = workerType;
    this.jobId = jobId;
    this.tools = tools;
    this.skillId = skillId;
    this.callbacks = callbacks || {};
    this.abortController = abortController || new AbortController();
    this._cancelled = false;

    // Create provider from worker brain config
    this.provider = createProvider(config);

    // Build system prompt
    const skillPrompt = skillId ? getUnifiedSkillById(skillId)?.systemPrompt : null;
    this.systemPrompt = getWorkerPrompt(workerType, config, skillPrompt);

    // Max tool depth from config
    this.maxDepth = config.brain.max_tool_depth || 12;
  }

  /** Cancel this worker. */
  cancel() {
    this._cancelled = true;
    this.abortController.abort();
    getLogger().info(`Worker ${this.jobId} [${this.workerType}] cancelled`);
  }

  /** Run the worker loop with the given task. */
  async run(task) {
    const logger = getLogger();
    logger.info(`Worker ${this.jobId} [${this.workerType}] starting: ${task.slice(0, 100)}`);

    const messages = [{ role: 'user', content: task }];

    try {
      const result = await this._runLoop(messages);
      if (this._cancelled) return; // don't report if cancelled
      if (this.callbacks.onComplete) this.callbacks.onComplete(result);
    } catch (err) {
      if (this._cancelled) return;
      logger.error(`Worker ${this.jobId} error: ${err.message}`);
      if (this.callbacks.onError) this.callbacks.onError(err);
    }
  }

  async _runLoop(messages) {
    const logger = getLogger();

    for (let depth = 0; depth < this.maxDepth; depth++) {
      if (this._cancelled) throw new Error('Worker cancelled');

      logger.debug(`Worker ${this.jobId} loop iteration ${depth + 1}/${this.maxDepth}`);

      const response = await this.provider.chat({
        system: this.systemPrompt,
        messages,
        tools: this.tools,
        signal: this.abortController.signal,
      });

      if (this._cancelled) throw new Error('Worker cancelled');

      // End turn — return the text
      if (response.stopReason === 'end_turn') {
        return response.text || 'Task completed.';
      }

      // Tool use
      if (response.stopReason === 'tool_use') {
        messages.push({ role: 'assistant', content: response.rawContent });

        // Log thinking text
        if (response.text && response.text.trim()) {
          logger.debug(`Worker ${this.jobId} thinking: ${response.text.slice(0, 200)}`);
        }

        const toolResults = [];

        for (const block of response.toolCalls) {
          if (this._cancelled) throw new Error('Worker cancelled');

          const summary = this._formatToolSummary(block.name, block.input);
          logger.info(`Worker ${this.jobId} tool: ${summary}`);
          this._reportProgress(`🔧 ${summary}`);

          const result = await executeTool(block.name, block.input, {
            config: this.config,
            user: null, // workers don't have user context
            personaManager: null,
            onUpdate: this.callbacks.onUpdate || null, // Real bot onUpdate (returns message_id for coder.js smart output)
            sendPhoto: this.callbacks.sendPhoto || null,
          });

          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: this._truncateResult(block.name, result),
          });
        }

        messages.push({ role: 'user', content: toolResults });
        continue;
      }

      // Unexpected stop reason
      logger.warn(`Worker ${this.jobId} unexpected stopReason: ${response.stopReason}`);
      return response.text || 'Worker finished with unexpected response.';
    }

    return `Worker reached maximum tool depth (${this.maxDepth}). Partial results may be available.`;
  }

  _reportProgress(text) {
    if (this.callbacks.onProgress) {
      try { this.callbacks.onProgress(text); } catch {}
    }
  }

  _truncateResult(name, result) {
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

  _formatToolSummary(name, input) {
    const _short = (s, len = 80) => s && s.length > len ? s.slice(0, len) + '...' : s;
    const _host = (url) => { try { return new URL(url).hostname; } catch { return url; } };

    switch (name) {
      case 'web_search':        return `Searching: "${_short(input.query, 60)}"`;
      case 'browse_website':    return `Opening ${_host(input.url)}`;
      case 'interact_with_page': return 'Interacting with page';
      case 'extract_content':   return 'Extracting content';
      case 'screenshot_website': return `Screenshot of ${_host(input.url)}`;
      case 'execute_command':   return `Running: ${_short(input.command, 60)}`;
      case 'read_file':         return `Reading ${_short(input.path)}`;
      case 'write_file':        return `Writing ${_short(input.path)}`;
      case 'git_clone':         return `Cloning ${_short(input.repo)}`;
      case 'git_checkout':      return `Switching to ${input.branch}`;
      case 'git_commit':        return `Committing: "${_short(input.message, 50)}"`;
      case 'git_push':          return 'Pushing changes';
      case 'github_create_pr':  return `Creating PR: "${_short(input.title, 50)}"`;
      case 'spawn_claude_code': return `Coding: ${_short(input.prompt, 60)}`;
      case 'docker_exec':       return `Running in ${_short(input.container)}`;
      case 'docker_compose':    return `Docker compose ${input.action}`;
      default:                  return `${name}`;
    }
  }
}
