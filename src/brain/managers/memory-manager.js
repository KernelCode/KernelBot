import { getLogger } from '../../utils/logger.js';
import { genId } from '../../utils/ids.js';

/**
 * BrainMemoryManager — SQLite-backed drop-in replacement for MemoryManager.
 * Same public API: addEpisodic, getRecentEpisodic, getMemoriesAboutUser,
 *   searchEpisodic, pruneOld, addSemantic, searchSemantic, buildContextBlock.
 *
 * Uses sqlite-vec for vector search when available, with LIKE fallback.
 */
export class BrainMemoryManager {
  constructor(db, characterId) {
    this._db = db;
    this._characterId = characterId;
  }

  /**
   * Add an episodic memory.
   * @param {{ type?: string, source?: string, summary: string, tags?: string[], importance?: number, userId?: string }} memory
   */
  addEpisodic(memory) {
    const logger = getLogger();
    const now = Date.now();
    const id = genId('ep');

    this._db.run(`
      INSERT INTO memories (id, character_id, type, source, user_id, summary, tags, importance, scope, created_at)
      VALUES (:id, :characterId, 'episodic', :source, :userId, :summary, :tags, :importance, :scope, :now)
    `, {
      id,
      characterId: this._characterId,
      source: memory.source || 'user_chat',
      userId: memory.userId || null,
      summary: memory.summary,
      tags: JSON.stringify(memory.tags || []),
      importance: memory.importance || 5,
      scope: memory.scope || 'org_wide',
      now,
    });

    logger.debug(`[Memory] Added episodic: "${memory.summary.slice(0, 80)}" (${id})`);

    // Background embed for vector search
    this._db.embedBackground('memory_vectors', id, memory.summary);

    return {
      id,
      timestamp: now,
      type: memory.type || 'interaction',
      source: memory.source || 'user_chat',
      userId: memory.userId || null,
      summary: memory.summary,
      tags: memory.tags || [],
      importance: memory.importance || 5,
    };
  }

  /**
   * Get recent episodic memories within the last N hours.
   */
  getRecentEpisodic(hours = 24, limit = 20) {
    const cutoff = Date.now() - hours * 3600_000;
    const rows = this._db.all(`
      SELECT * FROM memories
      WHERE character_id = :characterId AND type = 'episodic' AND created_at > :cutoff
      ORDER BY created_at DESC
      LIMIT :limit
    `, { characterId: this._characterId, cutoff, limit });

    return rows.map(r => this._rowToEntry(r));
  }

  /**
   * Get memories about a specific user.
   */
  getMemoriesAboutUser(userId, limit = 10) {
    const rows = this._db.all(`
      SELECT * FROM memories
      WHERE character_id = :characterId AND type = 'episodic' AND user_id = :userId
      ORDER BY created_at DESC
      LIMIT :limit
    `, { characterId: this._characterId, userId: String(userId), limit });

    return rows.map(r => this._rowToEntry(r));
  }

  /**
   * Search episodic memories — vector search with LIKE fallback.
   */
  async searchEpisodic(query, limit = 10) {
    // Try vector search first
    if (this._db.hasVectors) {
      try {
        const hits = await this._db.vectorSearch('memory_vectors', query, limit);
        if (hits.length > 0) {
          const ids = hits.map(h => h.id);
          const placeholders = ids.map(() => '?').join(',');
          const rows = this._db.all(
            `SELECT * FROM memories WHERE id IN (${placeholders}) AND character_id = ? AND type = 'episodic'`,
            [...ids, this._characterId],
          );
          // Preserve vector-search order
          const rowMap = new Map(rows.map(r => [r.id, r]));
          return ids.map(id => rowMap.get(id)).filter(Boolean).map(r => this._rowToEntry(r));
        }
      } catch (err) {
        getLogger().warn(`[Memory] Vector search failed, falling back to LIKE: ${err.message}`);
      }
    }

    // LIKE fallback
    const q = `%${query}%`;
    const rows = this._db.all(`
      SELECT * FROM memories
      WHERE character_id = :characterId AND type = 'episodic'
        AND (summary LIKE :q OR tags LIKE :q)
      ORDER BY importance DESC, created_at DESC
      LIMIT :limit
    `, { characterId: this._characterId, q, limit });

    return rows.map(r => this._rowToEntry(r));
  }

