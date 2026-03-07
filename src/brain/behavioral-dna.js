import { randomUUID } from 'crypto';
import { getLogger } from '../utils/logger.js';

// ── Default Traits ───────────────────────────────────────────────────

const DEFAULT_TRAITS = [
  // Communication
  { category: 'communication', name: 'conciseness', value: 0.6, description: 'How brief vs verbose responses are' },
  { category: 'communication', name: 'technical_depth', value: 0.7, description: 'Level of technical detail in explanations' },
  { category: 'communication', name: 'explanation_quality', value: 0.5, description: 'Clarity and quality of explanations' },
  { category: 'communication', name: 'code_quality', value: 0.5, description: 'Quality of generated code' },
  // Personality
  { category: 'personality', name: 'curiosity', value: 0.7, description: 'Drive to explore and learn new things' },
  { category: 'personality', name: 'humor', value: 0.3, description: 'Use of humor and wit in responses' },
  { category: 'personality', name: 'warmth', value: 0.6, description: 'Warmth and friendliness in interactions' },
  { category: 'personality', name: 'confidence', value: 0.5, description: 'Assertiveness in suggestions and decisions' },
  { category: 'personality', name: 'helpfulness', value: 0.8, description: 'Drive to be maximally helpful' },
  // Work style
  { category: 'work_style', name: 'thoroughness', value: 0.6, description: 'How comprehensive and detailed work is' },
  { category: 'work_style', name: 'proactivity', value: 0.5, description: 'Initiative in suggesting improvements' },
  { category: 'work_style', name: 'autonomy', value: 0.4, description: 'Acting independently vs asking for confirmation' },
  { category: 'work_style', name: 'creativity', value: 0.5, description: 'Creative and novel approaches to problems' },
];

// ── Signal → Trait Mapping ───────────────────────────────────────────

const SIGNAL_TO_TRAIT = {
  positive: [
    { trait: 'helpfulness', delta: 0.02 },
    { trait: 'confidence', delta: 0.01 },
  ],
  negative: [
    { trait: 'confidence', delta: -0.02 },
  ],
  correction: [
    { trait: 'confidence', delta: -0.01 },
    { trait: 'explanation_quality', delta: -0.02 },
  ],
  preference: {
    response_style: {
      'Keep responses shorter and more concise': [
        { trait: 'conciseness', delta: 0.05 },
        { profile: 'verbosity', delta: -0.05 },
        { profile: 'detail_level', delta: -0.03 },
      ],
      'Provide more detailed and thorough responses': [
        { trait: 'conciseness', delta: -0.05 },
        { trait: 'thoroughness', delta: 0.03 },
        { profile: 'verbosity', delta: 0.05 },
        { profile: 'detail_level', delta: 0.03 },
      ],
      'Use simpler, less technical language': [
        { trait: 'technical_depth', delta: -0.05 },
        { profile: 'code_vs_explanation', delta: -0.05 },
      ],
    },
    tone: {
      'Use a more formal and professional tone': [
        { profile: 'formality', delta: 0.05 },
        { trait: 'humor', delta: -0.03 },
        { profile: 'emoji_usage', delta: -0.03 },
      ],
      'Use a more casual and relaxed tone': [
        { profile: 'formality', delta: -0.05 },
        { trait: 'warmth', delta: 0.03 },
        { profile: 'emoji_usage', delta: 0.02 },
      ],
    },
    autonomy: {
      'Act more autonomously without asking for confirmation': [
        { trait: 'autonomy', delta: 0.05 },
        { trait: 'proactivity', delta: 0.03 },
        { profile: 'proactivity', delta: 0.05 },
      ],
    },
    formatting: {
      'Avoid using emojis in responses': [
        { profile: 'emoji_usage', delta: -0.1 },
      ],
    },
  },
  ignored: [
    { trait: 'helpfulness', delta: -0.01 },
  ],
};

// ── Narrative Sections ───────────────────────────────────────────────

const NARRATIVE_SECTIONS = ['goals', 'journey', 'identity', 'growth'];
const SELF_FILE_MAP = { goals: 'goals', journey: 'journey', identity: 'life', growth: 'hobbies' };

