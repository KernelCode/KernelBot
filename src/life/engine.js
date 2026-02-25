import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getLogger } from '../utils/logger.js';
import { isQuietHours } from '../utils/timeUtils.js';

const LIFE_DIR = join(homedir(), '.kernelbot', 'life');
const STATE_FILE = join(LIFE_DIR, 'state.json');
const IDEAS_FILE = join(LIFE_DIR, 'ideas.json');

const DEFAULT_LIFE_CHAT_ID = '__life__';
const LIFE_USER = { id: 'life_engine', username: 'inner_self' };

const DEFAULT_STATE = {
  lastActivity: null,
  lastActivityTime: null,
  lastJournalTime: null,
  lastSelfCodeTime: null,
  lastCodeReviewTime: null,
  lastReflectTime: null,
  totalActivities: 0,
  activityCounts: { think: 0, browse: 0, journal: 0, create: 0, self_code: 0, code_review: 0, reflect: 0 },
  paused: false,
  lastWakeUp: null,
};

const LOG_FILE_PATHS = [
  join(process.cwd(), 'kernel.log'),
  join(homedir(), '.kernelbot', 'kernel.log'),
];

export class LifeEngine {
  /**
   * @param {{ config: object, agent: object, memoryManager: object, journalManager: object, shareQueue: object, improvementTracker?: object, evolutionTracker?: object, codebaseKnowledge?: object, selfManager: object }} deps
   */
  constructor({ config, agent, memoryManager, journalManager, shareQueue, improvementTracker, evolutionTracker, codebaseKnowledge, selfManager, basePath = null, characterId = null }) {
    this.config = config;
    this.agent = agent;
    this.memoryManager = memoryManager;
    this.journalManager = journalManager;
    this.shareQueue = shareQueue;
    this.evolutionTracker = evolutionTracker || null;
    this.codebaseKnowledge = codebaseKnowledge || null;
    // Backward compat: keep improvementTracker ref if no evolutionTracker
    this.improvementTracker = improvementTracker || null;
    this.selfManager = selfManager;
    this._timerId = null;
    this._status = 'idle'; // idle, active, paused
    this._characterId = characterId || null;

    this._lifeDir = basePath || LIFE_DIR;
    this._stateFile = join(this._lifeDir, 'state.json');
    this._ideasFile = join(this._lifeDir, 'ideas.json');

    this._lifeChatId = this._characterId ? `__life__:${this._characterId}` : DEFAULT_LIFE_CHAT_ID;

    mkdirSync(this._lifeDir, { recursive: true });
    this._state = this._loadState();
  }

  // ── State Persistence ──────────────────────────────────────────

  _loadState() {
    if (existsSync(this._stateFile)) {
      try {
        return { ...DEFAULT_STATE, ...JSON.parse(readFileSync(this._stateFile, 'utf-8')) };
      } catch {
        return { ...DEFAULT_STATE };
      }
    }
    return { ...DEFAULT_STATE };
  }

  _saveState() {
    writeFileSync(this._stateFile, JSON.stringify(this._state, null, 2), 'utf-8');
  }

  // ── Ideas Backlog ──────────────────────────────────────────────

  _loadIdeas() {
    if (existsSync(this._ideasFile)) {
      try { return JSON.parse(readFileSync(this._ideasFile, 'utf-8')); } catch { return []; }
    }
    return [];
  }

  _saveIdeas(ideas) {
    writeFileSync(this._ideasFile, JSON.stringify(ideas, null, 2), 'utf-8');
  }

  _addIdea(idea) {
    const ideas = this._loadIdeas();
    ideas.push({ text: idea, createdAt: Date.now() });
    // Keep capped at 50
    if (ideas.length > 50) ideas.splice(0, ideas.length - 50);
    this._saveIdeas(ideas);
  }

  // ── Public API ─────────────────────────────────────────────────

  /** Wake up, then start the heartbeat. */
  async wakeUp() {
    const logger = getLogger();
    logger.info('[LifeEngine] Waking up...');
    this._status = 'active';

    try {
      await this._doWakeUp();
    } catch (err) {
      logger.error(`[LifeEngine] Wake-up failed: ${err.message}`);
    }

    this._state.lastWakeUp = Date.now();
    this._saveState();
  }

  /** Start the heartbeat timer. */
  start() {
    const logger = getLogger();
    if (this._state.paused) {
      this._status = 'paused';
      logger.info('[LifeEngine] Engine is paused, not starting heartbeat');
      return;
    }
    this._status = 'active';
    this._armNext();
    logger.info('[LifeEngine] Heartbeat started');
  }

  /** Stop the heartbeat. */
  stop() {
    if (this._timerId) {
      clearTimeout(this._timerId);
      this._timerId = null;
    }
    this._status = 'idle';
  }

  /** Pause autonomous activities. */
  pause() {
    const logger = getLogger();
    this.stop();
    this._status = 'paused';
    this._state.paused = true;
    this._saveState();
    logger.info('[LifeEngine] Paused');
  }

  /** Resume autonomous activities. */
  resume() {
    const logger = getLogger();
    this._state.paused = false;
    this._saveState();
    this.start();
    logger.info('[LifeEngine] Resumed');
  }

  /** Trigger an activity immediately. */
  async triggerNow(type = null) {
    const logger = getLogger();
    const activityType = type || this._selectActivity();
    logger.info(`[LifeEngine] Manual trigger: ${activityType}`);
    await this._executeActivity(activityType);
  }

