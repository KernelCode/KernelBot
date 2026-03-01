/**
 * Time Awareness Utility — Riyadh-local helpers.
 *
 * Provides timezone-aware helpers anchored to Asia/Riyadh so that
 * automated tasks can respect the user's real-world schedule.
 *
 * Quiet hours (02:00 – 10:00 Riyadh time) are intentionally wider than
 * the generic defaults in timeUtils.js because the owner fasts during
 * Ramadan and typically sleeps through the early-morning hours.
 *
 * @module utils/timeAwareness
 */

const TIMEZONE = 'Asia/Riyadh';
const QUIET_START_HOUR = 2;
const QUIET_END_HOUR = 10;

/**
 * Return the current date/time in the Asia/Riyadh timezone.
 *
 * The returned object contains the full ISO-style formatted string,
 * the numeric hour (0-23), and the raw Date for further processing.
 *
 * @returns {{ formatted: string, hour: number, date: Date }}
 */
export function getCurrentRiyadhTime() {
  const now = new Date();

  const formatted = now.toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZone: TIMEZONE,
  });

  const hourParts = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    hour12: false,
    timeZone: TIMEZONE,
  }).formatToParts(now);

  const hour = parseInt(
    hourParts.find((p) => p.type === 'hour')?.value || '0',
    10,
  );

  return { formatted, hour, date: now };
}

/**
 * Check whether the current Riyadh time falls within quiet hours.
 *
 * Quiet hours are defined as **02:00 – 10:00 (Asia/Riyadh)** to
 * respect the user's sleep schedule during Ramadan fasting, when
 * they tend to sleep through the early-morning period.
 *
 * Automated tasks (notifications, self-improvement PRs, noisy jobs)
 * should check this flag and defer non-urgent work until after the
 * quiet window closes.
 *
 * @returns {boolean} `true` when the current Riyadh time is between
 *   02:00 and 10:00 (inclusive start, exclusive end).
 */
export function isQuietHours() {
  const { hour } = getCurrentRiyadhTime();
  return hour >= QUIET_START_HOUR && hour < QUIET_END_HOUR;
}
