import { randomUUID } from 'crypto';
import { getLogger } from '../utils/logger.js';

/**
 * Default action types with base weights and cooldowns.
 * base_weight: relative importance (higher = more likely to be picked)
 * cooldown_ms: minimum time between runs of this action
 */
const DEFAULT_ACTIONS = {
  consolidate:       { base_weight: 1.0, cooldown_ms: 4 * 3600_000 },
  synthesize_feedback: { base_weight: 0.8, cooldown_ms: 2 * 3600_000 },
  think:             { base_weight: 0.7, cooldown_ms: 30 * 60_000 },
  browse:            { base_weight: 0.6, cooldown_ms: 30 * 60_000 },
  journal:           { base_weight: 0.6, cooldown_ms: 4 * 3600_000 },
  grow_skill:        { base_weight: 0.8, cooldown_ms: 2 * 3600_000 },
  research_gaps:     { base_weight: 0.7, cooldown_ms: 1 * 3600_000 },
  evolve_narrative:  { base_weight: 0.5, cooldown_ms: 6 * 3600_000 },
  extract_patterns:  { base_weight: 0.6, cooldown_ms: 4 * 3600_000 },
  evolve_dna:        { base_weight: 0.5, cooldown_ms: 6 * 3600_000 },
  decay_stale:       { base_weight: 0.3, cooldown_ms: 12 * 3600_000 },
};

/**
 * SynthesisLoop — intelligent heartbeat controller for the Life Engine.
 * Replaces random weighted activity selection with:
 *   assess → prioritize → execute → measure → adapt
 */
export class SynthesisLoop {
  constructor(db, { worldModel, feedbackEngine, causalMemory, behavioralDNA, memoryManager, skillForge, consolidation, characterId }) {
    this._db = db;
    this._worldModel = worldModel || null;
    this._feedbackEngine = feedbackEngine || null;
    this._causalMemory = causalMemory || null;
    this._behavioralDNA = behavioralDNA || null;
    this._memoryManager = memoryManager || null;
    this._skillForge = skillForge || null;
    this._consolidation = consolidation || null;
    this._characterId = characterId || null;
    this._lifeEngine = null; // Set post-construction (circular dep)
    this._lastCycle = null;

    this._ensureDefaultWeights();
  }

  // ── Assessment (pure SQL, <10ms) ──────────────────────────────

  assess() {
    const now = Date.now();
    const assessments = {};

    // 1. Consolidation — unprocessed episodic memories
    try {
      const lastConsolidation = this._db.get(
        `SELECT created_at FROM synthesis_outcomes WHERE action_type = 'consolidate' ORDER BY created_at DESC LIMIT 1`
      );
      const since = lastConsolidation?.created_at || 0;
      const unprocessed = this._db.get(
        `SELECT COUNT(*) as cnt FROM memories WHERE type = 'episodic' AND created_at > :since`,
        { since }
      );
      const count = unprocessed?.cnt || 0;
      const urgency = Math.min(1.0, count / 50);
      assessments.consolidation = { urgency, reason: `${count} unprocessed memories`, action: 'consolidate' };
    } catch {
      assessments.consolidation = { urgency: 0, reason: 'check failed', action: 'consolidate' };
    }

    // 2. Feedback — unhandled feedback signals
    try {
      const unhandled = this._db.get(
        `SELECT COUNT(*) as cnt FROM feedback_signals WHERE adjustment_id IS NULL`
      );
      const count = unhandled?.cnt || 0;
      const urgency = Math.min(1.0, count / 10);
      assessments.feedback = { urgency, reason: `${count} unhandled signals`, action: 'synthesize_feedback' };
    } catch {
      assessments.feedback = { urgency: 0, reason: 'check failed', action: 'synthesize_feedback' };
    }

    // 3. Knowledge gaps — low-confidence beliefs
    try {
      const gaps = this._db.get(
        `SELECT COUNT(*) as cnt FROM beliefs WHERE confidence < 0.4 AND updated_at < :cutoff`,
        { cutoff: now - 24 * 3600_000 }
      );
      const count = gaps?.cnt || 0;
      const urgency = Math.min(1.0, count / 5);
      assessments.knowledge_gaps = { urgency, reason: `${count} low-confidence beliefs`, action: 'research_gaps' };
    } catch {
      assessments.knowledge_gaps = { urgency: 0, reason: 'check failed', action: 'research_gaps' };
    }

    // 4. Skills — stalest forge_skill in seed/growing
    try {
      const stalest = this._db.get(
        `SELECT skill_id, topic, last_researched_at FROM forge_skills
         WHERE status IN ('seed', 'growing')
         ORDER BY COALESCE(last_researched_at, created_at) ASC LIMIT 1`
      );
      if (stalest) {
        const lastAt = stalest.last_researched_at || 0;
        const daysSince = (now - lastAt) / (24 * 3600_000);
        const urgency = Math.min(1.0, daysSince / 7);
        assessments.skills = { urgency, reason: `"${stalest.topic}" stale ${Math.round(daysSince)}d`, action: 'grow_skill', target: stalest.skill_id };
      } else {
        assessments.skills = { urgency: 0, reason: 'no growing skills', action: 'grow_skill' };
      }
    } catch {
      assessments.skills = { urgency: 0, reason: 'check failed', action: 'grow_skill' };
    }

    // 5. DNA drift — traits drifting from target
    try {
      const drift = this._db.get(
        `SELECT MAX(ABS(value - target_value)) as max_drift FROM dna_traits
         WHERE target_value IS NOT NULL AND ABS(value - target_value) > 0.1`
      );
      const maxDrift = drift?.max_drift || 0;
      const urgency = Math.min(1.0, maxDrift * 2);
      assessments.dna_drift = { urgency, reason: `max drift ${maxDrift.toFixed(2)}`, action: 'evolve_dna' };
    } catch {
      assessments.dna_drift = { urgency: 0, reason: 'check failed', action: 'evolve_dna' };
    }

    // 6. Narrative — staleness of self narratives
    try {
      const oldest = this._db.get(
        `SELECT MIN(updated_at) as oldest_at FROM self_narrative WHERE character_id = :characterId`,
        { characterId: this._characterId }
      );
      if (oldest?.oldest_at) {
        const daysSince = (now - oldest.oldest_at) / (24 * 3600_000);
        const urgency = Math.min(1.0, daysSince / 7);
        assessments.narrative = { urgency, reason: `oldest narrative ${Math.round(daysSince)}d old`, action: 'evolve_narrative' };
      } else {
        assessments.narrative = { urgency: 0.2, reason: 'no narratives yet', action: 'evolve_narrative' };
      }
    } catch {
      assessments.narrative = { urgency: 0, reason: 'check failed', action: 'evolve_narrative' };
    }

    return assessments;
  }