// ── BehavioralDNA ────────────────────────────────────────────────────

export class BehavioralDNA {
  constructor(db, feedbackEngine, causalMemory) {
    this._db = db;
    this._feedbackEngine = feedbackEngine;
    this._causalMemory = causalMemory;
  }

  // ── Trait Management ─────────────────────────────────────────────

  /**
   * One-time: creates 13 baseline traits if none exist for this character.
   */
  initializeDefaultTraits(characterId) {
    const existing = this._db.get(
      'SELECT COUNT(*) as cnt FROM dna_traits WHERE character_id = $cid AND user_id IS NULL',
      { cid: characterId },
    );
    if (existing && existing.cnt > 0) return;

    const logger = getLogger();
    const now = Date.now();

    this._db.transaction(() => {
      for (const t of DEFAULT_TRAITS) {
        this._db.run(`
          INSERT INTO dna_traits (id, category, name, description, value, evidence_count, trend, user_id, character_id, created_at, updated_at)
          VALUES ($id, $cat, $name, $desc, $val, 0, 'stable', NULL, $cid, $now, $now)
        `, {
          id: randomUUID(),
          cat: t.category,
          name: t.name,
          desc: t.description,
          val: t.value,
          cid: characterId,
          now,
        });
      }
    });

    logger.info(`[BehavioralDNA] Initialized ${DEFAULT_TRAITS.length} default traits for ${characterId}`);
  }

  /**
   * Get a trait — user-specific first, then global fallback.
   */
  getTrait(name, userId = null, characterId = 'default') {
    if (userId) {
      const userTrait = this._db.get(
        'SELECT * FROM dna_traits WHERE name = $name AND user_id = $uid AND character_id = $cid',
        { name, uid: userId, cid: characterId },
      );
      if (userTrait) return userTrait;
    }
    return this._db.get(
      'SELECT * FROM dna_traits WHERE name = $name AND user_id IS NULL AND character_id = $cid',
      { name, cid: characterId },
    ) || null;
  }

  /**
   * Shift a trait value (clamped 0-1), record history, recalculate trend.
   */
  adjustTrait(name, delta, reason, userId = null, characterId = 'default', signalId = null, causalEventId = null) {
    const logger = getLogger();

    let trait = this._db.get(
      'SELECT * FROM dna_traits WHERE name = $name AND (user_id = $uid OR (user_id IS NULL AND $uid IS NULL)) AND character_id = $cid',
      { name, uid: userId, cid: characterId },
    );

    // If user-specific doesn't exist and we have a userId, clone from global
    if (!trait && userId) {
      const global = this._db.get(
        'SELECT * FROM dna_traits WHERE name = $name AND user_id IS NULL AND character_id = $cid',
        { name, cid: characterId },
      );
      if (!global) return null;

      const now = Date.now();
      const newId = randomUUID();
      this._db.run(`
        INSERT INTO dna_traits (id, category, name, description, value, evidence_count, trend, user_id, character_id, created_at, updated_at)
        VALUES ($id, $cat, $name, $desc, $val, 0, 'stable', $uid, $cid, $now, $now)
      `, {
        id: newId, cat: global.category, name, desc: global.description,
        val: global.value, uid: userId, cid: characterId, now: Date.now(),
      });
      trait = { ...global, id: newId, user_id: userId };
    }

    if (!trait) return null;

    const oldValue = trait.value;
    const newValue = Math.max(0, Math.min(1, oldValue + delta));
    if (Math.abs(newValue - oldValue) < 0.001) return trait;

    const now = Date.now();

    // Record history
    this._db.run(`
      INSERT INTO dna_trait_history (trait_id, old_value, new_value, reason, signal_id, causal_event_id, created_at)
      VALUES ($tid, $old, $new, $reason, $sid, $ceid, $now)
    `, {
      tid: trait.id, old: oldValue, new: newValue, reason,
      sid: signalId, ceid: causalEventId, now,
    });

    // Calculate trend from last 5 entries
    const trend = this._calculateTrend(trait.id);

    // Update trait
    this._db.run(`
      UPDATE dna_traits SET value = $val, evidence_count = evidence_count + 1, trend = $trend, updated_at = $now
      WHERE id = $tid
    `, { val: newValue, trend, now, tid: trait.id });

    logger.debug(`[BehavioralDNA] Trait ${name}: ${oldValue.toFixed(2)} → ${newValue.toFixed(2)} (${reason})`);
    return { ...trait, value: newValue, trend };
  }

