import { createProvider, PROVIDERS } from './providers/index.js';
import { orchestratorToolDefinitions, executeOrchestratorTool } from './tools/orchestrator-tools.js';
import { getToolsForWorker } from './swarm/worker-registry.js';
import { WORKER_TYPES } from './swarm/worker-registry.js';
import { getOrchestratorPrompt } from './prompts/orchestrator.js';
import { getWorkerPrompt } from './prompts/workers.js';
import { getUnifiedSkillById } from './skills/custom.js';
import { WorkerAgent } from './worker.js';
import { getLogger } from './utils/logger.js';
import { getMissingCredential, saveCredential, saveProviderToYaml, saveOrchestratorToYaml, saveClaudeCodeModelToYaml, saveClaudeCodeAuth } from './utils/config.js';
import { resetClaudeCodeSpawner, getSpawner } from './tools/coding.js';

const MAX_RESULT_LENGTH = 3000;
const LARGE_FIELDS = ['stdout', 'stderr', 'content', 'diff', 'output', 'body', 'html', 'text', 'log', 'logs'];

export class OrchestratorAgent {
  constructor({ config, conversationManager, personaManager, selfManager, jobManager, automationManager, memoryManager, shareQueue }) {
    this.config = config;
    this.conversationManager = conversationManager;
    this.personaManager = personaManager;
    this.selfManager = selfManager || null;
    this.jobManager = jobManager;
    this.automationManager = automationManager || null;
    this.memoryManager = memoryManager || null;
    this.shareQueue = shareQueue || null;
    this._pending = new Map(); // chatId -> pending state
    this._chatCallbacks = new Map(); // chatId -> { onUpdate, sendPhoto }

    // Orchestrator provider (30s timeout — lean dispatch/summarize calls)
    const orchProviderKey = config.orchestrator.provider || 'anthropic';
    const orchProviderDef = PROVIDERS[orchProviderKey];
    const orchApiKey = config.orchestrator.api_key || (orchProviderDef && process.env[orchProviderDef.envKey]) || process.env.ANTHROPIC_API_KEY;
    this.orchestratorProvider = createProvider({
      brain: {
        provider: orchProviderKey,
        model: config.orchestrator.model,
        max_tokens: config.orchestrator.max_tokens,
        temperature: config.orchestrator.temperature,
        api_key: orchApiKey,
        timeout: 30_000,
      },
    });

    // Worker provider uses user's chosen brain
    this.workerProvider = createProvider(config);

    // Set up job lifecycle event listeners
    this._setupJobListeners();
  }

