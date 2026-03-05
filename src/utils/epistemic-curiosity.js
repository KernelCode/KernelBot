/**
 * Epistemic Curiosity — Active Inference-driven topic selection.
 *
 * Bridges the gap between the aspirational Active Inference / Free Energy
 * Principle framework documented in the knowledge base and the actual
 * learning-topic selection logic in the Life Engine.
 *
 * Instead of FIFO (oldest-first) selection, this module computes an
 * **epistemic value** for each candidate skill, favouring topics where
 * learning would most reduce the system's overall uncertainty.
 *
 * Epistemic value is computed from three signals:
 *
 *   1. **Staleness** — How long since the skill was last researched.
 *      Older knowledge decays in relevance, increasing uncertainty.
 *
 *   2. **Immaturity** — Lower maturity means more unknowns.
 *      Seeds carry higher epistemic value than near-mature skills.
 *
 *   3. **Domain diversity** — Domains that are under-explored relative
 *      to others carry a novelty bonus (exploration pressure).
 *
 * The final score is a weighted sum normalised to [0, 1]:
 *
 *   epistemicValue = w_stale * staleness
 *                  + w_immature * immaturity
 *                  + w_diversity * domainNovelty
 *
 * Persistence: a lightweight log of topic-selection decisions is kept at
 * ~/.kernelbot/life/epistemic_log.json so that metacognition can later
 * audit *why* certain topics were chosen.
 *
 * @module utils/epistemic-curiosity
 * @see {@link module:life/engine~LifeEngine#_doLearn}
 * @see {@link module:life/daydream_engine~DaydreamEngine#updateUncertainty}
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const LOG_DIR = join(homedir(), '.kernelbot', 'life');
const LOG_FILE = join(LOG_DIR, 'epistemic_log.json');
const MAX_LOG_ENTRIES = 100;

/** Default weights for the three epistemic-value signals. */
const DEFAULT_WEIGHTS = {
  staleness: 0.4,
  immaturity: 0.35,
  diversity: 0.25,
};

/**
 * Compute a staleness score in [0, 1] based on time since last research.
 *
 * Uses a soft-cap sigmoid so that very old skills asymptote to 1.0 rather
 * than growing without bound.
 *
 * @param {number|null} lastResearchedAt — epoch ms (null ⇒ never researched)
 * @param {number} now — current epoch ms
 * @returns {number} staleness in [0, 1]
 */
function stalenessScore(lastResearchedAt, now) {
  if (!lastResearchedAt) return 1.0; // never researched → maximally stale
  const ageHours = (now - lastResearchedAt) / (1000 * 60 * 60);
  // Sigmoid: rises quickly in the first 48 h, then flattens toward 1.0
  return 1 - Math.exp(-ageHours / 48);
}

/**
 * Compute an immaturity score in [0, 1].
 *
 * Maturity ranges from 0 (seed) to 10 (mature).
 * Score = 1 − (maturity / 10), so seeds score 1.0 and near-mature skills ≈ 0.
 *
 * @param {number} maturity — skill maturity level (0–10)
 * @returns {number} immaturity in [0, 1]
 */
function immaturityScore(maturity) {
  return 1 - Math.min(maturity, 10) / 10;
}

/**
 * Compute domain-diversity novelty scores for a set of skills.
 *
 * Domains that are under-represented among growable skills receive a
 * higher novelty bonus, pushing the system toward broader exploration.
 *
 * @param {object[]} skills — array of skill metadata objects (must have `.domain`)
 * @returns {Map<string, number>} domain → novelty score in [0, 1]
 */
function domainNoveltyScores(skills) {
  const counts = {};
  for (const s of skills) {
    counts[s.domain] = (counts[s.domain] || 0) + 1;
  }
  const total = skills.length || 1;
  const scores = new Map();
  for (const [domain, count] of Object.entries(counts)) {
    // Inverse frequency: rare domains score higher
    scores.set(domain, 1 - count / total);
  }
  return scores;
}

/**
 * Rank an array of growable skills by epistemic value.
 *
 * Each skill receives a composite score from staleness, immaturity, and
 * domain diversity. The array is returned sorted descending (highest
 * epistemic value first).
 *
 * @param {object[]} skills — growable skill metadata objects from SkillForge
 * @param {{ staleness?: number, immaturity?: number, diversity?: number }} [weights]
 * @returns {{ skill: object, epistemicValue: number, breakdown: { staleness: number, immaturity: number, diversity: number } }[]}
 */
export function rankByEpistemicValue(skills, weights = {}) {
  if (!skills || skills.length === 0) return [];

  const w = { ...DEFAULT_WEIGHTS, ...weights };
  const now = Date.now();
  const domainScores = domainNoveltyScores(skills);

  return skills
    .map(skill => {
      const stale = stalenessScore(skill.lastResearchedAt, now);
      const immature = immaturityScore(skill.maturity || 0);
      const diversity = domainScores.get(skill.domain) || 0.5;

      const epistemicValue =
        w.staleness * stale +
        w.immaturity * immature +
        w.diversity * diversity;

      return {
        skill,
        epistemicValue,
        breakdown: { staleness: stale, immaturity: immature, diversity },
      };
    })
    .sort((a, b) => b.epistemicValue - a.epistemicValue);
}

/**
 * Select the best topic for learning based on epistemic value.
 *
 * Convenience wrapper: returns the top-ranked skill after computing
 * epistemic values, or null if no growable skills exist.
 *
 * @param {object[]} growableSkills — from SkillForge.getGrowableSkills()
 * @returns {{ skill: object, epistemicValue: number, breakdown: object } | null}
 */
export function selectTopicForLearning(growableSkills) {
  const ranked = rankByEpistemicValue(growableSkills);
  return ranked.length > 0 ? ranked[0] : null;
}

/**
 * Log an epistemic topic-selection decision for later metacognitive audit.
 *
 * @param {{ skill: object, epistemicValue: number, breakdown: object }} selection
 * @param {number} candidateCount — how many skills were considered
 */
export function logEpistemicDecision(selection, candidateCount) {
  mkdirSync(LOG_DIR, { recursive: true });

  let log = [];
  if (existsSync(LOG_FILE)) {
    try {
      log = JSON.parse(readFileSync(LOG_FILE, 'utf-8'));
    } catch {
      log = [];
    }
  }

  log.push({
    timestamp: new Date().toISOString(),
    selectedTopic: selection.skill.topic,
    skillId: selection.skill.skillId,
    epistemicValue: Math.round(selection.epistemicValue * 1000) / 1000,
    breakdown: {
      staleness: Math.round(selection.breakdown.staleness * 1000) / 1000,
      immaturity: Math.round(selection.breakdown.immaturity * 1000) / 1000,
      diversity: Math.round(selection.breakdown.diversity * 1000) / 1000,
    },
    candidateCount,
  });

  // Cap the log
  if (log.length > MAX_LOG_ENTRIES) {
    log = log.slice(-MAX_LOG_ENTRIES);
  }

  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2), 'utf-8');
}
