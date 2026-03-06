import { getLogger } from '../../utils/logger.js';
import { genId } from '../../utils/ids.js';
import { getStartOfDayMs } from '../../utils/date.js';

const TERMINAL_STATUSES = ['merged', 'rejected', 'failed'];

/**
 * BrainEvolutionTracker — SQLite-backed drop-in replacement for EvolutionTracker.
 * Same public API for proposals, lessons, queries, and stats.
 */
export class BrainEvolutionTracker {
  constructor(db, characterId) {
    this._db = db;
    this._characterId = characterId;
  }

  // ── Proposals ─────────────────────────────────────────────────

  addProposal(trigger, context) {
    const logger = getLogger();
    const now = Date.now();
    const id = genId('evo');

    this._db.run(`
      INSERT INTO evolution_proposals (id, character_id, status, trigger_type, trigger_context,
        research, plan, branch, commits, files_changed, pr_number, pr_url, outcome, created_at, updated_at)
      VALUES (:id, :characterId, 'research', :trigger, :context,
        :research, :plan, NULL, '[]', '[]', NULL, NULL, :outcome, :now, :now)
    `, {
      id, characterId: this._characterId,
      trigger, context,
      research: JSON.stringify({ findings: null, sources: [], completedAt: 0 }),
      plan: JSON.stringify({ description: null, filesToModify: [], risks: null, testStrategy: null, completedAt: 0 }),
      outcome: JSON.stringify({ merged: false, feedback: null, lessonsLearned: null }),
      now,
    });

    logger.info(`[Evolution] New proposal: ${id} (trigger: ${trigger})`);
    return this._getProposal(id);
  }

  updateResearch(id, findings, sources = []) {
    const now = Date.now();
    this._db.run(`
      UPDATE evolution_proposals SET
        research = :research, status = 'planned', updated_at = :now
      WHERE id = :id AND character_id = :characterId
    `, {
      research: JSON.stringify({ findings, sources, completedAt: now }),
      now, id, characterId: this._characterId,
    });
    return this._getProposal(id);
  }

  updatePlan(id, plan) {
    const now = Date.now();
    this._db.run(`
      UPDATE evolution_proposals SET
        plan = :plan, status = 'planned', updated_at = :now
      WHERE id = :id AND character_id = :characterId
    `, {
      plan: JSON.stringify({
        description: plan.description,
        filesToModify: plan.filesToModify || [],
        risks: plan.risks || null,
        testStrategy: plan.testStrategy || null,
        completedAt: now,
      }),
      now, id, characterId: this._characterId,
    });
    return this._getProposal(id);
  }

  updateCoding(id, branch, commits = [], files = []) {
    const now = Date.now();
    this._db.run(`
      UPDATE evolution_proposals SET
        branch = :branch, commits = :commits, files_changed = :files,
        status = 'coding', updated_at = :now
      WHERE id = :id AND character_id = :characterId
    `, {
      branch,
      commits: JSON.stringify(commits),
      files: JSON.stringify(files),
      now, id, characterId: this._characterId,
    });
    return this._getProposal(id);
  }

  updatePR(id, prNumber, prUrl) {
    const now = Date.now();
    this._db.run(`
      UPDATE evolution_proposals SET
        pr_number = :prNumber, pr_url = :prUrl,
        status = 'pr_open', updated_at = :now
      WHERE id = :id AND character_id = :characterId
    `, { prNumber, prUrl, now, id, characterId: this._characterId });
    return this._getProposal(id);
  }

  resolvePR(id, merged, feedback = null) {
    const now = Date.now();
    this._db.run(`
      UPDATE evolution_proposals SET
        status = :status,
        outcome = :outcome,
        updated_at = :now
      WHERE id = :id AND character_id = :characterId
    `, {
      status: merged ? 'merged' : 'rejected',
      outcome: JSON.stringify({ merged, feedback, lessonsLearned: null }),
      now, id, characterId: this._characterId,
    });
    return this._getProposal(id);
  }

  failProposal(id, reason) {
    const logger = getLogger();
    const now = Date.now();
    this._db.run(`
      UPDATE evolution_proposals SET
        status = 'failed',
        outcome = :outcome,
        updated_at = :now
      WHERE id = :id AND character_id = :characterId
    `, {
      outcome: JSON.stringify({ merged: false, feedback: reason, lessonsLearned: null }),
      now, id, characterId: this._characterId,
    });
    logger.warn(`[Evolution] Proposal ${id} failed: ${reason}`);
    return this._getProposal(id);
  }

  // ── Lessons ───────────────────────────────────────────────────

