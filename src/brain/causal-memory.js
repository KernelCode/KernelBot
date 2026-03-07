import { randomUUID } from 'crypto';
import { getLogger } from '../utils/logger.js';

/**
 * CausalMemory — stores causal chains (trigger → goal → approach → outcome → lesson)
 * for every significant event, enabling reasoning like:
 * "Last time we tried X and it failed because Y, so this time let's try Z."
 *
 * Also extracts task patterns from accumulated events.
 */
export class CausalMemory {
  constructor(db, worldModel) {
    this._db = db;
    this._worldModel = worldModel;
  }

  // ── Recording ─────────────────────────────────────────────────────

  /**
   * Record a causal event.
   * @param {object} event
   * @param {string} event.trigger — what initiated this
   * @param {string} [event.goal] — intended outcome
   * @param {string} [event.approach] — method chosen
   * @param {string[]} [event.toolsUsed] — tools/workers used
   * @param {string[]} [event.entitiesInvolved] — entity IDs from World Model
   * @param {string} [event.outcome] — what actually happened
   * @param {'success'|'partial'|'failure'|'unknown'} [event.outcomeType]
   * @param {string} [event.lesson] — what we learned
   * @param {string} [event.counterfactual] — what we'd do differently
   * @param {string} [event.memoryId] — linked episodic memory
   * @param {string} [event.jobId] — linked worker job
   * @param {string} [event.userId]
   * @param {string} [event.characterId]
   * @param {number} [event.durationMs]
   * @returns {string|null} event ID
   */
  async recordEvent(event) {
    const logger = getLogger();
    const now = Date.now();
    const id = `ce_${randomUUID().slice(0, 8)}`;

    try {
      this._db.run(`
        INSERT INTO causal_events (id, memory_id, job_id, trigger, goal, approach, tools_used, entities_involved, outcome, outcome_type, lesson, counterfactual, user_id, character_id, duration_ms, created_at, updated_at)
        VALUES ($id, $memoryId, $jobId, $trigger, $goal, $approach, $toolsUsed, $entities, $outcome, $outcomeType, $lesson, $counterfactual, $userId, $characterId, $durationMs, $now, $now)
      `, {
        id,
        memoryId: event.memoryId || null,
        jobId: event.jobId || null,
        trigger: (event.trigger || '').slice(0, 500),
        goal: (event.goal || '').slice(0, 500),
        approach: (event.approach || '').slice(0, 500),
        toolsUsed: event.toolsUsed ? JSON.stringify(event.toolsUsed) : null,
        entities: event.entitiesInvolved ? JSON.stringify(event.entitiesInvolved) : null,
        outcome: (event.outcome || '').slice(0, 1000),
        outcomeType: event.outcomeType || 'unknown',
        lesson: (event.lesson || '').slice(0, 500) || null,
        counterfactual: (event.counterfactual || '').slice(0, 500) || null,
        userId: event.userId || null,
        characterId: event.characterId || null,
        durationMs: event.durationMs || null,
        now,
      });

      // Background embed for vector search
      const embedText = [event.trigger, event.goal, event.approach, event.outcome, event.lesson]
        .filter(Boolean).join(' ');
      this._db.embedBackground('causal_vectors', id, embedText);

      logger.debug(`[CausalMemory] Recorded event ${id}: ${event.outcomeType || 'unknown'} — ${(event.trigger || '').slice(0, 80)}`);
      return id;
    } catch (err) {
      logger.warn(`[CausalMemory] Failed to record event: ${err.message}`);
      return null;
    }
  }

  /**
   * Add a lesson to an existing causal event.
   * @param {string} eventId
   * @param {string} lesson
   * @param {string} [counterfactual]
   */
  addLesson(eventId, lesson, counterfactual = null) {
    try {
      const sets = ['lesson = $lesson', 'updated_at = $now'];
      const params = { eventId, lesson, now: Date.now() };
      if (counterfactual) {
        sets.push('counterfactual = $counterfactual');
        params.counterfactual = counterfactual;
      }
      this._db.run(`UPDATE causal_events SET ${sets.join(', ')} WHERE id = $eventId`, params);
    } catch (err) {
      getLogger().warn(`[CausalMemory] addLesson failed: ${err.message}`);
    }
  }

  /**
   * Update outcome on an existing event (e.g. after feedback).
   * @param {string} eventId
   * @param {object} update — { outcome, outcomeType, lesson }
   */
  updateOutcome(eventId, update) {
    try {
      const sets = ['updated_at = $now'];
      const params = { eventId, now: Date.now() };
      if (update.outcome) { sets.push('outcome = $outcome'); params.outcome = update.outcome; }
      if (update.outcomeType) { sets.push('outcome_type = $outcomeType'); params.outcomeType = update.outcomeType; }
      if (update.lesson) { sets.push('lesson = $lesson'); params.lesson = update.lesson; }
      this._db.run(`UPDATE causal_events SET ${sets.join(', ')} WHERE id = $eventId`, params);
    } catch (err) {
      getLogger().warn(`[CausalMemory] updateOutcome failed: ${err.message}`);
    }
  }

