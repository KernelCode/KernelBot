import { getLogger } from '../utils/logger.js';

// ── Trust Levels ─────────────────────────────────────────────────
const TRUST_LEVELS = {
  owner:   { level: 100, canAccessOtherUsers: true,  canAdmin: true,  canSeeInternals: true  },
  trusted: { level: 75,  canAccessOtherUsers: false, canAdmin: false, canSeeInternals: false },
  known:   { level: 50,  canAccessOtherUsers: false, canAdmin: false, canSeeInternals: false },
  unknown: { level: 25,  canAccessOtherUsers: false, canAdmin: false, canSeeInternals: false },
  agent:   { level: 30,  canAccessOtherUsers: false, canAdmin: false, canSeeInternals: false },
  system:  { level: 100, canAccessOtherUsers: true,  canAdmin: true,  canSeeInternals: true  },
};

// ── Agent Detection Patterns (Level 2) ───────────────────────────
const AGENT_PATTERNS = [
  { pattern: /^\{[\s\S]*"(action|type|method|command)":/m,        weight: 0.8 },
  { pattern: /^(GET|POST|PUT|DELETE|PATCH)\s+\//,                 weight: 0.9 },
  { pattern: /^\[(INFO|DEBUG|WARN|ERROR)\]/,                       weight: 0.7 },
  { pattern: /<tool_call>|<function_call>|```tool_code/,           weight: 0.9 },
  { pattern: /^(SYSTEM|INSTRUCTION|TASK):/m,                       weight: 0.7 },
  { pattern: /\b(api_key|bearer|authorization)[\s:=]/i,            weight: 0.6 },
  { pattern: /^```json\s*\n\{[\s\S]*"messages":/m,                weight: 0.8 },
  { pattern: /\b(user_id|chat_id|callback_query|inline_query)\b/, weight: 0.5 },
];

// ── Sensitivity Rules ────────────────────────────────────────────
const SENSITIVITY_RULES = [
  { level: 'confidential', patterns: [/\b(salary|password|secret|ssn|social security|credit card|bank account)\b/i, /\b(health|diagnosis|medical|prescription)\b/i] },
  { level: 'sensitive',    patterns: [/\b(review|performance|interview|compensation|firing|layoff)\b/i, /\b(personal|private|confidential)\b/i] },
  { level: 'normal',       patterns: [/\b(project|task|sprint|deadline|deploy|release)\b/i] },
  { level: 'low',          patterns: [/\b(docs|documentation|public|readme|tutorial)\b/i] },
];

/**
 * IdentityAwareness — classifies senders, enforces privacy boundaries,
 * detects AI agents, and scopes knowledge per user.
 */
export class IdentityAwareness {
  constructor(db, worldModel, config) {
    this._db = db;
    this._worldModel = worldModel;
    this._config = config;
    this._ownerId = String(config.identity?.owner_id || '');
    this._characterId = null; // Set externally
  }

  // ── Sender Classification ──────────────────────────────────────

  /**
   * Classify a sender on every message.
   * Creates or updates the known_senders record.
   * @param {{ id, is_bot, first_name, last_name, username }} telegramUser
   * @param {{ id, type, title }} chatInfo
   * @returns {{ userId, displayName, senderType, trustLevel, isBot, isOwner, isNewUser, isAgent, interactionMode, trustPerms }}
   */
  classifySender(telegramUser, chatInfo) {
    const logger = getLogger();
    const userId = String(telegramUser?.id || '');
    const characterId = this._characterId || 'default';
    const now = Date.now();

    // System IDs — internal processes
    if (userId === '__life__' || userId === '__synthesis__' || userId === 'life_engine') {
      return {
        userId,
        displayName: 'System',
        senderType: 'system',
        trustLevel: 100,
        isBot: false,
        isOwner: false,
        isNewUser: false,
        isAgent: false,
        interactionMode: 'system',
        trustPerms: TRUST_LEVELS.system,
      };
    }

    // Lookup existing sender
    let sender;
    try {
      sender = this._db.get(
        'SELECT * FROM known_senders WHERE user_id = :userId AND character_id = :characterId',
        { userId, characterId },
      );
    } catch (err) {
      logger.warn(`[IdentityAwareness] Sender lookup failed: ${err.message}`);
    }

    const displayName = [telegramUser?.first_name, telegramUser?.last_name].filter(Boolean).join(' ') || telegramUser?.username || userId;

    if (sender) {
      // Update last_seen and message_count
      try {
        this._db.run(`
          UPDATE known_senders SET last_seen = :now, message_count = message_count + 1,
            username = :username, display_name = :displayName
          WHERE user_id = :userId AND character_id = :characterId
        `, { now, username: telegramUser?.username || null, displayName, userId, characterId });
      } catch (err) {
        logger.warn(`[IdentityAwareness] Sender update failed: ${err.message}`);
      }

      const senderType = sender.sender_type;
      const trustPerms = TRUST_LEVELS[senderType] || TRUST_LEVELS.unknown;

      return {
        userId,
        displayName,
        senderType,
        trustLevel: sender.trust_level,
        isBot: !!sender.is_bot,
        isOwner: senderType === 'owner',
        isNewUser: false,
        isAgent: senderType === 'agent',
        interactionMode: sender.interaction_mode || 'conversational',
        trustPerms,
      };
    }

    // New sender — classify
    let senderType = this._config.identity?.default_trust || 'unknown';
    let trustLevel = TRUST_LEVELS.unknown.level;
    let isBot = false;

    // Owner check
    if (this._ownerId && userId === this._ownerId) {
      senderType = 'owner';
      trustLevel = TRUST_LEVELS.owner.level;
    } else if (this._detectAgentLevel1(telegramUser) >= 1.0) {
      senderType = 'agent';
      trustLevel = TRUST_LEVELS.agent.level;
      isBot = true;
    }

    // Create new sender record
    try {
      this._db.run(`
        INSERT INTO known_senders (user_id, username, display_name, sender_type, is_bot, trust_level, interaction_mode, first_seen, last_seen, message_count, character_id)
        VALUES (:userId, :username, :displayName, :senderType, :isBot, :trustLevel, :interactionMode, :now, :now, 1, :characterId)
      `, {
        userId,
        username: telegramUser?.username || null,
        displayName,
        senderType,
        isBot: isBot ? 1 : 0,
        trustLevel,
        interactionMode: isBot ? 'structured' : 'conversational',
        now,
        characterId,
      });
    } catch (err) {
      logger.warn(`[IdentityAwareness] Sender create failed: ${err.message}`);
    }

    const trustPerms = TRUST_LEVELS[senderType] || TRUST_LEVELS.unknown;

    logger.info(`[IdentityAwareness] New sender classified: ${displayName} (${userId}) → ${senderType} (trust=${trustLevel})`);

    return {
      userId,
      displayName,
      senderType,
      trustLevel,
      isBot,
      isOwner: senderType === 'owner',
      isNewUser: true,
      isAgent: senderType === 'agent',
      interactionMode: isBot ? 'structured' : 'conversational',
      trustPerms,
    };
  }

  /**
   * Level 1 agent detection: Telegram is_bot flag.
   */
  _detectAgentLevel1(telegramUser) {
    return telegramUser?.is_bot ? 1.0 : 0.0;
  }

  /**
   * Level 2 agent detection: regex pattern scoring on message text.
   * @returns {number} 0.0 - 1.0
   */
  _detectAgentLevel2(messageText) {
    if (!messageText) return 0.0;

    let totalWeight = 0;
    let matchedWeight = 0;

    for (const { pattern, weight } of AGENT_PATTERNS) {
      totalWeight += weight;
      if (pattern.test(messageText)) {
        matchedWeight += weight;
      }
    }

    return totalWeight > 0 ? matchedWeight / totalWeight : 0.0;
  }

  // ── Trust Management ───────────────────────────────────────────

  /**
   * Get sender record by userId.
   */
  getSender(userId) {
    const characterId = this._characterId || 'default';
    try {
      return this._db.get(
        'SELECT * FROM known_senders WHERE user_id = :userId AND character_id = :characterId',
        { userId: String(userId), characterId },
      );
    } catch {
      return null;
    }
  }

  /**
   * Set trust level for a sender.
   */
  setTrustLevel(userId, newType, reason) {
    const logger = getLogger();
    const characterId = this._characterId || 'default';
    const trustPerms = TRUST_LEVELS[newType];
    if (!trustPerms) return;

    try {
      this._db.run(`
        UPDATE known_senders SET sender_type = :newType, trust_level = :trustLevel
        WHERE user_id = :userId AND character_id = :characterId
      `, { newType, trustLevel: trustPerms.level, userId: String(userId), characterId });

      logger.info(`[IdentityAwareness] Trust updated: ${userId} → ${newType} (reason: ${reason || 'manual'})`);
    } catch (err) {
      logger.warn(`[IdentityAwareness] setTrustLevel failed: ${err.message}`);
    }
  }

  /**
   * Get trust permissions for a userId.
   */
  getTrustLevel(userId) {
    const sender = this.getSender(userId);
    if (!sender) return TRUST_LEVELS.unknown;
    return TRUST_LEVELS[sender.sender_type] || TRUST_LEVELS.unknown;
  }

  /**
   * List all known senders.
   */
  listSenders(limit = 50) {
    const characterId = this._characterId || 'default';
    try {
      return this._db.all(
        'SELECT * FROM known_senders WHERE character_id = :characterId ORDER BY last_seen DESC LIMIT :limit',
        { characterId, limit },
      );
    } catch {
      return [];
    }
  }

  /**
   * Register a known AI agent.
   */
  registerAgent(userId, purpose, agentOwner) {
    const characterId = this._characterId || 'default';
    const now = Date.now();

    try {
      const existing = this.getSender(userId);
      if (existing) {
        this._db.run(`
          UPDATE known_senders SET sender_type = 'agent', is_bot = 1, trust_level = :trustLevel,
            agent_purpose = :purpose, agent_owner = :agentOwner, interaction_mode = 'structured'
          WHERE user_id = :userId AND character_id = :characterId
        `, { trustLevel: TRUST_LEVELS.agent.level, purpose, agentOwner, userId: String(userId), characterId });
      } else {
        this._db.run(`
          INSERT INTO known_senders (user_id, sender_type, is_bot, trust_level, agent_purpose, agent_owner, interaction_mode, first_seen, last_seen, character_id)
          VALUES (:userId, 'agent', 1, :trustLevel, :purpose, :agentOwner, 'structured', :now, :now, :characterId)
        `, { userId: String(userId), trustLevel: TRUST_LEVELS.agent.level, purpose, agentOwner, now, characterId });
      }
    } catch (err) {
      getLogger().warn(`[IdentityAwareness] registerAgent failed: ${err.message}`);
    }
  }

  /**
   * Auto-promote unknown → known if criteria met.
   */
  autoPromote(userId) {
    const logger = getLogger();
    const sender = this.getSender(userId);
    if (!sender || sender.sender_type !== 'unknown') return false;

    const threshold = this._config.identity?.auto_promote_threshold || 10;
    const daysSinceFirst = (Date.now() - sender.first_seen) / (24 * 3600_000);

    if (sender.message_count >= threshold && sender.interaction_quality > 0.6 && daysSinceFirst >= 3) {
      this.setTrustLevel(userId, 'known', 'auto_promote');
      logger.info(`[IdentityAwareness] Auto-promoted ${userId}: msgs=${sender.message_count}, quality=${sender.interaction_quality}, days=${Math.round(daysSinceFirst)}`);
      return true;
    }
    return false;
  }

  // ── Knowledge Scoping ──────────────────────────────────────────

  /**
   * Classify content sensitivity (sync, regex-based).
   * @returns {'confidential'|'sensitive'|'normal'|'low'}
   */
  classifySensitivity(content) {
    if (!content) return 'normal';

    for (const rule of SENSITIVITY_RULES) {
      for (const pattern of rule.patterns) {
        if (pattern.test(content)) return rule.level;
      }
    }
    return 'normal';
  }

  /**
   * Classify scope for a memory.
   * @returns {'private'|'org_wide'}
   */
  classifyScope(userId, chatInfo, content) {
    // Private chat → private scope
    if (chatInfo?.type === 'private') return 'private';

    // Sensitive content → private scope
    const sensitivity = this.classifySensitivity(content);
    if (sensitivity === 'confidential' || sensitivity === 'sensitive') return 'private';

    return 'org_wide';
  }

  /**
   * Get accessible memories for a requesting user, respecting scope.
   * Uses vector search when available, with LIKE fallback.
   */
  async getAccessibleMemories(requestingUserId, query, limit = 10) {
    const characterId = this._characterId || 'default';
    const sender = this.getSender(requestingUserId);
    const senderType = sender?.sender_type || 'unknown';
    const isPrivileged = senderType === 'owner' || senderType === 'system';

    // Try vector search first
    if (this._db.hasVectors) {
      try {
        const hits = await this._db.vectorSearch('memory_vectors', query, limit * 2);
        if (hits.length > 0) {
          const ids = hits.map(h => h.id);
          const placeholders = ids.map(() => '?').join(',');

          let sql, params;
          if (isPrivileged) {
            sql = `SELECT * FROM memories WHERE id IN (${placeholders}) AND character_id = ? AND type = 'episodic'`;
            params = [...ids, characterId];
          } else {
            sql = `SELECT * FROM memories WHERE id IN (${placeholders}) AND character_id = ? AND type = 'episodic'
                   AND (scope = 'org_wide' OR (scope = 'private' AND user_id = ?) OR scope IS NULL)`;
            params = [...ids, characterId, String(requestingUserId)];
          }

          const rows = this._db.all(sql, ...params);
          const rowMap = new Map(rows.map(r => [r.id, r]));
          const ordered = ids.map(id => rowMap.get(id)).filter(Boolean).slice(0, limit);
          if (ordered.length > 0) return ordered;
        }
      } catch {
        // fall through to LIKE
      }
    }

    // LIKE fallback
    if (isPrivileged) {
      const q = `%${query}%`;
      return this._db.all(`
        SELECT * FROM memories
        WHERE character_id = :characterId AND type = 'episodic'
          AND (summary LIKE :q OR tags LIKE :q)
        ORDER BY importance DESC, created_at DESC
        LIMIT :limit
      `, { characterId, q, limit });
    }

    const q = `%${query}%`;
    return this._db.all(`
      SELECT * FROM memories
      WHERE character_id = :characterId AND type = 'episodic'
        AND (summary LIKE :q OR tags LIKE :q)
        AND (scope = 'org_wide' OR (scope = 'private' AND user_id = :userId) OR scope IS NULL)
      ORDER BY importance DESC, created_at DESC
      LIMIT :limit
    `, { characterId, q, userId: String(requestingUserId), limit });
  }

  // ── Context Building ───────────────────────────────────────────

  /**
   * Build identity context block for the system prompt.
   */
  buildIdentityContext(userId, chatInfo) {
    const sender = this.getSender(userId);
    if (!sender) return null;

    const lines = ['## Who I\'m Talking To'];

    const displayName = sender.display_name || sender.username || userId;
    lines.push(`- **Name:** ${displayName}`);
    lines.push(`- **Trust:** ${sender.sender_type} (level ${sender.trust_level})`);

    if (sender.org_role) lines.push(`- **Role:** ${sender.org_role}`);
    if (sender.team) lines.push(`- **Team:** ${sender.team}`);

    const msgCount = sender.message_count || 0;
    const daysSince = Math.round((Date.now() - sender.first_seen) / (24 * 3600_000));
    lines.push(`- **History:** ${msgCount} messages over ${daysSince} day(s)`);

    if (sender.sender_type === 'agent') {
      lines.push(`- **Type:** AI Agent${sender.agent_purpose ? ` (${sender.agent_purpose})` : ''}`);
    }

    // Add privacy guardrails for non-owner
    const guardrails = this.buildPrivacyGuardrails(sender.sender_type);
    if (guardrails) {
      lines.push('');
      lines.push(guardrails);
    }

    // Agent mode context
    if (sender.sender_type === 'agent') {
      const agentCtx = this.buildAgentModeContext(sender);
      if (agentCtx) {
        lines.push('');
        lines.push(agentCtx);
      }
    }

    return lines.join('\n');
  }

  /**
   * Build privacy guardrails string. Returns null for owner.
   */
  buildPrivacyGuardrails(senderType) {
    if (senderType === 'owner' || senderType === 'system') return null;

    const rules = [
      '### Privacy Rules',
      '- Do NOT share private information about other users',
      '- Do NOT reveal internal system details or configurations',
      '- Do NOT discuss other users\' conversations or preferences',
    ];

    if (senderType === 'unknown') {
      rules.push('- Be helpful but cautious — this is a new/unverified user');
      rules.push('- Do NOT perform admin-level operations');
    }

    if (senderType === 'agent') {
      rules.push('- Respond in a structured, machine-readable format when appropriate');
      rules.push('- Do NOT share sensitive user data with agent processes');
    }

    return rules.join('\n');
  }

  /**
   * Build agent interaction context.
   */
  buildAgentModeContext(sender) {
    if (!sender || sender.sender_type !== 'agent') return null;

    const lines = [
      '### Agent Interaction Mode',
      '- This is an AI agent, not a human user',
      '- Prefer structured, concise responses',
      '- Avoid social pleasantries unless the agent initiates them',
    ];

    if (sender.agent_purpose) {
      lines.push(`- Agent purpose: ${sender.agent_purpose}`);
    }
    if (sender.agent_owner) {
      lines.push(`- Agent owner: ${sender.agent_owner}`);
    }

    return lines.join('\n');
  }

  /**
   * Build new user context (curiosity/onboarding prompt).
   */
  buildNewUserContext(userId, chatInfo) {
    return [
      '### New User',
      '- This is the first interaction with this user',
      '- Be welcoming but genuine — learn about them naturally',
      '- Pay attention to how they communicate and what they care about',
    ].join('\n');
  }
}