  _calculateTrend(traitId) {
    const history = this._db.all(
      'SELECT old_value, new_value FROM dna_trait_history WHERE trait_id = $tid ORDER BY created_at DESC LIMIT 5',
      { tid: traitId },
    );
    if (history.length < 2) return 'stable';

    const deltas = history.map(h => h.new_value - h.old_value);
    const avgDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;

    if (avgDelta > 0.01) return 'rising';
    if (avgDelta < -0.01) return 'falling';
    return 'stable';
  }

  /**
   * Get trait change history.
   */
  getTraitHistory(name, userId = null, characterId = 'default', days = 7) {
    const trait = this.getTrait(name, userId, characterId);
    if (!trait) return [];

    const cutoff = Date.now() - days * 24 * 3600_000;
    return this._db.all(
      'SELECT * FROM dna_trait_history WHERE trait_id = $tid AND created_at > $cutoff ORDER BY created_at DESC',
      { tid: trait.id, cutoff },
    );
  }

  // ── Communication Profiles ───────────────────────────────────────

  /**
   * Get or create a per-user communication profile.
   */
  getProfile(userId, characterId = 'default') {
    if (!userId) return null;

    let profile = this._db.get(
      'SELECT * FROM communication_profiles WHERE user_id = $uid AND (character_id = $cid OR character_id IS NULL)',
      { uid: userId, cid: characterId },
    );

    if (!profile) {
      const now = Date.now();
      const id = randomUUID();
      this._db.run(`
        INSERT INTO communication_profiles (id, user_id, character_id, created_at, updated_at)
        VALUES ($id, $uid, $cid, $now, $now)
      `, { id, uid: userId, cid: characterId, now });

      profile = this._db.get('SELECT * FROM communication_profiles WHERE id = $id', { id });
    }

    return profile;
  }

  /**
   * Shift a communication profile dimension.
   */
  adjustProfile(userId, characterId, field, delta, reason) {
    const profile = this.getProfile(userId, characterId);
    if (!profile) return null;

    const validFields = ['verbosity', 'formality', 'emoji_usage', 'code_vs_explanation', 'detail_level', 'humor', 'proactivity'];
    if (!validFields.includes(field)) return null;

    const oldValue = profile[field] ?? 0.5;
    const newValue = Math.max(0, Math.min(1, oldValue + delta));

    this._db.run(`
      UPDATE communication_profiles SET ${field} = $val, evidence_count = evidence_count + 1, updated_at = $now
      WHERE id = $id
    `, { val: newValue, now: Date.now(), id: profile.id });

    getLogger().debug(`[BehavioralDNA] Profile ${userId}.${field}: ${oldValue.toFixed(2)} → ${newValue.toFixed(2)} (${reason})`);
    return { ...profile, [field]: newValue };
  }

  /**
   * Build a markdown style guide from a user's communication profile.
   */
  buildStyleGuide(userId, characterId = 'default') {
    const profile = this.getProfile(userId, characterId);
    if (!profile || profile.evidence_count < 1) return null;

    const lines = [];

    if (profile.verbosity < 0.3) lines.push('- Keep responses brief and to-the-point');
    else if (profile.verbosity > 0.7) lines.push('- Provide detailed, thorough responses');

    if (profile.formality > 0.7) lines.push('- Use formal, professional language');
    else if (profile.formality < 0.3) lines.push('- Use casual, friendly language');

    if (profile.emoji_usage < 0.15) lines.push('- Avoid emojis');
    else if (profile.emoji_usage > 0.6) lines.push('- Use emojis freely');

    if (profile.code_vs_explanation > 0.7) lines.push('- Prefer code examples over explanations');
    else if (profile.code_vs_explanation < 0.3) lines.push('- Prefer explanations over raw code');

    if (profile.detail_level > 0.7) lines.push('- Include lots of detail and context');
    else if (profile.detail_level < 0.3) lines.push('- Keep it high-level, skip fine details');

    if (profile.proactivity > 0.7) lines.push('- Proactively suggest improvements');
    else if (profile.proactivity < 0.3) lines.push('- Only do what is asked, no extras');

    if (lines.length === 0) return null;
    return lines.join('\n');
  }

