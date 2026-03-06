import { getLogger } from '../utils/logger.js';

const CONSOLIDATION_INTERVAL_MS = 6 * 3600_000; // 6 hours
const META_KEY = 'last_consolidation';

/**
 * MemoryConsolidation — synthesizes episodic memories into World Model knowledge.
 * Runs periodically (every 6h) to extract entities, relationships, and beliefs
 * from recent memories and merge redundant entries.
 */
export class MemoryConsolidation {
  constructor(db, worldModel) {
    this._db = db;
    this._worldModel = worldModel;
    this._causalMemory = null; // Set externally after CausalMemory init
    this._behavioralDNA = null; // Set externally after BehavioralDNA init
    this._identityAwareness = null; // Set externally after IdentityAwareness init
  }

  /**
   * Check if consolidation should run (6h since last run).
   */
  shouldConsolidate(characterId) {
    const row = this._db.get(
      'SELECT value FROM codebase_meta WHERE key = :key',
      { key: `${META_KEY}:${characterId}` },
    );
    if (!row) return true;

    const lastRun = parseInt(row.value, 10);
    return Date.now() - lastRun >= CONSOLIDATION_INTERVAL_MS;
  }

  /**
   * Run memory consolidation for a character.
   * 1. Fetch recent episodic memories
   * 2. Fetch world model snapshot
   * 3. LLM prompt → extract new entities, relationships, beliefs
   * 4. Apply via WorldModel methods
   * 5. Merge redundant memories
   * 6. Record timestamp
   *
   * @param {string} characterId
   * @param {object} provider — LLM provider with .chat() method
   * @returns {object} stats — { memoriesProcessed, entitiesCreated, relationshipsCreated, beliefsCreated, memoriesMerged }
   */
  async consolidate(characterId, provider) {
    const logger = getLogger();
    const stats = {
      memoriesProcessed: 0,
      entitiesCreated: 0,
      relationshipsCreated: 0,
      beliefsCreated: 0,
      memoriesMerged: 0,
    };

    // 1. Fetch recent episodic memories (last 24h, up to 50)
    const cutoff = Date.now() - 24 * 3600_000;
    const memories = this._db.all(`
      SELECT * FROM memories
      WHERE character_id = :characterId AND type = 'episodic' AND created_at > :cutoff
      ORDER BY created_at DESC
      LIMIT 50
    `, { characterId, cutoff });

    if (memories.length < 3) {
      logger.debug('[Consolidation] Too few memories to consolidate');
      this._recordTimestamp(characterId);
      return stats;
    }

    stats.memoriesProcessed = memories.length;

    // 2. Fetch world model snapshot
    const existingContext = this._worldModel.buildWorldContext(characterId, null, 10) || 'No existing knowledge.';

    // 3. Build LLM prompt
    const memoryList = memories.map((m, i) => {
      const tags = JSON.parse(m.tags || '[]');
      return `${i + 1}. [${m.source || 'unknown'}] ${m.summary}${tags.length ? ` (tags: ${tags.join(', ')})` : ''}`;
    }).join('\n');

    const prompt = `You are analyzing episodic memories to extract structured knowledge for a world model.

## Existing World Model
${existingContext}

## Recent Memories (last 24h)
${memoryList}

## Task
Analyze these memories and extract:
1. **New entities** — people, projects, tools, concepts, organizations mentioned
2. **Updated entities** — existing entities with new properties or information
3. **Relationships** — connections between entities (uses, works_on, knows, etc.)
4. **Beliefs** — things learned about entities (preferences, facts, opinions)
5. **Merge candidates** — memory indices that describe the same event/fact

Return JSON only:
{
  "entities": [{"type": "person|project|tool|concept|organization|place", "name": "...", "properties": {}, "aliases": []}],
  "relationships": [{"source": "entity name", "target": "entity name", "relation": "uses|works_on|knows|created_by|part_of|depends_on|likes|dislikes"}],
  "beliefs": [{"entity": "entity name", "statement": "...", "source": "inferred|observed", "confidence": 0.7}],
  "merge_groups": [[1, 3], [5, 8, 12]]
}

Rules:
- Only extract clearly stated or strongly implied information
- Entity names should be specific, not generic
- Merge groups contain 1-indexed memory indices that are redundant/about the same thing
- Keep it focused — quality over quantity
- Return empty arrays if nothing meaningful`;

    try {
      const response = await provider.chat({
        messages: [{ role: 'user', content: prompt }],
      });

      const text = (response.text || '').trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.warn('[Consolidation] No JSON in LLM response');
        this._recordTimestamp(characterId);
        return stats;
      }

      const data = JSON.parse(jsonMatch[0]);

      // 4. Apply entities
      const entityIdMap = new Map();
      if (Array.isArray(data.entities)) {
        for (const ent of data.entities) {
          if (!ent.name || !ent.type) continue;
          const id = this._worldModel.upsertEntity(
            ent.type, ent.name, ent.properties || {}, ent.aliases || [], characterId,
          );
          entityIdMap.set(ent.name.toLowerCase(), id);
          stats.entitiesCreated++;
        }
      }

      // Apply relationships
      if (Array.isArray(data.relationships)) {
        for (const rel of data.relationships) {
          if (!rel.source || !rel.target || !rel.relation) continue;
          const sourceId = entityIdMap.get(rel.source.toLowerCase())
            || this._worldModel.findEntity(rel.source, characterId)?.id;
          const targetId = entityIdMap.get(rel.target.toLowerCase())
            || this._worldModel.findEntity(rel.target, characterId)?.id;
          if (sourceId && targetId) {
            this._worldModel.addRelationship(sourceId, targetId, rel.relation, {}, characterId);
            stats.relationshipsCreated++;
          }
        }
      }

      // Apply beliefs
      if (Array.isArray(data.beliefs)) {
        for (const belief of data.beliefs) {
          if (!belief.entity || !belief.statement) continue;
          const entityId = entityIdMap.get(belief.entity.toLowerCase())
            || this._worldModel.findEntity(belief.entity, characterId)?.id;
          if (entityId) {
            this._worldModel.addBelief(
              entityId, belief.statement, belief.source || 'inferred',
              belief.confidence || 0.7, characterId,
            );
            stats.beliefsCreated++;
          }
        }
      }

      // 5. Merge redundant memories
      if (Array.isArray(data.merge_groups)) {
        for (const group of data.merge_groups) {
          if (!Array.isArray(group) || group.length < 2) continue;

          // Convert 1-indexed to actual memory objects
          const groupMems = group
            .map(idx => memories[idx - 1])
            .filter(Boolean);

          if (groupMems.length < 2) continue;

          // Keep the highest-importance one as survivor
          groupMems.sort((a, b) => (b.importance || 5) - (a.importance || 5));
          const survivor = groupMems[0];

          // Boost survivor importance
          const newImportance = Math.min(10, (survivor.importance || 5) + 1);
          this._db.run(
            'UPDATE memories SET importance = :importance WHERE id = :id',
            { importance: newImportance, id: survivor.id },
          );

          // Mark others as merged (keep them but lower importance)
          for (let i = 1; i < groupMems.length; i++) {
            this._db.run(
              'UPDATE memories SET importance = 1, tags = :tags WHERE id = :id',
              {
                tags: JSON.stringify([...(JSON.parse(groupMems[i].tags || '[]')), `merged_into:${survivor.id}`]),
                id: groupMems[i].id,
              },
            );
            stats.memoriesMerged++;
          }
        }
      }
    } catch (err) {
      logger.warn(`[Consolidation] LLM analysis failed: ${err.message}`);
    }

