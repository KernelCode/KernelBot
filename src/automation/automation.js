import { randomBytes } from 'crypto';

/**
 * A single recurring automation — a scheduled task that the orchestrator runs.
 */
export class Automation {
  constructor({ chatId, name, description, schedule }) {
    this.id = randomBytes(4).toString('hex');
    this.chatId = String(chatId);
    this.name = name;
    this.description = description; // the task prompt
    this.schedule = schedule;       // { type, expression?, minutes?, minMinutes?, maxMinutes? }
    this.enabled = true;
    this.lastRun = null;
    this.nextRun = null;
    this.runCount = 0;
    this.lastError = null;
    this.createdAt = Date.now();
  }

  /** Human-readable one-line summary. */
  toSummary() {
    const status = this.enabled ? '🟢' : '⏸️';
    const scheduleStr = formatSchedule(this.schedule);
    const nextStr = this.nextRun
      ? `next: ${new Date(this.nextRun).toLocaleString()}`
      : 'not scheduled';
    const runs = this.runCount > 0 ? ` | ${this.runCount} runs` : '';
    return `${status} \`${this.id}\` **${this.name}** — ${scheduleStr} (${nextStr}${runs})`;
  }

  /** Serialize for persistence. */
  toJSON() {
    return {
      id: this.id,
      chatId: this.chatId,
      name: this.name,
      description: this.description,
      schedule: this.schedule,
      enabled: this.enabled,
      lastRun: this.lastRun,
      nextRun: this.nextRun,
      runCount: this.runCount,
      lastError: this.lastError,
      createdAt: this.createdAt,
    };
  }

  /** Deserialize from persistence. */
  static fromJSON(data) {
    const auto = Object.create(Automation.prototype);
    auto.id = data.id;
    auto.chatId = String(data.chatId);
    auto.name = data.name;
    auto.description = data.description;
    auto.schedule = data.schedule;
    auto.enabled = data.enabled;
    auto.lastRun = data.lastRun;
    auto.nextRun = data.nextRun;
    auto.runCount = data.runCount;
    auto.lastError = data.lastError;
    auto.createdAt = data.createdAt;
    return auto;
  }
}

/** Format a schedule object for display. */
function formatSchedule(schedule) {
  switch (schedule.type) {
    case 'cron':
      return `cron: \`${schedule.expression}\``;
    case 'interval':
      return `every ${schedule.minutes}m`;
    case 'random':
      return `random ${schedule.minMinutes}–${schedule.maxMinutes}m`;
    default:
      return schedule.type;
  }
}
