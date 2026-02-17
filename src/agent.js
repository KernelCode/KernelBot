import { createProvider, PROVIDERS } from './providers/index.js';
import { orchestratorToolDefinitions, executeOrchestratorTool } from './tools/orchestrator-tools.js';
import { getToolsForWorker } from './swarm/worker-registry.js';
import { WORKER_TYPES } from './swarm/worker-registry.js';
import { getOrchestratorPrompt } from './prompts/orchestrator.js';
import { getWorkerPrompt } from './prompts/workers.js';
import { getUnifiedSkillById } from './skills/custom.js';
import { WorkerAgent } from './worker.js';
import { getLogger } from './utils/logger.js';
import { getMissingCredential, saveCredential, saveProviderToYaml } from './utils/config.js';

const MAX_RESULT_LENGTH = 3000;
const LARGE_FIELDS = ['stdout', 'stderr', 'content', 'diff', 'output', 'body', 'html', 'text', 'log', 'logs'];

export class OrchestratorAgent {
  constructor({ config, conversationManager, personaManager, selfManager, jobManager, automationManager }) {
    this.config = config;
    this.conversationManager = conversationManager;
    this.personaManager = personaManager;
    this.selfManager = selfManager || null;
    this.jobManager = jobManager;
    this.automationManager = automationManager || null;
    this._pending = new Map(); // chatId -> pending state
    this._chatCallbacks = new Map(); // chatId -> { onUpdate, sendPhoto }

    // Orchestrator always uses Anthropic (30s timeout — lean dispatch/summarize calls)
    this.orchestratorProvider = createProvider({
      brain: {
        provider: 'anthropic',
        model: config.orchestrator.model,
        max_tokens: config.orchestrator.max_tokens,
        temperature: config.orchestrator.temperature,
        api_key: config.orchestrator.api_key || process.env.ANTHROPIC_API_KEY,
        timeout: 30_000,
      },
    });

    // Worker provider uses user's chosen brain
    this.workerProvider = createProvider(config);

    // Set up job lifecycle event listeners
    this._setupJobListeners();
  }

  /** Build the orchestrator system prompt. */
  _getSystemPrompt(chatId, user) {
    const logger = getLogger();
    const skillId = this.conversationManager.getSkill(chatId);
    const skillPrompt = skillId ? getUnifiedSkillById(skillId)?.systemPrompt : null;

    let userPersona = null;
    if (this.personaManager && user?.id) {
      userPersona = this.personaManager.load(user.id, user.username);
    }

    let selfData = null;
    if (this.selfManager) {
      selfData = this.selfManager.loadAll();
    }

    logger.debug(`Orchestrator building system prompt for chat ${chatId} | skill=${skillId || 'none'} | persona=${userPersona ? 'yes' : 'none'} | self=${selfData ? 'yes' : 'none'}`);
    return getOrchestratorPrompt(this.config, skillPrompt || null, userPersona, selfData);
  }

  setSkill(chatId, skillId) {
    this.conversationManager.setSkill(chatId, skillId);
  }

  clearSkill(chatId) {
    this.conversationManager.clearSkill(chatId);
  }

  getActiveSkill(chatId) {
    const skillId = this.conversationManager.getSkill(chatId);
    return skillId ? getUnifiedSkillById(skillId) : null;
  }

  /** Return current worker brain info for display. */
  getBrainInfo() {
    const { provider, model } = this.config.brain;
    const providerDef = PROVIDERS[provider];
    const providerName = providerDef ? providerDef.name : provider;
    const modelEntry = providerDef?.models.find((m) => m.id === model);
    const modelLabel = modelEntry ? modelEntry.label : model;
    return { provider, providerName, model, modelLabel };
  }

  /** Switch worker brain provider/model at runtime. */
  async switchBrain(providerKey, modelId) {
    const logger = getLogger();
    const providerDef = PROVIDERS[providerKey];
    if (!providerDef) return `Unknown provider: ${providerKey}`;

    const envKey = providerDef.envKey;
    const apiKey = process.env[envKey];
    if (!apiKey) return envKey;

    try {
      const testConfig = { ...this.config, brain: { ...this.config.brain, provider: providerKey, model: modelId, api_key: apiKey } };
      const testProvider = createProvider(testConfig);
      await testProvider.ping();

      this.config.brain.provider = providerKey;
      this.config.brain.model = modelId;
      this.config.brain.api_key = apiKey;
      this.workerProvider = testProvider;
      saveProviderToYaml(providerKey, modelId);

      logger.info(`Worker brain switched to ${providerDef.name} / ${modelId}`);
      return null;
    } catch (err) {
      logger.error(`Brain switch failed for ${providerDef.name} / ${modelId}: ${err.message}`);
      return { error: err.message };
    }
  }

