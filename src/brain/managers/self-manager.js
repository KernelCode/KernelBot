import { getLogger } from '../../utils/logger.js';

const VALID_FILES = ['goals', 'journey', 'life', 'hobbies'];

/**
 * BrainSelfManager — SQLite-backed drop-in replacement for SelfManager.
 * Same public API: initWithDefaults, load, save, loadAll.
 */
export class BrainSelfManager {
  constructor(db, characterId) {
    this._db = db;
    this._characterId = characterId;
    this._cache = new Map();
  }

  /** Create self-files with custom defaults (for character initialization). */
  initWithDefaults(defaults) {
    const now = Date.now();
    for (const [name, content] of Object.entries(defaults)) {
      if (!VALID_FILES.includes(name)) continue;
      this._db.run(`
        INSERT OR REPLACE INTO self_data (character_id, file_name, content, updated_at)
        VALUES (:characterId, :fileName, :content, :now)
      `, { characterId: this._characterId, fileName: name, content, now });
      this._cache.set(name, content);
    }
  }

  /** Load a single self-file by name. Returns markdown string. */
  load(name) {
    if (!VALID_FILES.includes(name)) throw new Error(`Unknown self-file: ${name}`);

    if (this._cache.has(name)) return this._cache.get(name);

    const row = this._db.get(
      'SELECT content FROM self_data WHERE character_id = :characterId AND file_name = :fileName',
      { characterId: this._characterId, fileName: name },
    );

    if (row) {
      this._cache.set(name, row.content);
      return row.content;
    }

    // No data — return empty string (defaults should have been set via migration)
    return '';
  }

  /** Save (overwrite) a self-file. */
  save(name, content) {
    const logger = getLogger();
    if (!VALID_FILES.includes(name)) throw new Error(`Unknown self-file: ${name}`);

    this._db.run(`
      INSERT OR REPLACE INTO self_data (character_id, file_name, content, updated_at)
      VALUES (:characterId, :fileName, :content, :now)
    `, { characterId: this._characterId, fileName: name, content, now: Date.now() });

    this._cache.set(name, content);
    logger.info(`Updated self-file: ${name}`);
  }

  /** Load all self-files and return combined markdown string. */
  loadAll() {
    const sections = [];
    for (const name of VALID_FILES) {
      const content = this.load(name);
      if (content) sections.push(content);
    }
    return sections.join('\n---\n\n');
  }
}