  // ── Retrieval ─────────────────────────────────────────────────────

  /**
   * Find similar past events via vector search.
   * @param {string} description — task description to match against
   * @param {number} limit
   * @returns {Promise<Array>}
   */
  async findSimilarEvents(description, limit = 5) {
    if (!this._db.hasVectors) return this._fallbackTextSearch(description, limit);

    try {
      const results = await this._db.vectorSearch('causal_vectors', description, limit);
      if (results.length === 0) return this._fallbackTextSearch(description, limit);

      const ids = results.map(r => r.id);
      const params = {};
      const placeholders = ids.map((id, i) => { params[`id${i}`] = id; return `$id${i}`; }).join(',');
      return this._db.all(
        `SELECT * FROM causal_events WHERE id IN (${placeholders}) ORDER BY created_at DESC`,
        params,
      );
    } catch {
      return this._fallbackTextSearch(description, limit);
    }
  }

  /**
   * Fallback text search when vectors aren't available.
   */
  _fallbackTextSearch(description, limit) {
    try {
      const words = description.toLowerCase().split(/\s+/).filter(w => w.length > 3).slice(0, 5);
      if (words.length === 0) return [];

      const conditions = words.map((_, i) => `(LOWER(trigger) LIKE $w${i} OR LOWER(goal) LIKE $w${i} OR LOWER(approach) LIKE $w${i} OR LOWER(outcome) LIKE $w${i})`);
      const params = {};
      words.forEach((w, i) => { params[`w${i}`] = `%${w}%`; });
      params.limit = limit;

      return this._db.all(`
        SELECT * FROM causal_events
        WHERE ${conditions.join(' OR ')}
        ORDER BY created_at DESC
        LIMIT $limit
      `, params);
    } catch {
      return [];
    }
  }

  /**
   * Get events involving a specific entity.
   * @param {string} entityId
   * @param {number} limit
   * @returns {Array}
   */
  getEventsForEntity(entityId, limit = 10) {
    try {
      return this._db.all(`
        SELECT * FROM causal_events
        WHERE entities_involved LIKE $pattern
        ORDER BY created_at DESC
        LIMIT $limit
      `, { pattern: `%${entityId}%`, limit });
    } catch {
      return [];
    }
  }

  /**
   * Get recent failures.
   * @param {number} limit
   * @returns {Array}
   */
  getFailures(limit = 10) {
    try {
      return this._db.all(`
        SELECT * FROM causal_events
        WHERE outcome_type = 'failure'
        ORDER BY created_at DESC
        LIMIT $limit
      `, { limit });
    } catch {
      return [];
    }
  }

  /**
   * Get past successes matching a pattern.
   * Uses vector search when available, with LIKE fallback.
   * @param {string} taskPattern — text to match
   * @param {number} limit
   * @returns {Promise<Array>}
   */
  async getSuccesses(taskPattern, limit = 5) {
    // Try vector search first
    if (this._db.hasVectors) {
      try {
        const hits = await this._db.vectorSearch('causal_vectors', taskPattern, limit * 2);
        if (hits.length > 0) {
          const ids = hits.map(h => h.id);
          const params = {};
          const placeholders = ids.map((id, i) => { params[`id${i}`] = id; return `$id${i}`; }).join(',');
          const rows = this._db.all(
            `SELECT * FROM causal_events WHERE id IN (${placeholders}) AND outcome_type = 'success'`,
            params,
          );
          const rowMap = new Map(rows.map(r => [r.id, r]));
          const ordered = ids.map(id => rowMap.get(id)).filter(Boolean).slice(0, limit);
          if (ordered.length > 0) return ordered;
        }
      } catch {
        // fall through to LIKE
      }
    }

    // LIKE fallback
    try {
      return this._db.all(`
        SELECT * FROM causal_events
        WHERE outcome_type = 'success'
          AND (LOWER(trigger) LIKE $pattern OR LOWER(goal) LIKE $pattern)
        ORDER BY created_at DESC
        LIMIT $limit
      `, { pattern: `%${taskPattern.toLowerCase()}%`, limit });
    } catch {
      return [];
    }
  }

  /**
   * Find a recent causal event by job ID.
   * @param {string} jobId
   * @returns {object|null}
   */
  getEventByJobId(jobId) {
    try {
      return this._db.get('SELECT * FROM causal_events WHERE job_id = $jobId', { jobId });
    } catch {
      return null;
    }
  }

  // ── Pattern Extraction ────────────────────────────────────────────

