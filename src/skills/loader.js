/**
 * Skills loader — parses markdown skill files with YAML frontmatter.
 * Replaces catalog.js as the primary skill source.
 * Uses js-yaml (already a dependency) instead of gray-matter.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, unlinkSync, renameSync } from 'fs';
import { join, basename, extname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import yaml from 'js-yaml';
import { getLogger as _getLogger } from '../utils/logger.js';

/** Safe logger that falls back to console if logger not initialized. */
function getLogger() {
  try {
    return _getLogger();
  } catch {
    return console;
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILTIN_DIR = join(__dirname, '..', '..', 'skills');
const CUSTOM_DIR = join(homedir(), '.kernelbot', 'skills');

/** Category metadata for display purposes. */
export const SKILL_CATEGORIES = {
  engineering: { name: 'Engineering', emoji: '⚙️' },
  design: { name: 'Design', emoji: '🎨' },
  marketing: { name: 'Marketing', emoji: '📣' },
  business: { name: 'Business', emoji: '💼' },
  writing: { name: 'Writing', emoji: '✍️' },
  data: { name: 'Data & AI', emoji: '📊' },
  finance: { name: 'Finance', emoji: '💰' },
  legal: { name: 'Legal', emoji: '⚖️' },
  education: { name: 'Education', emoji: '📚' },
  healthcare: { name: 'Healthcare', emoji: '🏥' },
  creative: { name: 'Creative', emoji: '🎬' },
};

/** In-memory cache. Map<id, Skill> */
let skillCache = null;

/**
 * Parse a markdown file with YAML frontmatter.
 * Returns { data: {frontmatter}, body: string } or null on failure.
 */
function parseFrontmatter(content) {
  const trimmed = content.trim();
  if (!trimmed.startsWith('---')) return null;

  const endIdx = trimmed.indexOf('---', 3);
  if (endIdx === -1) return null;

  const yamlStr = trimmed.slice(3, endIdx).trim();
  const body = trimmed.slice(endIdx + 3).trim();

  try {
    const data = yaml.load(yamlStr) || {};
    return { data, body };
  } catch {
    return null;
  }
}

/**
 * Load a single .md skill file into a Skill object.
 * @returns {object|null} Skill object or null if invalid
 */
function loadSkillFile(filePath) {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const parsed = parseFrontmatter(content);
    if (!parsed) return null;

    const { data, body } = parsed;
    if (!data.id || !data.name) return null;

    return {
      id: data.id,
      name: data.name,
      emoji: data.emoji || '🛠️',
      category: data.category || 'custom',
      description: data.description || '',
      worker_affinity: data.worker_affinity || null,
      tags: data.tags || [],
      body, // raw markdown body = the full prompt
      filePath,
      isCustom: filePath.startsWith(CUSTOM_DIR),
    };
  } catch {
    return null;
  }
}

/**
 * Scan a directory recursively for .md files and load them as skills.
 * @returns {Map<string, object>} Map of id → skill
 */
function scanDirectory(dir) {
  const results = new Map();
  if (!existsSync(dir)) return results;

  function walk(current) {
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && extname(entry.name) === '.md') {
        const skill = loadSkillFile(fullPath);
        if (skill) {
          results.set(skill.id, skill);
        }
      }
    }
  }

  walk(dir);
  return results;
}

/**
 * Load all skills from built-in and custom directories.
 * Custom skills override built-in skills with the same ID.
 * @param {boolean} force - Force reload even if cached
 * @returns {Map<string, object>} Map of id → skill
 */
export function loadAllSkills(force = false) {
  if (skillCache && !force) return skillCache;

  const logger = getLogger();
  skillCache = new Map();

  // Load built-in skills first
  const builtins = scanDirectory(BUILTIN_DIR);
  for (const [id, skill] of builtins) {
    skillCache.set(id, skill);
  }

  // Load custom skills (override built-ins with same ID)
  const customs = scanDirectory(CUSTOM_DIR);
  for (const [id, skill] of customs) {
    skillCache.set(id, skill);
  }

  logger.debug(`Skills loaded: ${builtins.size} built-in, ${customs.size} custom, ${skillCache.size} total`);
  return skillCache;
}

/** Get a skill by ID. Custom-first lookup (custom dir overrides built-in). */
export function getSkillById(id) {
  const skills = loadAllSkills();
  return skills.get(id) || null;
}

/** Return all skills in a given category. */
export function getSkillsByCategory(categoryKey) {
  const skills = loadAllSkills();
  return [...skills.values()].filter(s => s.category === categoryKey);
}

/** Return an array of { key, name, emoji, count } for all categories that have skills. */
export function getCategoryList() {
  const skills = loadAllSkills();
  const counts = new Map();

  for (const skill of skills.values()) {
    counts.set(skill.category, (counts.get(skill.category) || 0) + 1);
  }

  const result = [];
  // Built-in categories first (in defined order)
  for (const [key, cat] of Object.entries(SKILL_CATEGORIES)) {
    const count = counts.get(key) || 0;
    if (count > 0) {
      result.push({ key, name: cat.name, emoji: cat.emoji, count });
    }
  }

  // Custom category if any custom skills exist
  const customSkills = [...skills.values()].filter(s => s.isCustom && s.category === 'custom');
  if (customSkills.length > 0 && !result.find(r => r.key === 'custom')) {
    result.push({ key: 'custom', name: 'Custom', emoji: '🛠️', count: customSkills.length });
  }

  return result;
}

/**
 * Build a combined prompt string from multiple skill IDs.
 * Each skill gets a header and its full body.
 * @param {string[]} skillIds - Array of skill IDs
 * @param {number} charBudget - Max characters (default ~16000 ≈ 4000 tokens)
 * @returns {string|null} Combined prompt or null if no valid skills
 */