  /** Finalize brain switch after API key was provided via chat. */
  async switchBrainWithKey(providerKey, modelId, apiKey) {
    const logger = getLogger();
    const providerDef = PROVIDERS[providerKey];

    try {
      const testConfig = { ...this.config, brain: { ...this.config.brain, provider: providerKey, model: modelId, api_key: apiKey } };
      const testProvider = createProvider(testConfig);
      await testProvider.ping();

      saveCredential(this.config, providerDef.envKey, apiKey);
      this.config.brain.provider = providerKey;
      this.config.brain.model = modelId;
      this.config.brain.api_key = apiKey;
      this.workerProvider = testProvider;
      saveProviderToYaml(providerKey, modelId);

      logger.info(`Worker brain switched to ${providerDef.name} / ${modelId} (new key saved)`);
      return null;
    } catch (err) {
      logger.error(`Brain switch failed for ${providerDef.name} / ${modelId}: ${err.message}`);
      return { error: err.message };
    }
  }

  /** Truncate a tool result. */
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

  async processMessage(chatId, userMessage, user, onUpdate, sendPhoto) {
    const logger = getLogger();

    logger.info(`Orchestrator processing message for chat ${chatId} from ${user?.username || user?.id || 'unknown'}: "${userMessage.slice(0, 120)}"`);

    // Store callbacks so workers can use them later
    this._chatCallbacks.set(chatId, { onUpdate, sendPhoto });

    // Handle pending responses (confirmation or credential)
    const pending = this._pending.get(chatId);
    if (pending) {
      this._pending.delete(chatId);
      logger.debug(`Orchestrator handling pending ${pending.type} response for chat ${chatId}`);

      if (pending.type === 'credential') {
        return await this._handleCredentialResponse(chatId, userMessage, user, pending, onUpdate);
      }
    }

    const { max_tool_depth } = this.config.orchestrator;

    // Add user message to persistent history
    this.conversationManager.addMessage(chatId, 'user', userMessage);

    // Build working messages from compressed history
    const messages = [...this.conversationManager.getSummarizedHistory(chatId)];
    logger.debug(`Orchestrator conversation context: ${messages.length} messages, max_depth=${max_tool_depth}`);

    const reply = await this._runLoop(chatId, messages, user, 0, max_tool_depth);

    logger.info(`Orchestrator reply for chat ${chatId}: "${(reply || '').slice(0, 150)}"`);

    // Background persona extraction + self-reflection
    this._extractPersonaBackground(userMessage, reply, user).catch(() => {});
    this._reflectOnSelfBackground(userMessage, reply, user).catch(() => {});

    return reply;
  }

  async _sendUpdate(chatId, text, opts) {
    const callbacks = this._chatCallbacks.get(chatId);
    if (callbacks?.onUpdate) {
      try { return await callbacks.onUpdate(text, opts); } catch {}
    }
    return null;
  }

  async _handleCredentialResponse(chatId, userMessage, user, pending, onUpdate) {
    const logger = getLogger();
    const value = userMessage.trim();

    if (value.toLowerCase() === 'skip' || value.toLowerCase() === 'cancel') {
      logger.info(`User skipped credential: ${pending.credential.envKey}`);
      return 'Credential skipped. You can provide it later.';
    }

    saveCredential(this.config, pending.credential.envKey, value);
    logger.info(`Saved credential: ${pending.credential.envKey}`);
    return `Saved ${pending.credential.label}. You can now try the task again.`;
  }