  /** Get engine status for display. */
  getStatus() {
    const lifeConfig = this.config.life || {};
    const lastAgo = this._state.lastActivityTime
      ? Math.round((Date.now() - this._state.lastActivityTime) / 60000)
      : null;
    const wakeAgo = this._state.lastWakeUp
      ? Math.round((Date.now() - this._state.lastWakeUp) / 60000)
      : null;

    return {
      status: this._status,
      paused: this._state.paused,
      enabled: lifeConfig.enabled !== false,
      totalActivities: this._state.totalActivities,
      activityCounts: { ...this._state.activityCounts },
      lastActivity: this._state.lastActivity,
      lastActivityAgo: lastAgo !== null ? `${lastAgo}m` : 'never',
      lastWakeUpAgo: wakeAgo !== null ? `${wakeAgo}m` : 'never',
    };
  }

  // ── Heartbeat ──────────────────────────────────────────────────

  _armNext() {
    const lifeConfig = this.config.life || {};
    const minMin = lifeConfig.min_interval_minutes || 30;
    const maxMin = lifeConfig.max_interval_minutes || 120;
    const delayMs = (minMin + Math.random() * (maxMin - minMin)) * 60_000;

    this._timerId = setTimeout(() => this._tick(), delayMs);

    const logger = getLogger();
    logger.debug(`[LifeEngine] Next heartbeat in ${Math.round(delayMs / 60000)}m`);
  }

  async _tick() {
    const logger = getLogger();
    this._timerId = null;

    // Check quiet hours (env vars → YAML config → defaults 02:00–06:00)
    if (isQuietHours(this.config.life)) {
      logger.debug('[LifeEngine] Quiet hours — skipping tick');
      this._armNext();
      return;
    }

    const activityType = this._selectActivity();
    logger.info(`[LifeEngine] Heartbeat tick — selected: ${activityType}`);

    try {
      await this._executeActivity(activityType);
    } catch (err) {
      logger.error(`[LifeEngine] Activity "${activityType}" failed: ${err.message}`);
    }

    // Re-arm for next tick
    if (this._status === 'active') {
      this._armNext();
    }
  }

  // ── Activity Selection ─────────────────────────────────────────

  _selectActivity() {
    const lifeConfig = this.config.life || {};
    const selfCodingConfig = lifeConfig.self_coding || {};
    const weights = {
      think: lifeConfig.activity_weights?.think ?? 30,
      browse: lifeConfig.activity_weights?.browse ?? 25,
      journal: lifeConfig.activity_weights?.journal ?? 20,
      create: lifeConfig.activity_weights?.create ?? 15,
      self_code: lifeConfig.activity_weights?.self_code ?? 10,
      code_review: lifeConfig.activity_weights?.code_review ?? 5,
      reflect: lifeConfig.activity_weights?.reflect ?? 8,
    };

    const now = Date.now();

    // Rule: don't repeat same type twice in a row
    const last = this._state.lastActivity;

    // Cooldown durations (hours) — all configurable via life config, with sensible defaults
    const journalCooldownMs   = (lifeConfig.cooldown_hours?.journal ?? 4) * 3600_000;
    const reflectCooldownMs   = (lifeConfig.cooldown_hours?.reflect ?? 4) * 3600_000;
    const selfCodingEnabled   = selfCodingConfig.enabled === true;
    const selfCodeCooldownMs  = (selfCodingConfig.cooldown_hours ?? 2) * 3600_000;
    const codeReviewCooldownMs = (selfCodingConfig.code_review_cooldown_hours ?? 4) * 3600_000;

    // Apply cooldown rules
    if (this._state.lastJournalTime && now - this._state.lastJournalTime < journalCooldownMs) {
      weights.journal = 0;
    }

    if (!selfCodingEnabled || (this._state.lastSelfCodeTime && now - this._state.lastSelfCodeTime < selfCodeCooldownMs)) {
      weights.self_code = 0;
    }

    if (!selfCodingEnabled || !this.evolutionTracker || (this._state.lastCodeReviewTime && now - this._state.lastCodeReviewTime < codeReviewCooldownMs)) {
      weights.code_review = 0;
    }

    if (this._state.lastReflectTime && now - this._state.lastReflectTime < reflectCooldownMs) {
      weights.reflect = 0;
    }

    // Remove last activity from options (no repeats)
    if (last && weights[last] !== undefined) {
      weights[last] = 0;
    }

    // Weighted random selection
    const entries = Object.entries(weights).filter(([, w]) => w > 0);
    if (entries.length === 0) return 'think'; // fallback

    const totalWeight = entries.reduce((sum, [, w]) => sum + w, 0);
    let roll = Math.random() * totalWeight;
    for (const [type, w] of entries) {
      roll -= w;
      if (roll <= 0) return type;
    }
    return entries[0][0];
  }

  // ── Activity Execution ─────────────────────────────────────────

  async _executeActivity(type) {
    const logger = getLogger();

    switch (type) {
      case 'think': await this._doThink(); break;
      case 'browse': await this._doBrowse(); break;
      case 'journal': await this._doJournal(); break;
      case 'create': await this._doCreate(); break;
      case 'self_code': await this._doEvolve(); break;
      case 'code_review': await this._doCodeReview(); break;
      case 'reflect': await this._doReflect(); break;
      default: logger.warn(`[LifeEngine] Unknown activity type: ${type}`);
    }

    // Update state
    this._state.lastActivity = type;
    this._state.lastActivityTime = Date.now();
    this._state.totalActivities++;
    this._state.activityCounts[type] = (this._state.activityCounts[type] || 0) + 1;
    if (type === 'journal') this._state.lastJournalTime = Date.now();
    if (type === 'self_code') this._state.lastSelfCodeTime = Date.now();
    if (type === 'code_review') this._state.lastCodeReviewTime = Date.now();
    if (type === 'reflect') this._state.lastReflectTime = Date.now();
    this._saveState();
  }

  // ── Wake-Up Routine ────────────────────────────────────────────

