import { getLogger } from '../../utils/logger.js';

/**
 * BrainConversationManager — SQLite-backed drop-in replacement for ConversationManager.
 * Same public API: load, save, getHistory, getSummarizedHistory, addMessage,
 *   clear, clearAll, getMessageCount, getLastMessageTimestamp,
 *   setSkills, addSkill, removeSkill, getSkills, clearSkills,
 *   setSkill, getSkill, clearSkill, switchFile.
 */
export class BrainConversationManager {
  static MAX_SKILLS = 5;

  constructor(db, config) {
    this._db = db;
    this.maxHistory = config.conversation.max_history;
    this.recentWindow = config.conversation.recent_window || 10;
    this.logger = getLogger();

    // Character ID filter — set via switchFile equivalent
    this._characterId = null;

    // In-memory cache for hot path
    this._cache = new Map();
    this._skillCache = new Map();
  }

  /** No-op — data is always in SQLite. Returns true for compat. */
  load() { return true; }

  /** No-op — data is always in SQLite. */
  save() { /* no-op */ }

  /**
   * Retrieve message history for a chat.
   * @param {string|number} chatId
   * @returns {Array<{role: string, content: string, timestamp?: number}>}
   */
  getHistory(chatId) {
    const key = String(chatId);

    if (this._cache.has(key)) return this._cache.get(key);

    // Try exact match first (handles prefixed keys like "kernel:12345")
    let rows = this._db.all(`
      SELECT role, content, timestamp FROM conversations
      WHERE chat_id = :chatId
      ORDER BY timestamp ASC
    `, { chatId: key });

    // Fallback: if no results and key has character prefix, try with character_id filter
    if (rows.length === 0 && this._characterId && key.startsWith(this._characterId + ':')) {
      const rawChatId = key.slice(this._characterId.length + 1);
      rows = this._db.all(`
        SELECT role, content, timestamp FROM conversations
        WHERE chat_id = :chatId AND character_id = :characterId
        ORDER BY timestamp ASC
      `, { chatId: rawChatId, characterId: this._characterId });
    }

    const history = rows.map(r => {
      const msg = { role: r.role, content: r.content, timestamp: r.timestamp };
      // Try to parse JSON content (for tool_result arrays)
      if (r.content.startsWith('[') || r.content.startsWith('{')) {
        try { msg.content = JSON.parse(r.content); } catch { /* keep as string */ }
      }
      return msg;
    });

    this._cache.set(key, history);
    return history;
  }

  /**
   * Get the timestamp of the most recent message in a chat.
   */
  getLastMessageTimestamp(chatId) {
    const history = this.getHistory(chatId);
    if (history.length === 0) return null;
    return history[history.length - 1].timestamp || null;
  }

  /**
   * Format a timestamp as a relative time marker.
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
   * Return a shallow copy of a message with a time marker prepended.
   */
  _annotateWithTime(msg) {
    const marker = this._formatRelativeTime(msg.timestamp);
    if (!marker || typeof msg.content !== 'string') return msg;
    return { ...msg, content: `${marker} ${msg.content}` };
  }

  /** Strip internal metadata fields. */
  _sanitize(msg) {
    return { role: msg.role, content: msg.content };
  }

  /**
   * Get history with older messages compressed into a summary.
   */
  getSummarizedHistory(chatId) {
    const history = this.getHistory(chatId);

    if (history.length <= this.recentWindow) {
      return history.map(m => this._sanitize(this._annotateWithTime(m)));
    }

    const olderMessages = history.slice(0, history.length - this.recentWindow);
    const recentMessages = history.slice(history.length - this.recentWindow);

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

    const annotatedRecent = recentMessages.map(m => this._sanitize(this._annotateWithTime(m)));
    return [summaryMessage, ...annotatedRecent];
  }

  /**
   * Append a message to a chat's history, trim to max length, and persist.
   */
  addMessage(chatId, role, content) {
    const key = String(chatId);
    const now = Date.now();

    // Serialize content for storage
    const contentStr = typeof content === 'string' ? content : JSON.stringify(content);

    this._db.run(`
      INSERT INTO conversations (chat_id, role, content, timestamp, character_id)
      VALUES (:chatId, :role, :content, :timestamp, :characterId)
    `, {
      chatId: key, role, content: contentStr,
      timestamp: now,
      characterId: this._characterId || '',
    });

    // Trim old messages beyond maxHistory
    const countRow = this._db.get(
      'SELECT COUNT(*) as count FROM conversations WHERE chat_id = :chatId',
      { chatId: key },
    );
    if (countRow && countRow.count > this.maxHistory) {
      this._db.run(`
        DELETE FROM conversations WHERE id IN (
          SELECT id FROM conversations WHERE chat_id = :chatId
          ORDER BY timestamp ASC LIMIT :excess
        )
      `, { chatId: key, excess: countRow.count - this.maxHistory });
    }

    // Ensure starts with user role — trim leading non-user messages
    const firstNonUser = this._db.get(`
      SELECT id FROM conversations WHERE chat_id = :chatId AND role != 'user'
      ORDER BY timestamp ASC LIMIT 1
    `, { chatId: key });
    if (firstNonUser) {
      const firstUser = this._db.get(`
        SELECT timestamp FROM conversations WHERE chat_id = :chatId AND role = 'user'
        ORDER BY timestamp ASC LIMIT 1
      `, { chatId: key });
      if (firstUser) {
        this._db.run(`
          DELETE FROM conversations WHERE chat_id = :chatId AND timestamp < :ts
        `, { chatId: key, ts: firstUser.timestamp });
      }
    }

    // Invalidate cache
    this._cache.delete(key);
  }

