import { randomBytes } from 'crypto';
import { getLogger } from '../utils/logger.js';

function genId(prefix) {
  return `${prefix}_${randomBytes(4).toString('hex')}`;
}

/**
 * WorldModel — structured knowledge graph for entities, relationships, beliefs, and jargon.
 * Stored in BrainDB (SQLite). Enables KERNEL to reason about the user's world contextually.
 */
export class WorldModel {
  constructor(db) {
    this._db = db;
  }

  // ── Entity Management ──────────────────────────────────────────

  upsertEntity(type, name, properties = {}, aliases = [], characterId = 'default') {
    const now = Date.now();
    const existing = this.findEntity(name, characterId);

    if (existing) {
      // Merge properties and aliases (existing is already parsed by _parseEntity)
      const mergedProps = { ...existing.properties, ...properties };
      const mergedAliases = [...new Set([...existing.aliases, ...aliases])];

      this._db.run(`
        UPDATE entities SET properties = :properties, aliases = :aliases,
          last_mentioned = :now, mention_count = mention_count + 1
        WHERE id = :id
      `, {
        properties: JSON.stringify(mergedProps),
        aliases: JSON.stringify(mergedAliases),
        now,
        id: existing.id,
      });

      const embedText = `${name} (${type})${Object.keys(mergedProps).length ? ': ' + Object.entries(mergedProps).map(([k,v])=>`${k}=${v}`).join(', ') : ''}`;
      this._db.embedBackground('entity_vectors', existing.id, embedText);

      return existing.id;
    }

    const id = genId('ent');
    this._db.run(`
      INSERT INTO entities (id, type, name, properties, aliases, character_id, mention_count, first_mentioned, last_mentioned)
      VALUES (:id, :type, :name, :properties, :aliases, :characterId, 1, :now, :now)
    `, {
      id, type, name,
      properties: JSON.stringify(properties),
      aliases: JSON.stringify(aliases),
      characterId, now,
    });

    const embedText = `${name} (${type})${Object.keys(properties).length ? ': ' + Object.entries(properties).map(([k,v])=>`${k}=${v}`).join(', ') : ''}`;
    this._db.embedBackground('entity_vectors', id, embedText);

    return id;
  }

  getEntity(id) {
    const row = this._db.get('SELECT * FROM entities WHERE id = :id', { id });
    return row ? this._parseEntity(row) : null;
  }

  findEntity(name, characterId = 'default') {
    // Exact name match (case-insensitive)
    let row = this._db.get(
      'SELECT * FROM entities WHERE character_id = :characterId AND name COLLATE NOCASE = :name',
      { characterId, name },
    );
    if (row) return this._parseEntity(row);

    // Alias search — check JSON aliases array
    const candidates = this._db.all(
      'SELECT * FROM entities WHERE character_id = :characterId AND aliases IS NOT NULL',
      { characterId },
    );
    for (const c of candidates) {
      const aliases = JSON.parse(c.aliases || '[]');
      if (aliases.some(a => a.toLowerCase() === name.toLowerCase())) {
        return this._parseEntity(c);
      }
    }
    return null;
  }

  async searchEntities(query, type = null, limit = 10) {
    // Try vector search first
    if (this._db.hasVectors) {
      try {
        const hits = await this._db.vectorSearch('entity_vectors', query, limit * 2);
        if (hits.length > 0) {
          const ids = hits.map(h => h.id);
          const placeholders = ids.map(() => '?').join(',');
          const typeFilter = type ? ` AND type = ?` : '';
          const params = type ? [...ids, type] : ids;
          const rows = this._db.all(
            `SELECT * FROM entities WHERE id IN (${placeholders})${typeFilter}`,
            ...params,
          );
          // Preserve vector-distance ordering
          const rowMap = new Map(rows.map(r => [r.id, r]));
          const ordered = ids.map(id => rowMap.get(id)).filter(Boolean).slice(0, limit);
          if (ordered.length > 0) return ordered.map(r => this._parseEntity(r));
        }
      } catch {
        // fall through to LIKE
      }
    }

    // LIKE fallback
    const likeQuery = `%${query}%`;
    if (type) {
      return this._db.all(
        'SELECT * FROM entities WHERE type = :type AND (name LIKE :q OR properties LIKE :q) ORDER BY mention_count DESC LIMIT :limit',
        { type, q: likeQuery, limit },
      ).map(r => this._parseEntity(r));
    }
    return this._db.all(
      'SELECT * FROM entities WHERE name LIKE :q OR properties LIKE :q ORDER BY mention_count DESC LIMIT :limit',
      { q: likeQuery, limit },
    ).map(r => this._parseEntity(r));
  }