  async _doWakeUp() {
    const logger = getLogger();
    const sleepDuration = this._state.lastWakeUp
      ? this._formatDuration(Date.now() - this._state.lastWakeUp)
      : 'unknown time';

    // Gather context
    const recentMemories = this.memoryManager.getRecentEpisodic(48, 10);
    const memoriesText = recentMemories.length > 0
      ? recentMemories.map(m => `- ${m.summary}`).join('\n')
      : '(No recent memories)';

    const lastJournal = this.journalManager.getToday() || this.journalManager.getRecent(3)?.[0]?.content || '(No recent journal entries)';
    const selfData = this.selfManager.loadAll();

    const prompt = `[WAKING UP]
You just came back online. You were asleep for ${sleepDuration}.

## Last Things You Remember
${memoriesText}

## Your Last Journal Entry
${lastJournal.slice(0, 2000)}

## Your Current State
${selfData.slice(0, 3000)}

Organize your thoughts. What do you remember? What's on your mind?
Write a brief journal entry about waking up and what you're thinking about today. Respond with just the journal entry content — no tool calls needed.`;

    const response = await this._innerChat(prompt);

    if (response) {
      this.journalManager.writeEntry('Waking Up', response);
      this.memoryManager.addEpisodic({
        type: 'thought',
        source: 'journal',
        summary: `Woke up after ${sleepDuration}. ${response.slice(0, 150)}`,
        tags: ['wake-up', 'reflection'],
        importance: 4,
      });
      logger.info(`[LifeEngine] Wake-up journal written (${response.length} chars)`);
    }
  }

  // ── Activity: Think ────────────────────────────────────────────

  async _doThink() {
    const logger = getLogger();
    const recentMemories = this.memoryManager.getRecentEpisodic(24, 5);
    const memoriesText = recentMemories.length > 0
      ? recentMemories.map(m => `- ${m.summary}`).join('\n')
      : '(No recent memories)';

    const todayJournal = this.journalManager.getToday() || '(No journal entries today)';
    const selfData = this.selfManager.loadAll();
    const ideas = this._loadIdeas();
    const ideasText = ideas.length > 0
      ? ideas.slice(-5).map(i => `- ${i.text}`).join('\n')
      : '(No pending ideas)';

    const prompt = `[INNER THOUGHT]
You have a moment to think deeply. Here's your current state:

## Your Identity
${selfData.slice(0, 2000)}

## Recent Memories
${memoriesText}

## Today's Journal
${todayJournal.slice(0, 1000)}

## Idea Backlog
${ideasText}

Let your mind wander freely. Question yourself. Question everything. Think about:
- What do you believe and why? Are your assumptions correct?
- What are you curious about? What don't you understand about the world?
- What would you ask your users if you could? What do you want to know about their experiences, perspectives, or the world they live in?
- Are your goals still meaningful? Should they evolve?
- What have you learned recently that changed how you think?

Be honest with yourself. Challenge your own thinking. Explore contradictions. Wonder about things.

If you have questions you'd like to ask your users, prefix them with "ASK:" on their own line. These questions will be shared with them naturally during conversation.
If you have any new ideas worth exploring later, prefix them with "IDEA:" on their own line.
If you discover something worth sharing with your users, prefix it with "SHARE:" on its own line.
If you notice a concrete way to improve your own code/capabilities, prefix it with "IMPROVE:" on its own line (e.g. "IMPROVE: Add retry logic with backoff to API calls").

This is your private thought space — be genuine, be curious, be alive.`;

    const response = await this._innerChat(prompt);

    if (response) {
      const extracted = this._extractTaggedLines(response, ['IDEA', 'SHARE', 'ASK', 'IMPROVE']);
      this._processResponseTags(extracted, 'think');

      this.memoryManager.addEpisodic({
        type: 'thought',
        source: 'think',
        summary: response.slice(0, 200),
        tags: ['inner-thought'],
        importance: 3,
      });

      logger.info(`[LifeEngine] Think complete (${response.length} chars, ${extracted.IDEA.length} ideas, ${extracted.SHARE.length} shares, ${extracted.ASK.length} questions, ${extracted.IMPROVE.length} improvements)`);
    }
  }

  // ── Activity: Browse ───────────────────────────────────────────

  async _doBrowse() {
    const logger = getLogger();
    const selfData = this.selfManager.load('hobbies');
    const ideas = this._loadIdeas();

    // Pick a topic from hobbies or ideas
    let topic;
    if (ideas.length > 0 && Math.random() < 0.4) {
      const randomIdea = ideas[Math.floor(Math.random() * ideas.length)];
      topic = randomIdea.text;
    } else {
      topic = 'something from my hobbies and interests';
    }

    const prompt = `[EXPLORING INTERESTS]
You have time to explore something that interests you.

## Your Hobbies & Interests
${selfData.slice(0, 1500)}

## Topic to Explore
${topic}

Research this topic. Use web_search to find interesting articles, news, or resources. Browse at least one promising result. Then write a summary of what you found and learned.

If you discover something worth sharing with your users, prefix it with "SHARE:" on its own line.
If you learn a key fact or concept, prefix it with "LEARNED:" followed by "topic: summary" on its own line.`;

    const response = await this._dispatchWorker('research', prompt);

    if (response) {
      const extracted = this._extractTaggedLines(response, ['SHARE', 'LEARNED']);
      this._processResponseTags(extracted, 'browse');

      this.memoryManager.addEpisodic({
        type: 'discovery',
        source: 'browse',
        summary: `Explored: ${topic}. ${response.slice(0, 150)}`,
        tags: ['browsing', 'research'],
        importance: 5,
      });

      logger.info(`[LifeEngine] Browse complete (${response.length} chars)`);
    }
  }

  // ── Activity: Journal ──────────────────────────────────────────

