import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getLogger } from '../utils/logger.js';
import { genId } from '../utils/ids.js';
import { getStartOfDayMs } from '../utils/date.js';

const LIFE_DIR = join(homedir(), '.kernelbot', 'life');
const EVOLUTION_FILE = join(LIFE_DIR, 'evolution.json');

const VALID_STATUSES = ['research', 'planned', 'coding', 'pr_open', 'merged', 'rejected', 'failed'];
const TERMINAL_STATUSES = ['merged', 'rejected', 'failed'];

const DEFAULT_DATA = {
  proposals: [],
  lessons: [],
  stats: { totalProposals: 0, merged: 0, rejected: 0, failed: 0, successRate: 0 },
};

export class EvolutionTracker {
  constructor(basePath = null) {
    const lifeDir = basePath || LIFE_DIR;
    this._evolutionFile = join(lifeDir, 'evolution.json');
    mkdirSync(lifeDir, { recursive: true });
    this._data = this._load();
  }

  _load() {
    if (existsSync(this._evolutionFile)) {
      try {
        const raw = JSON.parse(readFileSync(this._evolutionFile, 'utf-8'));
        return {
          proposals: raw.proposals || [],
          lessons: raw.lessons || [],
          stats: { ...DEFAULT_DATA.stats, ...raw.stats },
        };
      } catch {
        return { ...DEFAULT_DATA, proposals: [], lessons: [] };
      }
    }
    return { ...DEFAULT_DATA, proposals: [], lessons: [] };
  }

  _save() {
    writeFileSync(this._evolutionFile, JSON.stringify(this._data, null, 2), 'utf-8');
  }

  _recalcStats() {
    const { proposals } = this._data;
    const total = proposals.length;
    const merged = proposals.filter(p => p.status === 'merged').length;
    const rejected = proposals.filter(p => p.status === 'rejected').length;
    const failed = proposals.filter(p => p.status === 'failed').length;
    const resolved = merged + rejected + failed;
    this._data.stats = {
      totalProposals: total,
      merged,
      rejected,
      failed,
      successRate: resolved > 0 ? Math.round((merged / resolved) * 100) : 0,
    };
  }

  // ── Proposals ─────────────────────────────────────────────────

  addProposal(trigger, context) {
    const logger = getLogger();
    const now = Date.now();
    const proposal = {
      id: genId('evo'),
      createdAt: now,
      status: 'research',
      trigger,
      triggerContext: context,
      research: { findings: null, sources: [], completedAt: 0 },
      plan: { description: null, filesToModify: [], risks: null, testStrategy: null, completedAt: 0 },
      branch: null,
      commits: [],
      filesChanged: [],
      prNumber: null,
      prUrl: null,
      outcome: { merged: false, feedback: null, lessonsLearned: null },
      updatedAt: now,
    };

    this._data.proposals.push(proposal);
    this._recalcStats();
    this._save();
    logger.info(`[Evolution] New proposal: ${proposal.id} (trigger: ${trigger})`);
    return proposal;
  }

  updateResearch(id, findings, sources = []) {
    const proposal = this._findProposal(id);
    if (!proposal) return null;

    proposal.research = {
      findings,
      sources,
      completedAt: Date.now(),
    };
    proposal.status = 'planned';
    proposal.updatedAt = Date.now();
    this._save();
    return proposal;
  }

  updatePlan(id, plan) {
    const proposal = this._findProposal(id);
    if (!proposal) return null;

    proposal.plan = {
      description: plan.description,
      filesToModify: plan.filesToModify || [],
      risks: plan.risks || null,
      testStrategy: plan.testStrategy || null,
      completedAt: Date.now(),
    };
    proposal.status = 'planned';
    proposal.updatedAt = Date.now();
    this._save();
    return proposal;
  }

  updateCoding(id, branch, commits = [], files = []) {
    const proposal = this._findProposal(id);
    if (!proposal) return null;

    proposal.branch = branch;
    proposal.commits = commits;
    proposal.filesChanged = files;
    proposal.status = 'coding';
    proposal.updatedAt = Date.now();
    this._save();
    return proposal;
  }

  updatePR(id, prNumber, prUrl) {
    const proposal = this._findProposal(id);
    if (!proposal) return null;

    proposal.prNumber = prNumber;
    proposal.prUrl = prUrl;
    proposal.status = 'pr_open';
    proposal.updatedAt = Date.now();
    this._save();
    return proposal;
  }

  resolvePR(id, merged, feedback = null) {
    const proposal = this._findProposal(id);
    if (!proposal) return null;

    proposal.status = merged ? 'merged' : 'rejected';
    proposal.outcome = {
      merged,
      feedback,
      lessonsLearned: null,
    };
    proposal.updatedAt = Date.now();
    this._recalcStats();
    this._save();
    return proposal;
  }

  failProposal(id, reason) {
    const logger = getLogger();
    const proposal = this._findProposal(id);
    if (!proposal) return null;

    proposal.status = 'failed';
    proposal.outcome = {
      merged: false,
      feedback: reason,
      lessonsLearned: null,
    };
    proposal.updatedAt = Date.now();
    this._recalcStats();
    this._save();
    logger.warn(`[Evolution] Proposal ${id} failed: ${reason}`);
    return proposal;
  }

  // ── Lessons ───────────────────────────────────────────────────

  addLesson(category, lesson, fromProposal = null, importance = 5) {
    const logger = getLogger();
    const entry = {
      id: genId('les'),
      category,
      lesson,
      fromProposal,
      importance,
      createdAt: Date.now(),
    };
    this._data.lessons.push(entry);
    // Cap lessons at 200
    if (this._data.lessons.length > 200) {
      this._data.lessons = this._data.lessons.slice(-200);
    }
    this._save();
    logger.info(`[Evolution] Lesson added: "${lesson.slice(0, 80)}" (${category})`);
    return entry;
  }

  // ── Queries ───────────────────────────────────────────────────

  getActiveProposal() {
    return this._data.proposals.find(p => !TERMINAL_STATUSES.includes(p.status)) || null;
  }

  getRecentProposals(limit = 10) {
    return this._data.proposals.slice(-limit);
  }

  getRecentLessons(limit = 10) {
    return this._data.lessons.slice(-limit);
  }

  getLessonsByCategory(category) {
    return this._data.lessons.filter(l => l.category === category);
  }

  getStats() {
    return { ...this._data.stats };
  }

  getPRsToCheck() {
    return this._data.proposals.filter(p => p.status === 'pr_open');
  }

  getProposalsToday() {
    const cutoff = getStartOfDayMs();
    return this._data.proposals.filter(p => p.createdAt >= cutoff);
  }

  // ── Internal ──────────────────────────────────────────────────

  _findProposal(id) {
    return this._data.proposals.find(p => p.id === id) || null;
  }
}
