import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { Automation } from './automation.js';
import { scheduleNext, cancel } from './scheduler.js';
import { getLogger } from '../utils/logger.js';
import { isQuietHours, msUntilQuietEnd } from '../utils/timeUtils.js';

const DATA_DIR = join(homedir(), '.kernelbot');
const DATA_FILE = join(DATA_DIR, 'automations.json');

const DEFAULT_MAX_PER_CHAT = 10;
const DEFAULT_MIN_INTERVAL = 5; // minutes

export class AutomationManager {
  constructor() {
    /** @type {Map<string, Automation>} id → Automation */
    this.automations = new Map();
    /** @type {Map<string, any>} id → timer ID */
    this.timers = new Map();
    /** @type {Map<string, Promise>} chatId → execution chain (serialize per chat) */
    this._chatLocks = new Map();

    // Injected via init()
    this._sendMessage = null;
    this._sendChatAction = null;
    this._agentFactory = null;
    this._config = null;

    this._load();
  }

  /**
   * Initialize with bot context. Called after bot is created.
   * @param {object} opts
   * @param {Function} opts.sendMessage - (chatId, text, opts?) => Promise
   * @param {Function} opts.sendChatAction - (chatId, action) => Promise
   * @param {Function} opts.agentFactory - (chatId) => { agent, onUpdate, sendPhoto }
   * @param {object} opts.config
   */
  init({ sendMessage, sendChatAction, agentFactory, config }) {
    this._sendMessage = sendMessage;
    this._sendChatAction = sendChatAction;
    this._agentFactory = agentFactory;
    this._config = config;
  }

  /** Arm all enabled automations (called on startup). */
  startAll() {
    const logger = getLogger();
    let armed = 0;
    for (const auto of this.automations.values()) {
      if (auto.enabled) {
        this._arm(auto);
        armed++;
      }
    }
    if (armed > 0) {
      logger.info(`[AutomationManager] Armed ${armed} automation(s) on startup`);
    }
  }

  /** Cancel all timers (called on shutdown). */
  shutdown() {
    for (const timerId of this.timers.values()) {
      cancel(timerId);
    }
    this.timers.clear();
  }

  // ── CRUD ──────────────────────────────────────────────────────────

  /**
   * Create a new automation.
   * @param {string} chatId
   * @param {object} data - { name, description, schedule }
   * @returns {Automation}
   */
  create(chatId, data) {
    const logger = getLogger();

    // Enforce limits
    const chatAutos = this.listForChat(chatId);
    const maxPerChat = this._config?.automation?.max_per_chat || DEFAULT_MAX_PER_CHAT;
    if (chatAutos.length >= maxPerChat) {
      throw new Error(`Maximum automations per chat (${maxPerChat}) reached.`);
    }

    this._validateSchedule(data.schedule);

    const auto = new Automation({
      chatId,
      name: data.name,
      description: data.description,
      schedule: data.schedule,
      respectQuietHours: data.respectQuietHours,
    });

    this.automations.set(auto.id, auto);
    this._arm(auto);
    this._save();

    logger.info(`[AutomationManager] Created automation ${auto.id} "${auto.name}" for chat ${chatId}`);
    return auto;
  }

  /** List all automations for a chat. */
  listForChat(chatId) {
    const id = String(chatId);
    return [...this.automations.values()].filter((a) => a.chatId === id);
  }

  /** List all automations across all chats. */
  listAll() {
    return [...this.automations.values()];
  }

  /** Get a single automation by ID. */
  get(id) {
    return this.automations.get(id) || null;
  }

