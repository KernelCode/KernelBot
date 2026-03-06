import { getLogger } from '../../utils/logger.js';
import { genId } from '../../utils/ids.js';
import { getStartOfDayMs } from '../../utils/date.js';

/**
 * BrainShareQueue — SQLite-backed drop-in replacement for ShareQueue.
 * Same public API: add, getPending, markShared, buildShareBlock, getSharedTodayCount, prune.
 */
export class BrainShareQueue {
  constructor(db, characterId) {
    this._db = db;
    this._characterId = characterId;
  }

  /**
   * Add something to the share queue.
   * @param {string} content
   * @param {string} source
   * @param {string} priority - low, medium, high
   * @param {string|null} targetUserId
   * @param {string[]} tags
   */
  add(content, source, priority = 'medium', targetUserId = null, tags = []) {
    const logger = getLogger();
    const id = genId('sh');
    const now = Date.now();

    this._db.run(`
      INSERT INTO shares (id, character_id, content, source, priority, target_user_id, tags, status, created_at)
      VALUES (:id, :characterId, :content, :source, :priority, :targetUserId, :tags, 'pending', :now)
    `, {
      id,
      characterId: this._characterId,
      content, source, priority,
      targetUserId: targetUserId ? String(targetUserId) : null,
      tags: JSON.stringify(tags),
      now,
    });

    logger.debug(`[ShareQueue] Added: "${content.slice(0, 80)}" (${id})`);
    return { id, content, source, createdAt: now, priority, targetUserId, tags };
  }

  /**
   * Get pending shares for a specific user (or general ones).
   */
  getPending(userId = null, limit = 3) {
    const userIdStr = userId ? String(userId) : null;

    const rows = this._db.all(`
      SELECT * FROM shares
      WHERE character_id = :characterId AND status = 'pending'
        AND (target_user_id IS NULL ${userIdStr ? 'OR target_user_id = :userId' : ''})
      ORDER BY
        CASE priority WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END DESC,
        created_at DESC
      LIMIT :limit
    `, { characterId: this._characterId, userId: userIdStr, limit });

    return rows.map(r => ({
      id: r.id,
      content: r.content,
      source: r.source,
      createdAt: r.created_at,
      priority: r.priority,
      targetUserId: r.target_user_id,
      tags: JSON.parse(r.tags || '[]'),
    }));
  }

  /**
   * Mark a share as shared with a user.
   */
  markShared(id, userId) {
    const logger = getLogger();
    const result = this._db.run(`
      UPDATE shares SET status = 'shared', shared_at = :now, shared_to_user_id = :userId
      WHERE id = :id AND status = 'pending'
    `, { now: Date.now(), userId: String(userId), id });

    if (result.changes > 0) {
      logger.debug(`[ShareQueue] Marked shared: ${id} → user ${userId}`);
      return true;
    }
    return false;
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
   * Get count of shares sent today.
   */
  getSharedTodayCount() {
    const cutoff = getStartOfDayMs();
    const row = this._db.get(`
      SELECT COUNT(*) as count FROM shares
      WHERE character_id = :characterId AND status = 'shared' AND shared_at >= :cutoff
    `, { characterId: this._characterId, cutoff });
    return row?.count || 0;
  }

  /**
   * Prune old pending shares.
   */
  prune(maxAgeDays = 7) {
    const cutoff = Date.now() - maxAgeDays * 86400_000;
    const result = this._db.run(`
      DELETE FROM shares
      WHERE character_id = :characterId AND status = 'pending' AND created_at < :cutoff
    `, { characterId: this._characterId, cutoff });
    return result.changes;
  }
}
