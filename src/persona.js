import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getLogger } from './utils/logger.js';

const PERSONAS_DIR = join(homedir(), '.kernelbot', 'personas');

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

export class UserPersonaManager {
  constructor() {
    this._cache = new Map();
    mkdirSync(PERSONAS_DIR, { recursive: true });
  }

  /** Load persona for a user. Returns markdown string. Creates default if missing. */
  load(userId, username) {
    const logger = getLogger();
    const id = String(userId);

    if (this._cache.has(id)) return this._cache.get(id);

    const filePath = join(PERSONAS_DIR, `${id}.md`);
    let content;

    if (existsSync(filePath)) {
      content = readFileSync(filePath, 'utf-8');
      logger.debug(`Loaded persona for user ${id}`);
    } else {
      content = defaultTemplate(username, new Date().toISOString().slice(0, 10));
      writeFileSync(filePath, content, 'utf-8');
      logger.info(`Created default persona for user ${id} (${username})`);
    }

    this._cache.set(id, content);
    return content;
  }

  /** Save (overwrite) persona for a user. Updates cache and disk. */
  save(userId, content) {
    const logger = getLogger();
    const id = String(userId);
    const filePath = join(PERSONAS_DIR, `${id}.md`);

    writeFileSync(filePath, content, 'utf-8');
    this._cache.set(id, content);
    logger.info(`Updated persona for user ${id}`);
  }
}