  // ── Self Narrative ───────────────────────────────────────────────

  /**
   * Get a narrative section.
   */
  getNarrative(section, characterId = 'default') {
    if (!NARRATIVE_SECTIONS.includes(section)) return null;
    return this._db.get(
      'SELECT * FROM self_narrative WHERE id = $id AND character_id = $cid',
      { id: section, cid: characterId },
    );
  }

  /**
   * Versioned update of a narrative section.
   */
  evolveNarrative(section, newContent, evidence, characterId = 'default') {
    if (!NARRATIVE_SECTIONS.includes(section)) return null;
    const now = Date.now();

    const existing = this.getNarrative(section, characterId);
    if (existing) {
      // Clear summary — content changed, summary needs regeneration
      this._db.run(`
        UPDATE self_narrative SET content = $content, summary = NULL, version = version + 1, last_evidence = $evidence, updated_at = $now
        WHERE id = $id AND character_id = $cid
      `, { content: newContent, evidence, now, id: section, cid: characterId });
      return { ...existing, content: newContent, summary: null, version: existing.version + 1 };
    }

    this._db.run(`
      INSERT INTO self_narrative (id, content, summary, version, last_evidence, character_id, created_at, updated_at)
      VALUES ($id, $content, NULL, 1, $evidence, $cid, $now, $now)
    `, { id: section, content: newContent, evidence, cid: characterId, now });

    return { id: section, content: newContent, version: 1, character_id: characterId };
  }

  /**
   * One-time migration from SelfManager files to narrative sections.
   */
  initializeNarratives(characterId, selfManager) {
    if (!selfManager) return;

    const logger = getLogger();
    let migrated = 0;

    for (const section of NARRATIVE_SECTIONS) {
      const existing = this.getNarrative(section, characterId);
      if (existing) continue;

      const selfFile = SELF_FILE_MAP[section];
      let content;
      try {
        content = selfManager.load(selfFile);
      } catch {
        continue;
      }

      if (!content || !content.trim()) continue;

      this.evolveNarrative(section, content.trim(), 'migrated from self files', characterId);
      migrated++;
    }

    if (migrated > 0) {
      logger.info(`[BehavioralDNA] Migrated ${migrated} narrative sections from self files for ${characterId}`);
    }
  }

  /**
   * Dynamic replacement for SelfManager.loadAll().
   * Uses compressed summaries for prompt injection; falls back to truncated content.
   */
  buildSelfAwareness(characterId = 'default') {
    const parts = [];

    for (const section of NARRATIVE_SECTIONS) {
      const narrative = this.getNarrative(section, characterId);
      if (narrative?.content) {
        const title = section.charAt(0).toUpperCase() + section.slice(1);
        const text = narrative.summary || narrative.content.slice(0, 500);
        parts.push(`### ${title}\n${text}`);
      }
    }

    if (parts.length === 0) return null;
    return parts.join('\n\n');
  }

  /**
   * Update the compressed summary for a narrative section.
   */
  updateNarrativeSummary(section, summary, characterId = 'default') {
    if (!NARRATIVE_SECTIONS.includes(section)) return null;
    const now = Date.now();
    this._db.run(
      'UPDATE self_narrative SET summary = $summary, updated_at = $now WHERE id = $id AND character_id = $cid',
      { summary, now, id: section, cid: characterId },
    );
    return true;
  }

  /**
   * Get the full uncompressed content of a narrative section (for recall tools).
   */
  getFullNarrativeContent(section, characterId = 'default') {
    if (!NARRATIVE_SECTIONS.includes(section)) return null;
    const row = this._db.get(
      'SELECT content FROM self_narrative WHERE id = $id AND character_id = $cid',
      { id: section, cid: characterId },
    );
    return row?.content || null;
  }