  getEntitiesByType(type, characterId = 'default', limit = 20) {
    return this._db.all(
      'SELECT * FROM entities WHERE character_id = :characterId AND type = :type ORDER BY mention_count DESC LIMIT :limit',
      { characterId, type, limit },
    ).map(r => this._parseEntity(r));
  }

  incrementMention(entityId) {
    this._db.run(
      'UPDATE entities SET mention_count = mention_count + 1, last_mentioned = :now WHERE id = :id',
      { now: Date.now(), id: entityId },
    );
  }

  _parseEntity(row) {
    return {
      ...row,
      properties: JSON.parse(row.properties || '{}'),
      aliases: JSON.parse(row.aliases || '[]'),
    };
  }

  // ── Relationships ──────────────────────────────────────────────

  addRelationship(sourceId, targetId, relation, properties = {}, characterId = 'default') {
    const now = Date.now();

    // Upsert — same src+tgt+rel = update confidence
    const existing = this._db.get(
      'SELECT * FROM relationships WHERE source_id = :sourceId AND target_id = :targetId AND relation = :relation',
      { sourceId, targetId, relation },
    );

    if (existing) {
      const newCount = (existing.evidence_count || 1) + 1;
      const newConfidence = Math.min(0.95, existing.confidence + 0.05);
      const mergedProps = { ...JSON.parse(existing.properties || '{}'), ...properties };
      this._db.run(`
        UPDATE relationships SET confidence = :confidence, evidence_count = :count,
          properties = :properties, updated_at = :now
        WHERE id = :id
      `, {
        confidence: newConfidence, count: newCount,
        properties: JSON.stringify(mergedProps), now, id: existing.id,
      });
      return existing.id;
    }

    const id = genId('rel');
    this._db.run(`
      INSERT INTO relationships (id, source_id, target_id, relation, properties, confidence, evidence_count, character_id, created_at, updated_at)
      VALUES (:id, :sourceId, :targetId, :relation, :properties, 0.7, 1, :characterId, :now, :now)
    `, {
      id, sourceId, targetId, relation,
      properties: JSON.stringify(properties),
      characterId, now,
    });
    return id;
  }

  getRelationships(entityId, direction = 'both') {
    let rows = [];
    if (direction === 'outgoing' || direction === 'both') {
      rows = rows.concat(this._db.all(
        'SELECT r.*, e.name as target_name, e.type as target_type FROM relationships r JOIN entities e ON r.target_id = e.id WHERE r.source_id = :entityId ORDER BY r.confidence DESC',
        { entityId },
      ));
    }
    if (direction === 'incoming' || direction === 'both') {
      rows = rows.concat(this._db.all(
        'SELECT r.*, e.name as source_name, e.type as source_type FROM relationships r JOIN entities e ON r.source_id = e.id WHERE r.target_id = :entityId ORDER BY r.confidence DESC',
        { entityId },
      ));
    }
    return rows.map(r => ({
      ...r,
      properties: JSON.parse(r.properties || '{}'),
    }));
  }

  getRelatedEntities(entityId, depth = 2) {
    const visited = new Set();
    const result = [];
    const queue = [{ id: entityId, depth: 0 }];

    while (queue.length > 0) {
      const { id, depth: d } = queue.shift();
      if (visited.has(id) || d > depth) continue;
      visited.add(id);

      const rels = this.getRelationships(id, 'both');
      for (const rel of rels) {
        const otherId = rel.source_id === id ? rel.target_id : rel.source_id;
        if (!visited.has(otherId)) {
          const entity = this.getEntity(otherId);
          if (entity) {
            result.push({ entity, relationship: rel, depth: d + 1 });
            queue.push({ id: otherId, depth: d + 1 });
          }
        }
      }
    }
    return result;
  }

  // ── Beliefs ────────────────────────────────────────────────────

  addBelief(entityId, statement, source = 'inferred', confidence = 0.7, characterId = 'default') {
    const now = Date.now();
    const id = genId('bel');
    this._db.run(`
      INSERT INTO beliefs (id, entity_id, statement, source, confidence, evidence, counter_evidence, character_id, created_at, updated_at)
      VALUES (:id, :entityId, :statement, :source, :confidence, :evidence, :counterEvidence, :characterId, :now, :now)
    `, {
      id, entityId, statement, source, confidence,
      evidence: JSON.stringify([statement]),
      counterEvidence: JSON.stringify([]),
      characterId, now,
    });
    return id;
  }

