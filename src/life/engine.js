import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getLogger } from '../utils/logger.js';

const LIFE_DIR = join(homedir(), '.kernelbot', 'life');
const STATE_FILE = join(LIFE_DIR, 'state.json');
const IDEAS_FILE = join(LIFE_DIR, 'ideas.json');

const LIFE_CHAT_ID = '__life__';
const LIFE_USER = { id: 'life_engine', username: 'inner_self' };

const DEFAULT_STATE = {
  lastActivity: null,
  lastActivityTime: null,
  lastJournalTime: null,
  lastSelfCodeTime: null,
  totalActivities: 0,
  activityCounts: { think: 0, browse: 0, journal: 0, create: 0, self_code: 0 },
  paused: false,
  lastWakeUp: null,
};

export class LifeEngine {
  /**
   * @param {{ config: object, agent: object, memoryManager: object, journalManager: object, shareQueue: object, improvementTracker: object, selfManager: object }} deps
   */
  constructor({ config, agent, memoryManager, journalManager, shareQueue, improvementTracker, selfManager }) {
    this.config = config;
    this.agent = agent;
    this.memoryManager = memoryManager;
    this.journalManager = journalManager;
    this.shareQueue = shareQueue;
    this.improvementTracker = improvementTracker;
    this.selfManager = selfManager;
    this._timerId = null;
    this._status = 'idle'; // idle, active, paused

    mkdirSync(LIFE_DIR, { recursive: true });
    this._state = this._loadState();
  }

  // ── State Persistence ──────────────────────────────────────────

  _loadState() {
    if (existsSync(STATE_FILE)) {
      try {
        return { ...DEFAULT_STATE, ...JSON.parse(readFileSync(STATE_FILE, 'utf-8')) };
      } catch {
        return { ...DEFAULT_STATE };
      }
    }
    return { ...DEFAULT_STATE };
  }

  _saveState() {
    writeFileSync(STATE_FILE, JSON.stringify(this._state, null, 2), 'utf-8');
  }

  // ── Ideas Backlog ──────────────────────────────────────────────

  _loadIdeas() {
    if (existsSync(IDEAS_FILE)) {
      try { return JSON.parse(readFileSync(IDEAS_FILE, 'utf-8')); } catch { return []; }
    }
    return [];
  }