  addLesson(category, lesson, fromProposal = null, importance = 5) {
    const logger = getLogger();
    const id = genId('les');
    const now = Date.now();

    this._db.run(`
      INSERT INTO evolution_lessons (id, character_id, category, lesson, from_proposal, importance, created_at)
      VALUES (:id, :characterId, :category, :lesson, :fromProposal, :importance, :now)
    `, { id, characterId: this._characterId, category, lesson, fromProposal, importance, now });

    // Cap at 200 lessons
    const count = this._db.get(
      'SELECT COUNT(*) as count FROM evolution_lessons WHERE character_id = :characterId',
      { characterId: this._characterId },
    );
    if (count && count.count > 200) {
      this._db.run(`
        DELETE FROM evolution_lessons WHERE id IN (
          SELECT id FROM evolution_lessons WHERE character_id = :characterId
          ORDER BY created_at ASC LIMIT :excess
        )
      `, { characterId: this._characterId, excess: count.count - 200 });
    }

    logger.info(`[Evolution] Lesson added: "${lesson.slice(0, 80)}" (${category})`);
    return { id, category, lesson, fromProposal, importance, createdAt: now };
  }

  // ── Queries ───────────────────────────────────────────────────

  getActiveProposal() {
    const row = this._db.get(`
      SELECT * FROM evolution_proposals
      WHERE character_id = :characterId AND status NOT IN ('merged', 'rejected', 'failed')
      ORDER BY created_at DESC LIMIT 1
    `, { characterId: this._characterId });
    return row ? this._parseProposal(row) : null;
  }

  getRecentProposals(limit = 10) {
    const rows = this._db.all(`
      SELECT * FROM evolution_proposals
      WHERE character_id = :characterId
      ORDER BY created_at DESC LIMIT :limit
    `, { characterId: this._characterId, limit });
    return rows.map(r => this._parseProposal(r));
  }

  getRecentLessons(limit = 10) {
    return this._db.all(`
      SELECT * FROM evolution_lessons
      WHERE character_id = :characterId
      ORDER BY created_at DESC LIMIT :limit
    `, { characterId: this._characterId, limit }).map(r => ({
      id: r.id,
      category: r.category,
      lesson: r.lesson,
      fromProposal: r.from_proposal,
      importance: r.importance,
      createdAt: r.created_at,
    }));
  }

  getLessonsByCategory(category) {
    return this._db.all(`
      SELECT * FROM evolution_lessons
      WHERE character_id = :characterId AND category = :category
      ORDER BY created_at DESC
    `, { characterId: this._characterId, category }).map(r => ({
      id: r.id,
      category: r.category,
      lesson: r.lesson,
      fromProposal: r.from_proposal,
      importance: r.importance,
      createdAt: r.created_at,
    }));
  }

  getStats() {
    const total = this._db.get(
      'SELECT COUNT(*) as count FROM evolution_proposals WHERE character_id = :characterId',
      { characterId: this._characterId },
    )?.count || 0;

    const merged = this._db.get(
      "SELECT COUNT(*) as count FROM evolution_proposals WHERE character_id = :characterId AND status = 'merged'",
      { characterId: this._characterId },
    )?.count || 0;

    const rejected = this._db.get(
      "SELECT COUNT(*) as count FROM evolution_proposals WHERE character_id = :characterId AND status = 'rejected'",
      { characterId: this._characterId },
    )?.count || 0;

    const failed = this._db.get(
      "SELECT COUNT(*) as count FROM evolution_proposals WHERE character_id = :characterId AND status = 'failed'",
      { characterId: this._characterId },
    )?.count || 0;

    const resolved = merged + rejected + failed;
    return {
      totalProposals: total,
      merged,
      rejected,
      failed,
      successRate: resolved > 0 ? Math.round((merged / resolved) * 100) : 0,
    };
  }

  getPRsToCheck() {
    const rows = this._db.all(`
      SELECT * FROM evolution_proposals
      WHERE character_id = :characterId AND status = 'pr_open'
    `, { characterId: this._characterId });
    return rows.map(r => this._parseProposal(r));
  }

  getProposalsToday() {
    const cutoff = getStartOfDayMs();
    const rows = this._db.all(`
      SELECT * FROM evolution_proposals
      WHERE character_id = :characterId AND created_at >= :cutoff
    `, { characterId: this._characterId, cutoff });
    return rows.map(r => this._parseProposal(r));
  }

  // ── Internal ──────────────────────────────────────────────────

  _getProposal(id) {
    const row = this._db.get(
      'SELECT * FROM evolution_proposals WHERE id = :id',
      { id },
    );
    return row ? this._parseProposal(row) : null;
  }

  _parseProposal(row) {
    return {
      id: row.id,
      createdAt: row.created_at,
      status: row.status,
      trigger: row.trigger_type,
      triggerContext: row.trigger_context,
      research: JSON.parse(row.research || '{}'),
      plan: JSON.parse(row.plan || '{}'),
      branch: row.branch,
      commits: JSON.parse(row.commits || '[]'),
      filesChanged: JSON.parse(row.files_changed || '[]'),
      prNumber: row.pr_number,
      prUrl: row.pr_url,
      outcome: JSON.parse(row.outcome || '{}'),
      updatedAt: row.updated_at,
    };
  }
}
