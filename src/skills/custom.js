/**
 * Custom user-defined skills — CRUD operations with JSON storage,
 * plus unified lookups that merge custom skills with the built-in catalog.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getSkillById, getSkillsByCategory, getCategoryList } from './catalog.js';

const STORAGE_DIR = join(homedir(), '.kernelbot');
const STORAGE_FILE = join(STORAGE_DIR, 'custom_skills.json');

let cache = null;

/** Slugify a name for use as an ID suffix. */
function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Generate a unique ID with `custom_` prefix. Appends -2, -3, etc. on collision. */
function generateId(name, existingIds) {
  const base = `custom_${slugify(name)}`;
  if (!existingIds.has(base)) return base;
  let n = 2;
  while (existingIds.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** Load custom skills from disk into the in-memory cache. */
export function loadCustomSkills() {
  if (cache !== null) return cache;
  if (!existsSync(STORAGE_FILE)) {
    cache = [];
    return cache;
  }
  try {
    const raw = readFileSync(STORAGE_FILE, 'utf-8');
    cache = JSON.parse(raw);
    if (!Array.isArray(cache)) cache = [];
  } catch {
    cache = [];
  }
  return cache;
}

/** Write the current cache to disk. */
export function saveCustomSkills(skills) {
  cache = skills;
  if (!existsSync(STORAGE_DIR)) {
    mkdirSync(STORAGE_DIR, { recursive: true });
  }
  writeFileSync(STORAGE_FILE, JSON.stringify(skills, null, 2), 'utf-8');
}

/** Return the cached array of custom skills. */
export function getCustomSkills() {
  if (cache === null) loadCustomSkills();
  return cache;
}

/**
 * Create a new custom skill, save, and return it.
 * @param {{ name: string, systemPrompt: string, description?: string }} opts
 */
export function addCustomSkill({ name, systemPrompt, description }) {
  const skills = getCustomSkills();
  const existingIds = new Set(skills.map((s) => s.id));
  const id = generateId(name, existingIds);

  const skill = {
    id,
    name,
    emoji: '\u{1F6E0}\uFE0F', // wrench emoji
    description: description || `Custom skill: ${name}`,
    systemPrompt,
    createdAt: new Date().toISOString(),
  };

  skills.push(skill);
  saveCustomSkills(skills);
  return skill;
}

/** Delete a custom skill by ID. Returns true if found and removed. */
export function deleteCustomSkill(id) {
  const skills = getCustomSkills();
  const idx = skills.findIndex((s) => s.id === id);
  if (idx === -1) return false;
  skills.splice(idx, 1);
  saveCustomSkills(skills);
  return true;
}

/** Find a custom skill by ID. */
export function getCustomSkillById(id) {
  const skills = getCustomSkills();
  return skills.find((s) => s.id === id);
}

/** Unified lookup: check custom first, then fall through to built-in catalog. */
export function getUnifiedSkillById(id) {
  return getCustomSkillById(id) || getSkillById(id);
}

/** Unified category list: built-in categories + custom category (if any exist). */
export function getUnifiedCategoryList() {
  const categories = getCategoryList();
  const customs = getCustomSkills();
  if (customs.length > 0) {
    categories.push({
      key: 'custom',
      name: 'Custom',
      emoji: '\u{1F6E0}\uFE0F',
      count: customs.length,
    });
  }
  return categories;
}

/** Unified skills-by-category: for 'custom' return custom skills; otherwise delegate. */
export function getUnifiedSkillsByCategory(key) {
  if (key === 'custom') return getCustomSkills();
  return getSkillsByCategory(key);
}
