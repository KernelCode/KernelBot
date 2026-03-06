import { randomUUID } from 'crypto';
import { getLogger } from '../utils/logger.js';

// ── Signal Detection Patterns ─────────────────────────────────────

const POSITIVE_PATTERNS = [
  /perfect|exactly|great|awesome|nice|love it/i,
  /^(yes|yeah|yep|👍|❤️|🔥)$/i,
  /thank(s| you)/i,
];

const NEGATIVE_PATTERNS = [
  /^no[,.]?\s/i,
  /wrong|incorrect|not (what|right|correct)/i,
  /too (long|short|verbose|brief)/i,
];

const CORRECTION_PATTERNS = [
  /actually[,.]\s/i,
  /it'?s? not .+[,;] it'?s?\s/i,
  /we (don'?t )?use .+ (not|instead)/i,
];

const PREFERENCE_PATTERNS = [
  { pattern: /shorter|more concise|too long|too verbose/i, category: 'response_style', right_behavior: 'Keep responses shorter and more concise' },
  { pattern: /more detail|too short|too brief|elaborate/i, category: 'response_style', right_behavior: 'Provide more detailed and thorough responses' },
  { pattern: /simpler|too complex|too technical|plain/i, category: 'response_style', right_behavior: 'Use simpler, less technical language' },
  { pattern: /formal|professional/i, category: 'tone', right_behavior: 'Use a more formal and professional tone' },
  { pattern: /casual|relaxed|chill/i, category: 'tone', right_behavior: 'Use a more casual and relaxed tone' },
  { pattern: /in (english|arabic|spanish|french)/i, category: 'language', right_behavior: 'Respond in the requested language' },
  { pattern: /don'?t (use|add|include) (emoji|emojis)/i, category: 'formatting', right_behavior: 'Avoid using emojis in responses' },
  { pattern: /stop (asking|confirming)|just do it/i, category: 'autonomy', right_behavior: 'Act more autonomously without asking for confirmation' },
];

// ── FeedbackEngine ────────────────────────────────────────────────

/**
 * FeedbackEngine — passive signal detection and behavioral adjustment.
 * Detects positive, negative, correction, and preference signals from user
 * interactions and converts them into behavioral adjustments injected into
 * the system prompt.
 *
 * Rule-based only (no LLM) — runs in <1ms per message.
 */
export class FeedbackEngine {
  constructor(db, worldModel) {
    this._db = db;
    this._worldModel = worldModel;
    this._causalMemory = null; // Set externally after CausalMemory init
    this._behavioralDNA = null; // Set externally after BehavioralDNA init
  }

  // ── Signal Detection ──────────────────────────────────────────────

  /**
   * Detect all signals from a user message + bot response pair.
   * Called after every user message, non-blocking.
   * @param {string} userMessage
   * @param {string} botMessage
   * @param {{ chatId, userId, characterId }} context
   * @returns {Array<{ type, trigger, bot, detail, context }>}
   */
  detectSignals(userMessage, botMessage, context = {}) {
    const signals = [];

    const positive = this._detectPositive(userMessage, botMessage);
    if (positive) signals.push({ ...positive, context });

    const negative = this._detectNegative(userMessage, botMessage);
    if (negative) signals.push({ ...negative, context });

    const correction = this._detectCorrection(userMessage, botMessage);
    if (correction) signals.push({ ...correction, context });

    const preferences = this._detectPreferences(userMessage, botMessage);
    for (const pref of preferences) {
      signals.push({ ...pref, context });
    }

    return signals;
  }

  _detectPositive(userMsg) {
    for (const pattern of POSITIVE_PATTERNS) {
      if (pattern.test(userMsg)) {
        return { type: 'positive', trigger: userMsg, detail: { matchedPattern: pattern.source } };
      }
    }
    return null;
  }

  _detectNegative(userMsg) {
    for (const pattern of NEGATIVE_PATTERNS) {
      if (pattern.test(userMsg)) {
        return { type: 'negative', trigger: userMsg, detail: { matchedPattern: pattern.source } };
      }
    }
    return null;
  }

  _detectCorrection(userMsg) {
    for (const pattern of CORRECTION_PATTERNS) {
      if (pattern.test(userMsg)) {
        return { type: 'correction', trigger: userMsg, detail: { matchedPattern: pattern.source } };
      }
    }
    return null;
  }

  _detectPreferences(userMsg) {
    const found = [];
    for (const { pattern, category, right_behavior } of PREFERENCE_PATTERNS) {
      if (pattern.test(userMsg)) {
        found.push({
          type: 'preference',
          trigger: userMsg,
          detail: { category, right_behavior, matchedPattern: pattern.source },
        });
      }
    }
    return found;
  }

  /**
   * Detect if a completed job's output was ignored (not referenced within a time window).
   * @param {string} jobId
   * @param {number} timeSinceResult — ms since result was delivered
   * @returns {{ type: 'ignored', detail }|null}
   */
  detectIgnored(jobId, timeSinceResult) {
    const IGNORE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
    if (timeSinceResult >= IGNORE_THRESHOLD_MS) {
      return { type: 'ignored', trigger: `job:${jobId}`, detail: { jobId, timeSinceResult } };
    }
    return null;
  }

  // ── Signal Processing ─────────────────────────────────────────────

  /**
   * Process a detected signal into a behavioral adjustment.
   * @param {{ type, trigger, bot, detail, context }} signal
   */
  processSignal(signal) {
    const logger = getLogger();
    const now = Date.now();
    const signalId = randomUUID();
    const { userId, chatId, characterId } = signal.context || {};

    // Store the raw signal
    try {
      this._db.run(`
        INSERT INTO feedback_signals (id, signal_type, trigger_message, bot_message, context, user_id, chat_id, character_id, created_at)
        VALUES ($id, $type, $trigger, $bot, $context, $userId, $chatId, $characterId, $now)
      `, {
        $id: signalId,
        $type: signal.type,
        $trigger: (signal.trigger || '').slice(0, 500),
        $bot: (signal.bot || '').slice(0, 500),
        $context: JSON.stringify(signal.detail || {}),
        $userId: userId || null,
        $chatId: chatId || null,
        $characterId: characterId || null,
        $now: now,
      });
    } catch (err) {
      logger.warn(`[FeedbackEngine] Failed to store signal: ${err.message}`);
      return;
    }

    // Route by signal type
    switch (signal.type) {
      case 'positive':
        this._reinforceExistingAdjustments(userId, characterId, 0.05);
        break;

      case 'negative':
        this._weakenRecentAdjustments(userId, characterId, 0.1);
        this._recordNegativeCausalEvent(signal);
        break;

      case 'correction':
        this._applyCorrection(signal);
        break;

      case 'preference':
        this._applyPreference(signal);
        break;

      case 'ignored':
        // Just stored as signal — no immediate adjustment
        break;
    }

    // Route to BehavioralDNA for trait/profile adjustments
    try {
      this._behavioralDNA?.applyFeedbackSignal(signal);
    } catch (err) {
      logger.debug(`[FeedbackEngine] BehavioralDNA signal routing failed: ${err.message}`);
    }

    logger.debug(`[FeedbackEngine] Processed ${signal.type} signal for user=${userId || 'global'}`);
  }

  /**
   * Reinforce recent active adjustments (on positive feedback).
   */
  _reinforceExistingAdjustments(userId, characterId, boost) {
    try {
      this._db.run(`
        UPDATE behavioral_adjustments
        SET confidence = MIN(1.0, confidence + $boost),
            evidence_count = evidence_count + 1,
            updated_at = $now
        WHERE active = 1
          AND (user_id = $userId OR user_id IS NULL)
          AND (character_id = $characterId OR character_id IS NULL)
          AND updated_at > $recentThreshold
      `, {
        $boost: boost,
        $now: Date.now(),
        $userId: userId || null,
        $characterId: characterId || null,
        $recentThreshold: Date.now() - 24 * 3600_000, // last 24h
      });
    } catch (err) {
      getLogger().warn(`[FeedbackEngine] Reinforce failed: ${err.message}`);
    }
  }

  /**
   * Weaken recent adjustments (on negative feedback — something isn't working).
   */
  _weakenRecentAdjustments(userId, characterId, penalty) {
    try {
      this._db.run(`
        UPDATE behavioral_adjustments
        SET confidence = MAX(0.0, confidence - $penalty),
            updated_at = $now
        WHERE active = 1
          AND (user_id = $userId OR user_id IS NULL)
          AND (character_id = $characterId OR character_id IS NULL)
          AND updated_at > $recentThreshold
      `, {
        $penalty: penalty,
        $now: Date.now(),
        $userId: userId || null,
        $characterId: characterId || null,
        $recentThreshold: Date.now() - 24 * 3600_000,
      });
    } catch (err) {
      getLogger().warn(`[FeedbackEngine] Weaken failed: ${err.message}`);
    }
  }

  /**
   * Apply a correction signal — update WorldModel beliefs if available,
   * and create a behavioral adjustment.
   */
  _applyCorrection(signal) {
    const logger = getLogger();
    const { userId, characterId } = signal.context || {};
    const trigger = signal.trigger || '';

    // Try to pipe through WorldModel for entity/belief updates
    if (this._worldModel) {
      try {
        // Extract "it's not X it's Y" patterns for belief updates
        const notMatch = trigger.match(/it'?s? not (.+?)[,;] it'?s?\s+(.+)/i);
        if (notMatch) {
          const wrong = notMatch[1].trim();
          const right = notMatch[2].trim();

          this._createOrUpdateAdjustment({
            trigger_pattern: trigger.slice(0, 200),
            wrong_behavior: wrong,
            right_behavior: right,
            category: 'factual',
            userId,
            characterId,
          });
          return;
        }

        // "we use X not Y" / "we don't use X"
        const useMatch = trigger.match(/we (?:don'?t )?use (.+?)(?:\s+(?:not|instead of)\s+(.+))?$/i);
        if (useMatch) {
          const right = useMatch[1].trim();
          const wrong = useMatch[2]?.trim() || null;

          this._createOrUpdateAdjustment({
            trigger_pattern: trigger.slice(0, 200),
            wrong_behavior: wrong,
            right_behavior: `Use ${right}`,
            category: 'tooling',
            userId,
            characterId,
          });
          return;
        }
      } catch (err) {
        logger.warn(`[FeedbackEngine] WorldModel correction failed: ${err.message}`);
      }
    }

    // Generic correction — store as adjustment
    this._createOrUpdateAdjustment({
      trigger_pattern: trigger.slice(0, 200),
      wrong_behavior: null,
      right_behavior: `User corrected: ${trigger.slice(0, 150)}`,
      category: 'correction',
      userId,
      characterId,
    });
  }

  /**
   * Apply a detected preference signal.
   */
  _applyPreference(signal) {
    const { userId, characterId } = signal.context || {};
    const { category, right_behavior } = signal.detail || {};

    this._createOrUpdateAdjustment({
      trigger_pattern: (signal.trigger || '').slice(0, 200),
      wrong_behavior: null,
      right_behavior,
      category,
      userId,
      characterId,
    });
  }

  /**
   * Record a causal event from a negative signal (retroactive failure recording).
   */
  _recordNegativeCausalEvent(signal) {
    if (!this._causalMemory) return;
    const { userId, characterId } = signal.context || {};

    // Look for the most recent task outcome to link this negative signal to
    try {
      const recentOutcome = this._db.get(`
        SELECT * FROM task_outcomes
        WHERE created_at > $cutoff
        ORDER BY created_at DESC
        LIMIT 1
      `, { $cutoff: Date.now() - 10 * 60_000 }); // last 10 minutes

      if (recentOutcome) {
        // Check if a causal event already exists for this job
        const existing = this._causalMemory.getEventByJobId(recentOutcome.job_id);
        if (existing) {
          // Update existing event to failure
          this._causalMemory.updateOutcome(existing.id, {
            outcomeType: 'failure',
            outcome: `User was not satisfied: ${(signal.trigger || '').slice(0, 200)}`,
            lesson: `User was not satisfied: ${(signal.trigger || '').slice(0, 200)}`,
          });
        } else {
          // Create new failure event
          this._causalMemory.recordEvent({
            jobId: recentOutcome.job_id,
            trigger: recentOutcome.task_summary || 'unknown task',
            goal: recentOutcome.task_summary,
            approach: `${recentOutcome.worker_type} worker`,
            toolsUsed: recentOutcome.worker_type ? [recentOutcome.worker_type] : [],
            outcome: `User was not satisfied: ${(signal.trigger || '').slice(0, 200)}`,
            outcomeType: 'failure',
            lesson: `User was not satisfied: ${(signal.trigger || '').slice(0, 200)}`,
            userId,
            characterId,
          }).catch(() => {});
        }
      }
    } catch (err) {
      getLogger().debug(`[FeedbackEngine] Negative causal event failed: ${err.message}`);
    }
  }

  /**
   * Create a new behavioral adjustment or reinforce an existing similar one.
   */
  async _createOrUpdateAdjustment({ trigger_pattern, wrong_behavior, right_behavior, category, userId, characterId }) {
    const logger = getLogger();
    const now = Date.now();

    try {
      // Look for an existing matching adjustment
      const existing = await this._findMatchingAdjustment(category, right_behavior, userId, characterId);

      if (existing) {
        // Reinforce existing
        this._db.run(`
          UPDATE behavioral_adjustments
          SET confidence = MIN(1.0, confidence + 0.1),
              evidence_count = evidence_count + 1,
              updated_at = $now
          WHERE id = $id
        `, { $id: existing.id, $now: now });

        logger.debug(`[FeedbackEngine] Reinforced adjustment ${existing.id} (${category}): evidence=${existing.evidence_count + 1}`);
      } else {
        // Create new
        const id = randomUUID();
        this._db.run(`
          INSERT INTO behavioral_adjustments (id, trigger_pattern, wrong_behavior, right_behavior, category, confidence, evidence_count, user_id, character_id, active, created_at, updated_at)
          VALUES ($id, $trigger, $wrong, $right, $category, 0.5, 1, $userId, $characterId, 1, $now, $now)
        `, {
          $id: id,
          $trigger: trigger_pattern,
          $wrong: wrong_behavior || null,
          $right: right_behavior,
          $category: category || null,
          $userId: userId || null,
          $characterId: characterId || null,
          $now: now,
        });

        logger.debug(`[FeedbackEngine] Created adjustment ${id} (${category}): ${right_behavior}`);

        this._db.embedBackground('adjustment_vectors', id, `${trigger_pattern} ${right_behavior}`);
      }
    } catch (err) {
      logger.warn(`[FeedbackEngine] Adjustment create/update failed: ${err.message}`);
    }
  }

  /**
   * Find an existing adjustment matching the same category + behavior.
   * Tries vector similarity first (distance < 0.3), then exact match.
   */
  async _findMatchingAdjustment(category, rightBehavior, userId, characterId) {
    // Try vector similarity first
    if (this._db.hasVectors) {
      try {
        const hits = await this._db.vectorSearch('adjustment_vectors', rightBehavior, 3);
        for (const hit of hits) {
          if (hit.distance > 0.3) continue;
          const row = this._db.get(`
            SELECT * FROM behavioral_adjustments
            WHERE id = $id AND active = 1
              AND category = $category
              AND (user_id = $userId OR user_id IS NULL)
              AND (character_id = $characterId OR character_id IS NULL)
          `, {
            $id: hit.id,
            $category: category || null,
            $userId: userId || null,
            $characterId: characterId || null,
          });
          if (row) return row;
        }
      } catch {
        // fall through to exact match
      }
    }

    // Exact match fallback
    try {
      return this._db.get(`
        SELECT * FROM behavioral_adjustments
        WHERE active = 1
          AND category = $category
          AND right_behavior = $right
          AND (user_id = $userId OR user_id IS NULL)
          AND (character_id = $characterId OR character_id IS NULL)
        LIMIT 1
      `, {
        $category: category || null,
        $right: rightBehavior,
        $userId: userId || null,
        $characterId: characterId || null,
      });
    } catch {
      return null;
    }
  }

  // ── Adjustment Management ─────────────────────────────────────────

  /**
   * Get active adjustments sorted by confidence * evidence.
   * @param {string|null} userId — null for global adjustments
   * @param {string|null} category — filter by category, or null for all
   * @param {number} limit
   * @returns {Array}
   */
  getActiveAdjustments(userId = null, category = null, limit = 10, characterId = null) {
    try {
      let sql = `
        SELECT * FROM behavioral_adjustments
        WHERE active = 1
          AND (user_id = $userId OR user_id IS NULL)
          AND (character_id = $characterId OR character_id IS NULL)
      `;
      const params = { $userId: userId || null, $characterId: characterId || null };

      if (category) {
        sql += ` AND category = $category`;
        params.$category = category;
      }

      sql += ` ORDER BY (confidence * evidence_count) DESC LIMIT $limit`;
      params.$limit = limit;

      return this._db.all(sql, params);
    } catch {
      return [];
    }
  }

  /**
   * Build a formatted markdown block of top adjustments for the system prompt.
   * Capped at ~200 tokens (top 5 adjustments).
   * @param {string|null} userId
   * @param {string} characterId
   * @returns {string|null}
   */
  buildAdjustmentBlock(userId = null, characterId = 'default') {
    const adjustments = this.getActiveAdjustments(userId, null, 5);
    if (adjustments.length === 0) return null;

    // Only include adjustments with minimum confidence threshold
    const qualified = adjustments.filter(a => a.confidence >= 0.3 && a.evidence_count >= 2);
    if (qualified.length === 0) return null;

    const lines = qualified.map(a => {
      let line = `- **${a.category || 'general'}**: ${a.right_behavior}`;
      if (a.wrong_behavior) {
        line += ` (not: ${a.wrong_behavior})`;
      }
      return line;
    });

    return lines.join('\n');
  }

  /**
   * Decay old adjustments that haven't been reinforced recently.
   * Called during consolidation cycle.
   * @param {number} daysThreshold — decay adjustments older than this many days
   */
  decayOldAdjustments(daysThreshold = 30) {
    const logger = getLogger();
    const threshold = Date.now() - daysThreshold * 24 * 3600_000;

    try {
      // Reduce confidence on stale adjustments
      const result = this._db.run(`
        UPDATE behavioral_adjustments
        SET confidence = MAX(0.0, confidence - 0.1),
            updated_at = $now
        WHERE active = 1
          AND updated_at < $threshold
          AND confidence > 0.0
      `, { $now: Date.now(), $threshold: threshold });

      // Deactivate adjustments that have decayed to zero
      this._db.run(`
        UPDATE behavioral_adjustments
        SET active = 0, updated_at = $now
        WHERE active = 1 AND confidence <= 0.0
      `, { $now: Date.now() });

      if (result.changes > 0) {
        logger.info(`[FeedbackEngine] Decayed ${result.changes} stale adjustments`);
      }
    } catch (err) {
      logger.warn(`[FeedbackEngine] Decay failed: ${err.message}`);
    }
  }

  // ── Task Outcome Tracking ─────────────────────────────────────────

  /**
   * Record that a worker job completed — starts the observation window.
   * @param {string} jobId
   * @param {string} workerType
   * @param {string} taskSummary
   * @param {string|null} userId
   * @param {string|null} characterId
   */
  recordJobCompletion(jobId, workerType, taskSummary, userId, characterId) {
    try {
      this._db.run(`
        INSERT OR IGNORE INTO task_outcomes (job_id, worker_type, task_summary, user_id, character_id, created_at)
        VALUES ($jobId, $workerType, $taskSummary, $userId, $characterId, $now)
      `, {
        $jobId: jobId,
        $workerType: workerType,
        $taskSummary: (taskSummary || '').slice(0, 500),
        $userId: userId || null,
        $characterId: characterId || null,
        $now: Date.now(),
      });
    } catch (err) {
      getLogger().warn(`[FeedbackEngine] recordJobCompletion failed: ${err.message}`);
    }
  }

  /**
   * Update a task outcome with user reaction data.
   * @param {string} jobId
   * @param {{ result_used, follow_up_requested, user_satisfaction, time_to_response }} outcome
   */
  recordTaskOutcome(jobId, outcome) {
    try {
      const sets = [];
      const params = { $jobId: jobId };

      if (outcome.result_used !== undefined) {
        sets.push('result_used = $resultUsed');
        params.$resultUsed = outcome.result_used ? 1 : 0;
      }
      if (outcome.follow_up_requested !== undefined) {
        sets.push('follow_up_requested = $followUp');
        params.$followUp = outcome.follow_up_requested ? 1 : 0;
      }
      if (outcome.user_satisfaction) {
        sets.push('user_satisfaction = $satisfaction');
        params.$satisfaction = outcome.user_satisfaction;
      }
      if (outcome.time_to_response !== undefined) {
        sets.push('time_to_response = $timeToResponse');
        params.$timeToResponse = outcome.time_to_response;
      }

      if (sets.length > 0) {
        this._db.run(`UPDATE task_outcomes SET ${sets.join(', ')} WHERE job_id = $jobId`, params);
      }
    } catch (err) {
      getLogger().warn(`[FeedbackEngine] recordTaskOutcome failed: ${err.message}`);
    }
  }

  /**
   * Get aggregated task outcome patterns per worker type.
   * @param {string} workerType
   * @param {number} limit
   * @returns {Array}
   */
  getTaskPatterns(workerType, limit = 20) {
    try {
      return this._db.all(`
        SELECT worker_type,
               COUNT(*) as total_tasks,
               SUM(CASE WHEN result_used = 1 THEN 1 ELSE 0 END) as results_used,
               SUM(CASE WHEN follow_up_requested = 1 THEN 1 ELSE 0 END) as follow_ups,
               AVG(time_to_response) as avg_response_time
        FROM task_outcomes
        WHERE worker_type = $workerType
        GROUP BY worker_type
        LIMIT $limit
      `, { $workerType: workerType, $limit: limit });
    } catch {
      return [];
    }
  }
}
