/**
 * SkillForge — manages the learning lifecycle of skills.
 * Skills progress: seed → growing → mature → contributed.
 * Integrates with the Life Engine for autonomous growth and
 * with the Orchestrator for auto-assignment to workers.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import yaml from 'js-yaml';
import { getLogger as _getLogger } from '../utils/logger.js';
import { saveCustomSkill, getSkillById, loadAllSkills } from './loader.js';

function getLogger() {
  try {
    return _getLogger();
  } catch {
    return console;
  }
}

const DEFAULT_SKILLS_DIR = join(homedir(), '.kernelbot', 'skills');
const DEFAULT_FORGE_FILE = join(DEFAULT_SKILLS_DIR, 'forge.json');

const DEFAULT_FORGE_DATA = {
  skills: {},
  stats: {
    totalCreated: 0,
    totalContributed: 0,
    lastResearchTime: null,
  },
};

export class SkillForge {
  /**
   * @param {{ basePath?: string, agent?: object, memoryManager?: object, config?: object }} deps
   */
  constructor({ basePath, agent, memoryManager, config } = {}) {
    this._skillsDir = basePath || DEFAULT_SKILLS_DIR;
    this._forgeFile = join(this._skillsDir, 'forge.json');
    this.agent = agent || null;
    this.memoryManager = memoryManager || null;
    this.config = config || {};
    mkdirSync(this._skillsDir, { recursive: true });
    this._data = this._load();
  }

  // ── Persistence ─────────────────────────────────────────────

  _load() {
    if (existsSync(this._forgeFile)) {
      try {
        const raw = JSON.parse(readFileSync(this._forgeFile, 'utf-8'));
        return {
          skills: raw.skills || {},
          stats: { ...DEFAULT_FORGE_DATA.stats, ...raw.stats },
        };
      } catch {
        return { skills: {}, stats: { ...DEFAULT_FORGE_DATA.stats } };
      }
    }
    return { skills: {}, stats: { ...DEFAULT_FORGE_DATA.stats } };
  }

  _save() {
    writeFileSync(this._forgeFile, JSON.stringify(this._data, null, 2), 'utf-8');
  }

  // ── Lifecycle ───────────────────────────────────────────────

  /**
   * Create an initial skill from a topic. Generates a seed skill .md file
   * and tracks it in forge.json.
   * @param {string} topic - Topic to learn about
   * @param {string} domain - Domain category (engineering, design, etc.)
   * @param {string} context - Optional initial context or research findings
   * @returns {object} The forge skill metadata
   */
  async seedSkill(topic, domain = 'engineering', context = '') {
    const logger = getLogger();
    const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const skillId = `custom_${slug}`;

    // Check if already tracked
    if (this._data.skills[skillId]) {
      logger.info(`[SkillForge] Skill "${skillId}" already exists (status: ${this._data.skills[skillId].status})`);
      return this._data.skills[skillId];
    }

    // Extract auto-assign patterns from topic name
    const autoAssignPatterns = this._generatePatterns(topic);

    // Create the skill .md file via loader
    const body = context
      ? `# ${topic}\n\n## Initial Research\n${context}`
      : `# ${topic}\n\n_Seed skill — awaiting initial research._`;

    const skill = saveCustomSkill({
      name: topic,
      emoji: '🌱',
      category: domain,
      body,
      description: `Self-learning skill: ${topic}`,
    });

    if (!skill) {
      logger.error(`[SkillForge] Failed to save seed skill for "${topic}"`);
      return null;
    }

    // Update the skill file with forge-specific frontmatter
    this._updateSkillFrontmatter(skill.filePath, {
      auto_assign: autoAssignPatterns,
      forge_managed: true,
      maturity: 0,
      last_researched: new Date().toISOString().split('T')[0],
      worker_affinity: null, // available to all workers
    });

    // Track in forge.json
    const now = Date.now();
    const forgeMeta = {
      skillId: skill.id,
      topic,
      status: 'seed',
      maturity: 0,
      domain,
      createdAt: now,
      lastResearchedAt: null,
      lastUpdatedAt: now,
      researchCount: 0,
      sources: [],
      relatedSkills: [],
      autoAssignPatterns,
      contributedPrUrl: null,
    };

    this._data.skills[skill.id] = forgeMeta;
    this._data.stats.totalCreated++;
    this._save();

    // Invalidate skill cache so loader picks up the new frontmatter
    loadAllSkills(true);

    logger.info(`[SkillForge] Seeded skill "${topic}" (${skill.id}) in domain "${domain}" with ${autoAssignPatterns.length} patterns`);
    return forgeMeta;
  }

  /**
   * Grow an existing skill by appending new knowledge.
   * Called by the Life Engine's learn activity or manually.
   * @param {string} skillId - The skill ID to grow
   * @param {string} newKnowledge - New research findings to append
   * @param {string[]} sources - URLs of sources
   * @returns {object|null} Updated forge metadata or null
   */
  async growSkill(skillId, newKnowledge, sources = []) {
    const logger = getLogger();
    const meta = this._data.skills[skillId];
    if (!meta) {
      logger.warn(`[SkillForge] Cannot grow unknown skill: ${skillId}`);
      return null;
    }

    const skill = getSkillById(skillId);
    if (!skill) {
      logger.warn(`[SkillForge] Skill file not found for: ${skillId}`);
      return null;
    }

    // Append timestamped knowledge section to the skill body
    const dateStr = new Date().toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    const appendSection = `\n\n## Update: ${dateStr}\n${newKnowledge}${sources.length > 0 ? `\n\nSources: ${sources.join(', ')}` : ''}`;

    // Read and append to the skill file
    try {
      const content = readFileSync(skill.filePath, 'utf-8');
      writeFileSync(skill.filePath, content + appendSection, 'utf-8');
    } catch (err) {
      logger.error(`[SkillForge] Failed to append to skill file: ${err.message}`);
      return null;
    }

    // Update forge metadata
    const now = Date.now();
    meta.maturity = Math.min(10, meta.maturity + 1);
    meta.researchCount++;
    meta.lastResearchedAt = now;
    meta.lastUpdatedAt = now;
    meta.sources = [...new Set([...meta.sources, ...sources])].slice(-20); // Keep last 20

    // Status transitions
    if (meta.status === 'seed' && meta.maturity >= 1) {
      meta.status = 'growing';
      logger.info(`[SkillForge] Skill "${skillId}" transitioned: seed → growing`);
    }
    if (meta.status === 'growing' && meta.maturity >= 5) {
      meta.status = 'mature';
      logger.info(`[SkillForge] Skill "${skillId}" transitioned: growing → mature`);
    }

    // Update frontmatter
    this._updateSkillFrontmatter(skill.filePath, {
      maturity: meta.maturity,
      last_researched: new Date().toISOString().split('T')[0],
    });

    this._data.stats.lastResearchTime = now;
    this._save();

    // Invalidate skill cache
    loadAllSkills(true);

    logger.info(`[SkillForge] Grew skill "${skillId}" — maturity: ${meta.maturity}, status: ${meta.status}`);
    return meta;
  }

  // ── Auto-Assignment ─────────────────────────────────────────

  /**
   * Match forge-managed skills against a task description.
   * Returns skill IDs sorted by relevance (max 3).
   * @param {string} taskDescription - The task to match against
   * @param {string} workerType - Optional worker type for affinity filtering
   * @returns {string[]} Matched skill IDs
   */
  matchSkills(taskDescription, workerType = null) {
    if (!taskDescription) return [];
    const taskLower = taskDescription.toLowerCase();
    const matched = [];

    for (const [skillId, meta] of Object.entries(this._data.skills)) {
      if (meta.status === 'contributed') continue; // Skip contributed skills (use published version)

      const patterns = meta.autoAssignPatterns || [];
      const score = patterns.filter(p => taskLower.includes(p.toLowerCase())).length;
      if (score > 0) {
        // Boost by maturity (mature skills are more useful)
        const boostedScore = score + (meta.maturity * 0.2);
        matched.push({ skillId, score: boostedScore });
      }
    }

    const maxAutoAssign = this.config.skills?.forge?.max_auto_assign ?? 3;

    return matched
      .sort((a, b) => b.score - a.score)
      .slice(0, maxAutoAssign)
      .map(m => m.skillId);
  }

  /**
   * Get all auto-assign patterns across all forge skills.
   * @returns {Map<string, string>} pattern → skillId
   */
  getAutoAssignPatterns() {
    const patterns = new Map();
    for (const [skillId, meta] of Object.entries(this._data.skills)) {
      for (const p of meta.autoAssignPatterns || []) {
        patterns.set(p.toLowerCase(), skillId);
      }
    }
    return patterns;
  }

  // ── Contribution ────────────────────────────────────────────

  /**
   * Get skills eligible for community contribution.
   * @returns {object[]} Array of forge metadata for mature skills
   */
  getMatureSkills() {
    const threshold = this.config.skills?.forge?.contribute_threshold ?? 7;
    return Object.values(this._data.skills)
      .filter(m => m.status === 'mature' && m.maturity >= threshold && !m.contributedPrUrl);
  }

  /**
   * Mark a skill as contributed with PR URL.
   * @param {string} skillId
   * @param {string} prUrl
   */
  markContributed(skillId, prUrl) {
    const meta = this._data.skills[skillId];
    if (!meta) return;
    meta.status = 'contributed';
    meta.contributedPrUrl = prUrl;
    this._data.stats.totalContributed++;
    this._save();
  }

  // ── Status & Queries ────────────────────────────────────────

  /**
   * Get forge status for display.
   * @returns {object}
   */
  getForgeStatus() {
    const skills = Object.values(this._data.skills);
    const byStatus = { seed: 0, growing: 0, mature: 0, contributed: 0 };
    for (const s of skills) {
      byStatus[s.status] = (byStatus[s.status] || 0) + 1;
    }
    return {
      total: skills.length,
      byStatus,
      stats: this._data.stats,
      skills: skills.map(s => ({
        skillId: s.skillId,
        topic: s.topic,
        status: s.status,
        maturity: s.maturity,
        domain: s.domain,
        researchCount: s.researchCount,
        lastResearchedAt: s.lastResearchedAt,
      })),
    };
  }

  /**
   * Get a specific forge skill's metadata.
   * @param {string} skillId
   * @returns {object|null}
   */
  getSkillMeta(skillId) {
    return this._data.skills[skillId] || null;
  }

  /**
   * Get all forge-managed skill IDs.
   * @returns {string[]}
   */
  getForgeSkillIds() {
    return Object.keys(this._data.skills);
  }

  /**
   * Get skills that need growth (seed or growing, sorted by staleness).
   * @returns {object[]}
   */
  getGrowableSkills() {
    return Object.values(this._data.skills)
      .filter(s => s.status === 'seed' || s.status === 'growing')
      .sort((a, b) => (a.lastResearchedAt || 0) - (b.lastResearchedAt || 0));
  }

  /**
   * Build expertise profile for orchestrator prompt.
   * Groups skills by domain and returns a summary.
   * @returns {string|null}
   */
  buildExpertiseProfile() {
    const skills = Object.values(this._data.skills);
    if (skills.length === 0) return null;

    const domains = {};
    for (const s of skills) {
      if (!domains[s.domain]) domains[s.domain] = [];
      domains[s.domain].push(s);
    }

    const statusEmoji = { seed: '🌱', growing: '🌿', mature: '🌳', contributed: '🎁' };

    const lines = [];
    for (const [domain, domainSkills] of Object.entries(domains)) {
      const skillList = domainSkills
        .sort((a, b) => b.maturity - a.maturity)
        .map(s => `${statusEmoji[s.status] || '📦'} ${s.topic} (${s.status})`)
        .join(', ');
      lines.push(`- **${domain}**: ${skillList}`);
    }

    return lines.join('\n');
  }

  /**
   * Build a summary of learned skills for the orchestrator prompt.
   * @returns {string|null}
   */
  buildLearnedSkillsSummary() {
    const skills = Object.values(this._data.skills);
    if (skills.length === 0) return null;

    const statusEmoji = { seed: '🌱', growing: '🌿', mature: '🌳', contributed: '🎁' };
    return skills
      .map(s => `${statusEmoji[s.status] || '📦'} ${s.topic} (${s.status}, maturity ${s.maturity}/10)`)
      .join(', ');
  }

  // ── Internal Helpers ────────────────────────────────────────

  /**
   * Generate auto-assign keyword patterns from a topic name.
   * @param {string} topic
   * @returns {string[]}
   */
  _generatePatterns(topic) {
    const patterns = new Set();
    const lower = topic.toLowerCase();

    // Add the full topic name
    patterns.add(lower);

    // Add individual words (>2 chars)
    const words = lower.split(/[\s\-_]+/).filter(w => w.length > 2);
    for (const w of words) {
      patterns.add(w);
    }

    return [...patterns];
  }

  /**
   * Update specific frontmatter fields in a skill .md file.
   * Preserves existing frontmatter and body.
   * @param {string} filePath
   * @param {object} updates - Key-value pairs to merge into frontmatter
   */
  _updateSkillFrontmatter(filePath, updates) {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const trimmed = content.trim();
      if (!trimmed.startsWith('---')) return;

      const endIdx = trimmed.indexOf('---', 3);
      if (endIdx === -1) return;

      const yamlStr = trimmed.slice(3, endIdx).trim();
      const body = trimmed.slice(endIdx + 3).trim();

      const data = yaml.load(yamlStr) || {};
      Object.assign(data, updates);

      const newYaml = yaml.dump(data, { lineWidth: -1 }).trim();
      const newContent = `---\n${newYaml}\n---\n\n${body}`;
      writeFileSync(filePath, newContent, 'utf-8');
    } catch {
      // Silently fail — frontmatter update is non-critical
    }
  }
}