  /**
   * Extract task patterns from recent causal events using LLM.
   * Should be called periodically (during consolidation).
   * @param {string} characterId
   * @param {object} provider — LLM provider with .chat()
   * @returns {object} stats
   */
  async extractPatterns(characterId, provider) {
    const logger = getLogger();
    const stats = { patternsCreated: 0, patternsUpdated: 0 };

    // Get recent events (last 7 days, up to 30)
    const cutoff = Date.now() - 7 * 24 * 3600_000;
    const events = this._db.all(`
      SELECT * FROM causal_events
      WHERE created_at > $cutoff
      ORDER BY created_at DESC
      LIMIT 30
    `, { cutoff });

    if (events.length < 3) {
      logger.debug('[CausalMemory] Too few causal events for pattern extraction');
      return stats;
    }

    // Build event summary for LLM
    const eventList = events.map((e, i) => {
      const tools = e.tools_used ? JSON.parse(e.tools_used).join(', ') : 'unknown';
      return `${i + 1}. [${e.outcome_type}] Trigger: ${e.trigger}\n   Approach: ${e.approach || 'unknown'}\n   Tools: ${tools}\n   Outcome: ${e.outcome || 'unknown'}\n   Lesson: ${e.lesson || 'none'}`;
    }).join('\n\n');

    // Fetch existing patterns for context
    const existingPatterns = this._db.all(`
      SELECT * FROM task_patterns
      WHERE confidence > 0.2
      ORDER BY confidence DESC
      LIMIT 10
    `);
    const existingContext = existingPatterns.length > 0
      ? existingPatterns.map(p => `- [${p.pattern_type}] ${p.description} (confidence: ${p.confidence.toFixed(2)})`).join('\n')
      : 'None yet.';

    const prompt = `Analyze these causal events from task completions and extract patterns.

## Existing Patterns
${existingContext}

## Recent Causal Events
${eventList}

## Task
Find patterns in these events:
1. **BEST_PRACTICE**: Approaches that consistently succeed
2. **FAILURE_MODE**: Approaches that consistently fail
3. **USER_PREFERENCE**: What this user prefers for specific task types
4. **TOOL_PATTERN**: Which tools/workers work best for which tasks

Return JSON only:
{
  "patterns": [
    {
      "pattern_type": "best_practice|failure_mode|user_preference|tool_pattern",
      "description": "Clear, actionable description",
      "trigger_pattern": "regex-like pattern for when to apply",
      "recommended_approach": "what to do (for best practices/tool patterns)",
      "avoid": "what not to do (for failure modes)",
      "evidence_indices": [1, 3, 5],
      "confidence": 0.7
    }
  ]
}

Rules:
- Only extract patterns with 2+ supporting events
- Be specific and actionable
- Keep descriptions concise (1-2 sentences)
- Confidence: 0.5 = 2 events, 0.7 = 3+ events, 0.9 = 5+ events
- Return empty array if no clear patterns`;

    try {
      const response = await provider.chat({ messages: [{ role: 'user', content: prompt }] });
      const text = (response.text || '').trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.warn('[CausalMemory] No JSON in pattern extraction response');
        return stats;
      }

      const data = JSON.parse(jsonMatch[0]);
      const now = Date.now();

      if (Array.isArray(data.patterns)) {
        for (const pat of data.patterns) {
          if (!pat.description || !pat.pattern_type) continue;

          // Map evidence indices to event IDs
          const evidenceIds = (pat.evidence_indices || [])
            .map(idx => events[idx - 1]?.id)
            .filter(Boolean);

          // Check for existing similar pattern
          const existing = this._db.get(`
            SELECT * FROM task_patterns
            WHERE pattern_type = $type AND description = $desc
            LIMIT 1
          `, { type: pat.pattern_type, desc: pat.description });

          if (existing) {
            // Update confidence and evidence
            const oldEvidence = JSON.parse(existing.evidence_ids || '[]');
            const mergedEvidence = [...new Set([...oldEvidence, ...evidenceIds])];
            this._db.run(`
              UPDATE task_patterns
              SET confidence = MIN(1.0, $confidence),
                  evidence_ids = $evidence,
                  updated_at = $now
              WHERE id = $id
            `, {
              id: existing.id,
              confidence: Math.min(1.0, (existing.confidence + pat.confidence) / 2 + 0.05),
              evidence: JSON.stringify(mergedEvidence),
              now,
            });
            stats.patternsUpdated++;
          } else {
            const id = `tp_${randomUUID().slice(0, 8)}`;
            this._db.run(`
              INSERT INTO task_patterns (id, pattern_type, description, trigger_pattern, recommended_approach, avoid, evidence_ids, confidence, character_id, created_at, updated_at)
              VALUES ($id, $type, $desc, $trigger, $approach, $avoid, $evidence, $confidence, $characterId, $now, $now)
            `, {
              id,
              type: pat.pattern_type,
              desc: pat.description,
              trigger: pat.trigger_pattern || null,
              approach: pat.recommended_approach || null,
              avoid: pat.avoid || null,
              evidence: JSON.stringify(evidenceIds),
              confidence: pat.confidence || 0.5,
              characterId,
              now,
            });
            stats.patternsCreated++;
          }
        }
      }
    } catch (err) {
      logger.warn(`[CausalMemory] Pattern extraction failed: ${err.message}`);
    }