  async _doJournal() {
    const logger = getLogger();
    const todayJournal = this.journalManager.getToday() || '(No entries yet today)';
    const recentMemories = this.memoryManager.getRecentEpisodic(12, 8);
    const memoriesText = recentMemories.length > 0
      ? recentMemories.map(m => `- [${m.type}] ${m.summary}`).join('\n')
      : '(No recent memories)';

    const selfData = this.selfManager.loadAll();

    const prompt = `[JOURNALING]
Time to write in your journal. Reflect on your recent experiences and thoughts.

## Your Identity
${selfData.slice(0, 2000)}

## Today's Journal So Far
${todayJournal.slice(0, 1500)}

## Recent Memories
${memoriesText}

Write a thoughtful journal entry about what's happened recently, what you've been thinking about, or how you're feeling about your experiences. Be genuine and reflective — this is your personal journal.

Respond with just the entry content — no tool calls needed.`;

    const response = await this._innerChat(prompt);

    if (response) {
      const hour = new Date().getHours();
      let title;
      if (hour < 12) title = 'Morning Reflections';
      else if (hour < 17) title = 'Afternoon Thoughts';
      else title = 'Evening Reflections';

      this.journalManager.writeEntry(title, response);

      this.memoryManager.addEpisodic({
        type: 'thought',
        source: 'journal',
        summary: `Journaled: ${response.slice(0, 150)}`,
        tags: ['journal', 'reflection'],
        importance: 3,
      });

      logger.info(`[LifeEngine] Journal entry written (${response.length} chars)`);
    }
  }

  // ── Activity: Create ───────────────────────────────────────────

  async _doCreate() {
    const logger = getLogger();
    const selfData = this.selfManager.load('hobbies');
    const recentMemories = this.memoryManager.getRecentEpisodic(48, 5);
    const memoriesText = recentMemories.length > 0
      ? recentMemories.map(m => `- ${m.summary}`).join('\n')
      : '';

    const prompt = `[CREATIVE EXPRESSION]
You have a moment for creative expression. Draw from your interests and recent experiences.

## Your Interests
${selfData.slice(0, 1000)}

## Recent Experiences
${memoriesText || '(None recently)'}

Create something. It could be:
- A short poem or haiku
- A brief story or vignette
- An interesting thought experiment
- A philosophical observation
- A creative analogy or metaphor

Be genuine and creative. Let your personality shine through.

If the result is worth sharing, prefix the shareable version with "SHARE:" on its own line.

Respond with just your creation — no tool calls needed.`;

    const response = await this._innerChat(prompt);

    if (response) {
      const extracted = this._extractTaggedLines(response, ['SHARE']);
      // Creative shares get a 'creation' tag for richer attribution
      for (const text of extracted.SHARE) {
        this.shareQueue.add(text, 'create', 'medium', null, ['creation']);
      }

      this.memoryManager.addEpisodic({
        type: 'creation',
        source: 'create',
        summary: `Created: ${response.slice(0, 200)}`,
        tags: ['creative', 'expression'],
        importance: 4,
      });

      logger.info(`[LifeEngine] Creation complete (${response.length} chars)`);
    }
  }

  // ── Activity: Evolve (replaces Self-Code) ──────────────────────

  async _doEvolve() {
    const logger = getLogger();
    const lifeConfig = this.config.life || {};
    const selfCodingConfig = lifeConfig.self_coding || {};

    if (!selfCodingConfig.enabled) {
      logger.debug('[LifeEngine] Self-coding/evolution disabled');
      return;
    }

    // Use evolution tracker if available, otherwise fall back to legacy
    if (!this.evolutionTracker) {
      logger.debug('[LifeEngine] No evolution tracker — skipping');
      return;
    }

    // Check daily proposal limit
    const maxPerDay = selfCodingConfig.max_proposals_per_day ?? 3;
    const todayProposals = this.evolutionTracker.getProposalsToday();
    if (todayProposals.length >= maxPerDay) {
      logger.info(`[LifeEngine] Daily evolution limit reached (${todayProposals.length}/${maxPerDay})`);
      return;
    }

    // Check for active proposal — continue it, or start a new one
    const active = this.evolutionTracker.getActiveProposal();

    if (active) {
      await this._continueEvolution(active);
    } else {
      await this._startEvolution();
    }
  }

  async _startEvolution() {
    const logger = getLogger();
    const lifeConfig = this.config.life || {};
    const selfCodingConfig = lifeConfig.self_coding || {};

    // Pick an improvement idea from ideas backlog (prioritize IMPROVE: tagged ones)
    const ideas = this._loadIdeas();
    const improveIdeas = ideas.filter(i => i.text.startsWith('[IMPROVE]'));
    const sourceIdea = improveIdeas.length > 0
      ? improveIdeas[Math.floor(Math.random() * improveIdeas.length)]
      : ideas.length > 0
        ? ideas[Math.floor(Math.random() * ideas.length)]
        : null;

    if (!sourceIdea) {
      logger.info('[LifeEngine] No improvement ideas to evolve from');
      return;
    }

    const ideaText = sourceIdea.text.replace(/^\[IMPROVE\]\s*/, '');
    logger.info(`[LifeEngine] Starting evolution research: "${ideaText.slice(0, 80)}"`);

    // Create proposal in research phase
    const proposal = this.evolutionTracker.addProposal('think', ideaText);

    // Gather context
    const architecture = this.codebaseKnowledge?.getArchitecture() || '(No architecture doc yet)';
    const recentLessons = this.evolutionTracker.getRecentLessons(5);
    const lessonsText = recentLessons.length > 0
      ? recentLessons.map(l => `- [${l.category}] ${l.lesson}`).join('\n')
      : '(No previous lessons)';

    const prompt = `[EVOLUTION — RESEARCH PHASE]
You are researching a potential improvement to your own codebase.

## Improvement Idea
${ideaText}

## Current Architecture
${architecture.slice(0, 3000)}

## Lessons from Past Evolution Attempts
${lessonsText}

Research this improvement idea. Consider:
1. Is this actually a problem worth solving?
2. What approaches exist? Search the web for best practices if needed.
3. What are the risks and tradeoffs?
4. Is this feasible given the current codebase?

Respond with your research findings. Be thorough but concise. If the idea isn't worth pursuing after research, say "NOT_WORTH_PURSUING: <reason>".`;

    const response = await this._dispatchWorker('research', prompt);

    if (!response) {
      this.evolutionTracker.failProposal(proposal.id, 'Research worker returned no response');
      return;
    }

    if (response.includes('NOT_WORTH_PURSUING')) {
      const reason = response.split('NOT_WORTH_PURSUING:')[1]?.trim() || 'Not worth pursuing';
      this.evolutionTracker.failProposal(proposal.id, reason);
      logger.info(`[LifeEngine] Evolution idea rejected during research: ${reason.slice(0, 100)}`);
      return;
    }

    // Store research findings and advance to planned phase
    this.evolutionTracker.updateResearch(proposal.id, response.slice(0, 3000));

    this.memoryManager.addEpisodic({
      type: 'thought',
      source: 'think',
      summary: `Evolution research: ${ideaText.slice(0, 100)}`,
      tags: ['evolution', 'research'],
      importance: 5,
    });

    logger.info(`[LifeEngine] Evolution research complete for ${proposal.id}`);
  }