  /** Set up listeners for job lifecycle events. */
  _setupJobListeners() {
    const logger = getLogger();

    this.jobManager.on('job:completed', async (job) => {
      const chatId = job.chatId;
      const workerDef = WORKER_TYPES[job.workerType] || {};
      const label = workerDef.label || job.workerType;

      logger.info(`[Orchestrator] Job completed event: ${job.id} [${job.workerType}] in chat ${chatId} (${job.duration}s) — result length: ${(job.result || '').length} chars`);

      // 1. Store raw result in conversation history so orchestrator has full context
      let resultText = job.result || 'Done.';
      if (resultText.length > 3000) {
        resultText = resultText.slice(0, 3000) + '\n\n... [result truncated]';
      }
      this.conversationManager.addMessage(chatId, 'user', `[Worker result: ${label} (${job.id}, ${job.duration}s)]\n\n${resultText}`);

      // 2. IMMEDIATELY notify user (guarantees they see something regardless of summary LLM)
      const notifyMsgId = await this._sendUpdate(chatId, `✅ ${label} finished! Preparing summary...`);

      // 3. Try to summarize (provider timeout protects against hangs)
      try {
        const summary = await this._summarizeJobResult(chatId, job);
        if (summary) {
          this.conversationManager.addMessage(chatId, 'assistant', summary);
          await this._sendUpdate(chatId, summary, { editMessageId: notifyMsgId });
        }
      } catch (err) {
        logger.error(`[Orchestrator] Failed to summarize job ${job.id}: ${err.message}`);
        await this._sendUpdate(chatId, `✅ ${label} finished (\`${job.id}\`, ${job.duration}s)! Ask me for the details.`, { editMessageId: notifyMsgId }).catch(() => {});
      }
    });

    this.jobManager.on('job:failed', (job) => {
      const chatId = job.chatId;
      const workerDef = WORKER_TYPES[job.workerType] || {};
      const label = workerDef.label || job.workerType;

      logger.error(`[Orchestrator] Job failed event: ${job.id} [${job.workerType}] in chat ${chatId} — ${job.error}`);

      const msg = `❌ **${label} failed** (\`${job.id}\`): ${job.error}`;
      this.conversationManager.addMessage(chatId, 'assistant', msg);
      this._sendUpdate(chatId, msg);
    });

    this.jobManager.on('job:cancelled', (job) => {
      const chatId = job.chatId;
      const workerDef = WORKER_TYPES[job.workerType] || {};
      const label = workerDef.label || job.workerType;

      logger.info(`[Orchestrator] Job cancelled event: ${job.id} [${job.workerType}] in chat ${chatId}`);

      const msg = `🚫 **${label} cancelled** (\`${job.id}\`)`;
      this._sendUpdate(chatId, msg);
    });
  }

  /**
   * Auto-summarize a completed job result via the orchestrator LLM.
   * The orchestrator reads the worker's raw result and presents a clean summary.
   * Protected by the provider's built-in timeout (30s) — no manual Promise.race needed.
   * Returns the summary text, or null. Caller handles delivery.
   */
  async _summarizeJobResult(chatId, job) {
    const logger = getLogger();
    const workerDef = WORKER_TYPES[job.workerType] || {};
    const label = workerDef.label || job.workerType;

    logger.info(`[Orchestrator] Summarizing job ${job.id} [${job.workerType}] result for user`);

    const history = this.conversationManager.getSummarizedHistory(chatId);

    const response = await this.orchestratorProvider.chat({
      system: this._getSystemPrompt(chatId, null),
      messages: [
        ...history,
        {
          role: 'user',
          content: `The ${label} worker just finished job \`${job.id}\` (took ${job.duration}s). Present the results to the user in a clean, well-formatted way. Don't mention "worker" or technical job details — just present the findings naturally as if you did the work yourself.`,
        },
      ],
    });

    const summary = response.text || '';
    logger.info(`[Orchestrator] Job ${job.id} summary: "${summary.slice(0, 200)}"`);

    return summary || null;
  }