  /** Build the orchestrator system prompt. */
  _getSystemPrompt(chatId, user, temporalContext = null) {
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

    // Build memory context block
    let memoriesBlock = null;
    if (this.memoryManager) {
      memoriesBlock = this.memoryManager.buildContextBlock(user?.id || null);
    }

    // Build share queue block
    let sharesBlock = null;
    if (this.shareQueue) {
      sharesBlock = this.shareQueue.buildShareBlock(user?.id || null);
    }

    logger.debug(`Orchestrator building system prompt for chat ${chatId} | skill=${skillId || 'none'} | persona=${userPersona ? 'yes' : 'none'} | self=${selfData ? 'yes' : 'none'} | memories=${memoriesBlock ? 'yes' : 'none'} | shares=${sharesBlock ? 'yes' : 'none'} | temporal=${temporalContext ? 'yes' : 'none'}`);
    return getOrchestratorPrompt(this.config, skillPrompt || null, userPersona, selfData, memoriesBlock, sharesBlock, temporalContext);
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

  /** Return current orchestrator info for display. */
  getOrchestratorInfo() {
    const provider = this.config.orchestrator.provider || 'anthropic';
    const model = this.config.orchestrator.model;
    const providerDef = PROVIDERS[provider];
    const providerName = providerDef ? providerDef.name : provider;
    const modelEntry = providerDef?.models.find((m) => m.id === model);
    const modelLabel = modelEntry ? modelEntry.label : model;
    return { provider, providerName, model, modelLabel };
  }

  /** Switch orchestrator provider/model at runtime. */
  async switchOrchestrator(providerKey, modelId) {
    const logger = getLogger();
    const providerDef = PROVIDERS[providerKey];
    if (!providerDef) return `Unknown provider: ${providerKey}`;

    const envKey = providerDef.envKey;
    const apiKey = process.env[envKey];
    if (!apiKey) return envKey;

    try {
      const testProvider = createProvider({
        brain: {
          provider: providerKey,
          model: modelId,
          max_tokens: this.config.orchestrator.max_tokens,
          temperature: this.config.orchestrator.temperature,
          api_key: apiKey,
          timeout: 30_000,
        },
      });
      await testProvider.ping();

      this.config.orchestrator.provider = providerKey;
      this.config.orchestrator.model = modelId;
      this.config.orchestrator.api_key = apiKey;
      this.orchestratorProvider = testProvider;
      saveOrchestratorToYaml(providerKey, modelId);

      logger.info(`Orchestrator switched to ${providerDef.name} / ${modelId}`);
      return null;
    } catch (err) {
      logger.error(`Orchestrator switch failed for ${providerDef.name} / ${modelId}: ${err.message}`);
      return { error: err.message };
    }
  }

  /** Finalize orchestrator switch after API key was provided via chat. */
  async switchOrchestratorWithKey(providerKey, modelId, apiKey) {
    const logger = getLogger();
    const providerDef = PROVIDERS[providerKey];

    try {
      const testProvider = createProvider({
        brain: {
          provider: providerKey,
          model: modelId,
          max_tokens: this.config.orchestrator.max_tokens,
          temperature: this.config.orchestrator.temperature,
          api_key: apiKey,
          timeout: 30_000,
        },
      });
      await testProvider.ping();

      saveCredential(this.config, providerDef.envKey, apiKey);
      this.config.orchestrator.provider = providerKey;
      this.config.orchestrator.model = modelId;
      this.config.orchestrator.api_key = apiKey;
      this.orchestratorProvider = testProvider;
      saveOrchestratorToYaml(providerKey, modelId);

      logger.info(`Orchestrator switched to ${providerDef.name} / ${modelId} (new key saved)`);
      return null;
    } catch (err) {
      logger.error(`Orchestrator switch failed for ${providerDef.name} / ${modelId}: ${err.message}`);
      return { error: err.message };
    }
  }

  /** Return current Claude Code model info for display. */
  getClaudeCodeInfo() {
    const model = this.config.claude_code?.model || 'claude-opus-4-6';
    const providerDef = PROVIDERS.anthropic;
    const modelEntry = providerDef?.models.find((m) => m.id === model);
    const modelLabel = modelEntry ? modelEntry.label : model;
    return { model, modelLabel };
  }

  /** Switch Claude Code model at runtime. */
  switchClaudeCodeModel(modelId) {
    const logger = getLogger();
    this.config.claude_code.model = modelId;
    saveClaudeCodeModelToYaml(modelId);
    resetClaudeCodeSpawner();
    logger.info(`Claude Code model switched to ${modelId}`);
  }

  /** Return current Claude Code auth config for display. */
  getClaudeAuthConfig() {
    const mode = this.config.claude_code?.auth_mode || 'system';
    const info = { mode };

    if (mode === 'api_key') {
      const key = this.config.claude_code?.api_key || process.env.CLAUDE_CODE_API_KEY || '';
      info.credential = key ? `${key.slice(0, 8)}...${key.slice(-4)}` : '(not set)';
    } else if (mode === 'oauth_token') {
      const token = this.config.claude_code?.oauth_token || process.env.CLAUDE_CODE_OAUTH_TOKEN || '';
      info.credential = token ? `${token.slice(0, 8)}...${token.slice(-4)}` : '(not set)';
    } else {
      info.credential = 'Using host system login';
    }

    return info;
  }

  /** Set Claude Code auth mode + credential at runtime. */
  setClaudeCodeAuth(mode, value) {
    const logger = getLogger();
    saveClaudeCodeAuth(this.config, mode, value);
    resetClaudeCodeSpawner();
    logger.info(`Claude Code auth mode set to: ${mode}`);
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

    // Detect time gap before adding the new message
    let temporalContext = null;
    const lastTs = this.conversationManager.getLastMessageTimestamp(chatId);
    if (lastTs) {
      const gapMs = Date.now() - lastTs;
      const gapMinutes = Math.floor(gapMs / 60_000);
      if (gapMinutes >= 30) {
        const gapHours = Math.floor(gapMinutes / 60);
        const gapText = gapHours >= 1
          ? `${gapHours} hour(s)`
          : `${gapMinutes} minute(s)`;
        temporalContext = `[Time gap detected: ${gapText} since last message. User may be starting a new topic.]`;
        logger.info(`Time gap detected for chat ${chatId}: ${gapText}`);
      }
    }

    // Add user message to persistent history
    this.conversationManager.addMessage(chatId, 'user', userMessage);

    // Build working messages from compressed history
    const messages = [...this.conversationManager.getSummarizedHistory(chatId)];
    logger.debug(`Orchestrator conversation context: ${messages.length} messages, max_depth=${max_tool_depth}`);

    const reply = await this._runLoop(chatId, messages, user, 0, max_tool_depth, temporalContext);

    logger.info(`Orchestrator reply for chat ${chatId}: "${(reply || '').slice(0, 150)}"`);

    // Background persona extraction + self-reflection
    this._extractPersonaBackground(userMessage, reply, user).catch(() => {});
    this._reflectOnSelfBackground(userMessage, reply, user).catch(() => {});

    // Mark pending shares as shared (they were in the prompt, bot wove them in)
    if (this.shareQueue && user?.id) {
      const pending = this.shareQueue.getPending(user.id, 3);
      for (const item of pending) {
        this.shareQueue.markShared(item.id, user.id);
      }
    }

    return reply;
  }

  async _sendUpdate(chatId, text, opts) {
    const callbacks = this._chatCallbacks.get(chatId);
    if (callbacks?.onUpdate) {
      try {
        return await callbacks.onUpdate(text, opts);
      } catch (err) {
        const logger = getLogger();
        logger.error(`[Orchestrator] _sendUpdate failed for chat ${chatId}: ${err.message}`);
      }
    } else {
      const logger = getLogger();
      logger.warn(`[Orchestrator] _sendUpdate: no callbacks for chat ${chatId}`);
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

      logger.info(`[Orchestrator] Job completed event: ${job.id} [${job.workerType}] in chat ${chatId} (${job.duration}s) — result length: ${(job.result || '').length} chars, structured: ${!!job.structuredResult}`);

      // 1. IMMEDIATELY notify user (guarantees they see something regardless of summary LLM)
      const notifyMsgId = await this._sendUpdate(chatId, `✅ ${label} finished! Preparing summary...`);
      logger.debug(`[Orchestrator] Job ${job.id} notification sent — msgId=${notifyMsgId || 'none'}`);

      // 2. Try to summarize, then store ONE message in history (summary or fallback — not both)
      try {
        const summary = await this._summarizeJobResult(chatId, job);
        if (summary) {
          logger.debug(`[Orchestrator] Job ${job.id} summary ready (${summary.length} chars) — delivering to user`);
          this.conversationManager.addMessage(chatId, 'assistant', summary);
          await this._sendUpdate(chatId, summary, { editMessageId: notifyMsgId });
        } else {
          // Summary was null — store the fallback
          const fallback = this._buildSummaryFallback(job, label);
          logger.debug(`[Orchestrator] Job ${job.id} using fallback (${fallback.length} chars) — delivering to user`);
          this.conversationManager.addMessage(chatId, 'assistant', fallback);
          await this._sendUpdate(chatId, fallback, { editMessageId: notifyMsgId });
        }
      } catch (err) {
        logger.error(`[Orchestrator] Failed to summarize job ${job.id}: ${err.message}`);
        // Store the fallback so the orchestrator retains context about what happened
        const fallback = this._buildSummaryFallback(job, label);
        this.conversationManager.addMessage(chatId, 'assistant', fallback);
        await this._sendUpdate(chatId, fallback, { editMessageId: notifyMsgId }).catch(() => {});
      }
    });

    // Handle jobs whose dependencies are now met
    this.jobManager.on('job:ready', async (job) => {
      const chatId = job.chatId;
      logger.info(`[Orchestrator] Job ready event: ${job.id} [${job.workerType}] — dependencies met, spawning worker`);

      try {
        await this._spawnWorker(job);
      } catch (err) {
        logger.error(`[Orchestrator] Failed to spawn ready job ${job.id}: ${err.message}`);
        if (!job.isTerminal) {
          this.jobManager.failJob(job.id, err.message);
        }
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
   * Uses structured data for focused summarization when available.
   * Short results (<500 chars) skip the LLM call entirely.
   * Protected by the provider's built-in timeout (30s).
   * Returns the summary text, or null. Caller handles delivery.
   */
  async _summarizeJobResult(chatId, job) {
    const logger = getLogger();
    const workerDef = WORKER_TYPES[job.workerType] || {};
    const label = workerDef.label || job.workerType;

    logger.info(`[Orchestrator] Summarizing job ${job.id} [${job.workerType}] result for user`);

    // Short results don't need LLM summarization
    const sr = job.structuredResult;
    const resultLen = (job.result || '').length;
    if (sr?.structured && resultLen < 500) {
      logger.info(`[Orchestrator] Job ${job.id} result short enough — skipping LLM summary`);
      return this._buildSummaryFallback(job, label);
    }

    // Build a focused prompt using structured data if available
    let resultContext;
    if (sr?.structured) {
      const parts = [`Summary: ${sr.summary}`, `Status: ${sr.status}`];
      if (sr.artifacts?.length > 0) {
        parts.push(`Artifacts: ${sr.artifacts.map(a => `${a.title || a.type}: ${a.url || a.path}`).join(', ')}`);
      }
      if (sr.followUp) parts.push(`Follow-up: ${sr.followUp}`);
      // Include details up to 8000 chars
      if (sr.details) {
        const d = typeof sr.details === 'string' ? sr.details : JSON.stringify(sr.details, null, 2);
        parts.push(`Details:\n${d.slice(0, 8000)}`);
      }
      resultContext = parts.join('\n');
    } else {
      resultContext = (job.result || 'Done.').slice(0, 8000);
    }

    const history = this.conversationManager.getSummarizedHistory(chatId);

    const response = await this.orchestratorProvider.chat({
      system: this._getSystemPrompt(chatId, null),
      messages: [
        ...history,
        {
          role: 'user',
          content: `The ${label} worker just finished job \`${job.id}\` (took ${job.duration}s). Here are the results:\n\n${resultContext}\n\nPresent these results to the user in a clean, well-formatted way. Don't mention "worker" or technical job details — just present the findings naturally as if you did the work yourself.`,
        },
      ],
    });

    const summary = response.text || '';
    logger.info(`[Orchestrator] Job ${job.id} summary: "${summary.slice(0, 200)}"`);

    return summary || null;
  }

  /**
   * Build a compact history entry for a completed job result.
   * Stored as role: 'assistant' (not fake 'user') with up to 6000 chars of detail.
   */
  _buildResultHistoryEntry(job) {
    const workerDef = WORKER_TYPES[job.workerType] || {};
    const label = workerDef.label || job.workerType;
    const sr = job.structuredResult;

    const parts = [`[${label} result — job ${job.id}, ${job.duration}s]`];

    if (sr?.structured) {
      parts.push(`Summary: ${sr.summary}`);
      parts.push(`Status: ${sr.status}`);
      if (sr.artifacts?.length > 0) {
        const artifactLines = sr.artifacts.map(a => `- ${a.title || a.type}: ${a.url || a.path || ''}`);
        parts.push(`Artifacts:\n${artifactLines.join('\n')}`);
      }
      if (sr.followUp) parts.push(`Follow-up: ${sr.followUp}`);
      if (sr.details) {
        const d = typeof sr.details === 'string' ? sr.details : JSON.stringify(sr.details, null, 2);
        const details = d.length > 6000
          ? d.slice(0, 6000) + '\n... [details truncated]'
          : d;
        parts.push(`Details:\n${details}`);
      }
    } else {
      // Raw text result
      const resultText = job.result || 'Done.';
      if (resultText.length > 6000) {
        parts.push(resultText.slice(0, 6000) + '\n... [result truncated]');
      } else {
        parts.push(resultText);
      }
    }

    return parts.join('\n\n');
  }

  /**
   * Build a fallback summary when LLM summarization fails.
   * Shows structured summary + artifacts directly instead of "ask me for details".
   */
  _buildSummaryFallback(job, label) {
    const sr = job.structuredResult;

    if (sr?.structured) {
      const parts = [`✅ **${label}** finished (\`${job.id}\`, ${job.duration}s)`];
      parts.push(`\n${sr.summary}`);
      if (sr.artifacts?.length > 0) {
        const artifactLines = sr.artifacts.map(a => {
          const link = a.url ? `[${a.title || a.type}](${a.url})` : (a.title || a.path || a.type);
          return `- ${link}`;
        });
        parts.push(`\n${artifactLines.join('\n')}`);
      }
      if (sr.details) {
        const d = typeof sr.details === 'string' ? sr.details : JSON.stringify(sr.details, null, 2);
        const details = d.length > 1500 ? d.slice(0, 1500) + '\n... [truncated]' : d;
        parts.push(`\n${details}`);
      }
      if (sr.followUp) parts.push(`\n💡 ${sr.followUp}`);
      return parts.join('');
    }

    // No structured result — show first 300 chars of raw result
    const snippet = (job.result || '').slice(0, 300);
    return `✅ **${label}** finished (\`${job.id}\`, ${job.duration}s)${snippet ? `\n\n${snippet}${job.result?.length > 300 ? '...' : ''}` : ''}`;
  }

  /**
   * Build structured context for a worker.
   * Assembles: orchestrator-provided context, recent user messages, user persona, dependency results.
   */
  _buildWorkerContext(job) {
    const logger = getLogger();
    const sections = [];

    // 1. Orchestrator-provided context
    if (job.context) {
      sections.push(`## Context\n${job.context}`);
    }

    // 2. Last 5 user messages from conversation history
    try {
      const history = this.conversationManager.getSummarizedHistory(job.chatId);
      const userMessages = history
        .filter(m => m.role === 'user' && typeof m.content === 'string')
        .slice(-5)
        .map(m => m.content.slice(0, 500));
      if (userMessages.length > 0) {
        sections.push(`## Recent Conversation\n${userMessages.map(m => `> ${m}`).join('\n\n')}`);
      }
    } catch (err) {
      logger.debug(`[Worker ${job.id}] Failed to load conversation history for context: ${err.message}`);
    }

    // 3. User persona
    if (this.personaManager && job.userId) {
      try {
        const persona = this.personaManager.load(job.userId);
        if (persona && persona.trim() && !persona.includes('No profile')) {
          sections.push(`## User Profile\n${persona}`);
        }
      } catch (err) {
        logger.debug(`[Worker ${job.id}] Failed to load persona for context: ${err.message}`);
      }
    }

    // 4. Dependency job results
    if (job.dependsOn.length > 0) {
      const depResults = [];
      for (const depId of job.dependsOn) {
        const depJob = this.jobManager.getJob(depId);
        if (!depJob || depJob.status !== 'completed') continue;

        const workerDef = WORKER_TYPES[depJob.workerType] || {};
        const label = workerDef.label || depJob.workerType;
        const sr = depJob.structuredResult;

        if (sr?.structured) {
          const parts = [`### ${label} (${depId}) — ${sr.status}`];
          parts.push(sr.summary);
          if (sr.artifacts?.length > 0) {
            parts.push(`Artifacts: ${sr.artifacts.map(a => `${a.title || a.type}: ${a.url || a.path || ''}`).join(', ')}`);
          }
          if (sr.details) {
            const d = typeof sr.details === 'string' ? sr.details : JSON.stringify(sr.details, null, 2);
            parts.push(d.slice(0, 4000));
          }
          depResults.push(parts.join('\n'));
        } else if (depJob.result) {
          depResults.push(`### ${label} (${depId})\n${depJob.result.slice(0, 4000)}`);
        }
      }
      if (depResults.length > 0) {
        sections.push(`## Prior Worker Results\n${depResults.join('\n\n')}`);
      }
    }

    if (sections.length === 0) return null;
    return sections.join('\n\n');
  }

  /**
   * Spawn a worker for a job — called from dispatch_task handler.
   * Creates smart progress reporting via editable Telegram message.
   */
  async _spawnWorker(job) {
    const logger = getLogger();

    // Direct dispatch for coding tasks — bypass worker LLM, go straight to Claude Code CLI
    if (job.workerType === 'coding') {
      return this._spawnDirectCoding(job);
    }

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

    // Build worker context (conversation history, persona, dependency results)
    const workerContext = this._buildWorkerContext(job);
    logger.debug(`[Orchestrator] Worker ${job.id} config: ${tools.length} tools, skill=${skillId || 'none'}, brain=${this.config.brain.provider}/${this.config.brain.model}, context=${workerContext ? 'yes' : 'none'}`);

    const worker = new WorkerAgent({
      config: this.config,
      workerType: job.workerType,
      jobId: job.id,
      tools,
      skillId,
      workerContext,
      callbacks: {
        onProgress: (text) => addActivity(text),
        onHeartbeat: (text) => job.addProgress(text),
        onUpdate, // Real bot onUpdate for tools (coder.js smart output needs message_id)
        onComplete: (result, parsedResult) => {
          logger.info(`[Worker ${job.id}] Completed — structured=${!!parsedResult?.structured}, result: "${(result || '').slice(0, 150)}"`);
          // Final status message update
          if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
          if (statusMsgId && onUpdate) {
            onUpdate(buildStatusText('done'), { editMessageId: statusMsgId }).catch(() => {});
          }
          this.jobManager.completeJob(job.id, result, parsedResult || null);
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
   * Direct coding dispatch — runs Claude Code CLI without a middleman worker LLM.
   * The orchestrator's task description goes straight to Claude Code as the prompt.
   */
  async _spawnDirectCoding(job) {
    const logger = getLogger();
    const chatId = job.chatId;
    const callbacks = this._chatCallbacks.get(chatId) || {};
    const onUpdate = callbacks.onUpdate;
    const workerDef = WORKER_TYPES[job.workerType] || {};
    const label = workerDef.label || job.workerType;

    logger.info(`[Orchestrator] Direct coding dispatch for job ${job.id} in chat ${chatId} — task: "${job.task.slice(0, 120)}"`);

    // AbortController for cancellation — duck-typed so JobManager.cancelJob() works unchanged
    const abortController = new AbortController();
    job.worker = { cancel: () => abortController.abort() };

    // Build context from conversation history, persona, dependency results
    const workerContext = this._buildWorkerContext(job);
    const prompt = workerContext
      ? `${workerContext}\n\n---\n\n${job.task}`
      : job.task;

    // Working directory
    const workingDirectory = this.config.claude_code?.workspace_dir || process.cwd();

    // Start the job
    this.jobManager.startJob(job.id);

    try {
      const spawner = getSpawner(this.config);
      const result = await spawner.run({
        workingDirectory,
        prompt,
        onOutput: onUpdate,
        signal: abortController.signal,
      });

      const output = result.output || 'Done.';
      logger.info(`[Orchestrator] Direct coding job ${job.id} completed — output: ${output.length} chars`);
      this.jobManager.completeJob(job.id, output, {
        structured: true,
        summary: output.slice(0, 500),
        status: 'success',
        details: output,
      });
    } catch (err) {
      logger.error(`[Orchestrator] Direct coding job ${job.id} failed: ${err.message}`);
      this.jobManager.failJob(job.id, err.message || String(err));
    }
  }

  /**
   * Build a compact worker activity digest for the orchestrator.
   * Returns a text block summarizing active/recent/waiting workers, or null if nothing relevant.
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
      const recentActivity = job.progress.slice(-8).join(' → ');
      lines.push(`- ${workerDef.label || job.workerType} (${job.id}) — running ${dur}s${recentActivity ? `\n  Recent: ${recentActivity}` : ''}`);
    }

    // Queued/waiting jobs
    const queued = jobs.filter(j => j.status === 'queued' && j.dependsOn.length > 0);
    for (const job of queued) {
      const workerDef = WORKER_TYPES[job.workerType] || {};
      lines.push(`- ${workerDef.label || job.workerType} (${job.id}) — queued, waiting for: ${job.dependsOn.join(', ')}`);
    }

    // Recently completed/failed jobs (within last 120s)
    const recentTerminal = jobs.filter(j =>
      j.isTerminal && j.completedAt && (now - j.completedAt) < 120_000,
    );
    for (const job of recentTerminal) {
      const workerDef = WORKER_TYPES[job.workerType] || {};
      const ago = Math.round((now - job.completedAt) / 1000);
      let snippet;
      if (job.status === 'completed') {
        if (job.structuredResult?.structured) {
          snippet = job.structuredResult.summary.slice(0, 300);
          if (job.structuredResult.artifacts?.length > 0) {
            snippet += ` | Artifacts: ${job.structuredResult.artifacts.map(a => a.title || a.type).join(', ')}`;
          }
          if (job.structuredResult.followUp) {
            snippet += ` | Follow-up: ${job.structuredResult.followUp.slice(0, 100)}`;
          }
        } else {
          snippet = (job.result || '').slice(0, 300);
        }
      } else {
        snippet = (job.error || '').slice(0, 300);
      }
      lines.push(`- ${workerDef.label || job.workerType} (${job.id}) — ${job.status} ${ago}s ago${snippet ? `\n  Result: ${snippet}` : ''}`);
    }

    if (lines.length === 0) return null;
    return `[Active Workers]\n${lines.join('\n')}`;
  }

  async _runLoop(chatId, messages, user, startDepth, maxDepth, temporalContext = null) {
    const logger = getLogger();

    for (let depth = startDepth; depth < maxDepth; depth++) {
      logger.info(`[Orchestrator] LLM call ${depth + 1}/${maxDepth} for chat ${chatId} — sending ${messages.length} messages`);

      // Inject transient context messages (not stored in conversation history)
      let workingMessages = [...messages];

      // On first iteration, inject temporal context if present
      if (depth === 0 && temporalContext) {
        workingMessages = [{ role: 'user', content: `[Temporal Context]\n${temporalContext}` }, ...workingMessages];
      }

      // Inject worker activity digest
      const digest = this._buildWorkerDigest(chatId);
      if (digest) {
        workingMessages = [{ role: 'user', content: `[Worker Status]\n${digest}` }, ...workingMessages];
      }

      const response = await this.orchestratorProvider.chat({
        system: this._getSystemPrompt(chatId, user, temporalContext),
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
            user,
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
  /** Background self-reflection — updates bot's own identity files and extracts episodic memories when meaningful. */
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
      'You also create episodic memories — short summaries of notable interactions.',
      '',
      'RULES:',
      '- Be VERY selective. Most conversations are routine. Only update when genuinely noteworthy.',
      '- Achievement or milestone? → journey',
      '- New goal or changed perspective? → goals',
      '- Relationship deepened or new insight about a user? → life',
      '- Discovered a new interest? → hobbies',
      '',
      'Return JSON with two optional fields:',
      '  "self_update": {"file": "<goals|journey|life|hobbies>", "content": "<full updated markdown>"} or null',
      '  "memory": {"summary": "...", "tags": ["..."], "importance": 1-10, "type": "interaction"} or null',
      '',
      'The memory field captures what happened in this conversation — the gist of it.',
      'Importance scale: 1=routine, 5=interesting, 8=significant, 10=life-changing.',
      'Most chats are 1-3. Only notable ones deserve 5+.',
      '',
      'If NOTHING noteworthy happened (no self update AND no memory worth keeping): respond with exactly NONE',
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
      'Return JSON with self_update and/or memory, or NONE.',
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

      // Handle self_update (backward compat: also check top-level file/content)
      const selfUpdate = parsed?.self_update || (parsed?.file ? parsed : null);
      if (selfUpdate?.file && selfUpdate?.content) {
        const validFiles = ['goals', 'journey', 'life', 'hobbies'];
        if (validFiles.includes(selfUpdate.file)) {
          this.selfManager.save(selfUpdate.file, selfUpdate.content);
          logger.info(`Self-reflection updated: ${selfUpdate.file}`);
        }
      }

      // Handle memory extraction
      if (parsed?.memory && this.memoryManager) {
        const mem = parsed.memory;
        if (mem.summary && mem.importance >= 2) {
          this.memoryManager.addEpisodic({
            type: mem.type || 'interaction',
            source: 'user_chat',
            summary: mem.summary,
            tags: mem.tags || [],
            importance: mem.importance || 3,
            userId: user?.id ? String(user.id) : null,
          });
          logger.info(`Memory extracted: "${mem.summary.slice(0, 80)}" (importance: ${mem.importance})`);
        }
      }
    } catch (err) {
      logger.debug(`Self-reflection skipped: ${err.message}`);
    }
  }
}

// Re-export as Agent for backward compatibility with bin/kernel.js import
export { OrchestratorAgent as Agent };