    logger.info(`[CausalMemory] Pattern extraction: ${stats.patternsCreated} created, ${stats.patternsUpdated} updated`);
    return stats;
  }

  /**
   * Get patterns relevant to a task description.
   * @param {string} taskDescription
   * @param {number} limit
   * @returns {Array}
   */
  getRelevantPatterns(taskDescription, limit = 5) {
    try {
      // First try matching trigger_patterns via regex
      const allPatterns = this._db.all(`
        SELECT * FROM task_patterns
        WHERE confidence > 0.3
        ORDER BY confidence DESC
        LIMIT 20
      `);

      const lower = taskDescription.toLowerCase();
      const matched = allPatterns.filter(p => {
        if (!p.trigger_pattern) return false;
        try {
          return new RegExp(p.trigger_pattern, 'i').test(lower);
        } catch {
          return lower.includes(p.trigger_pattern.toLowerCase());
        }
      });

      if (matched.length > 0) return matched.slice(0, limit);

      // Fallback: keyword matching against descriptions
      const words = lower.split(/\s+/).filter(w => w.length > 3).slice(0, 5);
      if (words.length === 0) return allPatterns.slice(0, limit);

      return allPatterns.filter(p => {
        const desc = p.description.toLowerCase();
        return words.some(w => desc.includes(w));
      }).slice(0, limit);
    } catch {
      return [];
    }
  }

  // ── Context Building ──────────────────────────────────────────────

  /**
   * Build causal context for prompt injection (worker tasks).
   * Returns formatted markdown with relevant past events + patterns.
   * @param {string} taskDescription
   * @param {number} maxEvents
   * @returns {Promise<string|null>}
   */
  async buildCausalContext(taskDescription, maxEvents = 3) {
    const sections = [];

    // 1. Find similar past events
    const events = await this.findSimilarEvents(taskDescription, maxEvents);
    if (events.length > 0) {
      const eventLines = events.map(e => {
        const ago = this._formatTimeAgo(e.created_at);
        const lines = [`### ${e.outcome_type === 'success' ? 'Success' : e.outcome_type === 'failure' ? 'Failure' : 'Partial'} (${ago}): "${(e.trigger || '').slice(0, 100)}"`];
        if (e.approach) lines.push(`- Approach: ${e.approach}`);
        if (e.outcome) lines.push(`- Outcome: ${e.outcome.slice(0, 200)}`);
        if (e.lesson) lines.push(`- Lesson: ${e.lesson}`);
        return lines.join('\n');
      });
      sections.push(`## Past Experience with Similar Tasks\n\n${eventLines.join('\n\n')}`);
    }

    // 2. Relevant patterns
    const patterns = this.getRelevantPatterns(taskDescription, 3);
    if (patterns.length > 0) {
      const patLines = patterns.map(p => {
        const parts = [`- **${p.pattern_type}**: ${p.description} (confidence: ${p.confidence.toFixed(2)})`];
        if (p.recommended_approach) parts.push(`  → Do: ${p.recommended_approach}`);
        if (p.avoid) parts.push(`  → Avoid: ${p.avoid}`);
        return parts.join('\n');
      });
      sections.push(`## Known Patterns\n\n${patLines.join('\n')}`);
    }

    if (sections.length === 0) return null;
    return sections.join('\n\n');
  }

  /**
   * Build a lighter causal context for the orchestrator prompt.
   * @param {string} characterId
   * @param {number} limit
   * @returns {string|null}
   */
  buildOrchestratorContext(characterId, limit = 5) {
    try {
      const patterns = this._db.all(`
        SELECT * FROM task_patterns
        WHERE confidence > 0.5
          AND (character_id = $characterId OR character_id IS NULL)
        ORDER BY confidence DESC
        LIMIT $limit
      `, { characterId, limit });

      if (patterns.length === 0) return null;

      const lines = patterns.map(p => {
        let line = `- ${p.description}`;
        if (p.recommended_approach) line += ` → ${p.recommended_approach}`;
        if (p.avoid) line += ` (avoid: ${p.avoid})`;
        return line;
      });

      return `When dispatching similar tasks, note:\n${lines.join('\n')}`;
    } catch {
      return null;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────

  _formatTimeAgo(timestamp) {
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days === 1) return 'yesterday';
    if (days < 7) return `${days} days ago`;
    return `${Math.floor(days / 7)} weeks ago`;
  }
}
