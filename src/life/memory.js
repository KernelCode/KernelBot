import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getLogger } from '../utils/logger.js';
import { genId } from '../utils/ids.js';
import { todayDateStr } from '../utils/date.js';

const LIFE_DIR = join(homedir(), '.kernelbot', 'life');
const EPISODIC_DIR = join(LIFE_DIR, 'memories', 'episodic');
const SEMANTIC_FILE = join(LIFE_DIR, 'memories', 'semantic', 'topics.json');

export class MemoryManager {
  constructor() {
    this._episodicCache = new Map(); // date -> array
    this._semanticCache = null;
    mkdirSync(EPISODIC_DIR, { recursive: true });
    mkdirSync(join(LIFE_DIR, 'memories', 'semantic'), { recursive: true });
  }

  // ── Episodic Memories ──────────────────────────────────────────

  _episodicPath(date) {
    return join(EPISODIC_DIR, `${date}.json`);
  }

  _loadEpisodicDay(date) {
    if (this._episodicCache.has(date)) return this._episodicCache.get(date);
    const filePath = this._episodicPath(date);
    let entries = [];
    if (existsSync(filePath)) {
      try {
        entries = JSON.parse(readFileSync(filePath, 'utf-8'));
      } catch {
        entries = [];
      }
    }
    this._episodicCache.set(date, entries);
    return entries;
  }

  _saveEpisodicDay(date, entries) {
    this._episodicCache.set(date, entries);
    writeFileSync(this._episodicPath(date), JSON.stringify(entries, null, 2), 'utf-8');
  }

  /**
   * Add an episodic memory.
   * @param {{ type: string, source: string, summary: string, tags?: string[], importance?: number, userId?: string }} memory
   */
  addEpisodic(memory) {
    const logger = getLogger();
    const date = todayDateStr();
    const entries = this._loadEpisodicDay(date);
    const entry = {
      id: genId('ep'),
      timestamp: Date.now(),
      type: memory.type || 'interaction',
      source: memory.source || 'user_chat',
      userId: memory.userId || null,
      summary: memory.summary,
      tags: memory.tags || [],
      importance: memory.importance || 5,
    };
    entries.push(entry);
    this._saveEpisodicDay(date, entries);
    logger.debug(`[Memory] Added episodic: "${entry.summary.slice(0, 80)}" (${entry.id})`);
    return entry;
  }

  /**
   * Get recent episodic memories within the last N hours.
   */
  getRecentEpisodic(hours = 24, limit = 20) {
    const cutoff = Date.now() - hours * 3600_000;
    const results = [];

    // Check today and recent days
    const daysToCheck = Math.ceil(hours / 24) + 1;
    const dates = this._getRecentDates(daysToCheck);

    for (const date of dates) {
      const entries = this._loadEpisodicDay(date);
      for (const entry of entries) {
        if (entry.timestamp >= cutoff) results.push(entry);
      }
    }

    results.sort((a, b) => b.timestamp - a.timestamp);
    return results.slice(0, limit);
  }

  /**
   * Get memories about a specific user.
   */
  getMemoriesAboutUser(userId, limit = 10) {
    const results = [];
    const dates = this._getRecentDates(90);

    for (const date of dates) {
      const entries = this._loadEpisodicDay(date);
      for (const entry of entries) {
        if (entry.userId === String(userId)) results.push(entry);
      }
    }

    results.sort((a, b) => b.timestamp - a.timestamp);
    return results.slice(0, limit);
  }

  /**
   * Search episodic memories by keyword (simple substring match on summary + tags).
   */
  searchEpisodic(query, limit = 10) {
    const q = query.toLowerCase();
    const results = [];
    const dates = this._getRecentDates(90);

    for (const date of dates) {
      const entries = this._loadEpisodicDay(date);
      for (const entry of entries) {
        const haystack = `${entry.summary} ${entry.tags.join(' ')}`.toLowerCase();
        if (haystack.includes(q)) results.push(entry);
      }
    }

    results.sort((a, b) => b.importance - a.importance || b.timestamp - a.timestamp);
    return results.slice(0, limit);
  }

