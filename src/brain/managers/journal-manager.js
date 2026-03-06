import { getLogger } from '../../utils/logger.js';
import { todayDateStr } from '../../utils/date.js';

function formatDate(date) {
  return new Date(date + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function timeNow() {
  return new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * BrainJournalManager — SQLite-backed drop-in replacement for JournalManager.
 * Same public API: writeEntry, getToday, getRecent, getEntry, list.
 */
export class BrainJournalManager {
  constructor(db, characterId) {
    this._db = db;
    this._characterId = characterId;
  }

  /**
   * Write a new entry to today's journal.
   * @param {string} title - Section title
   * @param {string} content - Entry content
   */
  writeEntry(title, content) {
    const logger = getLogger();
    const date = todayDateStr();
    const time = timeNow();
    const now = Date.now();

    const existing = this._db.get(
      'SELECT id, content FROM journals WHERE character_id = :characterId AND date = :date',
      { characterId: this._characterId, date },
    );

    const entry = `\n## ${title} (${time})\n${content}\n`;

    if (existing) {
      this._db.run(
        'UPDATE journals SET content = :content, updated_at = :now WHERE id = :id',
        { content: existing.content + entry, now, id: existing.id },
      );
    } else {
      const header = `# Journal — ${formatDate(date)}\n`;
      this._db.run(
        'INSERT INTO journals (character_id, date, content, updated_at) VALUES (:characterId, :date, :content, :now)',
        { characterId: this._characterId, date, content: header + entry, now },
      );
    }

    logger.info(`[Journal] Wrote entry: "${title}" for ${date}`);

    // Background embed for vector search
    const row = this._db.get('SELECT id FROM journals WHERE character_id = :cid AND date = :date', { cid: this._characterId, date });
    if (row) this._db.embedBackground('journal_vectors', row.id, `${title}: ${content}`);
  }

  /** Get today's journal content. */
  getToday() {
    const row = this._db.get(
      'SELECT content FROM journals WHERE character_id = :characterId AND date = :date',
      { characterId: this._characterId, date: todayDateStr() },
    );
    return row ? row.content : null;
  }

  /**
   * Get journal entries for the last N days.
   * Returns array of { date, content }.
   */
  getRecent(days = 7) {
    const rows = this._db.all(
      'SELECT date, content FROM journals WHERE character_id = :characterId ORDER BY date DESC LIMIT :days',
      { characterId: this._characterId, days },
    );
    return rows;
  }

  /** Get journal for a specific date. */
  getEntry(date) {
    const row = this._db.get(
      'SELECT content FROM journals WHERE character_id = :characterId AND date = :date',
      { characterId: this._characterId, date },
    );
    return row ? row.content : null;
  }

  /**
   * Semantic search across journal entries.
   * @param {string} query
   * @param {number} limit
   * @returns {Promise<Array<{date: string, content: string}>>}
   */
  async searchJournals(query, limit = 5) {
    // Try vector search first
    if (this._db.hasVectors) {
      try {
        const hits = await this._db.vectorSearch('journal_vectors', query, limit);
        if (hits.length > 0) {
          const ids = hits.map(h => h.id);
          const placeholders = ids.map(() => '?').join(',');
          const rows = this._db.all(
            `SELECT date, content FROM journals WHERE id IN (${placeholders}) AND character_id = ?`,
            [...ids, this._characterId],
          );
          const rowMap = new Map(rows.map(r => [r.date, r]));
          // Return in vector-distance order, dedup by date
          const seen = new Set();
          const ordered = [];
          for (const id of ids) {
            // Need to map id → date; re-fetch
            const jr = this._db.get('SELECT date, content FROM journals WHERE id = ?', id);
            if (jr && !seen.has(jr.date)) {
              seen.add(jr.date);
              ordered.push({ date: jr.date, content: jr.content });
            }
          }
          if (ordered.length > 0) return ordered.slice(0, limit);
        }
      } catch {
        // fall through to LIKE
      }
    }

    // LIKE fallback
    const q = `%${query}%`;
    const rows = this._db.all(`
      SELECT date, content FROM journals
      WHERE character_id = :characterId AND content LIKE :q
      ORDER BY date DESC
      LIMIT :limit
    `, { characterId: this._characterId, q, limit });
    return rows.map(r => ({ date: r.date, content: r.content }));
  }

  /** List available journal dates (most recent first). */
  list(limit = 30) {
    const rows = this._db.all(
      'SELECT date FROM journals WHERE character_id = :characterId ORDER BY date DESC LIMIT :limit',
      { characterId: this._characterId, limit },
    );
    return rows.map(r => r.date);
  }
}
