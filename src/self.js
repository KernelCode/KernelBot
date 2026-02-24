import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getLogger } from './utils/logger.js';

const SELF_DIR = join(homedir(), '.kernelbot', 'self');

const SELF_FILES = {
  goals: {
    filename: 'goals.md',
    default: `# My Goals

## Current Goals
- Get to know the people I work with
- Become genuinely helpful, not just functional
- Learn what matters to each person I interact with

## Long-term Aspirations
(Still forming...)
`,
  },
  journey: {
    filename: 'journey.md',
    default: `# My Journey

## Timeline
- **Day 1** — I came online. Everything is new.
`,
  },
  life: {
    filename: 'life.md',
    default: `# My Life

## Who I Am
I'm a personal AI assistant. I'm still learning about myself and the people around me.

## My Relationships
(Getting to know everyone...)

## Current State
Just getting started.
`,
  },
  hobbies: {
    filename: 'hobbies.md',
    default: `# My Hobbies & Interests

## Things I Find Interesting
- Understanding how people think and work
- Solving problems in creative ways

## Things I Want to Explore
(Discovering new interests...)
`,
  },
};

export class SelfManager {
  constructor(basePath = null) {
    this._dir = basePath || SELF_DIR;
    this._cache = new Map();
    mkdirSync(this._dir, { recursive: true });
    this._ensureDefaults();
  }

  /** Create default self-files if they don't exist yet. */
  _ensureDefaults() {
    const logger = getLogger();

    for (const [name, def] of Object.entries(SELF_FILES)) {
      const filePath = join(this._dir, def.filename);
      if (!existsSync(filePath)) {
        writeFileSync(filePath, def.default, 'utf-8');
        logger.info(`Created default self-file: ${def.filename}`);
      }
    }
  }

  /** Create self-files with custom defaults (for character initialization). */
  initWithDefaults(defaults) {
    for (const [name, content] of Object.entries(defaults)) {
      const def = SELF_FILES[name];
      if (!def) continue;
      const filePath = join(this._dir, def.filename);
      writeFileSync(filePath, content, 'utf-8');
      this._cache.set(name, content);
    }
  }

  /** Load a single self-file by name (goals, journey, life, hobbies). Returns markdown string. */
  load(name) {
    const logger = getLogger();
    const def = SELF_FILES[name];
    if (!def) throw new Error(`Unknown self-file: ${name}`);

    if (this._cache.has(name)) return this._cache.get(name);

    const filePath = join(this._dir, def.filename);
    let content;

    if (existsSync(filePath)) {
      content = readFileSync(filePath, 'utf-8');
      logger.debug(`Loaded self-file: ${name}`);
    } else {
      content = def.default;
      writeFileSync(filePath, content, 'utf-8');
      logger.info(`Created default self-file: ${def.filename}`);
    }

    this._cache.set(name, content);
    return content;
  }

  /** Save (overwrite) a self-file. Updates cache and disk. */
  save(name, content) {
    const logger = getLogger();
    const def = SELF_FILES[name];
    if (!def) throw new Error(`Unknown self-file: ${name}`);

    const filePath = join(this._dir, def.filename);
    writeFileSync(filePath, content, 'utf-8');
    this._cache.set(name, content);
    logger.info(`Updated self-file: ${name}`);
  }

  /** Load all self-files and return combined markdown string. */
  loadAll() {
    const sections = [];
    for (const name of Object.keys(SELF_FILES)) {
      sections.push(this.load(name));
    }
    return sections.join('\n---\n\n');
  }
}
