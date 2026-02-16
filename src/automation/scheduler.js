/**
 * Pure timer engine for automations — cron, interval, and random schedules.
 * Uses setTimeout (no new dependencies).
 */

/**
 * Calculate the next fire time for an automation.
 * @param {object} schedule - { type, expression?, minutes?, minMinutes?, maxMinutes? }
 * @param {number|null} lastRun - timestamp of last execution
 * @returns {number} next fire timestamp
 */
export function getNextFireTime(schedule, lastRun) {
  const now = Date.now();

  switch (schedule.type) {
    case 'cron':
      return nextCronTime(schedule.expression, now);

    case 'interval': {
      const intervalMs = schedule.minutes * 60 * 1000;
      if (lastRun) {
        const next = lastRun + intervalMs;
        return next > now ? next : now + 1000; // if overdue, fire soon
      }
      return now + intervalMs;
    }

    case 'random': {
      const minMs = schedule.minMinutes * 60 * 1000;
      const maxMs = schedule.maxMinutes * 60 * 1000;
      const delayMs = minMs + Math.random() * (maxMs - minMs);
      return now + delayMs;
    }

    default:
      throw new Error(`Unknown schedule type: ${schedule.type}`);
  }
}

/**
 * Schedule a timer for an automation. Returns the timer ID.
 * @param {object} automation - Automation instance
 * @param {Function} callback - called when timer fires
 * @returns {{ timerId: any, nextRun: number }}
 */
export function scheduleNext(automation, callback) {
  const nextRun = getNextFireTime(automation.schedule, automation.lastRun);
  const delay = Math.max(nextRun - Date.now(), 1000); // at least 1s

  const timerId = setTimeout(callback, delay);
  return { timerId, nextRun };
}

/**
 * Cancel a scheduled timer.
 * @param {any} timerId
 */
export function cancel(timerId) {
  if (timerId != null) clearTimeout(timerId);
}

// ── Cron parser ────────────────────────────────────────────────────────

/**
 * Parse a 5-field cron expression and compute the next occurrence after `after`.
 * Fields: minute hour dayOfMonth month dayOfWeek
 * Supports: numbers, ranges (1-5), steps (star/5), lists (1,3,5), star
 */
function nextCronTime(expression, after) {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Invalid cron expression (need 5 fields): ${expression}`);
  }

  const [minuteF, hourF, domF, monthF, dowF] = fields;
  const minutes = parseField(minuteF, 0, 59);
  const hours = parseField(hourF, 0, 23);
  const doms = parseField(domF, 1, 31);
  const months = parseField(monthF, 1, 12);
  const dows = parseField(dowF, 0, 6); // 0=Sunday

  const start = new Date(after + 60_000); // start from next minute
  start.setSeconds(0, 0);

  // Search up to 366 days ahead
  const limit = 366 * 24 * 60;
  for (let i = 0; i < limit; i++) {
    const candidate = new Date(start.getTime() + i * 60_000);
    const m = candidate.getMinutes();
    const h = candidate.getHours();
    const dom = candidate.getDate();
    const mon = candidate.getMonth() + 1; // 1-based
    const dow = candidate.getDay();

    if (
      minutes.has(m) &&
      hours.has(h) &&
      doms.has(dom) &&
      months.has(mon) &&
      dows.has(dow)
    ) {
      return candidate.getTime();
    }
  }

  // Fallback: 24h from now
  return after + 24 * 60 * 60 * 1000;
}

/**
 * Parse a single cron field into a Set of valid values.
 */
function parseField(field, min, max) {
  const values = new Set();

  for (const part of field.split(',')) {
    if (part === '*') {
      for (let i = min; i <= max; i++) values.add(i);
    } else if (part.includes('/')) {
      const [range, stepStr] = part.split('/');
      const step = parseInt(stepStr, 10);
      let start = min;
      let end = max;
      if (range !== '*') {
        if (range.includes('-')) {
          [start, end] = range.split('-').map(Number);
        } else {
          start = parseInt(range, 10);
        }
      }
      for (let i = start; i <= end; i += step) values.add(i);
    } else if (part.includes('-')) {
      const [s, e] = part.split('-').map(Number);
      for (let i = s; i <= e; i++) values.add(i);
    } else {
      values.add(parseInt(part, 10));
    }
  }

  return values;
}