  /**
   * Scope-filtered episodic search for non-owner users.
   * Uses vector search when available, with LIKE fallback.
   */
  async searchEpisodicScoped(query, userId, limit = 10) {
    const uid = String(userId);

    // Try vector search first — over-fetch for scope filtering
    if (this._db.hasVectors) {
      try {
        const hits = await this._db.vectorSearch('memory_vectors', query, limit * 2);
        if (hits.length > 0) {
          const ids = hits.map(h => h.id);
          const placeholders = ids.map(() => '?').join(',');
          const rows = this._db.all(
            `SELECT * FROM memories WHERE id IN (${placeholders}) AND character_id = ? AND type = 'episodic'
             AND (scope = 'org_wide' OR (scope = 'private' AND user_id = ?) OR scope IS NULL)`,
            [...ids, this._characterId, uid],
          );
          // Preserve vector-distance ordering
          const rowMap = new Map(rows.map(r => [r.id, r]));
          const ordered = ids.map(id => rowMap.get(id)).filter(Boolean).slice(0, limit);
          if (ordered.length > 0) return ordered.map(r => this._rowToEntry(r));
        }
      } catch (err) {
        getLogger().warn(`[Memory] Vector scoped search failed, falling back to LIKE: ${err.message}`);
      }
    }

    // LIKE fallback
    const q = `%${query}%`;
    const rows = this._db.all(`
      SELECT * FROM memories
      WHERE character_id = :characterId AND type = 'episodic'
        AND (summary LIKE :q OR tags LIKE :q)
        AND (scope = 'org_wide' OR (scope = 'private' AND user_id = :userId) OR scope IS NULL)
      ORDER BY importance DESC, created_at DESC
      LIMIT :limit
    `, { characterId: this._characterId, q, userId: uid, limit });

    return rows.map(r => this._rowToEntry(r));
  }

  /**
   * Prune episodic memories older than N days.
   */
  pruneOld(daysToKeep = 90) {
    const logger = getLogger();
    const cutoff = Date.now() - daysToKeep * 86400_000;

    // Get IDs to prune (for vector cleanup)
    const toDelete = this._db.all(`
      SELECT id FROM memories
      WHERE character_id = :characterId AND type = 'episodic' AND created_at < :cutoff
    `, { characterId: this._characterId, cutoff });

    if (toDelete.length === 0) return 0;

    // Delete vectors
    if (this._db.hasVectors) {
      for (const row of toDelete) {
        try {
          this._db.run('DELETE FROM memory_vectors WHERE memory_id = :id', { id: row.id });
        } catch { /* ignore — vec table may not have this entry */ }
      }
    }

    // Delete memories
    const result = this._db.run(`
      DELETE FROM memories
      WHERE character_id = :characterId AND type = 'episodic' AND created_at < :cutoff
    `, { characterId: this._characterId, cutoff });

    const pruned = result.changes;
    if (pruned > 0) logger.info(`[Memory] Pruned ${pruned} old episodic memories`);
    return pruned;
  }

  /**
   * Add or update semantic knowledge.
   * @param {string} topic - Topic key
   * @param {{ summary: string, sources?: string[], relatedTopics?: string[] }} knowledge
   */
  addSemantic(topic, knowledge) {
    const logger = getLogger();
    const key = topic.toLowerCase().replace(/\s+/g, '_');
    const id = `sem_${key}`;
    const now = Date.now();

    const existing = this._db.get(
      'SELECT * FROM memories WHERE id = :id AND character_id = :characterId',
      { id, characterId: this._characterId },
    );

    if (existing) {
      const existingSources = JSON.parse(existing.sources || '[]');
      const existingTopics = JSON.parse(existing.related_topics || '[]');
      const mergedSources = [...new Set([...existingSources, ...(knowledge.sources || [])])];
      const mergedTopics = [...new Set([...existingTopics, ...(knowledge.relatedTopics || [])])];

      this._db.run(`
        UPDATE memories SET summary = :summary, sources = :sources,
          related_topics = :relatedTopics, updated_at = :now
        WHERE id = :id
      `, {
        summary: knowledge.summary,
        sources: JSON.stringify(mergedSources),
        relatedTopics: JSON.stringify(mergedTopics),
        now, id,
      });
    } else {
      this._db.run(`
        INSERT INTO memories (id, character_id, type, source, summary, tags, importance, related_topics, sources, created_at, updated_at)
        VALUES (:id, :characterId, 'semantic', :source, :summary, '[]', 5, :relatedTopics, :sources, :now, :now)
      `, {
        id,
        characterId: this._characterId,
        source: key,
        summary: knowledge.summary,
        relatedTopics: JSON.stringify(knowledge.relatedTopics || []),
        sources: JSON.stringify(knowledge.sources || []),
        now,
      });
    }

    logger.debug(`[Memory] Updated semantic topic: ${key}`);

    // Background embed for vector search
    this._db.embedBackground('memory_vectors', id, knowledge.summary);

    return {
      summary: knowledge.summary,
      sources: knowledge.sources || [],
      learnedAt: now,
      relatedTopics: knowledge.relatedTopics || [],
    };
  }