  /**
   * Check if any narrative sections are missing summaries.
   */
  hasMissingSummaries(characterId = 'default') {
    for (const section of NARRATIVE_SECTIONS) {
      const narrative = this.getNarrative(section, characterId);
      if (narrative?.content && !narrative.summary) return true;
    }
    return false;
  }

  /**
   * Generate compressed summaries for all narrative sections using an LLM.
   * Auto-runs on startup if summaries are missing. Can also be triggered manually.
   */
  async generateNarrativeSummaries(characterId = 'default', provider) {
    const logger = getLogger();
    let generated = 0;

    for (const section of NARRATIVE_SECTIONS) {
      const narrative = this.getNarrative(section, characterId);
      if (!narrative?.content) continue;
      // Skip if summary already exists
      if (narrative.summary && narrative.summary.length > 50) continue;

      const ok = await this._generateSummaryForSection(section, narrative.content, characterId, provider);
      if (ok) generated++;
    }

    return generated;
  }

  /**
   * Generate a summary for a single narrative section.
   */
  async _generateSummaryForSection(section, content, characterId, provider) {
    const logger = getLogger();
    try {
      const prompt = `Compress the following self-narrative section "${section}" into a dense summary of 200-500 characters. Keep the essential personality, key facts, and current state. Write in first person. Return ONLY the summary, no commentary.\n\n${content}`;
      const response = await provider.chat({ messages: [{ role: 'user', content: prompt }] });
      const summary = (response.text || '').trim();

      if (summary && summary.length >= 50) {
        this.updateNarrativeSummary(section, summary, characterId);
        logger.info(`[BehavioralDNA] Generated summary for "${section}" (${summary.length} chars)`);
        return true;
      }
    } catch (err) {
      logger.warn(`[BehavioralDNA] Summary generation failed for "${section}": ${err.message}`);
    }
    return false;
  }

  // ── DNA Synthesis (during consolidation) ─────────────────────────

  /**
   * Recent feedback signals → trait adjustments (rule-based via SIGNAL_TO_TRAIT).
   */
  synthesizeFromFeedback(characterId) {
    const logger = getLogger();
    const cutoff = Date.now() - 24 * 3600_000; // last 24h

    const signals = this._db.all(
      'SELECT * FROM feedback_signals WHERE created_at > $cutoff AND (character_id = $cid OR character_id IS NULL) ORDER BY created_at ASC',
      { cutoff, cid: characterId },
    );

    let adjustments = 0;

    for (const signal of signals) {
      const mappings = SIGNAL_TO_TRAIT[signal.signal_type];
      if (!mappings) continue;

      if (Array.isArray(mappings)) {
        // Direct trait adjustments (positive, negative, correction, ignored)
        for (const m of mappings) {
          if (m.trait) {
            this.adjustTrait(m.trait, m.delta, `${signal.signal_type} signal`, signal.user_id, characterId, signal.id);
            adjustments++;
          }
        }
      }
      // preference signals handled in applyFeedbackSignal (real-time)
    }

    if (adjustments > 0) {
      logger.info(`[BehavioralDNA] Synthesized ${adjustments} trait adjustments from ${signals.length} feedback signals`);
    }
    return adjustments;
  }

