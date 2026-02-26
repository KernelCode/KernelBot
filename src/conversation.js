import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getLogger } from './utils/logger.js';

/**
 * Resolve the file path for persisted conversations.
 * Ensures the parent directory (~/.kernelbot/) exists.
 * @returns {string} Absolute path to conversations.json.
 */
function getConversationsPath() {
  const dir = join(homedir(), '.kernelbot');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'conversations.json');
}

/**
 * Manages per-chat conversation history, including persistence to disk,
 * summarization of older messages, and per-chat skill tracking.
 */
export class ConversationManager {
  /**
   * @param {object} config - Application config containing `conversation` settings.
   * @param {number} config.conversation.max_history - Maximum messages to retain per chat.
   * @param {number} [config.conversation.recent_window=10] - Number of recent messages kept verbatim in summarized history.
   */
  constructor(config, filePath = null) {
    this.maxHistory = config.conversation.max_history;
    this.recentWindow = config.conversation.recent_window || 10;
    this.conversations = new Map();
    this.activeSkills = new Map();
    this.filePath = filePath || getConversationsPath();
    this.logger = getLogger();
  }

  /**
   * Load persisted conversations and skills from disk.
   * @returns {boolean} True if at least one conversation was restored.
   */
  load() {
    if (!existsSync(this.filePath)) return false;
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const data = JSON.parse(raw);

      // Restore per-chat skills (backward compat: string → string[])
      if (data._skills && typeof data._skills === 'object') {
        for (const [chatId, value] of Object.entries(data._skills)) {
          // Old format stored a single string; new format stores an array
          const skills = Array.isArray(value) ? value : (typeof value === 'string' ? [value] : []);
          if (skills.length > 0) {
            this.activeSkills.set(String(chatId), skills);
          }
        }
      }

      for (const [chatId, messages] of Object.entries(data)) {
        if (chatId === '_skills') continue;
        this.conversations.set(String(chatId), messages);
      }
      this.logger.debug(`Conversations loaded: ${this.conversations.size} chats, ${this.activeSkills.size} active skills`);
      return this.conversations.size > 0;
    } catch (err) {
      this.logger.warn(`Failed to load conversations from ${this.filePath}: ${err.message}`);
      return false;
    }
  }

  /**
   * Persist all conversations and active skills to disk.
   * Failures are logged but never thrown to avoid crashing the bot.
   */
  save() {
    try {
      const data = {};
      for (const [chatId, messages] of this.conversations) {
        data[chatId] = messages;
      }
      // Persist active skills under a reserved key (stored as arrays)
      if (this.activeSkills.size > 0) {
        const skills = {};
        for (const [chatId, skillIds] of this.activeSkills) {
          skills[chatId] = skillIds;
        }
        data._skills = skills;
      }
      writeFileSync(this.filePath, JSON.stringify(data, null, 2));
    } catch (err) {
      this.logger.warn(`Failed to save conversations: ${err.message}`);
    }
  }

  /**
   * Retrieve the message history for a chat, initializing an empty array if none exists.
   * @param {string|number} chatId - Telegram chat identifier.
   * @returns {Array<{role: string, content: string, timestamp?: number}>} Message array (mutable reference).
   */
  getHistory(chatId) {
    const key = String(chatId);
    if (!this.conversations.has(key)) {
      this.conversations.set(key, []);
    }
    return this.conversations.get(key);
  }

  /**
   * Get the timestamp of the most recent message in a chat.
   * Used by agent.js for time-gap detection before the current message is added.
   */
  getLastMessageTimestamp(chatId) {
    const history = this.getHistory(chatId);
    if (history.length === 0) return null;
    return history[history.length - 1].timestamp || null;
  }

  /**
   * Format a timestamp as a relative time marker.
   * Returns null for missing timestamps (backward compat with old messages).
   */
  _formatRelativeTime(ts) {
    if (!ts) return null;
    const diff = Date.now() - ts;
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return '[just now]';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `[${minutes}m ago]`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `[${hours}h ago]`;
    const days = Math.floor(hours / 24);
    return `[${days}d ago]`;
  }

  /**
   * Return a shallow copy of a message with a time marker prepended to string content.
   * Skips tool_result arrays and messages without timestamps.
   */
  _annotateWithTime(msg) {
    const marker = this._formatRelativeTime(msg.timestamp);
    if (!marker || typeof msg.content !== 'string') return msg;
    return { ...msg, content: `${marker} ${msg.content}` };
  }

  /** Strip internal metadata fields, returning only API-safe {role, content}. */
  _sanitize(msg) {
    return { role: msg.role, content: msg.content };
  }

  /**
   * Get history with older messages compressed into a summary.
   * Keeps the last `recentWindow` messages verbatim and summarizes older ones.
   */
  getSummarizedHistory(chatId) {
    const history = this.getHistory(chatId);

    if (history.length <= this.recentWindow) {
      return history.map(m => this._sanitize(this._annotateWithTime(m)));
    }

    const olderMessages = history.slice(0, history.length - this.recentWindow);
    const recentMessages = history.slice(history.length - this.recentWindow);

    // Compress older messages into a single summary (include time markers when available)
    const summaryLines = olderMessages.map((msg) => {
      const timeTag = this._formatRelativeTime(msg.timestamp);
      const content = typeof msg.content === 'string'
        ? msg.content.slice(0, 200)
        : JSON.stringify(msg.content).slice(0, 200);
      return `[${msg.role}]${timeTag ? ` ${timeTag}` : ''}: ${content}`;
    });

    const summaryMessage = {
      role: 'user',
      content: `[CONVERSATION SUMMARY - ${olderMessages.length} earlier messages]\n${summaryLines.join('\n')}`,
    };

    // Annotate recent messages with time markers and strip metadata
    const annotatedRecent = recentMessages.map(m => this._sanitize(this._annotateWithTime(m)));

    // Ensure result starts with user role
    const result = [summaryMessage, ...annotatedRecent];

    // If the first real message after summary is assistant, that's fine since
    // our summary is role:user. But ensure recent starts correctly.
    return result;
  }

  /**
   * Append a message to a chat's history, trim to max length, and persist.
   * Automatically ensures the conversation starts with a user message.
   * @param {string|number} chatId - Telegram chat identifier.
   * @param {'user'|'assistant'} role - Message role.
   * @param {string} content - Message content.
   */
  addMessage(chatId, role, content) {
    const history = this.getHistory(chatId);
    history.push({ role, content, timestamp: Date.now() });

    // Trim to max history
    while (history.length > this.maxHistory) {
      history.shift();
    }

    // Ensure conversation starts with user role
    while (history.length > 0 && history[0].role !== 'user') {
      history.shift();
    }

    this.save();
  }

  /**
   * Delete all history and active skill for a specific chat.
   * @param {string|number} chatId - Telegram chat identifier.
   */
  clear(chatId) {
    this.conversations.delete(String(chatId));
    this.activeSkills.delete(String(chatId));
    this.logger.debug(`Conversation cleared for chat ${chatId}`);
    this.save();
  }

  /**
   * Delete all conversations across every chat.
   */
  clearAll() {
    const count = this.conversations.size;
    this.conversations.clear();
    this.logger.info(`All conversations cleared (${count} chats removed)`);
    this.save();
  }

  /**
   * Return the number of messages stored for a chat.
   * @param {string|number} chatId - Telegram chat identifier.
   * @returns {number} Message count.
   */
  getMessageCount(chatId) {
    const history = this.getHistory(chatId);
    return history.length;
  }

  // ── Multi-skill methods ─────────────────────────────────────────────

  /** Max active skills per chat. */
  static MAX_SKILLS = 5;

  /**
   * Replace all active skills for a chat.
   * @param {string|number} chatId
   * @param {string[]} skillIds
   */
  setSkills(chatId, skillIds) {
    const ids = skillIds.slice(0, ConversationManager.MAX_SKILLS);
    this.activeSkills.set(String(chatId), ids);
    this.save();
  }

  /**
   * Add a skill to a chat's active set. No-op if already active or at max.
   * @param {string|number} chatId
   * @param {string} skillId
   * @returns {boolean} true if added, false if already active or at max
   */
  addSkill(chatId, skillId) {
    const key = String(chatId);
    const current = this.activeSkills.get(key) || [];
    if (current.includes(skillId)) return false;
    if (current.length >= ConversationManager.MAX_SKILLS) return false;
    current.push(skillId);
    this.activeSkills.set(key, current);
    this.save();
    return true;
  }

  /**
   * Remove a skill from a chat's active set.
   * @param {string|number} chatId
   * @param {string} skillId
   * @returns {boolean} true if removed
   */
  removeSkill(chatId, skillId) {
    const key = String(chatId);
    const current = this.activeSkills.get(key) || [];
    const idx = current.indexOf(skillId);
    if (idx === -1) return false;
    current.splice(idx, 1);
    if (current.length === 0) {
      this.activeSkills.delete(key);
    } else {
      this.activeSkills.set(key, current);
    }
    this.save();
    return true;
  }

  /**
   * Get all active skill IDs for a chat.
   * @param {string|number} chatId
   * @returns {string[]} Array of active skill IDs (empty if none).
   */
  getSkills(chatId) {
    return this.activeSkills.get(String(chatId)) || [];
  }

  /**
   * Clear all active skills for a chat.
   * @param {string|number} chatId
   */
  clearSkills(chatId) {
    this.activeSkills.delete(String(chatId));
    this.save();
  }

  // ── Backward-compatible single-skill aliases ───────────────────────

  /**
   * Activate a single skill (replaces all). Backward compat.
   * @param {string|number} chatId
   * @param {string} skillId
   */
  setSkill(chatId, skillId) {
    this.setSkills(chatId, [skillId]);
  }

  /**
   * Get the first active skill ID (or null). Backward compat.
   * @param {string|number} chatId
   * @returns {string|null}
   */
  getSkill(chatId) {
    const skills = this.getSkills(chatId);
    return skills.length > 0 ? skills[0] : null;
  }

  /**
   * Deactivate all skills. Backward compat alias for clearSkills.
   * @param {string|number} chatId
   */
  clearSkill(chatId) {
    this.clearSkills(chatId);
  }

  /**
   * Switch the backing file for this manager.
   * Saves current data, clears in-memory state, then loads from the new file.
   * Used when switching characters to point at the new character's conversations.json.
   * @param {string} newPath - Absolute path to the new conversations JSON file.
   */
  switchFile(newPath) {
    this.save();
    this.conversations.clear();
    this.activeSkills.clear();
    this.filePath = newPath;
    this.load();
    this.logger.debug(`ConversationManager switched to: ${newPath}`);
  }
}