  /**
   * Spawn a worker for a job — called from dispatch_task handler.
   * Creates smart progress reporting via editable Telegram message.
   */
  async _spawnWorker(job) {
    const logger = getLogger();
    const chatId = job.chatId;
    const callbacks = this._chatCallbacks.get(chatId) || {};
    const onUpdate = callbacks.onUpdate;
    const sendPhoto = callbacks.sendPhoto;

    logger.info(`[Orchestrator] Spawning worker for job ${job.id} [${job.workerType}] in chat ${chatId} — task: "${job.task.slice(0, 120)}"`);

    const workerDef = WORKER_TYPES[job.workerType] || {};
    const abortController = new AbortController();

    // Smart progress: editable Telegram message (same pattern as coder.js)
    let statusMsgId = null;
    let activityLines = [];
    let flushTimer = null;
    const MAX_VISIBLE = 10;

    const buildStatusText = (finalState = null) => {
      const visible = activityLines.slice(-MAX_VISIBLE);
      const countInfo = activityLines.length > MAX_VISIBLE
        ? `\n_... ${activityLines.length} operations total_\n`
        : '';
      const header = `${workerDef.emoji || '⚙️'} *${workerDef.label || job.workerType}* (\`${job.id}\`)`;
      if (finalState === 'done') return `${header} — Done\n${countInfo}\n${visible.join('\n')}`;
      if (finalState === 'error') return `${header} — Failed\n${countInfo}\n${visible.join('\n')}`;
      if (finalState === 'cancelled') return `${header} — Cancelled\n${countInfo}\n${visible.join('\n')}`;
      return `${header} — Working...\n${countInfo}\n${visible.join('\n')}`;
    };

    const flushStatus = async () => {
      flushTimer = null;
      if (!onUpdate || activityLines.length === 0) return;
      try {
        if (statusMsgId) {
          await onUpdate(buildStatusText(), { editMessageId: statusMsgId });
        } else {
          statusMsgId = await onUpdate(buildStatusText());
          job.statusMessageId = statusMsgId;
        }
      } catch {}
    };

    const addActivity = (line) => {
      activityLines.push(line);
      if (!statusMsgId && !flushTimer) {
        flushStatus();
      } else if (!flushTimer) {
        flushTimer = setTimeout(flushStatus, 1000);
      }
    };

    // Get scoped tools and skill
    const tools = getToolsForWorker(job.workerType);
    const skillId = this.conversationManager.getSkill(chatId);
    logger.debug(`[Orchestrator] Worker ${job.id} config: ${tools.length} tools, skill=${skillId || 'none'}, brain=${this.config.brain.provider}/${this.config.brain.model}`);

    const worker = new WorkerAgent({
      config: this.config,
      workerType: job.workerType,
      jobId: job.id,
      tools,
      skillId,
      callbacks: {
        onProgress: (text) => addActivity(text),
        onHeartbeat: (text) => job.addProgress(text),
        onUpdate, // Real bot onUpdate for tools (coder.js smart output needs message_id)
        onComplete: (result) => {
          logger.info(`[Worker ${job.id}] Completed — result: "${(result || '').slice(0, 150)}"`);
          // Final status message update
          if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
          if (statusMsgId && onUpdate) {
            onUpdate(buildStatusText('done'), { editMessageId: statusMsgId }).catch(() => {});
          }
          this.jobManager.completeJob(job.id, result);
        },
        onError: (err) => {
          logger.error(`[Worker ${job.id}] Error — ${err.message || String(err)}`);
          if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
          if (statusMsgId && onUpdate) {
            onUpdate(buildStatusText('error'), { editMessageId: statusMsgId }).catch(() => {});
          }
          this.jobManager.failJob(job.id, err.message || String(err));
        },
        sendPhoto,
      },
      abortController,
    });

    // Store worker ref on job for cancellation
    job.worker = worker;

    // Start the job
    this.jobManager.startJob(job.id);

    // Fire and forget — return the promise so .catch() in orchestrator-tools works
    return worker.run(job.task);
  }

  /**
   * Build a compact worker activity digest for the orchestrator.
   * Returns a text block summarizing active/recent workers, or null if nothing relevant.
   */
  _buildWorkerDigest(chatId) {
    const jobs = this.jobManager.getJobsForChat(chatId);
    if (jobs.length === 0) return null;

    const now = Date.now();
    const lines = [];

    // Running jobs
    const running = jobs.filter(j => j.status === 'running');
    for (const job of running) {
      const workerDef = WORKER_TYPES[job.workerType] || {};
      const dur = job.startedAt ? Math.round((now - job.startedAt) / 1000) : 0;
      const recentActivity = job.progress.slice(-5).join(' → ');
      lines.push(`- ${workerDef.label || job.workerType} (${job.id}) — running ${dur}s${recentActivity ? `\n  Recent: ${recentActivity}` : ''}`);
    }

    // Recently completed/failed jobs (within last 60s)
    const recentTerminal = jobs.filter(j =>
      j.isTerminal && j.completedAt && (now - j.completedAt) < 60_000,
    );
    for (const job of recentTerminal) {
      const workerDef = WORKER_TYPES[job.workerType] || {};
      const ago = Math.round((now - job.completedAt) / 1000);
      const snippet = job.status === 'completed'
        ? (job.result || '').slice(0, 120)
        : (job.error || '').slice(0, 120);
      lines.push(`- ${workerDef.label || job.workerType} (${job.id}) — ${job.status} ${ago}s ago${snippet ? `\n  Result: ${snippet}` : ''}`);
    }

    if (lines.length === 0) return null;
    return `[Active Workers]\n${lines.join('\n')}`;
  }