  /**
   * Prune episodic memories older than N days.
   */
  pruneOld(daysToKeep = 90) {
    const logger = getLogger();
    const cutoffDate = new Date(Date.now() - daysToKeep * 86400_000).toISOString().slice(0, 10);
    let pruned = 0;

    try {
      const files = readdirSync(EPISODIC_DIR).filter(f => f.endsWith('.json'));
      for (const file of files) {
        const date = file.replace('.json', '');
        if (date < cutoffDate) {
          unlinkSync(join(EPISODIC_DIR, file));
          this._episodicCache.delete(date);
          pruned++;
        }
      }
    } catch (err) {
      logger.warn(`[Memory] Prune error: ${err.message}`);
    }

    if (pruned > 0) logger.info(`[Memory] Pruned ${pruned} old episodic files`);
    return pruned;
  }

  _getRecentDates(days) {
    const dates = [];
    const now = new Date();
    for (let i = 0; i < days; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      dates.push(d.toISOString().slice(0, 10));
    }
    return dates;
  }

  // ── Semantic Knowledge ─────────────────────────────────────────

  _loadSemantic() {
    if (this._semanticCache) return this._semanticCache;
    if (existsSync(SEMANTIC_FILE)) {
      try {
        this._semanticCache = JSON.parse(readFileSync(SEMANTIC_FILE, 'utf-8'));
      } catch {
        this._semanticCache = {};
      }
    } else {
      this._semanticCache = {};
    }
    return this._semanticCache;
  }

  _saveSemantic() {
    writeFileSync(SEMANTIC_FILE, JSON.stringify(this._semanticCache || {}, null, 2), 'utf-8');
  }

  /**
   * Add or update semantic knowledge.
   * @param {string} topic - Topic key (e.g. "rust_ownership")
   * @param {{ summary: string, sources?: string[], relatedTopics?: string[] }} knowledge
   */
  addSemantic(topic, knowledge) {
    const logger = getLogger();
    const data = this._loadSemantic();
    const key = topic.toLowerCase().replace(/\s+/g, '_');
    const existing = data[key];

    data[key] = {
      summary: knowledge.summary,
      sources: [...new Set([...(existing?.sources || []), ...(knowledge.sources || [])])],
      learnedAt: Date.now(),
      relatedTopics: [...new Set([...(existing?.relatedTopics || []), ...(knowledge.relatedTopics || [])])],
    };

    this._semanticCache = data;
    this._saveSemantic();
    logger.debug(`[Memory] Updated semantic topic: ${key}`);
    return data[key];
  }

  /**
   * Search semantic knowledge by keyword.
   */
  searchSemantic(query, limit = 5) {
    const q = query.toLowerCase();
    const data = this._loadSemantic();
    const results = [];

    for (const [key, val] of Object.entries(data)) {
      const haystack = `${key} ${val.summary} ${val.relatedTopics.join(' ')}`.toLowerCase();
      if (haystack.includes(q)) {
        results.push({ topic: key, ...val });
      }
    }

    results.sort((a, b) => b.learnedAt - a.learnedAt);
    return results.slice(0, limit);
  }

  // ── Prompt Builder ─────────────────────────────────────────────

  /**
   * Build a context block of relevant memories for the orchestrator prompt.
   * Pulls recent episodic + user-specific + semantic topics.
   * Capped to ~1500 chars.
   */
  buildContextBlock(userId = null) {
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
    const data = this._loadSemantic();
    const semanticEntries = Object.entries(data)
      .sort((a, b) => b[1].learnedAt - a[1].learnedAt)
      .slice(0, 3);
    if (semanticEntries.length > 0) {
      const lines = semanticEntries.map(([key, val]) => `- **${key}**: ${val.summary.slice(0, 100)}`);
      sections.push(`Knowledge:\n${lines.join('\n')}`);
    }

    if (sections.length === 0) return null;

    let block = sections.join('\n\n');
    if (block.length > 1500) block = block.slice(0, 1500) + '\n...';
    return block;
  }
}