  /**
   * Delete all history and active skills for a specific chat.
   */
  clear(chatId) {
    const key = String(chatId);
    this._db.run('DELETE FROM conversations WHERE chat_id = :chatId', { chatId: key });
    this._db.run(
      'DELETE FROM chat_skills WHERE chat_id = :chatId',
      { chatId: key },
    );
    this._cache.delete(key);
    this._skillCache.delete(key);
    this.logger.debug(`Conversation cleared for chat ${chatId}`);
  }

  /**
   * Delete all conversations across every chat.
   */
  clearAll() {
    this._db.run('DELETE FROM conversations');
    this._db.run('DELETE FROM chat_skills');
    this._cache.clear();
    this._skillCache.clear();
    this.logger.info('All conversations cleared');
  }

  /**
   * Return the number of messages stored for a chat.
   */
  getMessageCount(chatId) {
    const key = String(chatId);
    let row = this._db.get(
      'SELECT COUNT(*) as count FROM conversations WHERE chat_id = :chatId',
      { chatId: key },
    );
    // Fallback for migrated data with unprefixed chat_id
    if ((!row || row.count === 0) && this._characterId && key.startsWith(this._characterId + ':')) {
      const rawChatId = key.slice(this._characterId.length + 1);
      row = this._db.get(
        'SELECT COUNT(*) as count FROM conversations WHERE chat_id = :chatId AND character_id = :characterId',
        { chatId: rawChatId, characterId: this._characterId },
      );
    }
    return row?.count || 0;
  }

  // ── Multi-skill methods ─────────────────────────────────────────

  setSkills(chatId, skillIds) {
    const key = String(chatId);
    const ids = skillIds.slice(0, BrainConversationManager.MAX_SKILLS);

    this._db.transaction(() => {
      this._db.run(
        'DELETE FROM chat_skills WHERE chat_id = :chatId AND character_id = :characterId',
        { chatId: key, characterId: this._characterId || '' },
      );
      for (const skillId of ids) {
        this._db.run(
          'INSERT OR IGNORE INTO chat_skills (character_id, chat_id, skill_id) VALUES (:characterId, :chatId, :skillId)',
          { characterId: this._characterId || '', chatId: key, skillId },
        );
      }
    });

    this._skillCache.set(key, ids);
  }

  addSkill(chatId, skillId) {
    const key = String(chatId);
    const current = this.getSkills(chatId);
    if (current.includes(skillId)) return false;
    if (current.length >= BrainConversationManager.MAX_SKILLS) return false;

    this._db.run(
      'INSERT OR IGNORE INTO chat_skills (character_id, chat_id, skill_id) VALUES (:characterId, :chatId, :skillId)',
      { characterId: this._characterId || '', chatId: key, skillId },
    );

    this._skillCache.delete(key);
    return true;
  }

  removeSkill(chatId, skillId) {
    const key = String(chatId);
    const result = this._db.run(
      'DELETE FROM chat_skills WHERE chat_id = :chatId AND character_id = :characterId AND skill_id = :skillId',
      { chatId: key, characterId: this._characterId || '', skillId },
    );
    this._skillCache.delete(key);
    return result.changes > 0;
  }

  getSkills(chatId) {
    const key = String(chatId);
    if (this._skillCache.has(key)) return this._skillCache.get(key);

    let rows = this._db.all(
      'SELECT skill_id FROM chat_skills WHERE chat_id = :chatId AND character_id = :characterId',
      { chatId: key, characterId: this._characterId || '' },
    );
    // Fallback for migrated data with unprefixed chat_id
    if (rows.length === 0 && this._characterId && key.startsWith(this._characterId + ':')) {
      const rawChatId = key.slice(this._characterId.length + 1);
      rows = this._db.all(
        'SELECT skill_id FROM chat_skills WHERE chat_id = :chatId AND character_id = :characterId',
        { chatId: rawChatId, characterId: this._characterId },
      );
    }
    const skills = rows.map(r => r.skill_id);
    this._skillCache.set(key, skills);
    return skills;
  }

  clearSkills(chatId) {
    const key = String(chatId);
    this._db.run(
      'DELETE FROM chat_skills WHERE chat_id = :chatId AND character_id = :characterId',
      { chatId: key, characterId: this._characterId || '' },
    );
    this._skillCache.delete(key);
  }

  // ── Backward-compatible single-skill aliases ───────────────────

  setSkill(chatId, skillId) {
    this.setSkills(chatId, [skillId]);
  }

  getSkill(chatId) {
    const skills = this.getSkills(chatId);
    return skills.length > 0 ? skills[0] : null;
  }

  clearSkill(chatId) {
    this.clearSkills(chatId);
  }

  /**
   * Switch character context — equivalent to switchFile in file-based manager.
   * Clears caches and updates character_id filter.
   * Accepts a path like .../characters/<id>/conversations.json or a plain characterId.
   */
  switchFile(newPath) {
    this._cache.clear();
    this._skillCache.clear();

    if (newPath && typeof newPath === 'string') {
      // Try to extract character ID from path: .../characters/<id>/...
      const match = newPath.match(/[/\\]characters[/\\]([^/\\]+)/);
      if (match) {
        this._characterId = match[1];
      } else if (!newPath.includes('/') && !newPath.includes('\\')) {
        // Plain character ID string
        this._characterId = newPath;
      }
    }

    this.logger.debug(`BrainConversationManager switched to character: ${this._characterId}`);
  }
}