  updateBelief(beliefId, newConfidence, newEvidence = null) {
    const now = Date.now();
    const belief = this._db.get('SELECT * FROM beliefs WHERE id = :id', { id: beliefId });
    if (!belief) return;

    const evidence = JSON.parse(belief.evidence || '[]');
    if (newEvidence) evidence.push(newEvidence);

    this._db.run(`
      UPDATE beliefs SET confidence = :confidence, evidence = :evidence, updated_at = :now
      WHERE id = :id
    `, {
      confidence: newConfidence,
      evidence: JSON.stringify(evidence),
      now, id: beliefId,
    });
  }

  contradictBelief(beliefId, correction) {
    const now = Date.now();
    const belief = this._db.get('SELECT * FROM beliefs WHERE id = :id', { id: beliefId });
    if (!belief) return;

    const counterEvidence = JSON.parse(belief.counter_evidence || '[]');
    counterEvidence.push(correction);
    const newConfidence = Math.max(0.1, belief.confidence - 0.2);

    this._db.run(`
      UPDATE beliefs SET confidence = :confidence, counter_evidence = :counterEvidence, updated_at = :now
      WHERE id = :id
    `, {
      confidence: newConfidence,
      counterEvidence: JSON.stringify(counterEvidence),
      now, id: beliefId,
    });
  }

  getBeliefsAbout(entityId) {
    return this._db.all(
      'SELECT * FROM beliefs WHERE entity_id = :entityId ORDER BY confidence DESC',
      { entityId },
    ).map(b => ({
      ...b,
      evidence: JSON.parse(b.evidence || '[]'),
      counter_evidence: JSON.parse(b.counter_evidence || '[]'),
    }));
  }

  // ── Jargon ─────────────────────────────────────────────────────

  addJargon(term, meaning, userId = null, characterId = 'default') {
    const existing = this.lookupJargon(term, characterId);
    if (existing) {
      this._db.run(
        'UPDATE jargon SET meaning = :meaning WHERE id = :id',
        { meaning, id: existing.id },
      );
      return existing.id;
    }

    const result = this._db.run(`
      INSERT INTO jargon (term, meaning, user_id, character_id, created_at)
      VALUES (:term, :meaning, :userId, :characterId, :now)
    `, {
      term, meaning, userId, characterId, now: Date.now(),
    });
    return result.lastInsertRowid;
  }

  lookupJargon(term, characterId = 'default') {
    return this._db.get(
      'SELECT * FROM jargon WHERE character_id = :characterId AND term COLLATE NOCASE = :term',
      { characterId, term },
    );
  }

  // ── Context Building ──────────────────────────────────────────

  buildWorldContext(characterId = 'default', userId = null, limit = 8) {
    const parts = [];

    // Top entities by mention count
    const topEntities = this._db.all(
      'SELECT * FROM entities WHERE character_id = :characterId ORDER BY mention_count DESC LIMIT :limit',
      { characterId, limit },
    ).map(r => this._parseEntity(r));

    if (topEntities.length > 0) {
      const entLines = topEntities.map(e => {
        const props = Object.entries(e.properties)
          .filter(([, v]) => v)
          .map(([k, v]) => `${k}: ${v}`)
          .join(', ');
        return `- **${e.name}** (${e.type})${props ? ` — ${props}` : ''}`;
      });
      parts.push(`**Key Entities:**\n${entLines.join('\n')}`);
    }

    // Top relationships
    if (topEntities.length > 0) {
      const relLines = [];
      for (const ent of topEntities.slice(0, 5)) {
        const rels = this.getRelationships(ent.id, 'outgoing');
        for (const rel of rels.slice(0, 3)) {
          relLines.push(`- ${ent.name} → ${rel.relation} → ${rel.target_name}`);
        }
      }
      if (relLines.length > 0) {
        parts.push(`**Relationships:**\n${relLines.join('\n')}`);
      }
    }

    // Top beliefs by confidence
    const topBeliefs = this._db.all(
      'SELECT b.*, e.name as entity_name FROM beliefs b JOIN entities e ON b.entity_id = e.id WHERE b.character_id = :characterId AND b.confidence >= 0.5 ORDER BY b.confidence DESC LIMIT 6',
      { characterId },
    );
    if (topBeliefs.length > 0) {
      const beliefLines = topBeliefs.map(b =>
        `- ${b.entity_name}: ${b.statement} (${Math.round(b.confidence * 100)}%)`,
      );
      parts.push(`**What I Know:**\n${beliefLines.join('\n')}`);
    }

    // Jargon
    const jargonFilter = userId
      ? 'WHERE character_id = :characterId AND (user_id IS NULL OR user_id = :userId) ORDER BY created_at DESC LIMIT 5'
      : 'WHERE character_id = :characterId ORDER BY created_at DESC LIMIT 5';
    const jargonParams = userId ? { characterId, userId } : { characterId };
    const jargonRows = this._db.all(`SELECT * FROM jargon ${jargonFilter}`, jargonParams);
    if (jargonRows.length > 0) {
      const jargonLines = jargonRows.map(j => `- **${j.term}**: ${j.meaning}`);
      parts.push(`**Terminology:**\n${jargonLines.join('\n')}`);
    }

    return parts.length > 0 ? parts.join('\n\n') : null;
  }

