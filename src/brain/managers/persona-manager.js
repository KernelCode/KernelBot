import { getLogger } from '../../utils/logger.js';

function defaultTemplate(username, date) {
  return `# User Profile

## Basic Info
- Username: ${username || 'unknown'}
- First seen: ${date}

## Preferences
(Not yet known)

## Expertise & Interests
(Not yet known)

## Communication Style
(Not yet known)

## Notes
(Not yet known)
`;
}

/**
 * BrainPersonaManager — SQLite-backed drop-in replacement for UserPersonaManager.
 * Same public API: load, save.
 */
export class BrainPersonaManager {
  constructor(db) {
    this._db = db;
    this._cache = new Map();
  }

  /** Load persona for a user. Returns markdown string. Creates default if missing. */
  load(userId, username) {
    const logger = getLogger();
    const id = String(userId);

    if (this._cache.has(id)) return this._cache.get(id);

    const row = this._db.get(
      'SELECT persona_md FROM user_personas WHERE user_id = :userId',
      { userId: id },
    );

    if (row) {
      this._cache.set(id, row.persona_md);
      logger.debug(`Loaded persona for user ${id}`);
      return row.persona_md;
    }

    // Create default — enrich from known_senders if available
    let enrichedUsername = username;
    let extraInfo = '';
    try {
      const sender = this._db.get(
        'SELECT display_name, sender_type, org_role, team FROM known_senders WHERE user_id = :userId LIMIT 1',
        { userId: id },
      );
      if (sender) {
        if (sender.display_name) enrichedUsername = sender.display_name;
        if (sender.sender_type && sender.sender_type !== 'unknown') {
          extraInfo += `- Trust level: ${sender.sender_type}\n`;
        }
        if (sender.org_role) extraInfo += `- Role: ${sender.org_role}\n`;
        if (sender.team) extraInfo += `- Team: ${sender.team}\n`;
      }
    } catch { /* ignore — table may not exist yet */ }

    let content = defaultTemplate(enrichedUsername, new Date().toISOString().slice(0, 10));
    if (extraInfo) {
      content = content.replace('## Preferences', `## Known Info\n${extraInfo}\n## Preferences`);
    }

    this._db.run(`
      INSERT INTO user_personas (user_id, persona_md, updated_at)
      VALUES (:userId, :content, :now)
    `, { userId: id, content, now: Date.now() });

    this._cache.set(id, content);
    logger.info(`Created default persona for user ${id} (${username})`);

    this._db.embedBackground('persona_vectors', id, content);

    return content;
  }

  /** Save (overwrite) persona for a user. */
  save(userId, content) {
    const logger = getLogger();
    const id = String(userId);

    this._db.run(`
      INSERT OR REPLACE INTO user_personas (user_id, persona_md, updated_at)
      VALUES (:userId, :content, :now)
    `, { userId: id, content, now: Date.now() });

    this._cache.set(id, content);
    logger.info(`Updated persona for user ${id}`);

    this._db.embedBackground('persona_vectors', id, content);
  }

  /**
   * Get a compact persona (~500-800 chars) for prompt injection.
   * Extracts key fields from the full persona markdown.
   * Full persona stays available via load() for recall tools.
   */
  getCompactPersona(userId, username) {
    const full = this.load(userId, username);
    if (!full) return null;

    const lines = full.split('\n');
    const compact = [];
    let currentSection = '';
    let sectionLines = 0;
    const maxPerSection = 3;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Track section headers
      if (trimmed.startsWith('## ')) {
        currentSection = trimmed.replace('## ', '').toLowerCase();
        sectionLines = 0;
        // Skip sections with only "(Not yet known)"
        continue;
      }
      if (trimmed.startsWith('# ')) continue; // skip top-level header

      // Skip placeholder content
      if (trimmed === '(Not yet known)') continue;

      // Limit lines per section
      if (sectionLines >= maxPerSection) continue;

      compact.push(trimmed);
      sectionLines++;
    }

    const result = compact.join('\n');
    // If compact is already short enough or empty, return it
    if (result.length <= 800) return result || null;
    return result.slice(0, 800) + '...';
  }

  /**
   * Semantic search across user personas.
   * @param {string} query
   * @param {number} limit
   * @returns {Promise<Array<{userId: string, personaMd: string}>>}
   */
  async searchPersonas(query, limit = 5) {
    // Try vector search first
    if (this._db.hasVectors) {
      try {
        const hits = await this._db.vectorSearch('persona_vectors', query, limit);
        if (hits.length > 0) {
          const ids = hits.map(h => h.id);
          const placeholders = ids.map(() => '?').join(',');
          const rows = this._db.all(
            `SELECT user_id, persona_md FROM user_personas WHERE user_id IN (${placeholders})`,
            ...ids,
          );
          const rowMap = new Map(rows.map(r => [r.user_id, r]));
          const ordered = ids.map(id => rowMap.get(id)).filter(Boolean);
          if (ordered.length > 0) return ordered.map(r => ({ userId: r.user_id, personaMd: r.persona_md }));
        }
      } catch {
        // fall through to LIKE
      }
    }

    // LIKE fallback
    const q = `%${query}%`;
    const rows = this._db.all(
      `SELECT user_id, persona_md FROM user_personas WHERE persona_md LIKE :q LIMIT :limit`,
      { q, limit },
    );
    return rows.map(r => ({ userId: r.user_id, personaMd: r.persona_md }));
  }
}