  /**
   * Update an automation.
   * @param {string} id
   * @param {object} changes - partial fields to update
   * @returns {Automation|null}
   */
  update(id, changes) {
    const logger = getLogger();
    const auto = this.automations.get(id);
    if (!auto) return null;

    if (changes.name !== undefined) auto.name = changes.name;
    if (changes.description !== undefined) auto.description = changes.description;
    if (changes.respectQuietHours !== undefined) auto.respectQuietHours = changes.respectQuietHours;

    if (changes.schedule !== undefined) {
      this._validateSchedule(changes.schedule);
      auto.schedule = changes.schedule;
    }

    if (changes.enabled !== undefined) {
      auto.enabled = changes.enabled;
      if (auto.enabled) {
        this._arm(auto);
      } else {
        this._disarm(auto);
      }
    }

    // Re-arm if schedule changed while enabled
    if (changes.schedule !== undefined && auto.enabled) {
      this._arm(auto);
    }

    this._save();
    logger.info(`[AutomationManager] Updated automation ${id}: ${JSON.stringify(changes)}`);
    return auto;
  }

  /**
   * Delete an automation.
   * @param {string} id
   * @returns {boolean}
   */
  delete(id) {
    const logger = getLogger();
    const auto = this.automations.get(id);
    if (!auto) return false;

    this._disarm(auto);
    this.automations.delete(id);
    this._save();

    logger.info(`[AutomationManager] Deleted automation ${id} "${auto.name}"`);
    return true;
  }

  /**
   * Trigger an automation immediately (manual run).
   * @param {string} id
   */
  async runNow(id) {
    const auto = this.automations.get(id);
    if (!auto) throw new Error(`Automation ${id} not found.`);
    await this._executeAutomation(auto);
  }

  // ── Timer management ──────────────────────────────────────────────

  /** Arm (or re-arm) a timer for an automation. */
  _arm(auto) {
    const logger = getLogger();

    // Cancel existing timer if any
    this._disarm(auto);

    const { timerId, nextRun } = scheduleNext(auto, () => {
      this._onTimerFire(auto);
    });

    auto.nextRun = nextRun;
    this.timers.set(auto.id, timerId);

    logger.debug(`[AutomationManager] Armed ${auto.id} "${auto.name}" — next: ${new Date(nextRun).toLocaleString()}`);
  }

  /** Cancel an automation's timer. */
  _disarm(auto) {
    const timerId = this.timers.get(auto.id);
    if (timerId != null) {
      cancel(timerId);
      this.timers.delete(auto.id);
      auto.nextRun = null;
    }
  }

  /** Called when a timer fires. */
  _onTimerFire(auto) {
    const logger = getLogger();

    // Guard: automation may have been deleted or disabled while timer was pending
    const current = this.automations.get(auto.id);
    if (!current || !current.enabled) {
      logger.debug(`[AutomationManager] Timer fired for ${auto.id} but automation is disabled/deleted — skipping`);
      return;
    }

    // Quiet-hours deferral: postpone non-essential automations until the window ends
    if (current.respectQuietHours && isQuietHours(this._config?.life)) {
      const deferMs = msUntilQuietEnd(this._config?.life) + 60_000; // +1 min buffer
      logger.info(`[AutomationManager] Quiet hours — deferring "${current.name}" (${current.id}) for ${Math.round(deferMs / 60_000)}m`);

      // Cancel any existing timer and re-arm to fire after quiet hours
      this._disarm(current);
      const timerId = setTimeout(() => this._onTimerFire(current), deferMs);
      current.nextRun = Date.now() + deferMs;
      this.timers.set(current.id, timerId);
      return;
    }

    // Serialize execution per chat to prevent conversation history corruption
    this._enqueueExecution(current);
  }

  /** Enqueue automation execution into per-chat chain. */
  _enqueueExecution(auto) {
    const chatId = auto.chatId;
    const prev = this._chatLocks.get(chatId) || Promise.resolve();
    const next = prev.then(() => this._executeAutomation(auto)).catch(() => {});
    this._chatLocks.set(chatId, next);
  }