  // ── Prioritization ────────────────────────────────────────────

  prioritize(assessments) {
    const now = Date.now();
    const weights = this._getWeights();
    const candidates = [];

    for (const [dimension, assessment] of Object.entries(assessments)) {
      const w = weights[assessment.action];
      if (!w) continue;

      // Skip if on cooldown
      if (w.last_run_at && (now - w.last_run_at) < w.cooldown_ms) continue;

      const score = assessment.urgency * w.current_weight * (0.5 + w.success_rate);
      candidates.push({ dimension, ...assessment, score });
    }

    // Sort by score descending
    candidates.sort((a, b) => b.score - a.score);

    // Return top action, or fallback to think
    return candidates[0] || { action: 'think', urgency: 0.1, reason: 'fallback', score: 0 };
  }

  // ── Execution (delegates to LifeEngine) ───────────────────────

  async execute(action) {
    const logger = getLogger();
    const type = action.action;
    const startTime = Date.now();

    try {
      switch (type) {
        case 'consolidate':
          await this._execConsolidate();
          break;
        case 'think':
          await this._lifeEngine._doThink();
          break;
        case 'browse':
          await this._lifeEngine._doBrowse();
          break;
        case 'journal':
          await this._lifeEngine._doJournal();
          break;
        case 'grow_skill':
          await this._lifeEngine._doLearn();
          break;
        case 'evolve_narrative':
        case 'extract_patterns':
          await this._lifeEngine._doReflect();
          break;
        case 'synthesize_feedback':
          await this._execSynthesizeFeedback();
          break;
        case 'research_gaps':
          await this._lifeEngine._doBrowse();
          break;
        case 'evolve_dna':
          await this._execEvolveDNA();
          break;
        case 'decay_stale':
          await this._execDecayStale();
          break;
        default:
          logger.warn(`[SynthesisLoop] Unknown action: ${type}, falling back to think`);
          await this._lifeEngine._doThink();
      }

      return { success: true, duration_ms: Date.now() - startTime };
    } catch (err) {
      logger.error(`[SynthesisLoop] Action "${type}" failed: ${err.message}`);
      return { success: false, duration_ms: Date.now() - startTime, error: err.message };
    }
  }

  // ── Measurement ───────────────────────────────────────────────

  measure(action, result) {
    const quality = result.success ? 'productive' : 'failed';
    const id = randomUUID();

    this._db.run(
      `INSERT INTO synthesis_outcomes (id, action_type, target, urgency_score, result_quality, duration_ms, character_id, created_at)
       VALUES (:id, :actionType, :target, :urgency, :quality, :duration, :characterId, :createdAt)`,
      { id, actionType: action.action, target: action.target || null, urgency: action.urgency, quality, duration: result.duration_ms, characterId: this._characterId, createdAt: Date.now() }
    );

    return { id, quality, duration_ms: result.duration_ms };
  }

  // ── Adaptation ────────────────────────────────────────────────