export function buildSkillPrompt(skillIds, charBudget = 16000) {
  if (!skillIds || skillIds.length === 0) return null;

  const skills = loadAllSkills();
  const sections = [];

  for (const id of skillIds) {
    const skill = skills.get(id);
    if (!skill) continue;
    sections.push(`### Skill: ${skill.emoji} ${skill.name}\n${skill.body}`);
  }

  if (sections.length === 0) return null;

  let combined = sections.join('\n\n');

  // Truncate from end if over budget
  if (combined.length > charBudget) {
    combined = combined.slice(0, charBudget) + '\n\n[...truncated due to token budget]';
  }

  return combined;
}

/**
 * Filter skill IDs by worker affinity.
 * Skills with null worker_affinity pass through (available to all workers).
 * @param {string[]} skillIds - All active skill IDs
 * @param {string} workerType - The worker type (coding, browser, system, etc.)
 * @returns {string[]} Filtered skill IDs
 */
export function filterSkillsForWorker(skillIds, workerType) {
  if (!skillIds || skillIds.length === 0) return [];

  const skills = loadAllSkills();
  return skillIds.filter(id => {
    const skill = skills.get(id);
    if (!skill) return false;
    // null affinity = available to all workers
    if (!skill.worker_affinity) return true;
    return skill.worker_affinity.includes(workerType);
  });
}

/**
 * Save a custom skill as a .md file.
 * @param {{ name: string, emoji?: string, category?: string, body: string, description?: string }} opts
 * @returns {object} The saved skill object
 */
export function saveCustomSkill({ name, emoji, category, body, description }) {
  mkdirSync(CUSTOM_DIR, { recursive: true });

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  let id = `custom_${slug}`;

  // Check for collision
  const existing = loadAllSkills();
  if (existing.has(id)) {
    let n = 2;
    while (existing.has(`${id}-${n}`)) n++;
    id = `${id}-${n}`;
  }

  const frontmatter = {
    id,
    name,
    emoji: emoji || '🛠️',
    category: category || 'custom',
    description: description || `Custom skill: ${name}`,
  };

  const yamlStr = yaml.dump(frontmatter, { lineWidth: -1 }).trim();
  const content = `---\n${yamlStr}\n---\n\n${body}`;

  const filePath = join(CUSTOM_DIR, `${id}.md`);
  writeFileSync(filePath, content, 'utf-8');

  // Invalidate cache
  skillCache = null;

  return loadSkillFile(filePath);
}

/**
 * Delete a custom skill by ID.
 * @returns {boolean} true if found and deleted
 */
export function deleteCustomSkill(id) {
  const skill = getSkillById(id);
  if (!skill || !skill.isCustom) return false;

  try {
    unlinkSync(skill.filePath);
    skillCache = null; // invalidate cache
    return true;
  } catch {
    return false;
  }
}

/** Get all custom skills. */
export function getCustomSkills() {
  const skills = loadAllSkills();
  return [...skills.values()].filter(s => s.isCustom);
}

/**
 * Migrate old custom_skills.json to .md files.
 * Called once on startup if the old file exists.
 */
export function migrateOldCustomSkills() {
  const oldFile = join(homedir(), '.kernelbot', 'custom_skills.json');
  if (!existsSync(oldFile)) return;

  const logger = getLogger();
  try {
    const raw = readFileSync(oldFile, 'utf-8');
    const oldSkills = JSON.parse(raw);
    if (!Array.isArray(oldSkills) || oldSkills.length === 0) return;

    mkdirSync(CUSTOM_DIR, { recursive: true });
    let migrated = 0;

    for (const old of oldSkills) {
      if (!old.name || !old.systemPrompt) continue;

      const slug = old.id || old.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const id = slug.startsWith('custom_') ? slug : `custom_${slug}`;
      const filePath = join(CUSTOM_DIR, `${id}.md`);

      // Don't overwrite if already migrated
      if (existsSync(filePath)) continue;

      const frontmatter = {
        id,
        name: old.name,
        emoji: old.emoji || '🛠️',
        category: 'custom',
        description: old.description || `Custom skill: ${old.name}`,
      };

      const yamlStr = yaml.dump(frontmatter, { lineWidth: -1 }).trim();
      const content = `---\n${yamlStr}\n---\n\n${old.systemPrompt}`;
      writeFileSync(filePath, content, 'utf-8');
      migrated++;
    }

    if (migrated > 0) {
      logger.info(`Migrated ${migrated} custom skills from JSON to .md files`);
    }

    // Rename old file to mark as migrated
    renameSync(oldFile, oldFile + '.bak');
    logger.info('Renamed custom_skills.json to custom_skills.json.bak');
  } catch (err) {
    logger.warn(`Failed to migrate old custom skills: ${err.message}`);
  }
}

// ── Backward-compatible aliases ──────────────────────────────────────────
// These maintain the same API surface that custom.js exported,
// so existing imports keep working during the transition.

/** Unified skill lookup (same as getSkillById — customs already override). */
export const getUnifiedSkillById = getSkillById;

/** Unified category list (same as getCategoryList — already includes custom). */
export const getUnifiedCategoryList = getCategoryList;

/** Unified skills by category (same as getSkillsByCategory). */
export const getUnifiedSkillsByCategory = getSkillsByCategory;

/** Backward-compat: load custom skills from disk (now a no-op, auto-loaded). */
export function loadCustomSkills() {
  loadAllSkills();
}

/**
 * Backward-compat: add a custom skill.
 * @param {{ name: string, systemPrompt: string, description?: string }} opts
 */
export function addCustomSkill({ name, systemPrompt, description }) {
  return saveCustomSkill({ name, body: systemPrompt, description });
}