  // ── LLM Extraction ────────────────────────────────────────────

  async extractFromConversation(userMessage, botReply, userId, characterId, provider) {
    const logger = getLogger();

    const prompt = `Analyze this conversation exchange and extract structured knowledge.

User said: "${userMessage}"
Bot replied: "${botReply}"

Extract any entities, relationships, beliefs, or jargon mentioned. Return JSON only:
{
  "entities": [{"type": "person|project|tool|concept|organization|place", "name": "...", "properties": {}, "aliases": []}],
  "relationships": [{"source": "entity name", "target": "entity name", "relation": "uses|works_on|knows|created_by|part_of|depends_on|likes|dislikes"}],
  "beliefs": [{"entity": "entity name", "statement": "...", "source": "user_said|inferred", "confidence": 0.7}],
  "jargon": [{"term": "...", "meaning": "..."}]
}

Rules:
- Only extract clearly stated or strongly implied information
- Entity names should be proper nouns or specific terms, not generic words
- Skip greetings, small talk, and meta-conversation
- Return empty arrays if nothing meaningful to extract
- Keep it minimal — quality over quantity`;

    try {
      const response = await provider.chat({
        messages: [{ role: 'user', content: prompt }],
      });

      const text = (response.text || '').trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const data = JSON.parse(jsonMatch[0]);
      const result = { entities: 0, relationships: 0, beliefs: 0, jargon: 0 };

      // Process entities — dedup via findEntity
      const entityIdMap = new Map(); // name -> id
      if (Array.isArray(data.entities)) {
        for (const ent of data.entities) {
          if (!ent.name || !ent.type) continue;
          const id = this.upsertEntity(ent.type, ent.name, ent.properties || {}, ent.aliases || [], characterId);
          entityIdMap.set(ent.name.toLowerCase(), id);
          result.entities++;
        }
      }

      // Process relationships
      if (Array.isArray(data.relationships)) {
        for (const rel of data.relationships) {
          if (!rel.source || !rel.target || !rel.relation) continue;
          const sourceId = entityIdMap.get(rel.source.toLowerCase()) || this.findEntity(rel.source, characterId)?.id;
          const targetId = entityIdMap.get(rel.target.toLowerCase()) || this.findEntity(rel.target, characterId)?.id;
          if (sourceId && targetId) {
            this.addRelationship(sourceId, targetId, rel.relation, {}, characterId);
            result.relationships++;
          }
        }
      }

      // Process beliefs
      if (Array.isArray(data.beliefs)) {
        for (const belief of data.beliefs) {
          if (!belief.entity || !belief.statement) continue;
          const entityId = entityIdMap.get(belief.entity.toLowerCase()) || this.findEntity(belief.entity, characterId)?.id;
          if (entityId) {
            this.addBelief(entityId, belief.statement, belief.source || 'inferred', belief.confidence || 0.7, characterId);
            result.beliefs++;
          }
        }
      }

      // Process jargon
      if (Array.isArray(data.jargon)) {
        for (const j of data.jargon) {
          if (!j.term || !j.meaning) continue;
          this.addJargon(j.term, j.meaning, userId, characterId);
          result.jargon++;
        }
      }

      if (result.entities > 0 || result.relationships > 0 || result.beliefs > 0 || result.jargon > 0) {
        logger.debug(`[WorldModel] Extracted: ${result.entities}E ${result.relationships}R ${result.beliefs}B ${result.jargon}J`);
      }
      return result;
    } catch (err) {
      logger.warn(`[WorldModel] Extraction failed: ${err.message}`);
      return null;
    }
  }
}
