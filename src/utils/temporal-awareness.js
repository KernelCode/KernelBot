/**
 * Temporal & Spatial Awareness Engine
 *
 * Reads a local (git-ignored) config file to dynamically inject
 * the owner's real-time context into every LLM call:
 *   - Current local time in the owner's timezone
 *   - Whether they are currently within working hours
 *   - Location context
 *   - Day-of-week and date context
 *
 * The local config file (local_context.json) is NEVER committed.
 * Only this generic algorithm ships with the repo.
 */

import { readFileSync, existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getLogger } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCAL_CONTEXT_PATH = join(__dirname, '..', '..', 'local_context.json');

/** Cache the loaded config (reloaded on file change via mtime check). */
let _cache = null;
let _cacheMtime = 0;

/**
 * Load the local context config.
 * Returns null if the file doesn't exist (non-personal deployments).
 */
function loadLocalContext() {
  try {
    if (!existsSync(LOCAL_CONTEXT_PATH)) return null;

    const stat = statSync(LOCAL_CONTEXT_PATH);
    if (_cache && stat.mtimeMs === _cacheMtime) return _cache;

    const raw = readFileSync(LOCAL_CONTEXT_PATH, 'utf-8');
    _cache = JSON.parse(raw);
    _cacheMtime = stat.mtimeMs;
    return _cache;
  } catch (err) {
    const logger = getLogger();
    logger.debug(`[TemporalAwareness] Could not load local_context.json: ${err.message}`);
    return null;
  }
}

/**
 * Format a Date in a human-friendly way for a given timezone.
 */
function formatTime(date, timezone, locale = 'en-US') {
  return date.toLocaleString(locale, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZone: timezone,
  });
}

/**
 * Get the current hour (0-23) in the given timezone.
 */
function getCurrentHour(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    hour12: false,
    timeZone: timezone,
  }).formatToParts(date);
  const hourPart = parts.find(p => p.type === 'hour');
  return parseInt(hourPart?.value || '0', 10);
}

/**
 * Get the current day of week (0=Sun, 1=Mon, ..., 6=Sat) in the given timezone.
 */
function getCurrentDayOfWeek(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    timeZone: timezone,
  }).formatToParts(date);
  const dayStr = parts.find(p => p.type === 'weekday')?.value || '';
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return dayMap[dayStr] ?? -1;
}

/**
 * Determine the user's current status based on time, day, and working hours.
 */
function determineStatus(hour, dayOfWeek, workingHours) {
  if (!workingHours) return { status: 'unknown', detail: '' };

  const { start, end, days } = workingHours;
  const isWorkDay = days ? days.includes(dayOfWeek) : (dayOfWeek >= 0 && dayOfWeek <= 4);
  const isWorkHour = hour >= start && hour < end;

  if (!isWorkDay) {
    return { status: 'day_off', detail: 'Weekend / day off' };
  }

  if (isWorkHour) {
    return { status: 'working', detail: `At work (${workingHours.label || `${start}:00–${end}:00`})` };
  }

  // Outside working hours on a work day
  if (hour < start) {
    const hoursUntilWork = start - hour;
    return { status: 'before_work', detail: `Before work — starts in ~${hoursUntilWork}h` };
  }

  return { status: 'after_work', detail: 'Off work for the day' };
}

/**
 * Determine the likely activity period for more nuanced awareness.
 */
function determineActivityPeriod(hour) {
  if (hour >= 0 && hour < 5) return 'late_night';
  if (hour >= 5 && hour < 7) return 'early_morning';
  if (hour >= 7 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 14) return 'midday';
  if (hour >= 14 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 20) return 'evening';
  if (hour >= 20 && hour < 23) return 'night';
  return 'late_night';
}

/**
 * Build the temporal & spatial awareness string to inject into the system prompt.
 *
 * Returns a formatted context block, or null if no local config is found.
 *
 * Example output:
 *   ## Owner's Real-Time Context
 *   - Local Time: Monday, March 10, 2025, 02:15:30 AM (Asia/Riyadh)
 *   - Location: Riyadh, Saudi Arabia
 *   - Status: Off work — next shift at 10:00 AM
 *   - Period: Late night
 *
 *   IMPORTANT: Adjust your tone and assumptions to the owner's current time.
 *   Do NOT assume they are at work during off-hours or sleeping during work hours.
 */
export function buildTemporalAwareness() {
  const ctx = loadLocalContext();
  if (!ctx?.owner) return null;

  const logger = getLogger();
  const { owner } = ctx;
  const now = new Date();

  const timezone = owner.timezone || 'UTC';
  const locale = owner.locale || 'en-US';
  const location = owner.location
    ? `${owner.location.city}, ${owner.location.country}`
    : null;

  const formattedTime = formatTime(now, timezone, locale);
  const currentHour = getCurrentHour(now, timezone);
  const currentDay = getCurrentDayOfWeek(now, timezone);
  const { status, detail } = determineStatus(currentHour, currentDay, owner.working_hours);
  const period = determineActivityPeriod(currentHour);

  const lines = [
    `## Owner's Real-Time Context`,
    `- **Local Time**: ${formattedTime}`,
  ];

  if (location) {
    lines.push(`- **Location**: ${location}`);
  }

  if (owner.name) {
    lines.push(`- **Name**: ${owner.name}`);
  }

  lines.push(`- **Work Status**: ${detail || status}`);
  lines.push(`- **Period**: ${period.replace('_', ' ')}`);

  if (owner.working_hours) {
    const wh = owner.working_hours;
    lines.push(`- **Working Hours**: ${wh.start}:00–${wh.end}:00${wh.label ? ` (${wh.label})` : ''}`);
  }

  lines.push('');
  lines.push('IMPORTANT: Be aware of the owner\'s current local time and status.');
  lines.push('Do NOT assume they are at work during off-hours, or sleeping during work hours.');
  lines.push('Adjust greetings, tone, and context to match their real-time situation.');

  const block = lines.join('\n');

  logger.debug(`[TemporalAwareness] ${timezone} | hour=${currentHour} day=${currentDay} | status=${status} period=${period}`);

  return block;
}
