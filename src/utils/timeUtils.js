/**
 * Quiet Hours utility — configurable "Do Not Disturb" schedule.
 *
 * Set QUIET_HOURS_START and QUIET_HOURS_END in your .env to define
 * a window during which KernelBot will be more considerate: lower
 * notification frequency, softer tone, or skip non-urgent automations.
 *
 * If neither variable is set, quiet hours are disabled (returns false).
 */

/**
 * Check whether the current time falls within "quiet hours".
 *
 * Reads QUIET_HOURS_START and QUIET_HOURS_END from environment variables
 * (format: "HH:mm", e.g. "05:00" and "18:00").
 *
 * @returns {boolean} `true` if the current time is inside the configured window;
 *                    `false` if the variables are not set or the time is outside.
 */
export function isQuietHours() {
  const start = process.env.QUIET_HOURS_START;
  const end = process.env.QUIET_HOURS_END;

  if (!start || !end) return false;

  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  const [startH, startM] = start.split(':').map(Number);
  const [endH, endM] = end.split(':').map(Number);

  if (isNaN(startH) || isNaN(startM) || isNaN(endH) || isNaN(endM)) return false;

  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  // Supports ranges that cross midnight (e.g. 22:00 – 06:00)
  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}
