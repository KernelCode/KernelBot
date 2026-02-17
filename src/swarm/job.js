import { randomBytes } from 'crypto';

/** Valid job statuses and allowed transitions. */
const TRANSITIONS = {
  queued:    ['running', 'cancelled'],
  running:   ['completed', 'failed', 'cancelled'],
  completed: [],
  failed:    [],
  cancelled: [],
};

/**
 * A single unit of work dispatched from the orchestrator to a worker.
 */
export class Job {
  constructor({ chatId, workerType, task }) {
    this.id = randomBytes(4).toString('hex');        // short 8-char hex id
    this.chatId = chatId;
    this.workerType = workerType;
    this.task = task;
    this.status = 'queued';
    this.result = null;
    this.structuredResult = null;                      // WorkerResult: { summary, status, details, artifacts, followUp, toolsUsed, errors }
    this.context = null;                               // Orchestrator-provided context string
    this.dependsOn = [];                               // Job IDs this job depends on
    this.userId = null;                                // Telegram user ID for persona loading
    this.error = null;
    this.worker = null;                               // WorkerAgent ref
    this.statusMessageId = null;                      // Telegram message for progress edits
    this.createdAt = Date.now();
    this.startedAt = null;
    this.completedAt = null;
    this.timeoutMs = null;                              // Per-job timeout (set from worker type config)
    this.progress = [];                                 // Recent activity entries
    this.lastActivity = null;                           // Timestamp of last activity
  }

  /** Transition to a new status. Throws if the transition is invalid. */
  transition(newStatus) {
    const allowed = TRANSITIONS[this.status];
    if (!allowed || !allowed.includes(newStatus)) {
      throw new Error(`Invalid job transition: ${this.status} -> ${newStatus}`);
    }
    this.status = newStatus;
    if (newStatus === 'running') this.startedAt = Date.now();
    if (['completed', 'failed', 'cancelled'].includes(newStatus)) this.completedAt = Date.now();
  }

  /** Duration in seconds (or null if not started). */
  get duration() {
    if (!this.startedAt) return null;
    const end = this.completedAt || Date.now();
    return Math.round((end - this.startedAt) / 1000);
  }

  /** Record a progress heartbeat from the worker. Caps at 20 entries. */
  addProgress(text) {
    this.progress.push(text);
    if (this.progress.length > 20) this.progress.shift();
    this.lastActivity = Date.now();
  }

  /** Whether this job is in a terminal state. */
  get isTerminal() {
    return ['completed', 'failed', 'cancelled'].includes(this.status);
  }

  /** Human-readable one-line summary. */
  toSummary() {
    const statusEmoji = {
      queued: '🔜',
      running: '⚙️',
      completed: '✅',
      failed: '❌',
      cancelled: '🚫',
    };
    const emoji = statusEmoji[this.status] || '❓';
    const dur = this.duration != null ? ` (${this.duration}s)` : '';
    const summaryText = this.structuredResult?.summary || null;
    const lastAct = !summaryText && this.progress.length > 0 ? ` | ${this.progress[this.progress.length - 1]}` : '';
    const resultSnippet = summaryText ? ` | ${summaryText.slice(0, 80)}` : '';
    const deps = this.dependsOn.length > 0 ? ` [deps: ${this.dependsOn.join(',')}]` : '';
    return `${emoji} \`${this.id}\` [${this.workerType}] ${this.task.slice(0, 60)}${this.task.length > 60 ? '...' : ''}${dur}${resultSnippet}${lastAct}${deps}`;
  }
}
