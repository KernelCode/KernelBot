import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

function getConversationsPath() {
  const dir = join(homedir(), '.kernelbot');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'conversations.json');
}

export class ConversationManager {
  constructor(config) {
    this.maxHistory = config.conversation.max_history;
    this.recentWindow = config.conversation.recent_window || 10;
    this.conversations = new Map();
    this.activeSkills = new Map();
    this.filePath = getConversationsPath();
  }

  load() {
    if (!existsSync(this.filePath)) return false;
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const data = JSON.parse(raw);

      // Restore per-chat skills
      if (data._skills && typeof data._skills === 'object') {
        for (const [chatId, skillId] of Object.entries(data._skills)) {
          this.activeSkills.set(String(chatId), skillId);
        }
      }

      for (const [chatId, messages] of Object.entries(data)) {
        if (chatId === '_skills') continue;
        this.conversations.set(String(chatId), messages);
      }
      return this.conversations.size > 0;
    } catch {
      return false;
    }
  }

  save() {
    try {
      const data = {};
      for (const [chatId, messages] of this.conversations) {
        data[chatId] = messages;
      }
      // Persist active skills under a reserved key
      if (this.activeSkills.size > 0) {
        const skills = {};
        for (const [chatId, skillId] of this.activeSkills) {
          skills[chatId] = skillId;
        }
        data._skills = skills;
      }
      writeFileSync(this.filePath, JSON.stringify(data, null, 2));
    } catch {
      // Silent fail — don't crash the bot over persistence
    }
  }

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

  /**
   * Get history with older messages compressed into a summary.
   * Keeps the last `recentWindow` messages verbatim and summarizes older ones.
   */
  getSummarizedHistory(chatId) {
    const history = this.getHistory(chatId);

    if (history.length <= this.recentWindow) {
      return history.map(m => this._annotateWithTime(m));
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

    // Annotate recent messages with time markers
    const annotatedRecent = recentMessages.map(m => this._annotateWithTime(m));

    // Ensure result starts with user role
    const result = [summaryMessage, ...annotatedRecent];

    // If the first real message after summary is assistant, that's fine since
    // our summary is role:user. But ensure recent starts correctly.
    return result;
  }

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

  clear(chatId) {
    this.conversations.delete(String(chatId));
    this.activeSkills.delete(String(chatId));
    this.save();
  }

  clearAll() {
    this.conversations.clear();
    this.save();
  }

  getMessageCount(chatId) {
    const history = this.getHistory(chatId);
    return history.length;
  }

  setSkill(chatId, skillId) {
    this.activeSkills.set(String(chatId), skillId);
    this.save();
  }

  getSkill(chatId) {
    return this.activeSkills.get(String(chatId)) || null;
  }

  clearSkill(chatId) {
    this.activeSkills.delete(String(chatId));
    this.save();
  }
}