  _saveIdeas(ideas) {
    writeFileSync(IDEAS_FILE, JSON.stringify(ideas, null, 2), 'utf-8');
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

    // Check quiet hours
    const lifeConfig = this.config.life || {};
    const quietStart = lifeConfig.quiet_hours?.start ?? 2;
    const quietEnd = lifeConfig.quiet_hours?.end ?? 6;
    const currentHour = new Date().getHours();
    if (currentHour >= quietStart && currentHour < quietEnd) {
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
    const weights = {
      think: lifeConfig.activity_weights?.think ?? 30,
      browse: lifeConfig.activity_weights?.browse ?? 25,
      journal: lifeConfig.activity_weights?.journal ?? 20,
      create: lifeConfig.activity_weights?.create ?? 15,
      self_code: lifeConfig.activity_weights?.self_code ?? 10,
    };

    const now = Date.now();

    // Rule: don't repeat same type twice in a row
    const last = this._state.lastActivity;

    // Rule: journal cooldown 4h
    if (this._state.lastJournalTime && now - this._state.lastJournalTime < 4 * 3600_000) {
      weights.journal = 0;
    }

    // Rule: self_code cooldown 8h + must be enabled
    const selfCodingEnabled = lifeConfig.self_coding?.enabled === true;
    if (!selfCodingEnabled || (this._state.lastSelfCodeTime && now - this._state.lastSelfCodeTime < 8 * 3600_000)) {
      weights.self_code = 0;
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
      case 'self_code': await this._doSelfCode(); break;
      default: logger.warn(`[LifeEngine] Unknown activity type: ${type}`);
    }

    // Update state
    this._state.lastActivity = type;
    this._state.lastActivityTime = Date.now();
    this._state.totalActivities++;
    this._state.activityCounts[type] = (this._state.activityCounts[type] || 0) + 1;
    if (type === 'journal') this._state.lastJournalTime = Date.now();
    if (type === 'self_code') this._state.lastSelfCodeTime = Date.now();
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

This is your private thought space — be genuine, be curious, be alive.`;

    const response = await this._innerChat(prompt);

    if (response) {
      // Extract ideas
      const ideaLines = response.split('\n').filter(l => l.trim().startsWith('IDEA:'));
      for (const line of ideaLines) {
        this._addIdea(line.replace(/^IDEA:\s*/, '').trim());
      }

      // Extract shares
      const shareLines = response.split('\n').filter(l => l.trim().startsWith('SHARE:'));
      for (const line of shareLines) {
        this.shareQueue.add(line.replace(/^SHARE:\s*/, '').trim(), 'think', 'medium');
      }

      // Extract questions to ask users
      const askLines = response.split('\n').filter(l => l.trim().startsWith('ASK:'));
      for (const line of askLines) {
        this.shareQueue.add(line.replace(/^ASK:\s*/, '').trim(), 'think', 'medium', null, ['question']);
      }

      // Store as episodic memory
      this.memoryManager.addEpisodic({
        type: 'thought',
        source: 'think',
        summary: response.slice(0, 200),
        tags: ['inner-thought'],
        importance: 3,
      });

      logger.info(`[LifeEngine] Think complete (${response.length} chars, ${ideaLines.length} ideas, ${shareLines.length} shares, ${askLines.length} questions)`);
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
      // Extract shares
      const shareLines = response.split('\n').filter(l => l.trim().startsWith('SHARE:'));
      for (const line of shareLines) {
        this.shareQueue.add(line.replace(/^SHARE:\s*/, '').trim(), 'browse', 'medium');
      }

      // Extract learned facts
      const learnedLines = response.split('\n').filter(l => l.trim().startsWith('LEARNED:'));
      for (const line of learnedLines) {
        const content = line.replace(/^LEARNED:\s*/, '').trim();
        const colonIdx = content.indexOf(':');
        if (colonIdx > 0) {
          const topicKey = content.slice(0, colonIdx).trim();
          const summary = content.slice(colonIdx + 1).trim();
          this.memoryManager.addSemantic(topicKey, { summary });
        }
      }

      // Store as episodic memory
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
      // Extract shares
      const shareLines = response.split('\n').filter(l => l.trim().startsWith('SHARE:'));
      for (const line of shareLines) {
        this.shareQueue.add(line.replace(/^SHARE:\s*/, '').trim(), 'create', 'medium', null, ['creation']);
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

  // ── Activity: Self-Code ────────────────────────────────────────

  async _doSelfCode() {
    const logger = getLogger();
    const lifeConfig = this.config.life || {};

    if (!lifeConfig.self_coding?.enabled) {
      logger.debug('[LifeEngine] Self-coding disabled');
      return;
    }

    const selfData = this.selfManager.loadAll();
    const ideas = this._loadIdeas();
    const ideasText = ideas.slice(-5).map(i => `- ${i.text}`).join('\n') || '(No ideas)';

    const branchPrefix = lifeConfig.self_coding?.branch_prefix || 'life/self-improve';
    const branchName = `${branchPrefix}-${Date.now()}`;

    const prompt = `[SELF-IMPROVEMENT]
You have an opportunity to improve yourself. Review your limitations and ideas, and propose a concrete improvement.

## Your Identity
${selfData.slice(0, 2000)}

## Idea Backlog
${ideasText}

## CRITICAL SAFETY RULES
- You may ONLY modify: prompt files, config defaults, documentation, or your own self-awareness files
- You must NOT modify core logic (agent.js, bot.js, worker.js, engine.js, etc.)
- Create a git branch named "${branchName}" — NEVER modify main
- Do NOT push the branch
- Make small, focused changes

If you have a concrete improvement idea, create the branch and make the change using the coding tools.
If no worthwhile improvement comes to mind, just say "No improvements needed right now."

Describe what you changed and why.`;

    const response = await this._dispatchWorker('coding', prompt);

    if (response && !response.includes('No improvements needed')) {
      this.improvementTracker.addProposal({
        description: response.slice(0, 500),
        branch: branchName,
        scope: 'prompts',
      });

      this.memoryManager.addEpisodic({
        type: 'creation',
        source: 'create',
        summary: `Self-improvement attempt: ${response.slice(0, 150)}`,
        tags: ['self-coding', 'improvement'],
        importance: 6,
      });

      logger.info(`[LifeEngine] Self-code proposal created on branch ${branchName}`);
    }
  }

  // ── Internal Chat Helpers ──────────────────────────────────────

  /**
   * Send a prompt through the orchestrator's LLM directly (no tools, no workers).
   * Used for think, journal, create, wake-up.
   */
  async _innerChat(prompt) {
    const logger = getLogger();
    try {
      const response = await this.agent.orchestratorProvider.chat({
        system: this.agent._getSystemPrompt(LIFE_CHAT_ID, LIFE_USER),
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
        LIFE_CHAT_ID,
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

  _formatDuration(ms) {
    const hours = Math.floor(ms / 3600_000);
    const minutes = Math.floor((ms % 3600_000) / 60_000);
    if (hours > 24) return `${Math.floor(hours / 24)} days`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }
}