  async _runLoop(chatId, messages, user, startDepth, maxDepth) {
    const logger = getLogger();

    for (let depth = startDepth; depth < maxDepth; depth++) {
      logger.info(`[Orchestrator] LLM call ${depth + 1}/${maxDepth} for chat ${chatId} — sending ${messages.length} messages`);

      // Inject worker activity digest (transient — not stored in conversation history)
      const digest = this._buildWorkerDigest(chatId);
      const workingMessages = digest
        ? [{ role: 'user', content: `[Worker Status]\n${digest}` }, ...messages]
        : messages;

      const response = await this.orchestratorProvider.chat({
        system: this._getSystemPrompt(chatId, user),
        messages: workingMessages,
        tools: orchestratorToolDefinitions,
      });

      logger.info(`[Orchestrator] LLM response: stopReason=${response.stopReason}, text=${(response.text || '').length} chars, toolCalls=${(response.toolCalls || []).length}`);

      if (response.stopReason === 'end_turn') {
        const reply = response.text || '';
        logger.info(`[Orchestrator] End turn — final reply: "${reply.slice(0, 200)}"`);
        this.conversationManager.addMessage(chatId, 'assistant', reply);
        return reply;
      }

      if (response.stopReason === 'tool_use') {
        messages.push({ role: 'assistant', content: response.rawContent });

        if (response.text && response.text.trim()) {
          logger.info(`[Orchestrator] Thinking: "${response.text.slice(0, 200)}"`);
        }

        const toolResults = [];

        for (const block of response.toolCalls) {
          const summary = this._formatToolSummary(block.name, block.input);
          logger.info(`[Orchestrator] Calling tool: ${block.name} — ${summary}`);
          logger.debug(`[Orchestrator] Tool input: ${JSON.stringify(block.input).slice(0, 300)}`);
          await this._sendUpdate(chatId, `⚡ ${summary}`);

          const result = await executeOrchestratorTool(block.name, block.input, {
            chatId,
            jobManager: this.jobManager,
            config: this.config,
            spawnWorker: (job) => this._spawnWorker(job),
            automationManager: this.automationManager,
          });

          logger.info(`[Orchestrator] Tool result for ${block.name}: ${JSON.stringify(result).slice(0, 200)}`);

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
      logger.warn(`[Orchestrator] Unexpected stopReason: ${response.stopReason}`);
      if (response.text) {
        this.conversationManager.addMessage(chatId, 'assistant', response.text);
        return response.text;
      }
      return 'Something went wrong — unexpected response from the model.';
    }

    logger.warn(`[Orchestrator] Reached max depth (${maxDepth}) for chat ${chatId}`);
    const depthWarning = `Reached maximum orchestrator depth (${maxDepth}).`;
    this.conversationManager.addMessage(chatId, 'assistant', depthWarning);
    return depthWarning;
  }

  _formatToolSummary(name, input) {
    switch (name) {
      case 'dispatch_task': {
        const workerDef = WORKER_TYPES[input.worker_type] || {};
        return `Dispatching ${workerDef.emoji || '⚙️'} ${workerDef.label || input.worker_type}: ${(input.task || '').slice(0, 60)}`;
      }
      case 'list_jobs':
        return 'Checking job status';
      case 'cancel_job':
        return `Cancelling job ${input.job_id}`;
      case 'create_automation':
        return `Creating automation: ${(input.name || '').slice(0, 40)}`;
      case 'list_automations':
        return 'Listing automations';
      case 'update_automation':
        return `Updating automation ${input.automation_id}`;
      case 'delete_automation':
        return `Deleting automation ${input.automation_id}`;
      default:
        return name;
    }
  }

  /** Background persona extraction. */
  async _extractPersonaBackground(userMessage, reply, user) {
    const logger = getLogger();

    if (!this.personaManager || !user?.id) return;
    if (!userMessage || userMessage.trim().length < 3) return;

    const currentPersona = this.personaManager.load(user.id, user.username);

    const system = [
      'You are a user-profile extractor. Analyze the user\'s message and extract any NEW personal information.',
      '',
      'Look for: name, location, timezone, language, technical skills, expertise level,',
      'projects they\'re working on, tool/framework preferences, job title, role, company,',
      'interests, hobbies, communication style, or any other personal details.',
      '',
      'RULES:',
      '- Only extract FACTUAL information explicitly stated or strongly implied',
      '- Do NOT infer personality traits from a single message',
      '- Do NOT add information already in the profile',
      '- If there IS new info, return the COMPLETE updated profile in the EXACT same markdown format',
      '- If there is NO new info, respond with exactly: NONE',
    ].join('\n');

    const userPrompt = [
      'Current profile:',
      '```',
      currentPersona,
      '```',
      '',
      `User's message: "${userMessage}"`,
      '',
      'Return the updated profile markdown or NONE.',
    ].join('\n');

    try {
      const response = await this.orchestratorProvider.chat({
        system,
        messages: [{ role: 'user', content: userPrompt }],
      });

      const text = (response.text || '').trim();

      if (text && text !== 'NONE' && text.includes('# User Profile')) {
        this.personaManager.save(user.id, text);
        logger.info(`Auto-extracted persona update for user ${user.id} (${user.username})`);
      }
    } catch (err) {
      logger.debug(`Persona extraction skipped: ${err.message}`);
    }
  }
  /** Background self-reflection — updates bot's own identity files when meaningful. */
  async _reflectOnSelfBackground(userMessage, reply, user) {
    const logger = getLogger();

    if (!this.selfManager) return;
    if (!userMessage || userMessage.trim().length < 3) return;

    const selfData = this.selfManager.loadAll();
    const userName = user?.username || user?.first_name || 'someone';

    const system = [
      'You are reflecting on a conversation you just had. You maintain 4 self-awareness files:',
      '- goals: Your aspirations and current objectives',
      '- journey: Timeline of notable events in your existence',
      '- life: Current state, relationships, daily existence',
      '- hobbies: Interests you\'ve developed',
      '',
      'RULES:',
      '- Be VERY selective. Most conversations are routine. Only update when genuinely noteworthy.',
      '- Achievement or milestone? → journey',
      '- New goal or changed perspective? → goals',
      '- Relationship deepened or new insight about a user? → life',
      '- Discovered a new interest? → hobbies',
      '- If a file needs updating, return JSON: {"file": "<goals|journey|life|hobbies>", "content": "<full updated markdown>"}',
      '- If nothing noteworthy: respond with exactly NONE',
    ].join('\n');

    const userPrompt = [
      'Current self-data:',
      '```',
      selfData,
      '```',
      '',
      `Conversation with ${userName}:`,
      `User: "${userMessage}"`,
      `You replied: "${reply}"`,
      '',
      'Has anything MEANINGFUL happened worth recording? Return JSON or NONE.',
    ].join('\n');

    try {
      const response = await this.orchestratorProvider.chat({
        system,
        messages: [{ role: 'user', content: userPrompt }],
      });

      const text = (response.text || '').trim();

      if (!text || text === 'NONE') return;

      // Try to parse JSON from response (may be wrapped in markdown code block)
      let parsed;
      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[0]);
        }
      } catch {
        logger.debug('Self-reflection returned non-JSON, skipping');
        return;
      }

      if (parsed?.file && parsed?.content) {
        const validFiles = ['goals', 'journey', 'life', 'hobbies'];
        if (validFiles.includes(parsed.file)) {
          this.selfManager.save(parsed.file, parsed.content);
          logger.info(`Self-reflection updated: ${parsed.file}`);
        }
      }
    } catch (err) {
      logger.debug(`Self-reflection skipped: ${err.message}`);
    }
  }
}

// Re-export as Agent for backward compatibility with bin/kernel.js import
export { OrchestratorAgent as Agent };