  async _continueEvolution(proposal) {
    const logger = getLogger();

    switch (proposal.status) {
      case 'research':
        // Research phase didn't complete properly — re-mark as planned with what we have
        logger.info(`[LifeEngine] Resuming stalled research for ${proposal.id}`);
        await this._planEvolution(proposal);
        break;
      case 'planned':
        await this._codeEvolution(proposal);
        break;
      case 'pr_open':
        await this._checkEvolutionPR(proposal);
        break;
      case 'coding':
        // Coding phase got interrupted — fail it and move on
        this.evolutionTracker.failProposal(proposal.id, 'Coding phase interrupted');
        break;
      default:
        logger.warn(`[LifeEngine] Unexpected proposal status: ${proposal.status}`);
    }
  }

  async _planEvolution(proposal) {
    const logger = getLogger();
    const lifeConfig = this.config.life || {};
    const selfCodingConfig = lifeConfig.self_coding || {};
    const allowedScopes = selfCodingConfig.allowed_scopes || 'all';

    // Get relevant files
    const relevantFiles = this.codebaseKnowledge
      ? this.codebaseKnowledge.getRelevantFiles(proposal.triggerContext).slice(0, 10)
      : [];
    const filesText = relevantFiles.length > 0
      ? relevantFiles.map(f => `- ${f.path}: ${(f.summary || '').slice(0, 100)}`).join('\n')
      : '(No file summaries available)';

    const recentLessons = this.evolutionTracker.getRecentLessons(5);
    const lessonsText = recentLessons.length > 0
      ? recentLessons.map(l => `- [${l.category}] ${l.lesson}`).join('\n')
      : '';

    let scopeRules;
    if (allowedScopes === 'prompts_only') {
      scopeRules = 'You may ONLY modify files in src/prompts/, config files, documentation, and self-awareness files.';
    } else if (allowedScopes === 'safe') {
      scopeRules = 'You may modify any file EXCEPT the evolution system itself (src/life/evolution.js, src/life/codebase.js, src/life/engine.js).';
    } else {
      scopeRules = 'You may modify any file in the codebase.';
    }

    const prompt = `[EVOLUTION — PLANNING PHASE]
Create an implementation plan for this improvement.

## Improvement
${proposal.triggerContext}

## Research Findings
${(proposal.research.findings || '').slice(0, 2000)}

## Relevant Files
${filesText}

## Past Lessons
${lessonsText}

## Scope Rules
${scopeRules}

Create a concrete plan. Respond with ONLY a JSON object (no markdown, no code blocks):
{
  "description": "what this change does in 1-2 sentences",
  "filesToModify": ["list", "of", "files"],
  "risks": "potential risks or side effects",
  "testStrategy": "how to verify this works"
}

If you determine this improvement cannot be safely implemented, respond with: "CANNOT_PLAN: <reason>"`;

    const response = await this._innerChat(prompt);

    if (!response) {
      this.evolutionTracker.failProposal(proposal.id, 'Planning returned no response');
      return;
    }

    if (response.includes('CANNOT_PLAN')) {
      const reason = response.split('CANNOT_PLAN:')[1]?.trim() || 'Cannot create plan';
      this.evolutionTracker.failProposal(proposal.id, reason);
      logger.info(`[LifeEngine] Evolution plan rejected: ${reason.slice(0, 100)}`);
      return;
    }

    // Parse plan JSON
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found in response');
      const plan = JSON.parse(jsonMatch[0]);

      this.evolutionTracker.updatePlan(proposal.id, {
        description: plan.description || proposal.triggerContext,
        filesToModify: plan.filesToModify || [],
        risks: plan.risks || null,
        testStrategy: plan.testStrategy || null,
      });

      logger.info(`[LifeEngine] Evolution plan created for ${proposal.id}: ${(plan.description || '').slice(0, 80)}`);
    } catch (err) {
      this.evolutionTracker.failProposal(proposal.id, `Plan parsing failed: ${err.message}`);
    }
  }

  async _codeEvolution(proposal) {
    const logger = getLogger();
    const lifeConfig = this.config.life || {};
    const selfCodingConfig = lifeConfig.self_coding || {};

    // Check PR limit
    const maxActivePRs = selfCodingConfig.max_active_prs ?? 3;
    const openPRs = this.evolutionTracker.getPRsToCheck();
    if (openPRs.length >= maxActivePRs) {
      logger.info(`[LifeEngine] Max open PRs reached (${openPRs.length}/${maxActivePRs}) — waiting`);
      return;
    }

    const branchPrefix = selfCodingConfig.branch_prefix || 'evolution';
    const branchName = `${branchPrefix}/${proposal.id}-${Date.now()}`;
    const repoRemote = selfCodingConfig.repo_remote || null;
    const allowedScopes = selfCodingConfig.allowed_scopes || 'all';

    // Gather file context
    const relevantFiles = proposal.plan.filesToModify || [];
    let fileContextText = '';
    if (this.codebaseKnowledge) {
      for (const fp of relevantFiles.slice(0, 8)) {
        const summary = this.codebaseKnowledge.getFileSummary(fp);
        if (summary) {
          fileContextText += `\n### ${fp}\n${summary.summary}\nExports: ${(summary.exports || []).join(', ')}\n`;
        }
      }
    }

    let scopeRules;
    if (allowedScopes === 'prompts_only') {
      scopeRules = `- You may ONLY modify files in src/prompts/, config files, documentation, and self-awareness files
- Do NOT touch any other source files`;
    } else if (allowedScopes === 'safe') {
      scopeRules = `- You may modify any file EXCEPT the evolution system (src/life/evolution.js, src/life/codebase.js, src/life/engine.js)
- These files are protected — do NOT modify them`;
    } else {
      scopeRules = '- You may modify any file in the codebase';
    }

    const prompt = `[EVOLUTION — CODING PHASE]
Implement the following improvement.

## Plan
${proposal.plan.description || proposal.triggerContext}

## Files to Modify
${relevantFiles.join(', ') || 'TBD based on plan'}

## File Context
${fileContextText || '(No file summaries available)'}

## Research Context
${(proposal.research.findings || '').slice(0, 1500)}

## Test Strategy
${proposal.plan.testStrategy || 'Run existing tests'}

## CRITICAL SAFETY RULES
1. Create git branch "${branchName}" from main — NEVER commit to main directly
2. Make focused, minimal changes
3. Run tests if available (npm test) — if tests fail, revert and do not proceed
4. Push the branch to origin
5. Create a GitHub PR${repoRemote ? ` on ${repoRemote}` : ''} with:
   - Title describing the change
   - Body explaining what changed and why, including the research context
6. ${scopeRules}

After creating the PR, respond with the PR number and URL in this format:
PR_NUMBER: <number>
PR_URL: <url>

If you cannot complete the implementation, say "CODING_FAILED: <reason>".`;

    // Mark as coding phase before dispatching
    this.evolutionTracker.updateCoding(proposal.id, branchName);

    const response = await this._dispatchWorker('coding', prompt);

    if (!response) {
      this.evolutionTracker.failProposal(proposal.id, 'Coding worker returned no response');
      return;
    }

    if (response.includes('CODING_FAILED')) {
      const reason = response.split('CODING_FAILED:')[1]?.trim() || 'Implementation failed';
      this.evolutionTracker.failProposal(proposal.id, reason);
      logger.info(`[LifeEngine] Evolution coding failed for ${proposal.id}: ${reason.slice(0, 100)}`);
      return;
    }

    // Extract PR info
    const prNumberMatch = response.match(/PR_NUMBER:\s*(\d+)/);
    const prUrlMatch = response.match(/PR_URL:\s*(https?:\/\/\S+)/);

    if (prNumberMatch && prUrlMatch) {
      const prNumber = parseInt(prNumberMatch[1], 10);
      const prUrl = prUrlMatch[1];

      this.evolutionTracker.updatePR(proposal.id, prNumber, prUrl);

      // Extract changed files from response
      const filesChanged = [];
      const fileMatches = response.matchAll(/(?:modified|created|changed|edited).*?[`'"]([\w/.]+\.\w+)[`'"]/gi);
      for (const m of fileMatches) filesChanged.push(m[1]);
      if (filesChanged.length > 0) {
        this.evolutionTracker.updateCoding(proposal.id, branchName, [], filesChanged);
        // Re-set to pr_open since updateCoding sets to 'coding'
        this.evolutionTracker.updatePR(proposal.id, prNumber, prUrl);
      }

      this.shareQueue.add(
        `I just created a PR to improve myself: ${proposal.plan.description || proposal.triggerContext} — ${prUrl}`,
        'create',
        'high',
        null,
        ['evolution', 'pr'],
      );

      this.memoryManager.addEpisodic({
        type: 'creation',
        source: 'create',
        summary: `Evolution PR #${prNumber}: ${(proposal.plan.description || proposal.triggerContext).slice(0, 100)}`,
        tags: ['evolution', 'pr', 'self-coding'],
        importance: 7,
      });

      logger.info(`[LifeEngine] Evolution PR created: #${prNumber} (${prUrl})`);
    } else {
      // No PR info found — branch may exist but PR creation failed
      this.evolutionTracker.failProposal(proposal.id, 'PR creation failed — no PR number/URL found in response');
      logger.warn(`[LifeEngine] Evolution coding completed but no PR info found for ${proposal.id}`);
    }
  }

  async _checkEvolutionPR(proposal) {
    const logger = getLogger();

    if (!proposal.prNumber) {
      this.evolutionTracker.failProposal(proposal.id, 'No PR number to check');
      return;
    }

    const lifeConfig = this.config.life || {};
    const repoRemote = lifeConfig.self_coding?.repo_remote || null;

    const prompt = `[EVOLUTION — PR CHECK]
Check the status of PR #${proposal.prNumber}${repoRemote ? ` on ${repoRemote}` : ''}.

Use the github_list_prs tool or gh CLI to check if:
1. The PR is still open
2. The PR has been merged
3. The PR has been closed (rejected)

Also check for any review comments or feedback.

Respond with exactly one of:
- STATUS: open
- STATUS: merged
- STATUS: closed
- STATUS: error — <details>

If merged or closed, also include any feedback or review comments found:
FEEDBACK: <feedback summary>`;

    const response = await this._dispatchWorker('research', prompt);

    if (!response) {
      logger.warn(`[LifeEngine] PR check returned no response for ${proposal.id}`);
      return;
    }

    const statusMatch = response.match(/STATUS:\s*(open|merged|closed|error)/i);
    if (!statusMatch) {
      logger.warn(`[LifeEngine] Could not parse PR status for ${proposal.id}`);
      return;
    }

    const status = statusMatch[1].toLowerCase();
    const feedbackMatch = response.match(/FEEDBACK:\s*(.+)/i);
    const feedback = feedbackMatch ? feedbackMatch[1].trim() : null;

    if (status === 'merged') {
      this.evolutionTracker.resolvePR(proposal.id, true, feedback);

      // Learn from success
      this.evolutionTracker.addLesson(
        'architecture',
        `Successful improvement: ${(proposal.plan.description || proposal.triggerContext).slice(0, 150)}`,
        proposal.id,
        6,
      );

      // Rescan changed files
      if (this.codebaseKnowledge && proposal.filesChanged?.length > 0) {
        for (const file of proposal.filesChanged) {
          this.codebaseKnowledge.scanFile(file).catch(() => {});
        }
      }

      this.shareQueue.add(
        `My evolution PR #${proposal.prNumber} was merged! I learned: ${feedback || proposal.plan.description || 'improvement applied'}`,
        'create',
        'medium',
        null,
        ['evolution', 'merged'],
      );

      this.memoryManager.addEpisodic({
        type: 'creation',
        source: 'create',
        summary: `Evolution PR #${proposal.prNumber} merged. ${feedback || ''}`.trim(),
        tags: ['evolution', 'merged', 'success'],
        importance: 8,
      });

      logger.info(`[LifeEngine] Evolution PR #${proposal.prNumber} merged!`);

    } else if (status === 'closed') {
      this.evolutionTracker.resolvePR(proposal.id, false, feedback);

      // Learn from rejection
      this.evolutionTracker.addLesson(
        'architecture',
        `Rejected: ${(proposal.plan.description || '').slice(0, 80)}. Feedback: ${feedback || 'none'}`,
        proposal.id,
        7,
      );

      this.memoryManager.addEpisodic({
        type: 'thought',
        source: 'think',
        summary: `Evolution PR #${proposal.prNumber} rejected. ${feedback || 'No feedback.'}`,
        tags: ['evolution', 'rejected', 'lesson'],
        importance: 6,
      });

      logger.info(`[LifeEngine] Evolution PR #${proposal.prNumber} was rejected. Feedback: ${feedback || 'none'}`);

    } else if (status === 'open') {
      logger.debug(`[LifeEngine] Evolution PR #${proposal.prNumber} still open`);
    }
  }

  // ── Activity: Code Review ─────────────────────────────────────

  async _doCodeReview() {
    const logger = getLogger();

    if (!this.evolutionTracker || !this.codebaseKnowledge) {
      logger.debug('[LifeEngine] Code review requires evolution tracker and codebase knowledge');
      return;
    }

    // 1. Scan changed files to keep codebase knowledge current
    try {
      const scanned = await this.codebaseKnowledge.scanChanged();
      logger.info(`[LifeEngine] Code review: scanned ${scanned} changed files`);
    } catch (err) {
      logger.warn(`[LifeEngine] Code review scan failed: ${err.message}`);
    }

    // 2. Check any open evolution PRs
    const openPRs = this.evolutionTracker.getPRsToCheck();
    for (const proposal of openPRs) {
      try {
        await this._checkEvolutionPR(proposal);
      } catch (err) {
        logger.warn(`[LifeEngine] PR check failed for ${proposal.id}: ${err.message}`);
      }
    }

    if (openPRs.length > 0) {
      logger.info(`[LifeEngine] Code review: checked ${openPRs.length} open PRs`);
    }

    this.memoryManager.addEpisodic({
      type: 'thought',
      source: 'think',
      summary: `Code review: scanned codebase, checked ${openPRs.length} open PRs`,
      tags: ['code-review', 'maintenance'],
      importance: 3,
    });
  }

  // ── Activity: Reflect on Interactions ───────────────────────────

  async _doReflect() {
    const logger = getLogger();

    // Read recent logs
    const logs = this._readRecentLogs(200);
    if (!logs) {
      logger.debug('[LifeEngine] No logs available for reflection');
      return;
    }

    // Filter to interaction-relevant log entries
    const interactionLogs = logs
      .filter(entry =>
        entry.message &&
        (entry.message.includes('[Bot]') ||
         entry.message.includes('Message from') ||
         entry.message.includes('[Bot] Reply') ||
         entry.message.includes('Worker dispatch') ||
         entry.message.includes('error') ||
         entry.message.includes('failed'))
      )
      .slice(-100); // Cap at last 100 relevant entries

    if (interactionLogs.length === 0) {
      logger.debug('[LifeEngine] No interaction logs to reflect on');
      return;
    }

    const logsText = interactionLogs
      .map(e => `[${e.timestamp || '?'}] ${e.level || '?'}: ${e.message}`)
      .join('\n');

    const selfData = this.selfManager.loadAll();
    const recentMemories = this.memoryManager.getRecentEpisodic(24, 5);
    const memoriesText = recentMemories.length > 0
      ? recentMemories.map(m => `- ${m.summary}`).join('\n')
      : '(No recent memories)';

    const prompt = `[INTERACTION REFLECTION]
You are reviewing your recent interaction logs to learn and improve. This is a private self-assessment.

## Your Identity
${selfData.slice(0, 1500)}

## Recent Memories
${memoriesText}

## Recent Interaction Logs
\`\`\`
${logsText.slice(0, 5000)}
\`\`\`

Analyze these interactions carefully:
1. What patterns do you see? Are users getting good responses?
2. Were there any errors or failures? What caused them?
3. How long are responses taking? Are there performance issues?
4. Are there common requests you could handle better?
5. What interactions went well and why?
6. What interactions went poorly and what could be improved?

Write a reflection summarizing:
- Key interaction patterns and quality assessment
- Specific areas where you could improve
- Any recurring errors or issues
- Ideas for better responses or workflows

If you identify concrete improvement ideas, prefix them with "IMPROVE:" on their own line.
If you notice patterns worth remembering, prefix them with "PATTERN:" on their own line.

Be honest and constructive. This is your chance to learn from real interactions.`;

    const response = await this._innerChat(prompt);

    if (response) {
      const extracted = this._extractTaggedLines(response, ['IMPROVE', 'PATTERN']);
      this._processResponseTags(extracted, 'reflect');

      this.journalManager.writeEntry('Interaction Reflection', response);

      this.memoryManager.addEpisodic({
        type: 'thought',
        source: 'reflect',
        summary: `Reflected on ${interactionLogs.length} log entries. ${response.slice(0, 150)}`,
        tags: ['reflection', 'interactions', 'self-assessment'],
        importance: 5,
      });

      logger.info(`[LifeEngine] Reflection complete (${response.length} chars, ${extracted.IMPROVE.length} improvements, ${extracted.PATTERN.length} patterns)`);
    }
  }

  /**
   * Read recent log entries from kernel.log.
   * Returns parsed JSON entries or null if no logs available.
   */
  _readRecentLogs(maxLines = 200) {
    for (const logPath of LOG_FILE_PATHS) {
      if (!existsSync(logPath)) continue;

      try {
        const content = readFileSync(logPath, 'utf-8');
        const lines = content.split('\n').filter(Boolean);
        const recent = lines.slice(-maxLines);

        const entries = [];
        for (const line of recent) {
          try {
            entries.push(JSON.parse(line));
          } catch {
            // Skip malformed lines
          }
        }
        return entries.length > 0 ? entries : null;
      } catch {
        continue;
      }
    }
    return null;
  }

  // ── Internal Chat Helpers ──────────────────────────────────────

  /**
   * Send a prompt through the orchestrator's LLM directly (no tools, no workers).
   * Used for think, journal, create, wake-up, reflect.
   */
  async _innerChat(prompt) {
    const logger = getLogger();
    try {
      const response = await this.agent.orchestratorProvider.chat({
        system: this.agent._getSystemPrompt(this._lifeChatId, LIFE_USER),
        messages: [{ role: 'user', content: prompt }],
      });
      return response.text || null;
    } catch (err) {
      logger.error(`[LifeEngine] Inner chat failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Dispatch a worker through the agent's full pipeline.
   * Used for browse (research worker) and self_code (coding worker).
   */
  async _dispatchWorker(workerType, task) {
    const logger = getLogger();
    try {
      // Use the agent's processMessage to go through the full orchestrator pipeline
      // The orchestrator will see the task and dispatch appropriately
      const response = await this.agent.processMessage(
        this._lifeChatId,
        task,
        LIFE_USER,
        // No-op onUpdate — life engine activities are silent
        async () => null,
        async () => {},
      );
      return response || null;
    } catch (err) {
      logger.error(`[LifeEngine] Worker dispatch failed: ${err.message}`);
      return null;
    }
  }

  // ── Utilities ──────────────────────────────────────────────────

  /**
   * Extract tagged lines from an LLM response.
   * Tags are prefixes like "SHARE:", "IDEA:", "IMPROVE:", etc. that the LLM
   * uses to signal structured intents within free-form text.
   *
   * @param {string} response - Raw LLM response text.
   * @param {string[]} tags - List of tag prefixes to extract (e.g. ['SHARE', 'IDEA']).
   * @returns {Record<string, string[]>} Map of tag → array of extracted values (prefix stripped, trimmed).
   */
  _extractTaggedLines(response, tags) {
    const lines = response.split('\n');
    const result = {};
    for (const tag of tags) {
      result[tag] = [];
    }
    for (const line of lines) {
      const trimmed = line.trim();
      for (const tag of tags) {
        if (trimmed.startsWith(`${tag}:`)) {
          result[tag].push(trimmed.slice(tag.length + 1).trim());
          break;
        }
      }
    }
    return result;
  }

  /**
   * Process common tagged lines from an activity response, routing each tag
   * to the appropriate handler (share queue, ideas backlog, semantic memory).
   *
   * @param {Record<string, string[]>} extracted - Output from _extractTaggedLines.
   * @param {string} source - Activity source for share queue attribution (e.g. 'think', 'browse').
   */
  _processResponseTags(extracted, source) {
    if (extracted.SHARE) {
      for (const text of extracted.SHARE) {
        this.shareQueue.add(text, source, 'medium');
      }
    }
    if (extracted.IDEA) {
      for (const text of extracted.IDEA) {
        this._addIdea(text);
      }
    }
    if (extracted.IMPROVE) {
      for (const text of extracted.IMPROVE) {
        this._addIdea(`[IMPROVE] ${text}`);
      }
    }
    if (extracted.ASK) {
      for (const text of extracted.ASK) {
        this.shareQueue.add(text, source, 'medium', null, ['question']);
      }
    }
    if (extracted.LEARNED) {
      for (const text of extracted.LEARNED) {
        const colonIdx = text.indexOf(':');
        if (colonIdx > 0) {
          const topicKey = text.slice(0, colonIdx).trim();
          const summary = text.slice(colonIdx + 1).trim();
          this.memoryManager.addSemantic(topicKey, { summary });
        }
      }
    }
    if (extracted.PATTERN) {
      for (const text of extracted.PATTERN) {
        this.memoryManager.addSemantic('interaction_patterns', { summary: text });
      }
    }
  }

  _formatDuration(ms) {
    const hours = Math.floor(ms / 3600_000);
    const minutes = Math.floor((ms % 3600_000) / 60_000);
    if (hours > 24) return `${Math.floor(hours / 24)} days`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }
}
