import { createProvider } from './providers/index.js';
import { executeTool } from './tools/index.js';
import { closeSession } from './tools/browser.js';
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
   * @param {string|null} opts.workerContext - Structured context (conversation history, persona, dependency results)
   * @param {object} opts.callbacks - { onProgress, onComplete, onError }
   * @param {AbortController} opts.abortController - For cancellation
   */
  constructor({ config, workerType, jobId, tools, skillId, workerContext, callbacks, abortController }) {
    this.config = config;
    this.workerType = workerType;
    this.jobId = jobId;
    this.tools = tools;
    this.skillId = skillId;
    this.workerContext = workerContext || null;
    this.callbacks = callbacks || {};
    this.abortController = abortController || new AbortController();
    this._cancelled = false;
    this._toolCallCount = 0;
    this._llmCallCount = 0;
    this._errors = [];

    // Create provider from worker brain config
    this.provider = createProvider(config);

    // Build system prompt
    const skillPrompt = skillId ? getUnifiedSkillById(skillId)?.systemPrompt : null;
    this.systemPrompt = getWorkerPrompt(workerType, config, skillPrompt);

    // Safety ceiling — not a real limit, just prevents infinite loops
    // The real limit is the job timeout enforced by JobManager
    this.maxIterations = 200;

    const logger = getLogger();
    logger.info(`[Worker ${jobId}] Created: type=${workerType}, provider=${config.brain.provider}/${config.brain.model}, tools=${tools.length}, skill=${skillId || 'none'}, context=${workerContext ? 'yes' : 'none'}`);
  }

  /** Cancel this worker. */
  cancel() {
    this._cancelled = true;
    this.abortController.abort();
    getLogger().info(`[Worker ${this.jobId}] Cancel signal sent — aborting ${this.workerType} worker`);
  }

  /** Run the worker loop with the given task. */
  async run(task) {
    const logger = getLogger();
    logger.info(`[Worker ${this.jobId}] Starting task: "${task.slice(0, 150)}"`);

    // Build first message: context sections + task
    let firstMessage = '';
    if (this.workerContext) {
      firstMessage += this.workerContext + '\n\n---\n\n';
    }
    firstMessage += task;

    const messages = [{ role: 'user', content: firstMessage }];

    try {
      const result = await this._runLoop(messages);
      if (this._cancelled) {
        logger.info(`[Worker ${this.jobId}] Run completed but worker was cancelled — skipping callbacks`);
        return;
      }
      const parsed = this._parseResult(result);
      logger.info(`[Worker ${this.jobId}] Run finished successfully — structured=${!!parsed.structured}, result: "${(result || '').slice(0, 150)}"`);
      if (this.callbacks.onComplete) this.callbacks.onComplete(result, parsed);
    } catch (err) {
      if (this._cancelled) {
        logger.info(`[Worker ${this.jobId}] Run threw error but worker was cancelled — ignoring: ${err.message}`);
        return;
      }
      logger.error(`[Worker ${this.jobId}] Run failed: ${err.message}`);
      if (this.callbacks.onError) this.callbacks.onError(err);
    } finally {
      // Clean up browser session for this worker (frees the Puppeteer page)
      closeSession(this.jobId).catch(() => {});
      logger.info(`[Worker ${this.jobId}] Browser session cleaned up`);
    }
  }

  async _runLoop(messages) {
    const logger = getLogger();
    let consecutiveAllFailIterations = 0; // Track iterations where ALL tool calls fail

    for (let depth = 0; depth < this.maxIterations; depth++) {
      if (this._cancelled) {
        logger.info(`[Worker ${this.jobId}] Cancelled before iteration ${depth + 1}`);
        throw new Error('Worker cancelled');
      }

      logger.info(`[Worker ${this.jobId}] LLM call ${depth + 1} — sending ${messages.length} messages`);

      const response = await this.provider.chat({
        system: this.systemPrompt,
        messages,
        tools: this.tools,
        signal: this.abortController.signal,
      });

      this._llmCallCount++;
      logger.info(`[Worker ${this.jobId}] LLM response: stopReason=${response.stopReason}, text=${(response.text || '').length} chars, toolCalls=${(response.toolCalls || []).length}`);

      // Report stats to the job after each LLM call
      this._reportStats(response.text || null);

      if (this._cancelled) {
        logger.info(`[Worker ${this.jobId}] Cancelled after LLM response`);
        throw new Error('Worker cancelled');
      }

      // End turn — return the text
      if (response.stopReason === 'end_turn') {
        logger.info(`[Worker ${this.jobId}] End turn — final response: "${(response.text || '').slice(0, 200)}"`);
        return response.text || 'Task completed.';
      }

      // Tool use
      if (response.stopReason === 'tool_use') {
        messages.push({ role: 'assistant', content: response.rawContent });

        // Log thinking text
        if (response.text && response.text.trim()) {
          logger.info(`[Worker ${this.jobId}] Thinking: "${response.text.slice(0, 200)}"`);
        }

        const toolResults = [];

        for (const block of response.toolCalls) {
          if (this._cancelled) {
            logger.info(`[Worker ${this.jobId}] Cancelled before executing tool ${block.name}`);
            throw new Error('Worker cancelled');
          }

          const summary = this._formatToolSummary(block.name, block.input);
          logger.info(`[Worker ${this.jobId}] Executing tool: ${block.name} — ${summary}`);
          logger.debug(`[Worker ${this.jobId}] Tool input: ${JSON.stringify(block.input).slice(0, 300)}`);
          this._reportProgress(`🔧 ${summary}`);

          this._toolCallCount++;

          const result = await executeTool(block.name, block.input, {
            config: this.config,
            user: null, // workers don't have user context
            personaManager: null,
            onUpdate: this.callbacks.onUpdate || null, // Real bot onUpdate (returns message_id for coder.js smart output)
            sendPhoto: this.callbacks.sendPhoto || null,
            sessionId: this.jobId, // Per-worker browser session isolation
            signal: this.abortController.signal, // For killing child processes on cancellation
          });

          // Track errors
          if (result && typeof result === 'object' && result.error) {
            this._errors.push({ tool: block.name, error: result.error });
          }

          const resultStr = this._truncateResult(block.name, result);
          logger.info(`[Worker ${this.jobId}] Tool ${block.name} result: ${resultStr.slice(0, 200)}`);

          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: resultStr,
          });
        }

        // Track consecutive all-fail iterations (circuit breaker)
        const allFailed = toolResults.every(tr => {
          try { const parsed = JSON.parse(tr.content); return !!parsed.error; } catch { return false; }
        });
        if (allFailed) {
          consecutiveAllFailIterations++;
          logger.warn(`[Worker ${this.jobId}] All ${toolResults.length} tool calls failed (streak: ${consecutiveAllFailIterations})`);
          if (consecutiveAllFailIterations >= 3) {
            logger.warn(`[Worker ${this.jobId}] Circuit breaker: 3 consecutive all-fail iterations — forcing stop`);
            messages.push({ role: 'user', content: toolResults });
            messages.push({
              role: 'user',
              content: 'STOP: All your tool calls have failed 3 times in a row. Do NOT call any more tools. Summarize whatever you have found so far, or explain what went wrong.',
            });
            const bailResponse = await this.provider.chat({
              system: this.systemPrompt,
              messages,
              tools: [], // No tools — force text response
              signal: this.abortController.signal,
            });
            return bailResponse.text || 'All tool calls failed repeatedly. Could not complete the task.';
          }
        } else {
          consecutiveAllFailIterations = 0;
        }

        messages.push({ role: 'user', content: toolResults });
        continue;
      }

      // Unexpected stop reason
      logger.warn(`[Worker ${this.jobId}] Unexpected stopReason: ${response.stopReason}`);
      return response.text || 'Worker finished with unexpected response.';
    }

    // Safety ceiling hit (should basically never happen — job timeout is the real limit)
    logger.warn(`[Worker ${this.jobId}] Hit safety ceiling (${this.maxIterations} iterations) — requesting final summary`);
    this._reportProgress(`⏳ Summarizing results...`);

    try {
      messages.push({
        role: 'user',
        content: 'You have reached the iteration limit. Summarize everything you have found and accomplished so far. Return a complete, detailed summary of all results, data, and findings.',
      });

      const summaryResponse = await this.provider.chat({
        system: this.systemPrompt,
        messages,
        tools: [], // No tools — force text-only response
        signal: this.abortController.signal,
      });

      const summary = summaryResponse.text || '';
      logger.info(`[Worker ${this.jobId}] Final summary: "${summary.slice(0, 200)}"`);

      if (summary.length > 10) {
        return summary;
      }
    } catch (err) {
      logger.warn(`[Worker ${this.jobId}] Summary call failed: ${err.message}`);
    }

    // Fallback: extract any text the LLM produced during the loop
    const lastAssistantText = this._extractLastAssistantText(messages);
    if (lastAssistantText) {
      logger.info(`[Worker ${this.jobId}] Falling back to last assistant text: "${lastAssistantText.slice(0, 200)}"`);
      return lastAssistantText;
    }

    return 'Worker finished but could not produce a final summary.';
  }

  /** Extract the last meaningful assistant text from message history. */
  _extractLastAssistantText(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== 'assistant') continue;

      if (typeof msg.content === 'string' && msg.content.trim()) {
        return msg.content.trim();
      }
      if (Array.isArray(msg.content)) {
        const texts = msg.content
          .filter(b => b.type === 'text' && b.text?.trim())
          .map(b => b.text.trim());
        if (texts.length > 0) return texts.join('\n');
      }
    }
    return null;
  }

  /**
   * Parse the worker's final text into a structured WorkerResult.
   * Attempts JSON parse from ```json fences, falls back to wrapping raw text.
   */
  _parseResult(text) {
    if (!text) {
      return {
        structured: false,
        summary: 'Task completed.',
        status: 'success',
        details: '',
        artifacts: [],
        followUp: null,
        toolsUsed: this._toolCallCount,
        errors: this._errors,
      };
    }

    const _str = (v) => typeof v === 'string' ? v : (v ? JSON.stringify(v, null, 2) : '');

    // Try to extract JSON from ```json ... ``` fences
    const fenceMatch = text.match(/```json\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) {
      try {
        const parsed = JSON.parse(fenceMatch[1]);
        if (parsed.summary && parsed.status) {
          return {
            structured: true,
            summary: String(parsed.summary || ''),
            status: String(parsed.status || 'success'),
            details: _str(parsed.details),
            artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
            followUp: parsed.followUp ? String(parsed.followUp) : null,
            toolsUsed: this._toolCallCount,
            errors: this._errors,
          };
        }
      } catch { /* fall through */ }
    }

    // Try raw JSON parse (no fences)
    try {
      const parsed = JSON.parse(text);
      if (parsed.summary && parsed.status) {
        return {
          structured: true,
          summary: String(parsed.summary || ''),
          status: String(parsed.status || 'success'),
          details: _str(parsed.details),
          artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
          followUp: parsed.followUp ? String(parsed.followUp) : null,
          toolsUsed: this._toolCallCount,
          errors: this._errors,
        };
      }
    } catch { /* fall through */ }

    // Fallback: wrap raw text
    return {
      structured: false,
      summary: text.slice(0, 200),
      status: 'success',
      details: text,
      artifacts: [],
      followUp: null,
      toolsUsed: this._toolCallCount,
      errors: this._errors,
    };
  }

  _reportProgress(text) {
    if (this.callbacks.onProgress) {
      try { this.callbacks.onProgress(text); } catch {}
    }
    if (this.callbacks.onHeartbeat) {
      try { this.callbacks.onHeartbeat(text); } catch {}
    }
  }

  _reportStats(thinking) {
    if (this.callbacks.onStats) {
      try {
        this.callbacks.onStats({
          llmCalls: this._llmCallCount,
          toolCalls: this._toolCallCount,
          lastThinking: thinking || null,
        });
      } catch {}
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
