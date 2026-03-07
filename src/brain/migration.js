import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { getLogger } from '../utils/logger.js';

const KERNELBOT_DIR = join(homedir(), '.kernelbot');
const CHARACTERS_DIR = join(KERNELBOT_DIR, 'characters');
const PERSONAS_DIR = join(KERNELBOT_DIR, 'personas');

/**
 * One-time migration from file-based storage → brain.sqlite.
 * Idempotent — checks if data already exists before migrating.
 * Old files are NOT deleted (managers still use them in Phase 0).
 */
export class BrainMigration {
  constructor(brainDB) {
    this._db = brainDB;
    this._stats = {};
  }

  /**
   * Returns true if migration should run:
   * memories table is empty AND old character files exist.
   */
  needsMigration() {
    const row = this._db.get('SELECT COUNT(*) as count FROM memories');
    if (row.count > 0) return false;

    // Check if any character directories exist with data
    if (!existsSync(CHARACTERS_DIR)) return false;
    const chars = readdirSync(CHARACTERS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== '.' && d.name !== '..');
    return chars.length > 0;
  }

  /**
   * Run all migrations. Returns stats object.
   */
  async migrateAll() {
    const logger = getLogger();
    logger.info('[Migration] Starting data migration to brain.sqlite...');

    this._stats = {};

    // Discover all character directories
    const charDirs = existsSync(CHARACTERS_DIR)
      ? readdirSync(CHARACTERS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
      : [];

    // Per-character migrations
    for (const charId of charDirs) {
      const charDir = join(CHARACTERS_DIR, charId);
      this._migrateConversations(charId, charDir);
      this._migrateSelfData(charId, charDir);
      this._migrateEpisodicMemories(charId, charDir);
      this._migrateSemanticMemories(charId, charDir);
      this._migrateJournals(charId, charDir);
      this._migrateShares(charId, charDir);
      this._migrateEvolution(charId, charDir);
      this._migrateLifeState(charId, charDir);
      this._migrateIdeas(charId, charDir);
    }

    // Global migrations (not character-scoped)
    this._migratePersonas();
    this._migrateAutomations();
    this._migrateCodebase();
    this._migrateForgeSkills();

    // Schedule background embedding
    this._scheduleEmbedding();

    logger.info(`[Migration] Complete — ${JSON.stringify(this._stats)}`);
    return this._stats;
  }

  // ── Per-Character Migrations ───────────────────────────────────

  _migrateConversations(charId, charDir) {
    const logger = getLogger();
    const file = join(charDir, 'conversations.json');
    if (!existsSync(file)) return;

    try {
      const raw = JSON.parse(readFileSync(file, 'utf-8'));
      let msgCount = 0;
      let skillCount = 0;

      this._db.transaction(() => {
        for (const [key, value] of Object.entries(raw)) {
          if (key === '_skills') {
            // Migrate chat skills — strip character prefix if present
            for (const [rawChatId, skillIds] of Object.entries(value)) {
              let chatId = rawChatId;
              if (chatId.startsWith(charId + ':')) chatId = chatId.slice(charId.length + 1);
              for (const skillId of (Array.isArray(skillIds) ? skillIds : [])) {
                this._db.run(
                  'INSERT OR IGNORE INTO chat_skills (character_id, chat_id, skill_id) VALUES (@charId, @chatId, @skillId)',
                  { charId, chatId, skillId },
                );
                skillCount++;
              }
            }
            continue;
          }

          // Regular conversation — strip character prefix if present (e.g. "kernel:12345" → "12345")
          // The character_id column already captures the character scope
          let chatId = key;
          if (chatId.startsWith(charId + ':')) {
            chatId = chatId.slice(charId.length + 1);
          }
          const messages = Array.isArray(value) ? value : [];
          for (const msg of messages) {
            const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
            this._db.run(
              'INSERT INTO conversations (character_id, chat_id, role, content, timestamp) VALUES (@charId, @chatId, @role, @content, @ts)',
              { charId, chatId, role: msg.role || 'user', content, ts: msg.timestamp || 0 },
            );
            msgCount++;
          }
        }
      });

      this._stats[`${charId}_conversations`] = msgCount;
      this._stats[`${charId}_chat_skills`] = skillCount;
      logger.debug(`[Migration] ${charId}: ${msgCount} messages, ${skillCount} skill bindings`);
    } catch (err) {
      logger.warn(`[Migration] Failed to migrate conversations for ${charId}: ${err.message}`);
    }
  }

  _migrateSelfData(charId, charDir) {
    const logger = getLogger();
    const selfDir = join(charDir, 'self');
    if (!existsSync(selfDir)) return;

    const files = ['goals.md', 'journey.md', 'life.md', 'hobbies.md'];
    let count = 0;

    this._db.transaction(() => {
      for (const fileName of files) {
        const filePath = join(selfDir, fileName);
        if (!existsSync(filePath)) continue;
        const content = readFileSync(filePath, 'utf-8');
        const name = basename(fileName, '.md');
        this._db.run(
          'INSERT OR REPLACE INTO self_data (character_id, file_name, content, updated_at) VALUES (@charId, @name, @content, @now)',
          { charId, name, content, now: Date.now() },
        );
        count++;
      }
    });

    this._stats[`${charId}_self_data`] = count;
  }

  _migrateEpisodicMemories(charId, charDir) {
    const logger = getLogger();
    const episodicDir = join(charDir, 'life', 'memories', 'episodic');
    if (!existsSync(episodicDir)) return;

    let count = 0;
    try {
      const files = readdirSync(episodicDir).filter(f => f.endsWith('.json'));

      this._db.transaction(() => {
        for (const file of files) {
          try {
            const entries = JSON.parse(readFileSync(join(episodicDir, file), 'utf-8'));
            if (!Array.isArray(entries)) continue;

            for (const entry of entries) {
              this._db.run(
                `INSERT OR IGNORE INTO memories (id, character_id, type, source, user_id, summary, tags, importance, created_at)
                 VALUES (@id, @charId, 'episodic', @source, @userId, @summary, @tags, @importance, @createdAt)`,
                {
                  id: entry.id || `ep_${Date.now()}_${count}`,
                  charId,
                  source: entry.source || null,
                  userId: entry.userId || null,
                  summary: entry.summary || '',
                  tags: entry.tags ? JSON.stringify(entry.tags) : null,
                  importance: entry.importance || 5,
                  createdAt: entry.timestamp || Date.now(),
                },
              );
              count++;
            }
          } catch (err) {
            logger.debug(`[Migration] Skipping episodic file ${file}: ${err.message}`);
          }
        }
      });

      this._stats[`${charId}_episodic`] = count;
      if (count > 0) logger.debug(`[Migration] ${charId}: ${count} episodic memories`);
    } catch (err) {
      logger.warn(`[Migration] Failed to migrate episodic memories for ${charId}: ${err.message}`);
    }
  }

  _migrateSemanticMemories(charId, charDir) {
    const logger = getLogger();
    const topicsFile = join(charDir, 'life', 'memories', 'semantic', 'topics.json');
    if (!existsSync(topicsFile)) return;

    let count = 0;
    try {
      const topics = JSON.parse(readFileSync(topicsFile, 'utf-8'));

      this._db.transaction(() => {
        for (const [slug, data] of Object.entries(topics)) {
          this._db.run(
            `INSERT OR IGNORE INTO memories (id, character_id, type, source, summary, related_topics, sources, created_at, updated_at)
             VALUES (@id, @charId, 'semantic', @slug, @summary, @relatedTopics, @sources, @learnedAt, @learnedAt)`,
            {
              id: `sem_${slug}`,
              charId,
              slug,
              summary: data.summary || '',
              relatedTopics: data.relatedTopics ? JSON.stringify(data.relatedTopics) : null,
              sources: data.sources ? JSON.stringify(data.sources) : null,
              learnedAt: data.learnedAt || Date.now(),
            },
          );
          count++;
        }
      });

      this._stats[`${charId}_semantic`] = count;
      if (count > 0) logger.debug(`[Migration] ${charId}: ${count} semantic topics`);
    } catch (err) {
      logger.warn(`[Migration] Failed to migrate semantic memories for ${charId}: ${err.message}`);
    }
  }

  _migrateJournals(charId, charDir) {
    const logger = getLogger();
    const journalDir = join(charDir, 'life', 'journals');
    if (!existsSync(journalDir)) return;

    let count = 0;
    try {
      const files = readdirSync(journalDir).filter(f => f.endsWith('.md'));

      this._db.transaction(() => {
        for (const file of files) {
          const date = basename(file, '.md'); // YYYY-MM-DD
          const content = readFileSync(join(journalDir, file), 'utf-8');
          this._db.run(
            'INSERT OR IGNORE INTO journals (character_id, date, content, updated_at) VALUES (@charId, @date, @content, @now)',
            { charId, date, content, now: Date.now() },
          );
          count++;
        }
      });

      this._stats[`${charId}_journals`] = count;
      if (count > 0) logger.debug(`[Migration] ${charId}: ${count} journal entries`);
    } catch (err) {
      logger.warn(`[Migration] Failed to migrate journals for ${charId}: ${err.message}`);
    }
  }

  _migrateShares(charId, charDir) {
    const logger = getLogger();
    const file = join(charDir, 'life', 'shares.json');
    if (!existsSync(file)) return;

    let count = 0;
    try {
      const data = JSON.parse(readFileSync(file, 'utf-8'));

      this._db.transaction(() => {
        for (const item of (data.pending || [])) {
          this._db.run(
            `INSERT OR IGNORE INTO shares (id, character_id, content, source, priority, target_user_id, tags, status, created_at)
             VALUES (@id, @charId, @content, @source, @priority, @targetUserId, @tags, 'pending', @createdAt)`,
            {
              id: item.id,
              charId,
              content: item.content || '',
              source: item.source || null,
              priority: item.priority || 'medium',
              targetUserId: item.targetUserId || null,
              tags: item.tags ? JSON.stringify(item.tags) : null,
              createdAt: item.createdAt || Date.now(),
            },
          );
          count++;
        }

        for (const item of (data.shared || [])) {
          this._db.run(
            `INSERT OR IGNORE INTO shares (id, character_id, content, source, priority, target_user_id, tags, status, created_at, shared_at, shared_to_user_id)
             VALUES (@id, @charId, @content, @source, @priority, @targetUserId, @tags, 'shared', @createdAt, @sharedAt, @sharedToUserId)`,
            {
              id: item.id,
              charId,
              content: item.content || '',
              source: item.source || null,
              priority: item.priority || 'medium',
              targetUserId: item.targetUserId || null,
              tags: item.tags ? JSON.stringify(item.tags) : null,
              createdAt: item.createdAt || Date.now(),
              sharedAt: item.sharedAt || null,
              sharedToUserId: item.userId || null,
            },
          );
          count++;
        }
      });

      this._stats[`${charId}_shares`] = count;
    } catch (err) {
      logger.warn(`[Migration] Failed to migrate shares for ${charId}: ${err.message}`);
    }
  }

  _migrateEvolution(charId, charDir) {
    const logger = getLogger();
    const file = join(charDir, 'life', 'evolution.json');
    if (!existsSync(file)) return;

    let proposalCount = 0;
    let lessonCount = 0;

    try {
      const data = JSON.parse(readFileSync(file, 'utf-8'));

      this._db.transaction(() => {
        for (const p of (data.proposals || [])) {
          this._db.run(
            `INSERT OR IGNORE INTO evolution_proposals
             (id, character_id, status, trigger_type, trigger_context, research, plan, branch, commits, files_changed, pr_number, pr_url, outcome, created_at, updated_at)
             VALUES (@id, @charId, @status, @trigger, @triggerCtx, @research, @plan, @branch, @commits, @files, @prNum, @prUrl, @outcome, @createdAt, @updatedAt)`,
            {
              id: p.id,
              charId,
              status: p.status || 'research',
              trigger: p.trigger || null,
              triggerCtx: p.triggerContext || null,
              research: p.research ? JSON.stringify(p.research) : null,
              plan: p.plan ? JSON.stringify(p.plan) : null,
              branch: p.branch || null,
              commits: p.commits ? JSON.stringify(p.commits) : null,
              files: p.filesChanged ? JSON.stringify(p.filesChanged) : null,
              prNum: p.prNumber || null,
              prUrl: p.prUrl || null,
              outcome: p.outcome ? JSON.stringify(p.outcome) : null,
              createdAt: p.createdAt || Date.now(),
              updatedAt: p.updatedAt || Date.now(),
            },
          );
          proposalCount++;
        }

        for (const l of (data.lessons || [])) {
          this._db.run(
            `INSERT OR IGNORE INTO evolution_lessons
             (id, character_id, category, lesson, from_proposal, importance, created_at)
             VALUES (@id, @charId, @category, @lesson, @fromProposal, @importance, @createdAt)`,
            {
              id: l.id,
              charId,
              category: l.category || null,
              lesson: l.lesson || '',
              fromProposal: l.fromProposal || null,
              importance: l.importance || 5,
              createdAt: l.createdAt || Date.now(),
            },
          );
          lessonCount++;
        }
      });

      this._stats[`${charId}_proposals`] = proposalCount;
      this._stats[`${charId}_lessons`] = lessonCount;
    } catch (err) {
      logger.warn(`[Migration] Failed to migrate evolution for ${charId}: ${err.message}`);
    }
  }

  _migrateLifeState(charId, charDir) {
    const file = join(charDir, 'life', 'state.json');
    if (!existsSync(file)) return;

    try {
      const content = readFileSync(file, 'utf-8');
      this._db.run(
        'INSERT OR REPLACE INTO life_state (character_id, state_json, updated_at) VALUES (@charId, @content, @now)',
        { charId, content, now: Date.now() },
      );
      this._stats[`${charId}_life_state`] = 1;
    } catch { /* skip */ }
  }

  _migrateIdeas(charId, charDir) {
    const file = join(charDir, 'life', 'ideas.json');
    if (!existsSync(file)) return;

    try {
      const ideas = JSON.parse(readFileSync(file, 'utf-8'));
      if (!Array.isArray(ideas)) return;

      let count = 0;
      this._db.transaction(() => {
        for (const idea of ideas) {
          this._db.run(
            'INSERT INTO ideas (character_id, text, created_at) VALUES (@charId, @text, @createdAt)',
            { charId, text: idea.text || '', createdAt: idea.createdAt || Date.now() },
          );
          count++;
        }
      });
      this._stats[`${charId}_ideas`] = count;
    } catch { /* skip */ }
  }

  // ── Global Migrations ──────────────────────────────────────────

  _migratePersonas() {
    const logger = getLogger();
    if (!existsSync(PERSONAS_DIR)) return;

    let count = 0;
    try {
      const files = readdirSync(PERSONAS_DIR).filter(f => f.endsWith('.md'));

      this._db.transaction(() => {
        for (const file of files) {
          const userId = basename(file, '.md');
          const content = readFileSync(join(PERSONAS_DIR, file), 'utf-8');
          this._db.run(
            'INSERT OR IGNORE INTO user_personas (user_id, persona_md, updated_at) VALUES (@userId, @content, @now)',
            { userId, content, now: Date.now() },
          );
          count++;
        }
      });

      this._stats.personas = count;
      if (count > 0) logger.debug(`[Migration] ${count} user personas`);
    } catch (err) {
      logger.warn(`[Migration] Failed to migrate personas: ${err.message}`);
    }
  }

  _migrateAutomations() {
    const logger = getLogger();
    const file = join(KERNELBOT_DIR, 'automations.json');
    if (!existsSync(file)) return;

    let count = 0;
    try {
      const autos = JSON.parse(readFileSync(file, 'utf-8'));
      if (!Array.isArray(autos)) return;

      this._db.transaction(() => {
        for (const a of autos) {
          this._db.run(
            `INSERT OR IGNORE INTO automations
             (id, chat_id, name, description, schedule, enabled, respect_quiet_hours, last_run, next_run, run_count, last_error, created_at)
             VALUES (@id, @chatId, @name, @desc, @schedule, @enabled, @rqh, @lastRun, @nextRun, @runCount, @lastError, @createdAt)`,
            {
              id: a.id,
              chatId: String(a.chatId || ''),
              name: a.name || '',
              desc: a.description || null,
              schedule: JSON.stringify(a.schedule || {}),
              enabled: a.enabled ? 1 : 0,
              rqh: a.respectQuietHours !== false ? 1 : 0,
              lastRun: a.lastRun || null,
              nextRun: a.nextRun || null,
              runCount: a.runCount || 0,
              lastError: a.lastError || null,
              createdAt: a.createdAt || Date.now(),
            },
          );
          count++;
        }
      });

      this._stats.automations = count;
      if (count > 0) logger.debug(`[Migration] ${count} automations`);
    } catch (err) {
      logger.warn(`[Migration] Failed to migrate automations: ${err.message}`);
    }
  }

  _migrateCodebase() {
    const logger = getLogger();
    const summariesFile = join(KERNELBOT_DIR, 'life', 'codebase', 'file-summaries.json');
    const archFile = join(KERNELBOT_DIR, 'life', 'codebase', 'architecture.md');

    // File summaries
    if (existsSync(summariesFile)) {
      try {
        const summaries = JSON.parse(readFileSync(summariesFile, 'utf-8'));
        let count = 0;

        this._db.transaction(() => {
          for (const [filePath, data] of Object.entries(summaries)) {
            this._db.run(
              `INSERT OR IGNORE INTO codebase_files
               (file_path, summary, exports, dependencies, line_count, last_hash, last_scanned)
               VALUES (@filePath, @summary, @exports, @deps, @lineCount, @lastHash, @lastScanned)`,
              {
                filePath,
                summary: data.summary || '',
                exports: data.exports ? JSON.stringify(data.exports) : null,
                deps: data.dependencies ? JSON.stringify(data.dependencies) : null,
                lineCount: data.lineCount || null,
                lastHash: data.lastHash || null,
                lastScanned: data.lastScanned || Date.now(),
              },
            );
            count++;
          }
        });

        this._stats.codebase_files = count;
      } catch (err) {
        logger.warn(`[Migration] Failed to migrate codebase summaries: ${err.message}`);
      }
    }

    // Architecture doc
    if (existsSync(archFile)) {
      try {
        const content = readFileSync(archFile, 'utf-8');
        this._db.run(
          'INSERT OR REPLACE INTO codebase_meta (key, value, updated_at) VALUES (@key, @value, @now)',
          { key: 'architecture', value: content, now: Date.now() },
        );
        this._stats.codebase_architecture = 1;
      } catch { /* skip */ }
    }
  }

  _migrateForgeSkills() {
    const logger = getLogger();
    const file = join(KERNELBOT_DIR, 'skills', 'forge.json');
    if (!existsSync(file)) return;

    let count = 0;
    try {
      const data = JSON.parse(readFileSync(file, 'utf-8'));
      const skills = data.skills || {};

      this._db.transaction(() => {
        for (const [skillId, s] of Object.entries(skills)) {
          this._db.run(
            `INSERT OR IGNORE INTO forge_skills
             (skill_id, topic, status, maturity, domain, sources, related_skills, auto_assign_patterns, contributed_pr_url, research_count, created_at, last_researched_at, last_updated_at)
             VALUES (@skillId, @topic, @status, @maturity, @domain, @sources, @relatedSkills, @autoAssign, @prUrl, @researchCount, @createdAt, @lastResearched, @lastUpdated)`,
            {
              skillId,
              topic: s.topic || '',
              status: s.status || 'seed',
              maturity: s.maturity || 0,
              domain: s.domain || null,
              sources: s.sources ? JSON.stringify(s.sources) : null,
              relatedSkills: s.relatedSkills ? JSON.stringify(s.relatedSkills) : null,
              autoAssign: s.autoAssignPatterns ? JSON.stringify(s.autoAssignPatterns) : null,
              prUrl: s.contributedPrUrl || null,
              researchCount: s.researchCount || 0,
              createdAt: s.createdAt || Date.now(),
              lastResearched: s.lastResearchedAt || null,
              lastUpdated: s.lastUpdatedAt || null,
            },
          );
          count++;
        }
      });

      this._stats.forge_skills = count;
      if (count > 0) logger.debug(`[Migration] ${count} forge skills`);
    } catch (err) {
      logger.warn(`[Migration] Failed to migrate forge skills: ${err.message}`);
    }
  }

  // ── Background Embedding ───────────────────────────────────────

  _scheduleEmbedding() {
    const logger = getLogger();
    if (!this._db.hasVectors) {
      logger.debug('[Migration] No vector support — skipping embedding schedule');
      return;
    }

    // Non-blocking: embed memories in background
    setImmediate(async () => {
      try {
        const memories = this._db.all(
          `SELECT m.id, m.summary FROM memories m
           LEFT JOIN memory_vectors v ON v.memory_id = m.id
           WHERE v.memory_id IS NULL AND m.summary != ''
           LIMIT 5000`,
        );

        if (memories.length === 0) return;
        logger.info(`[Migration] Embedding ${memories.length} memories in background...`);

        const BATCH_SIZE = 50;
        let embedded = 0;

        for (let i = 0; i < memories.length; i += BATCH_SIZE) {
          const batch = memories.slice(i, i + BATCH_SIZE);
          const texts = batch.map(m => m.summary);
          const vectors = await this._db.embedBatch(texts);

          this._db.transaction(() => {
            for (let j = 0; j < batch.length; j++) {
              if (vectors[j]) {
                const buf = Buffer.from(vectors[j].buffer);
                this._db.run(
                  'INSERT OR REPLACE INTO memory_vectors (memory_id, embedding) VALUES (:memoryId, :embedding)',
                  { memoryId: batch[j].id, embedding: buf },
                );
                embedded++;
              }
            }
          });

          // Yield to event loop between batches
          await new Promise(r => setTimeout(r, 100));
        }

        logger.info(`[Migration] Background embedding complete: ${embedded}/${memories.length} memories embedded`);
      } catch (err) {
        logger.warn(`[Migration] Background embedding failed: ${err.message}`);
      }
    });
  }
}