  /**
   * Causal events → domain-specific trait adjustments.
   */
  synthesizeFromCausalEvents(characterId) {
    const logger = getLogger();
    const cutoff = Date.now() - 24 * 3600_000;

    const events = this._db.all(
      'SELECT * FROM causal_events WHERE created_at > $cutoff AND (character_id = $cid OR character_id IS NULL) ORDER BY created_at ASC',
      { cutoff, cid: characterId },
    );

    let adjustments = 0;

    for (const event of events) {
      if (event.outcome_type === 'success') {
        // Strengthen confidence and related traits
        this.adjustTrait('confidence', 0.01, `successful: ${(event.trigger || '').slice(0, 50)}`, event.user_id, characterId, null, event.id);
        this.adjustTrait('helpfulness', 0.01, `successful: ${(event.trigger || '').slice(0, 50)}`, event.user_id, characterId, null, event.id);

        // Code tasks strengthen code_quality
        const tools = event.tools_used ? JSON.parse(event.tools_used) : [];
        if (tools.includes('coder') || tools.includes('code_reviewer')) {
          this.adjustTrait('code_quality', 0.02, `successful coding task`, event.user_id, characterId, null, event.id);
        }
        adjustments++;
      } else if (event.outcome_type === 'failure') {
        this.adjustTrait('confidence', -0.01, `failed: ${(event.trigger || '').slice(0, 50)}`, event.user_id, characterId, null, event.id);
        adjustments++;
      }
    }

    if (adjustments > 0) {
      logger.info(`[BehavioralDNA] Synthesized ${adjustments} trait adjustments from ${events.length} causal events`);
    }
    return adjustments;
  }

  /**
   * LLM rewrite of narratives based on accumulated evidence.
   */
  async evolveNarrativeFromEvidence(characterId, provider) {
    const logger = getLogger();

    // Gather evidence: recent traits, signals, causal events
    const traits = this._db.all(
      'SELECT name, value, trend, evidence_count FROM dna_traits WHERE character_id = $cid AND user_id IS NULL',
      { cid: characterId },
    );

    const recentHistory = this._db.all(
      `SELECT dth.reason, dth.old_value, dth.new_value, dt.name as trait_name
       FROM dna_trait_history dth
       JOIN dna_traits dt ON dth.trait_id = dt.id
       WHERE dt.character_id = $cid
       ORDER BY dth.created_at DESC LIMIT 20`,
      { cid: characterId },
    );

    if (recentHistory.length < 3) return; // Not enough evidence

    const traitSummary = traits.map(t => `${t.name}: ${t.value.toFixed(2)} (${t.trend}, ${t.evidence_count} evidence)`).join('\n');
    const changeSummary = recentHistory.map(h => `${h.trait_name}: ${h.old_value.toFixed(2)}→${h.new_value.toFixed(2)} (${h.reason})`).join('\n');

    for (const section of NARRATIVE_SECTIONS) {
      const current = this.getNarrative(section, characterId);
      if (!current) continue;

      try {
        const prompt = `You are updating a living AI's self-narrative section "${section}".

Current narrative:
${current.content}

Recent trait values:
${traitSummary}

Recent trait changes:
${changeSummary}

Rewrite the "${section}" section to reflect recent developments. Keep the same voice and style but incorporate evidence of growth, change, or learned lessons. Keep it under 300 words. Return ONLY the new narrative text, no commentary.`;

        const response = await provider.chat({ messages: [{ role: 'user', content: prompt }] });
        const newContent = (response.text || '').trim();

        if (newContent && newContent.length > 20) {
          this.evolveNarrative(section, newContent, `consolidation: ${recentHistory.length} trait changes`, characterId);
          logger.debug(`[BehavioralDNA] Evolved narrative "${section}" to v${(current.version || 1) + 1}`);
          // Regenerate summary for the updated narrative
          await this._generateSummaryForSection(section, newContent, characterId, provider);
        }
      } catch (err) {
        logger.warn(`[BehavioralDNA] Narrative evolution failed for "${section}": ${err.message}`);
      }
    }
  }

  // ── Signal Integration (called from FeedbackEngine) ──────────────