  /**
   * Search semantic knowledge — vector search with LIKE fallback.
   */
  async searchSemantic(query, limit = 5) {
    // Try vector search first — semantic memories are also in memory_vectors
    if (this._db.hasVectors) {
      try {
        const hits = await this._db.vectorSearch('memory_vectors', query, limit);
        if (hits.length > 0) {
          const ids = hits.map(h => h.id);
          const placeholders = ids.map(() => '?').join(',');
          const rows = this._db.all(
            `SELECT * FROM memories WHERE id IN (${placeholders}) AND character_id = ? AND type = 'semantic'`,
            [...ids, this._characterId],
          );
          if (rows.length > 0) {
            return rows.map(r => ({
              topic: r.source,
              summary: r.summary,
              sources: JSON.parse(r.sources || '[]'),
              learnedAt: r.updated_at || r.created_at,
              relatedTopics: JSON.parse(r.related_topics || '[]'),
            }));
          }
        }
      } catch { /* fallback to LIKE */ }
    }

    const q = `%${query}%`;
    const rows = this._db.all(`
      SELECT * FROM memories
      WHERE character_id = :characterId AND type = 'semantic'
        AND (summary LIKE :q OR source LIKE :q OR related_topics LIKE :q)
      ORDER BY updated_at DESC
      LIMIT :limit
    `, { characterId: this._characterId, q, limit });

    return rows.map(r => ({
      topic: r.source,
      summary: r.summary,
      sources: JSON.parse(r.sources || '[]'),
      learnedAt: r.updated_at || r.created_at,
      relatedTopics: JSON.parse(r.related_topics || '[]'),
    }));
  }

  /**
   * Build a context block of relevant memories for the orchestrator prompt.
   * Capped to ~1500 chars.
   */
  buildContextBlock(userId = null, senderType = 'owner') {
    const sections = [];

    // Recent general memories (last 24h, top 5)
    const recent = this.getRecentEpisodic(24, 5);
    if (recent.length > 0) {
      const lines = recent.map(m => {
        const ago = Math.round((Date.now() - m.timestamp) / 60000);
        const timeLabel = ago < 60 ? `${ago}m ago` : `${Math.round(ago / 60)}h ago`;
        return `- ${m.summary} (${timeLabel})`;
      });
      sections.push(`Recent:\n${lines.join('\n')}`);
    }

    // User-specific memories (top 3)
    if (userId) {
      const userMems = this.getMemoriesAboutUser(userId, 3);
      if (userMems.length > 0) {
        const lines = userMems.map(m => `- ${m.summary}`);
        sections.push(`About this user:\n${lines.join('\n')}`);
      }
    }

    // Semantic knowledge (last 3 learned)
    const semanticRows = this._db.all(`
      SELECT * FROM memories
      WHERE character_id = :characterId AND type = 'semantic'
      ORDER BY COALESCE(updated_at, created_at) DESC
      LIMIT 3
    `, { characterId: this._characterId });

    if (semanticRows.length > 0) {
      const lines = semanticRows.map(r =>
        `- **${r.source}**: ${r.summary.slice(0, 100)}`,
      );
      sections.push(`Knowledge:\n${lines.join('\n')}`);
    }

    if (sections.length === 0) return null;

    let block = sections.join('\n\n');
    if (block.length > 1500) block = block.slice(0, 1500) + '\n...';
    return block;
  }

  /** Convert a DB row to the entry format expected by consumers. */
  _rowToEntry(row) {
    return {
      id: row.id,
      timestamp: row.created_at,
      type: row.type === 'episodic' ? (row.source || 'interaction') : row.type,
      source: row.source || 'user_chat',
      userId: row.user_id || null,
      summary: row.summary,
      tags: JSON.parse(row.tags || '[]'),
      importance: row.importance || 5,
    };
  }
}
