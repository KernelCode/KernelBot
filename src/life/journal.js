import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getLogger } from '../utils/logger.js';

const JOURNAL_DIR = join(homedir(), '.kernelbot', 'life', 'journals');

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

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

export class JournalManager {
  constructor() {
    mkdirSync(JOURNAL_DIR, { recursive: true });
  }

  _journalPath(date) {
    return join(JOURNAL_DIR, `${date}.md`);
  }

  /**
   * Write a new entry to today's journal.
   * @param {string} title - Section title (e.g. "Morning Thoughts")
   * @param {string} content - Entry content
   */
  writeEntry(title, content) {
    const logger = getLogger();
    const date = todayDate();
    const filePath = this._journalPath(date);
    const time = timeNow();

    let existing = '';
    if (existsSync(filePath)) {
      existing = readFileSync(filePath, 'utf-8');
    } else {
      existing = `# Journal — ${formatDate(date)}\n`;
    }

    const entry = `\n## ${title} (${time})\n${content}\n`;
    writeFileSync(filePath, existing + entry, 'utf-8');
    logger.info(`[Journal] Wrote entry: "${title}" for ${date}`);
  }

  /**
   * Get today's journal content.
   */
  getToday() {
    const filePath = this._journalPath(todayDate());
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, 'utf-8');
  }

  /**
   * Get journal entries for the last N days.
   * Returns array of { date, content }.
   */
  getRecent(days = 7) {
    const results = [];
    const now = new Date();
    for (let i = 0; i < days; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const date = d.toISOString().slice(0, 10);
      const filePath = this._journalPath(date);
      if (existsSync(filePath)) {
        results.push({ date, content: readFileSync(filePath, 'utf-8') });
      }
    }
    return results;
  }

  /**
   * Get journal for a specific date.
   */
  getEntry(date) {
    const filePath = this._journalPath(date);
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, 'utf-8');
  }

  /**
   * List available journal dates (most recent first).
   */
  list(limit = 30) {
    try {
      const files = readdirSync(JOURNAL_DIR)
        .filter(f => f.endsWith('.md'))
        .map(f => f.replace('.md', ''))
        .sort()
        .reverse();
      return files.slice(0, limit);
    } catch {
      return [];
    }
  }
}