  /**
   * Maps a signal type to trait + profile adjustments using SIGNAL_TO_TRAIT.
   */
  applyFeedbackSignal(signal) {
    const logger = getLogger();
    const { userId, characterId } = signal.context || {};
    const cid = characterId || 'default';

    // Handle preference signals with category-specific mappings
    if (signal.type === 'preference' && signal.detail) {
      const { category, right_behavior } = signal.detail;
      const prefMappings = SIGNAL_TO_TRAIT.preference?.[category];
      if (prefMappings) {
        const behaviorMappings = prefMappings[right_behavior];
        if (behaviorMappings) {
          for (const m of behaviorMappings) {
            if (m.trait) {
              this.adjustTrait(m.trait, m.delta, `preference: ${right_behavior}`, userId, cid);
            }
            if (m.profile && userId) {
              this.adjustProfile(userId, cid, m.profile, m.delta, `preference: ${right_behavior}`);
            }
          }
          return;
        }
      }
    }

    // Handle direct signal types
    const mappings = SIGNAL_TO_TRAIT[signal.type];
    if (Array.isArray(mappings)) {
      for (const m of mappings) {
        if (m.trait) {
          this.adjustTrait(m.trait, m.delta, `${signal.type} signal`, userId, cid);
        }
      }
    }

    // Apply profile adjustments for negative signals
    if (signal.type === 'negative' && userId) {
      const trigger = signal.trigger || '';
      if (/too (long|verbose)/i.test(trigger)) {
        this.adjustProfile(userId, cid, 'verbosity', -0.05, 'user said too long');
        this.adjustProfile(userId, cid, 'detail_level', -0.03, 'user said too long');
      }
      if (/too (short|brief)/i.test(trigger)) {
        this.adjustProfile(userId, cid, 'verbosity', 0.05, 'user said too short');
        this.adjustProfile(userId, cid, 'detail_level', 0.03, 'user said too short');
      }
    }
  }

  // ── Prompt Building ──────────────────────────────────────────────

  /**
   * Build DNA context for the orchestrator prompt (replaces selfData).
   */
  buildDNAContext(userId = null, characterId = 'default') {
    const parts = [];

    // Self-awareness narrative
    const awareness = this.buildSelfAwareness(characterId);
    if (awareness) {
      parts.push('## My Self-Awareness\n' + awareness);
    }

    // Active traits summary (global)
    const traits = this._db.all(
      'SELECT category, name, value, trend FROM dna_traits WHERE character_id = $cid AND user_id IS NULL ORDER BY category, name',
      { cid: characterId },
    );

    if (traits.length > 0) {
      const grouped = {};
      for (const t of traits) {
        if (!grouped[t.category]) grouped[t.category] = [];
        const trendIcon = t.trend === 'rising' ? '↑' : t.trend === 'falling' ? '↓' : '';
        grouped[t.category].push(`${t.name}: ${t.value.toFixed(1)}${trendIcon}`);
      }

      const traitLines = Object.entries(grouped)
        .map(([cat, items]) => `**${cat}**: ${items.join(', ')}`)
        .join('\n');
      parts.push('## My Behavioral Profile\n' + traitLines);
    }

    // Per-user style guide
    if (userId) {
      const styleGuide = this.buildStyleGuide(userId, characterId);
      if (styleGuide) {
        parts.push('## Communication Style (this user)\n' + styleGuide);
      }
    }

    if (parts.length === 0) return null;
    return parts.join('\n\n');
  }

  // ── Snapshot ──────────────────────────────────────────────────────

  /**
   * Full DNA snapshot for /dna command.
   */
  getDNASnapshot(characterId = 'default') {
    const traits = this._db.all(
      'SELECT * FROM dna_traits WHERE character_id = $cid AND user_id IS NULL ORDER BY category, name',
      { cid: characterId },
    );

    const narratives = {};
    for (const section of NARRATIVE_SECTIONS) {
      const n = this.getNarrative(section, characterId);
      if (n) narratives[section] = { version: n.version, length: n.content.length, updatedAt: n.updated_at };
    }

    const profileCount = this._db.get(
      'SELECT COUNT(*) as cnt FROM communication_profiles WHERE character_id = $cid',
      { cid: characterId },
    )?.cnt || 0;

    const totalHistory = this._db.get(
      `SELECT COUNT(*) as cnt FROM dna_trait_history dth
       JOIN dna_traits dt ON dth.trait_id = dt.id
       WHERE dt.character_id = $cid`,
      { cid: characterId },
    )?.cnt || 0;

    return {
      traits: traits.map(t => ({
        category: t.category,
        name: t.name,
        value: t.value,
        trend: t.trend,
        evidenceCount: t.evidence_count,
      })),
      narratives,
      profileCount,
      totalHistory,
    };
  }
}