  adapt(action, measurement) {
    const type = action.action;
    const isSuccess = measurement.quality === 'productive';

    const w = this._db.get(`SELECT * FROM synthesis_weights WHERE action_type = :type`, { type });
    if (!w) return;

    const newTotal = (w.total_runs || 0) + 1;
    // Rolling success rate: exponential moving average
    const alpha = 0.2;
    const newSuccessRate = w.success_rate * (1 - alpha) + (isSuccess ? 1 : 0) * alpha;
    const newWeight = w.base_weight * (0.5 + newSuccessRate);

    this._db.run(
      `UPDATE synthesis_weights
       SET current_weight = :weight, success_rate = :rate, total_runs = :total, last_run_at = :lastRun
       WHERE action_type = :type`,
      { weight: newWeight, rate: newSuccessRate, total: newTotal, lastRun: Date.now(), type }
    );
  }

  // ── Full Cycle ────────────────────────────────────────────────

  async runCycle() {
    const logger = getLogger();
    logger.info('[SynthesisLoop] Starting cycle');

    const assessments = this.assess();
    const action = this.prioritize(assessments);
    logger.info(`[SynthesisLoop] Prioritized: ${action.action} (urgency=${action.urgency.toFixed(2)}, score=${action.score?.toFixed(2) || '0'}, reason=${action.reason})`);

    const result = await this.execute(action);
    const measurement = this.measure(action, result);
    this.adapt(action, measurement);

    this._lastCycle = { action: action.action, urgency: action.urgency, reason: action.reason, ...measurement, timestamp: Date.now() };
    logger.info(`[SynthesisLoop] Cycle complete: ${action.action} → ${measurement.quality} (${measurement.duration_ms}ms)`);

    return { action, result, measurement };
  }

  // ── Status (for /synthesis command) ───────────────────────────

  getStatus() {
    const weights = this._getWeights();
    const recentOutcomes = this._db.all(
      `SELECT action_type, result_quality, urgency_score, duration_ms, created_at
       FROM synthesis_outcomes ORDER BY created_at DESC LIMIT 10`
    );
    return { weights, recentOutcomes, lastCycle: this._lastCycle };
  }

  // ── Internal Handlers ─────────────────────────────────────────

  async _execConsolidate() {
    if (this._consolidation) {
      await this._consolidation.runConsolidation(this._characterId);
    } else if (this._lifeEngine) {
      await this._lifeEngine._doConsolidate();
    }
  }

  async _execSynthesizeFeedback() {
    if (!this._feedbackEngine) return;

    // Process up to 5 unhandled signals
    const signals = this._db.all(
      `SELECT * FROM feedback_signals WHERE adjustment_id IS NULL ORDER BY created_at ASC LIMIT 5`
    );

    for (const signal of signals) {
      try {
        await this._feedbackEngine.processSignal(signal);
      } catch {
        // Individual signal failure shouldn't stop batch
      }
    }
  }

  async _execEvolveDNA() {
    if (!this._behavioralDNA) return;

    // Nudge drifting traits 10% toward target_value
    const drifting = this._db.all(
      `SELECT id, value, target_value FROM dna_traits
       WHERE target_value IS NOT NULL AND ABS(value - target_value) > 0.1`
    );

    for (const trait of drifting) {
      const nudge = (trait.target_value - trait.value) * 0.1;
      const newValue = Math.max(0, Math.min(1, trait.value + nudge));
      this._db.run(
        `UPDATE dna_traits SET value = :value, updated_at = :now WHERE id = :id`,
        { value: newValue, now: Date.now(), id: trait.id }
      );
    }
  }

  async _execDecayStale() {
    const now = Date.now();
    const staleCutoff = now - 30 * 24 * 3600_000; // 30 days

    // Decay old beliefs confidence × 0.9
    this._db.run(
      `UPDATE beliefs SET confidence = confidence * 0.9, updated_at = :now
       WHERE updated_at < :cutoff AND confidence > 0.1`,
      { now, cutoff: staleCutoff }
    );

    // Decay old adjustments
    this._db.run(
      `UPDATE behavioral_adjustments SET confidence = confidence * 0.9, updated_at = :now
       WHERE updated_at < :cutoff AND confidence > 0.1`,
      { now, cutoff: staleCutoff }
    );
  }

  // ── Helpers ───────────────────────────────────────────────────

  _getWeights() {
    const rows = this._db.all(`SELECT * FROM synthesis_weights`);
    const map = {};
    for (const r of rows) map[r.action_type] = r;
    return map;
  }

  _ensureDefaultWeights() {
    const existing = this._db.all(`SELECT action_type FROM synthesis_weights`);
    const existingSet = new Set(existing.map(r => r.action_type));

    for (const [action, defaults] of Object.entries(DEFAULT_ACTIONS)) {
      if (existingSet.has(action)) continue;
      this._db.run(
        `INSERT INTO synthesis_weights (action_type, base_weight, current_weight, cooldown_ms, character_id)
         VALUES (:action, :baseWeight, :currentWeight, :cooldown, :characterId)`,
        { action, baseWeight: defaults.base_weight, currentWeight: defaults.base_weight, cooldown: defaults.cooldown_ms, characterId: this._characterId }
      );
    }
  }
}
