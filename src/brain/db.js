import { Database } from 'bun:sqlite';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { getLogger } from '../utils/logger.js';
import { EmbeddingProvider } from './embeddings.js';

const SCHEMA_VERSION = 9;

/**
 * BrainDB — unified SQLite database for all KERNEL data.
 * Uses bun:sqlite (built-in, zero native compilation needed).
 */
export class BrainDB {
  constructor({ dbPath, config }) {
    this._dbPath = dbPath;
    this._config = config;
    this._db = null;
    this._embedder = null;
    this._vecEnabled = false;
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  async open() {
    const logger = getLogger();

    mkdirSync(dirname(this._dbPath), { recursive: true });

    this._db = new Database(this._dbPath, { strict: true });
    this._db.run('PRAGMA journal_mode = WAL');
    this._db.run('PRAGMA foreign_keys = ON');

    // Try to load sqlite-vec
    try {
      const sqliteVec = await import('sqlite-vec');
      sqliteVec.load(this._db);
      this._vecEnabled = true;
      logger.debug('[BrainDB] sqlite-vec loaded');
    } catch (err) {
      logger.warn(`[BrainDB] sqlite-vec not available — vector search disabled: ${err.message}`);
      this._vecEnabled = false;
    }

    // Init embedder
    this._embedder = EmbeddingProvider.create(this._config);

    // Create schema
    this._ensureSchema();

    logger.info(`[BrainDB] Opened ${this._dbPath} (vec=${this._vecEnabled}, embedder=${this._embedder.name}, dims=${this._embedder.dimensions})`);
  }

  close() {
    const logger = getLogger();
    if (this._db) {
      this._db.close();
      this._db = null;
      logger.info('[BrainDB] Closed');
    }
  }

  get isOpen() { return this._db !== null; }
  get hasVectors() { return this._vecEnabled && this._embedder.dimensions > 0; }
  get embedder() { return this._embedder; }

  // ── Schema ─────────────────────────────────────────────────────

  _ensureSchema() {
    this._db.exec(`
      -- Schema versioning
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER NOT NULL,
        applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );

      -- Memories (replaces episodic/*.json + topics.json)
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        type TEXT NOT NULL,            -- 'episodic' or 'semantic'
        source TEXT,                   -- e.g. 'user_chat', 'browse', topic slug for semantic
        user_id TEXT,
        summary TEXT NOT NULL,
        tags TEXT,                     -- JSON array
        importance INTEGER DEFAULT 5,
        related_topics TEXT,           -- JSON array (semantic only)
        sources TEXT,                  -- JSON array (semantic only)
        scope TEXT DEFAULT 'org_wide',
        created_at INTEGER NOT NULL,
        updated_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_memories_char ON memories(character_id);
      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(character_id, type);
      CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);

      -- Conversations (replaces conversations.json)
      CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,         -- JSON string for complex content
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_conv_chat ON conversations(character_id, chat_id);
      CREATE INDEX IF NOT EXISTS idx_conv_ts ON conversations(character_id, chat_id, timestamp);

      -- Chat skills (replaces _skills in conversations.json)
      CREATE TABLE IF NOT EXISTS chat_skills (
        character_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        PRIMARY KEY (character_id, chat_id, skill_id)
      );

      -- Journals (replaces journals/*.md)
      CREATE TABLE IF NOT EXISTS journals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id TEXT NOT NULL,
        date TEXT NOT NULL,            -- YYYY-MM-DD
        content TEXT NOT NULL,         -- full markdown for the day
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_journals_date ON journals(character_id, date);

      -- Self data (replaces self/*.md)
      CREATE TABLE IF NOT EXISTS self_data (
        character_id TEXT NOT NULL,
        file_name TEXT NOT NULL,        -- goals, journey, life, hobbies
        content TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (character_id, file_name)
      );

      -- User personas (replaces personas/*.md)
      CREATE TABLE IF NOT EXISTS user_personas (
        user_id TEXT PRIMARY KEY,
        persona_md TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Shares (replaces shares.json)
      CREATE TABLE IF NOT EXISTS shares (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT,
        priority TEXT DEFAULT 'medium',
        target_user_id TEXT,
        tags TEXT,                      -- JSON array
        status TEXT NOT NULL DEFAULT 'pending', -- pending | shared
        created_at INTEGER NOT NULL,
        shared_at INTEGER,
        shared_to_user_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_shares_status ON shares(character_id, status);

      -- Evolution proposals (replaces evolution.json proposals)
      CREATE TABLE IF NOT EXISTS evolution_proposals (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        status TEXT NOT NULL,           -- research, planned, coding, pr_open, merged, rejected, failed
        trigger_type TEXT,
        trigger_context TEXT,
        research TEXT,                  -- JSON object
        plan TEXT,                      -- JSON object
        branch TEXT,
        commits TEXT,                   -- JSON array
        files_changed TEXT,             -- JSON array
        pr_number INTEGER,
        pr_url TEXT,
        outcome TEXT,                   -- JSON object
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_evo_char ON evolution_proposals(character_id);

      -- Evolution lessons (replaces evolution.json lessons)
      CREATE TABLE IF NOT EXISTS evolution_lessons (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        category TEXT,
        lesson TEXT NOT NULL,
        from_proposal TEXT,
        importance INTEGER DEFAULT 5,
        created_at INTEGER NOT NULL
      );

      -- Forge skills (replaces forge.json)
      CREATE TABLE IF NOT EXISTS forge_skills (
        skill_id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        status TEXT NOT NULL,           -- seed, growing, mature, contributed
        maturity INTEGER DEFAULT 0,
        domain TEXT,
        sources TEXT,                   -- JSON array
        related_skills TEXT,            -- JSON array
        auto_assign_patterns TEXT,      -- JSON array
        contributed_pr_url TEXT,
        research_count INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_researched_at INTEGER,
        last_updated_at INTEGER
      );

      -- Codebase file summaries (replaces codebase/file-summaries.json)
      CREATE TABLE IF NOT EXISTS codebase_files (
        file_path TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        exports TEXT,                   -- JSON array
        dependencies TEXT,              -- JSON array
        line_count INTEGER,
        last_hash TEXT,
        last_scanned INTEGER NOT NULL
      );

      -- Codebase meta (replaces codebase/architecture.md)
      CREATE TABLE IF NOT EXISTS codebase_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Ideas (replaces ideas.json)
      CREATE TABLE IF NOT EXISTS ideas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ideas_char ON ideas(character_id);

      -- Automations (replaces automations.json)
      CREATE TABLE IF NOT EXISTS automations (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        schedule TEXT NOT NULL,          -- JSON object
        enabled INTEGER NOT NULL DEFAULT 1,
        respect_quiet_hours INTEGER NOT NULL DEFAULT 1,
        last_run INTEGER,
        next_run INTEGER,
        run_count INTEGER DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL
      );

      -- Life engine state (replaces state.json)
      CREATE TABLE IF NOT EXISTS life_state (
        character_id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,        -- full state object
        updated_at INTEGER NOT NULL
      );

      -- World Model: Entities (people, projects, tools, concepts)
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,              -- 'person', 'project', 'tool', 'concept', 'organization', 'place'
        name TEXT NOT NULL,
        properties TEXT,                 -- JSON object
        aliases TEXT,                    -- JSON array of alternative names
        character_id TEXT NOT NULL,
        mention_count INTEGER DEFAULT 1,
        first_mentioned INTEGER NOT NULL,
        last_mentioned INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(character_id, type);
      CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(character_id, name COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_entities_mentions ON entities(mention_count DESC);

      -- World Model: Relationships between entities
      CREATE TABLE IF NOT EXISTS relationships (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        target_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        relation TEXT NOT NULL,          -- e.g. 'uses', 'works_on', 'knows', 'created_by'
        properties TEXT,                 -- JSON object
        confidence REAL DEFAULT 0.7,
        evidence_count INTEGER DEFAULT 1,
        character_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rel_source ON relationships(source_id);
      CREATE INDEX IF NOT EXISTS idx_rel_target ON relationships(target_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_rel_unique ON relationships(source_id, target_id, relation);

      -- World Model: Beliefs about entities
      CREATE TABLE IF NOT EXISTS beliefs (
        id TEXT PRIMARY KEY,
        entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        statement TEXT NOT NULL,
        source TEXT,                     -- 'user_said', 'inferred', 'observed'
        confidence REAL DEFAULT 0.7,
        evidence TEXT,                   -- JSON array of supporting evidence
        counter_evidence TEXT,           -- JSON array of contradicting evidence
        character_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_beliefs_entity ON beliefs(entity_id);
      CREATE INDEX IF NOT EXISTS idx_beliefs_confidence ON beliefs(confidence DESC);

      -- World Model: User-specific jargon/terminology
      CREATE TABLE IF NOT EXISTS jargon (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        term TEXT NOT NULL,
        meaning TEXT NOT NULL,
        user_id TEXT,
        character_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_jargon_term ON jargon(character_id, term COLLATE NOCASE);

      -- Feedback Engine: Signals (raw detected signals from user interactions)
      CREATE TABLE IF NOT EXISTS feedback_signals (
        id TEXT PRIMARY KEY,
        signal_type TEXT NOT NULL,
        trigger_message TEXT,
        bot_message TEXT,
        context TEXT,
        user_id TEXT,
        chat_id TEXT,
        adjustment_id TEXT,
        character_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_feedback_type ON feedback_signals(signal_type);
      CREATE INDEX IF NOT EXISTS idx_feedback_user ON feedback_signals(user_id);

      -- Feedback Engine: Behavioral Adjustments (learned preferences)
      CREATE TABLE IF NOT EXISTS behavioral_adjustments (
        id TEXT PRIMARY KEY,
        trigger_pattern TEXT NOT NULL,
        wrong_behavior TEXT,
        right_behavior TEXT NOT NULL,
        category TEXT,
        confidence REAL DEFAULT 0.5,
        evidence_count INTEGER DEFAULT 1,
        user_id TEXT,
        character_id TEXT,
        active INTEGER DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_adjustments_category ON behavioral_adjustments(category);
      CREATE INDEX IF NOT EXISTS idx_adjustments_user ON behavioral_adjustments(user_id);
      CREATE INDEX IF NOT EXISTS idx_adjustments_confidence ON behavioral_adjustments(confidence DESC);

      -- Feedback Engine: Task Outcomes (worker job outcome tracking)
      CREATE TABLE IF NOT EXISTS task_outcomes (
        job_id TEXT PRIMARY KEY,
        worker_type TEXT,
        task_summary TEXT,
        result_used INTEGER,
        follow_up_requested INTEGER,
        user_satisfaction TEXT,
        time_to_response INTEGER,
        user_id TEXT,
        character_id TEXT,
        created_at INTEGER NOT NULL
      );

      -- Causal Memory: Events (trigger → goal → approach → outcome → lesson)
      CREATE TABLE IF NOT EXISTS causal_events (
        id TEXT PRIMARY KEY,
        memory_id TEXT,
        job_id TEXT,
        trigger TEXT NOT NULL,
        goal TEXT,
        approach TEXT,
        tools_used TEXT,
        entities_involved TEXT,
        outcome TEXT,
        outcome_type TEXT,
        lesson TEXT,
        counterfactual TEXT,
        user_id TEXT,
        character_id TEXT,
        duration_ms INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_causal_outcome ON causal_events(outcome_type);
      CREATE INDEX IF NOT EXISTS idx_causal_user ON causal_events(user_id);
      CREATE INDEX IF NOT EXISTS idx_causal_created ON causal_events(created_at DESC);

      -- Causal Memory: Task Patterns (aggregated from causal events)
      CREATE TABLE IF NOT EXISTS task_patterns (
        id TEXT PRIMARY KEY,
        pattern_type TEXT NOT NULL,
        description TEXT NOT NULL,
        trigger_pattern TEXT,
        recommended_approach TEXT,
        avoid TEXT,
        evidence_ids TEXT,
        confidence REAL DEFAULT 0.5,
        character_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_patterns_type ON task_patterns(pattern_type);
      CREATE INDEX IF NOT EXISTS idx_patterns_confidence ON task_patterns(confidence DESC);

      -- Behavioral DNA: Traits (personality/skill dimensions with confidence)
      CREATE TABLE IF NOT EXISTS dna_traits (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        value REAL NOT NULL DEFAULT 0.5,
        target_value REAL,
        evidence_count INTEGER DEFAULT 0,
        trend TEXT DEFAULT 'stable',
        user_id TEXT,
        character_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_dna_traits_char ON dna_traits(character_id);
      CREATE INDEX IF NOT EXISTS idx_dna_traits_name ON dna_traits(character_id, name);
      CREATE INDEX IF NOT EXISTS idx_dna_traits_user ON dna_traits(user_id, character_id);

      -- Behavioral DNA: Trait History (change log for trend detection)
      CREATE TABLE IF NOT EXISTS dna_trait_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trait_id TEXT NOT NULL REFERENCES dna_traits(id),
        old_value REAL NOT NULL,
        new_value REAL NOT NULL,
        reason TEXT,
        signal_id TEXT,
        causal_event_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_trait_history_trait ON dna_trait_history(trait_id);
      CREATE INDEX IF NOT EXISTS idx_trait_history_created ON dna_trait_history(created_at DESC);

      -- Behavioral DNA: Communication Profiles (per-user style dimensions)
      CREATE TABLE IF NOT EXISTS communication_profiles (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        character_id TEXT,
        verbosity REAL DEFAULT 0.5,
        formality REAL DEFAULT 0.5,
        emoji_usage REAL DEFAULT 0.3,
        code_vs_explanation REAL DEFAULT 0.5,
        detail_level REAL DEFAULT 0.5,
        humor REAL DEFAULT 0.3,
        proactivity REAL DEFAULT 0.5,
        preferred_format TEXT DEFAULT 'mixed',
        preferred_length TEXT DEFAULT 'medium',
        evidence_count INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_comm_profiles_user ON communication_profiles(user_id, character_id);

      -- Behavioral DNA: Self Narrative (versioned, replaces static self files)
      CREATE TABLE IF NOT EXISTS self_narrative (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        version INTEGER DEFAULT 1,
        last_evidence TEXT,
        character_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_narrative_char ON self_narrative(character_id);

      -- Synthesis Loop: Outcomes (Phase 6)
      CREATE TABLE IF NOT EXISTS synthesis_outcomes (
        id TEXT PRIMARY KEY,
        action_type TEXT NOT NULL,
        target TEXT,
        urgency_score REAL,
        result_quality TEXT,
        artifacts_created INTEGER DEFAULT 0,
        duration_ms INTEGER,
        character_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_synthesis_type ON synthesis_outcomes(action_type);
      CREATE INDEX IF NOT EXISTS idx_synthesis_quality ON synthesis_outcomes(result_quality);
      CREATE INDEX IF NOT EXISTS idx_synthesis_created ON synthesis_outcomes(created_at DESC);

      -- Synthesis Loop: Weights (Phase 6)
      CREATE TABLE IF NOT EXISTS synthesis_weights (
        action_type TEXT PRIMARY KEY,
        base_weight REAL NOT NULL DEFAULT 1.0,
        current_weight REAL NOT NULL DEFAULT 1.0,
        success_rate REAL DEFAULT 0.5,
        total_runs INTEGER DEFAULT 0,
        last_run_at INTEGER,
        cooldown_ms INTEGER DEFAULT 0,
        character_id TEXT
      );

      -- User Onboarding (Phase 9)
      CREATE TABLE IF NOT EXISTS user_onboarding (
        user_id TEXT PRIMARY KEY,
        phase TEXT NOT NULL DEFAULT 'profile',
        profile_data TEXT,
        selected_skills TEXT,
        training_notes TEXT,
        started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );

      -- Identity Awareness: Known Senders (Phase 7)
      CREATE TABLE IF NOT EXISTS known_senders (
        user_id TEXT NOT NULL,
        username TEXT,
        display_name TEXT,
        sender_type TEXT NOT NULL DEFAULT 'unknown',
        is_bot INTEGER DEFAULT 0,
        trust_level INTEGER DEFAULT 25,
        agent_platform TEXT,
        agent_purpose TEXT,
        agent_owner TEXT,
        interaction_mode TEXT DEFAULT 'conversational',
        org_role TEXT,
        team TEXT,
        introduced_by TEXT,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        message_count INTEGER DEFAULT 1,
        interaction_quality REAL DEFAULT 0.5,
        character_id TEXT,
        PRIMARY KEY (user_id, character_id)
      );
      CREATE INDEX IF NOT EXISTS idx_senders_type ON known_senders(sender_type);
      CREATE INDEX IF NOT EXISTS idx_senders_trust ON known_senders(trust_level DESC);
      CREATE INDEX IF NOT EXISTS idx_senders_last_seen ON known_senders(last_seen DESC);

      -- Identity Awareness: Knowledge Scopes (Phase 7)
      CREATE TABLE IF NOT EXISTS knowledge_scopes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id TEXT,
        scope_type TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        shared_with TEXT,
        sensitivity TEXT DEFAULT 'normal',
        auto_classified INTEGER DEFAULT 1,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_scope_owner ON knowledge_scopes(owner_user_id);
      CREATE INDEX IF NOT EXISTS idx_scope_type ON knowledge_scopes(scope_type);
      CREATE INDEX IF NOT EXISTS idx_scope_memory ON knowledge_scopes(memory_id);

      -- Identity Awareness: Agent Signatures (Phase 7)
      CREATE TABLE IF NOT EXISTS agent_signatures (
        id TEXT PRIMARY KEY,
        pattern_type TEXT NOT NULL,
        pattern TEXT NOT NULL,
        confidence REAL DEFAULT 0.5,
        agent_user_id TEXT,
        character_id TEXT,
        created_at INTEGER NOT NULL
      );

      -- Identity Awareness: Interaction Contexts (Phase 7)
      CREATE TABLE IF NOT EXISTS interaction_contexts (
        chat_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        chat_type TEXT,
        is_direct INTEGER DEFAULT 0,
        other_participants TEXT,
        current_topic TEXT,
        last_interaction INTEGER,
        interaction_count INTEGER DEFAULT 1,
        PRIMARY KEY (chat_id, user_id)
      );
    `);

    // Vector tables — only if embedder has dimensions
    if (this._vecEnabled && this._embedder.dimensions > 0) {
      const dims = this._embedder.dimensions;
      // sqlite-vec virtual tables
      this._db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(
          memory_id TEXT PRIMARY KEY,
          embedding float[${dims}]
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS persona_vectors USING vec0(
          user_id TEXT PRIMARY KEY,
          embedding float[${dims}]
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS entity_vectors USING vec0(
          entity_id TEXT PRIMARY KEY,
          embedding float[${dims}]
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS causal_vectors USING vec0(
          event_id TEXT PRIMARY KEY,
          embedding float[${dims}]
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS journal_vectors USING vec0(
          journal_id INTEGER PRIMARY KEY,
          embedding float[${dims}]
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS adjustment_vectors USING vec0(
          adjustment_id TEXT PRIMARY KEY,
          embedding float[${dims}]
        );
      `);
    }

    // Run migrations and record schema version
    const existing = this._db.query('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get();
    if (!existing) {
      this._db.query('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
    } else if (existing.version < SCHEMA_VERSION) {
      if (existing.version < 7) this._runV7Migration();
      // v8: new vector tables are IF NOT EXISTS — no-op migration needed
      this._db.query('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
    }
  }

  _runV7Migration() {
    const logger = getLogger();
    try {
      this._db.exec('ALTER TABLE memories ADD COLUMN scope TEXT DEFAULT \'org_wide\'');
      logger.info('[BrainDB] v7 migration: added scope column to memories');
    } catch (err) {
      // Column may already exist
      if (!err.message.includes('duplicate column')) {
        logger.warn(`[BrainDB] v7 migration warning: ${err.message}`);
      }
    }
  }

  // ── SQL Helpers ────────────────────────────────────────────────

  run(sql, params = {}) {
    return this._db.query(sql).run(params);
  }

  get(sql, params = {}) {
    return this._db.query(sql).get(params);
  }

  all(sql, params = {}) {
    return this._db.query(sql).all(params);
  }

  transaction(fn) {
    return this._db.transaction(fn)();
  }

  // ── Embedding Helpers ──────────────────────────────────────────

  async embed(text) {
    if (!this._embedder || this._embedder.dimensions === 0) return null;
    return this._embedder.embed(text);
  }

  async embedBatch(texts) {
    if (!this._embedder || this._embedder.dimensions === 0) return texts.map(() => null);
    return this._embedder.embedBatch(texts);
  }

  // ── Vector Search ──────────────────────────────────────────────

  /**
   * KNN vector search via sqlite-vec.
   * @param {'memory_vectors'|'persona_vectors'} table
   * @param {string} queryText — will be embedded first
   * @param {number} limit
   * @returns {Promise<Array<{id: string, distance: number}>>}
   */
  async vectorSearch(table, queryText, limit = 10) {
    if (!this.hasVectors) return [];

    const queryVec = await this.embed(queryText);
    if (!queryVec) return [];

    const idCol = this._vecIdCol(table) || 'memory_id';
    const buf = Buffer.from(queryVec.buffer);

    const rows = this._db.query(`
      SELECT ${idCol} as id, distance
      FROM ${table}
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `).all(buf, limit);

    return rows;
  }

  // ── Background Embedding ──────────────────────────────────────

  /**
   * Fire-and-forget embed + upsert into a vector table.
   * Safe to call even when vectors are disabled.
   */
  embedBackground(table, id, text) {
    if (!this.hasVectors || !text || text.length < 10) return;
    const idCol = this._vecIdCol(table);
    if (!idCol) return;
    setImmediate(async () => {
      try {
        const vec = await this.embed(text);
        if (vec) {
          const buf = Buffer.from(vec.buffer);
          this.run(`INSERT OR REPLACE INTO ${table} (${idCol}, embedding) VALUES ($id, $embedding)`, { id, embedding: buf });
        }
      } catch (err) {
        getLogger().warn(`[BrainDB] embedBackground ${table}/${id}: ${err.message}`);
      }
    });
  }

  /**
   * Map vector table name → its primary-key column.
   */
  _vecIdCol(table) {
    return {
      memory_vectors: 'memory_id',
      persona_vectors: 'user_id',
      entity_vectors: 'entity_id',
      causal_vectors: 'event_id',
      journal_vectors: 'journal_id',
      adjustment_vectors: 'adjustment_id',
    }[table] || null;
  }

  // ── Backfill ────────────────────────────────────────────────────

  /**
   * One-time async backfill for existing unembedded rows.
   * Rate-limited: 200ms delay between each embed call.
   */
  async backfillVectors() {
    if (!this.hasVectors) return;
    const logger = getLogger();
    const delay = (ms) => new Promise(r => setTimeout(r, ms));

    const backfillTable = async (label, sql, table, textFn) => {
      let count = 0;
      const rows = this.all(sql);
      for (const row of rows) {
        const text = textFn(row);
        if (!text || text.length < 10) continue;
        try {
          const vec = await this.embed(text);
          if (vec) {
            const idCol = this._vecIdCol(table);
            const buf = Buffer.from(vec.buffer);
            this.run(`INSERT OR REPLACE INTO ${table} (${idCol}, embedding) VALUES ($id, $embedding)`, { id: row.id, embedding: buf });
            count++;
          }
        } catch (err) {
          logger.debug(`[Backfill] ${label} ${row.id}: ${err.message}`);
        }
        await delay(200);
      }
      if (count > 0) logger.info(`[Backfill] ${label}: ${count} rows embedded`);
    };

    await backfillTable('memories',
      `SELECT m.id, m.summary FROM memories m LEFT JOIN memory_vectors mv ON m.id = mv.memory_id WHERE mv.memory_id IS NULL LIMIT 200`,
      'memory_vectors', r => r.summary);

    await backfillTable('entities',
      `SELECT e.id, e.name, e.type, e.properties FROM entities e LEFT JOIN entity_vectors ev ON e.id = ev.entity_id WHERE ev.entity_id IS NULL LIMIT 100`,
      'entity_vectors', r => {
        const props = JSON.parse(r.properties || '{}');
        const propStr = Object.keys(props).length ? ': ' + Object.entries(props).map(([k,v])=>`${k}=${v}`).join(', ') : '';
        return `${r.name} (${r.type})${propStr}`;
      });

    await backfillTable('personas',
      `SELECT up.user_id as id, up.persona_md FROM user_personas up LEFT JOIN persona_vectors pv ON up.user_id = pv.user_id WHERE pv.user_id IS NULL LIMIT 50`,
      'persona_vectors', r => r.persona_md);

    await backfillTable('journals',
      `SELECT j.id, j.content FROM journals j LEFT JOIN journal_vectors jv ON j.id = jv.journal_id WHERE jv.journal_id IS NULL LIMIT 50`,
      'journal_vectors', r => r.content);

    await backfillTable('adjustments',
      `SELECT ba.id, ba.trigger_pattern, ba.right_behavior FROM behavioral_adjustments ba LEFT JOIN adjustment_vectors av ON ba.id = av.adjustment_id WHERE av.adjustment_id IS NULL LIMIT 50`,
      'adjustment_vectors', r => `${r.trigger_pattern} ${r.right_behavior}`);
  }
}
