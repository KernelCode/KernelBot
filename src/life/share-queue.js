import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getLogger } from '../utils/logger.js';
import { genId } from '../utils/ids.js';
import { getStartOfDayMs } from '../utils/date.js';

const LIFE_DIR = join(homedir(), '.kernelbot', 'life');
const SHARES_FILE = join(LIFE_DIR, 'shares.json');

export class ShareQueue {
  constructor() {
    mkdirSync(LIFE_DIR, { recursive: true });
    this._data = this._load();
  }

  _load() {
    if (existsSync(SHARES_FILE)) {
      try {
        return JSON.parse(readFileSync(SHARES_FILE, 'utf-8'));
      } catch {
        return { pending: [], shared: [] };
      }
    }
    return { pending: [], shared: [] };
  }

  _save() {
    writeFileSync(SHARES_FILE, JSON.stringify(this._data, null, 2), 'utf-8');
  }

  /**
   * Add something to the share queue.
   * @param {string} content - What to share
   * @param {string} source - Where it came from (browse, think, create, etc.)
   * @param {string} priority - low, medium, high
   * @param {string|null} targetUserId - Specific user, or null for anyone
   * @param {string[]} tags - Topic tags
   */
  add(content, source, priority = 'medium', targetUserId = null, tags = []) {
    const logger = getLogger();
    const item = {
      id: genId('sh'),
      content,
      source,
      createdAt: Date.now(),
      priority,
      targetUserId,
      tags,
    };
    this._data.pending.push(item);
    this._save();
    logger.debug(`[ShareQueue] Added: "${content.slice(0, 80)}" (${item.id})`);
    return item;
  }

  /**
   * Get pending shares for a specific user (or general ones).
   */
  getPending(userId = null, limit = 3) {
    return this._data.pending
      .filter(item => !item.targetUserId || item.targetUserId === String(userId))
      .sort((a, b) => {
        const prio = { high: 3, medium: 2, low: 1 };
        return (prio[b.priority] || 0) - (prio[a.priority] || 0) || b.createdAt - a.createdAt;
      })
      .slice(0, limit);
  }

  /**
   * Mark a share as shared with a user.
   */
  markShared(id, userId) {
    const logger = getLogger();
    const idx = this._data.pending.findIndex(item => item.id === id);
    if (idx === -1) return false;

    const [item] = this._data.pending.splice(idx, 1);
    this._data.shared.push({
      ...item,
      sharedAt: Date.now(),
      userId: String(userId),
    });

    // Keep shared history capped at 100
    if (this._data.shared.length > 100) {
      this._data.shared = this._data.shared.slice(-100);
    }

    this._save();
    logger.debug(`[ShareQueue] Marked shared: ${id} → user ${userId}`);
    return true;
  }

  /**
   * Build a markdown block of pending shares for the orchestrator prompt.
   */
  buildShareBlock(userId = null) {
    const pending = this.getPending(userId, 3);
    if (pending.length === 0) return null;

    const lines = pending.map(item => {
      const ageMin = Math.round((Date.now() - item.createdAt) / 60000);
      const timeLabel = ageMin < 60 ? `${ageMin}m ago` : `${Math.round(ageMin / 60)}h ago`;
      return `- ${item.content} _(from ${item.source}, ${timeLabel})_`;
    });

    return lines.join('\n');
  }

  /**
   * Get count of shares sent today (for rate limiting proactive shares).
   */
  getSharedTodayCount() {
    const cutoff = getStartOfDayMs();
    return this._data.shared.filter(s => s.sharedAt >= cutoff).length;
  }

  /**
   * Prune old pending shares.
   */
  prune(maxAgeDays = 7) {
    const cutoff = Date.now() - maxAgeDays * 86400_000;
    const before = this._data.pending.length;
    this._data.pending = this._data.pending.filter(item => item.createdAt >= cutoff);
    if (this._data.pending.length < before) {
      this._save();
    }
    return before - this._data.pending.length;
  }
}
