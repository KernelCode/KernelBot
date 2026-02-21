import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getLogger } from '../utils/logger.js';
import { genId } from '../utils/ids.js';

const LIFE_DIR = join(homedir(), '.kernelbot', 'life');
const IMPROVEMENTS_FILE = join(LIFE_DIR, 'improvements.json');

export class ImprovementTracker {
  constructor() {
    mkdirSync(LIFE_DIR, { recursive: true });
    this._data = this._load();
  }

  _load() {
    if (existsSync(IMPROVEMENTS_FILE)) {
      try {
        return JSON.parse(readFileSync(IMPROVEMENTS_FILE, 'utf-8'));
      } catch {
        return { proposals: [] };
      }
    }
    return { proposals: [] };
  }

  _save() {
    writeFileSync(IMPROVEMENTS_FILE, JSON.stringify(this._data, null, 2), 'utf-8');
  }

  /**
   * Add a self-improvement proposal.
   * @param {{ description: string, branch: string, scope: string, files?: string[] }} proposal
   */
  addProposal(proposal) {
    const logger = getLogger();
    const entry = {
      id: genId('imp'),
      createdAt: Date.now(),
      status: 'pending', // pending, approved, rejected
      description: proposal.description,
      branch: proposal.branch,
      scope: proposal.scope || 'prompts',
      files: proposal.files || [],
    };
    this._data.proposals.push(entry);
    this._save();
    logger.info(`[Improvements] New proposal: "${entry.description.slice(0, 80)}" (${entry.id})`);
    return entry;
  }

  /**
   * Get pending proposals.
   */
  getPending() {
    return this._data.proposals.filter(p => p.status === 'pending');
  }

  /**
   * Get all proposals (for display).
   */
  getAll(limit = 20) {
    return this._data.proposals.slice(-limit);
  }

  /**
   * Update proposal status.
   */
  updateStatus(id, status) {
    const proposal = this._data.proposals.find(p => p.id === id);
    if (!proposal) return null;
    proposal.status = status;
    proposal.updatedAt = Date.now();
    this._save();
    return proposal;
  }
}