    // 6. Extract causal patterns if CausalMemory is available
    if (this._causalMemory) {
      try {
        const patternStats = await this._causalMemory.extractPatterns(characterId, provider);
        stats.patternsCreated = patternStats.patternsCreated;
        stats.patternsUpdated = patternStats.patternsUpdated;
      } catch (err) {
        logger.warn(`[Consolidation] Causal pattern extraction failed: ${err.message}`);
      }
    }

    // 7. DNA synthesis — feedback → traits, causal events → traits, narrative evolution
    if (this._behavioralDNA) {
      try {
        const feedbackAdj = this._behavioralDNA.synthesizeFromFeedback(characterId);
        const causalAdj = this._behavioralDNA.synthesizeFromCausalEvents(characterId);
        stats.dnaFeedbackAdjustments = feedbackAdj;
        stats.dnaCausalAdjustments = causalAdj;

        await this._behavioralDNA.evolveNarrativeFromEvidence(characterId, provider);
      } catch (err) {
        logger.warn(`[Consolidation] DNA synthesis failed: ${err.message}`);
      }
    }

    // 8. Backfill unscoped memories
    if (this._identityAwareness) {
      try {
        const unscoped = this._db.all(`
          SELECT id, user_id, summary FROM memories
          WHERE scope IS NULL LIMIT 100
        `);
        let backfilled = 0;
        for (const mem of unscoped) {
          const scope = this._identityAwareness.classifyScope(
            mem.user_id, null, mem.summary,
          );
          this._db.run('UPDATE memories SET scope = :scope WHERE id = :id', { scope, id: mem.id });
          backfilled++;
        }
        if (backfilled > 0) {
          stats.scopeBackfilled = backfilled;
          logger.info(`[Consolidation] Backfilled scope for ${backfilled} memories`);
        }
      } catch (err) {
        logger.warn(`[Consolidation] Scope backfill failed: ${err.message}`);
      }
    }

    // 9. Record timestamp
    this._recordTimestamp(characterId);

    logger.info(`[Consolidation] Complete: ${stats.memoriesProcessed} memories → ${stats.entitiesCreated}E ${stats.relationshipsCreated}R ${stats.beliefsCreated}B, ${stats.memoriesMerged} merged${stats.patternsCreated ? `, ${stats.patternsCreated}P created` : ''}${stats.patternsUpdated ? `, ${stats.patternsUpdated}P updated` : ''}`);
    return stats;
  }

  _recordTimestamp(characterId) {
    const key = `${META_KEY}:${characterId}`;
    this._db.run(`
      INSERT OR REPLACE INTO codebase_meta (key, value, updated_at)
      VALUES (:key, :value, :now)
    `, { key, value: String(Date.now()), now: Date.now() });
  }
}