  /** Execute an automation run. */
  async _executeAutomation(auto) {
    const logger = getLogger();

    // Convert chatId back to number to match Telegram's format
    // (Automation stores as string for JSON safety, but conversationManager uses number keys)
    const chatId = Number(auto.chatId);

    logger.info(`[AutomationManager] Executing automation ${auto.id} "${auto.name}" for chat ${chatId}`);

    // Update run stats
    auto.lastRun = Date.now();
    auto.runCount++;
    this._save();

    try {
      // Notify user
      if (this._sendChatAction) {
        await this._sendChatAction(chatId, 'typing').catch(() => {});
      }
      if (this._sendMessage) {
        await this._sendMessage(chatId, `⏰ Running: **${auto.name}**...`).catch(() => {});
      }

      // Get agent context for this chat
      if (!this._agentFactory) {
        throw new Error('AutomationManager not initialized — no agentFactory');
      }

      const { agent, onUpdate, sendPhoto } = this._agentFactory(chatId);
      const prompt = `[AUTOMATION: ${auto.name}] ${auto.description}`;

      // Run through the orchestrator like a normal user message
      const reply = await agent.processMessage(
        chatId,
        prompt,
        { id: 'automation', username: 'automation' },
        onUpdate,
        sendPhoto,
      );

      // Send the response
      if (reply && this._sendMessage) {
        await this._sendMessage(chatId, reply).catch(() => {});
      }

      auto.lastError = null;
      logger.info(`[AutomationManager] Automation ${auto.id} completed — reply: "${(reply || '').slice(0, 150)}"`);
    } catch (err) {
      auto.lastError = err.message;
      logger.error(`[AutomationManager] Automation ${auto.id} failed: ${err.message}`);

      if (this._sendMessage) {
        await this._sendMessage(
          chatId,
          `⚠️ Automation **${auto.name}** failed: ${err.message}`,
        ).catch(() => {});
      }
    }

    // Re-arm for next execution (regardless of success/failure)
    const current = this.automations.get(auto.id);
    if (current && current.enabled) {
      this._arm(current);
      this._save();
    }
  }

  // ── Validation ────────────────────────────────────────────────────

  _validateSchedule(schedule) {
    if (!schedule || !schedule.type) {
      throw new Error('Schedule must have a type (cron, interval, or random).');
    }

    const minInterval = this._config?.automation?.min_interval_minutes || DEFAULT_MIN_INTERVAL;

    switch (schedule.type) {
      case 'cron':
        if (!schedule.expression) {
          throw new Error('Cron schedule requires an expression field.');
        }
        break;

      case 'interval':
        if (!schedule.minutes || schedule.minutes < minInterval) {
          throw new Error(`Interval must be at least ${minInterval} minutes.`);
        }
        break;

      case 'random':
        if (!schedule.minMinutes || !schedule.maxMinutes) {
          throw new Error('Random schedule requires minMinutes and maxMinutes.');
        }
        if (schedule.minMinutes < minInterval) {
          throw new Error(`Minimum random interval must be at least ${minInterval} minutes.`);
        }
        if (schedule.maxMinutes <= schedule.minMinutes) {
          throw new Error('maxMinutes must be greater than minMinutes.');
        }
        break;

      default:
        throw new Error(`Unknown schedule type: ${schedule.type}. Use cron, interval, or random.`);
    }
  }

  // ── Persistence ───────────────────────────────────────────────────

  _load() {
    const logger = getLogger();
    try {
      if (existsSync(DATA_FILE)) {
        const raw = readFileSync(DATA_FILE, 'utf-8');
        const data = JSON.parse(raw);
        for (const item of data) {
          const auto = Automation.fromJSON(item);
          this.automations.set(auto.id, auto);
        }
        logger.info(`[AutomationManager] Loaded ${this.automations.size} automation(s) from disk`);
      }
    } catch (err) {
      logger.error(`[AutomationManager] Failed to load automations: ${err.message}`);
    }
  }

  _save() {
    try {
      if (!existsSync(DATA_DIR)) {
        mkdirSync(DATA_DIR, { recursive: true });
      }
      const data = [...this.automations.values()].map((a) => a.toJSON());
      writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      const logger = getLogger();
      logger.error(`[AutomationManager] Failed to save automations: ${err.message}`);
    }
  }
}
