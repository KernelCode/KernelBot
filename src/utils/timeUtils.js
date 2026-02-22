/**
 * Quiet Hours utility — configurable "Do Not Disturb" schedule.
 *
 * Resolution order (first defined wins):
 *   1. Environment variables  QUIET_HOURS_START / QUIET_HOURS_END  (HH:mm)
 *   2. YAML config values     config.life.quiet_hours.start / .end (integer hour)
 *   3. Built-in defaults      02:00 – 06:00
 *
 * If neither variable is set, quiet hours are disabled (returns false).
 */

/** Default quiet-hours window (integer hours). */
const DEFAULT_START = 2;
const DEFAULT_END = 6;

/**
 * Check whether the current time falls within "quiet hours".
 *
 * @param {object} [lifeConfig] - Optional `config.life` object from YAML.
 *   When provided, `lifeConfig.quiet_hours.start` / `.end` (integer hours)
 *   act as the second-priority source before the hardcoded defaults.
 * @returns {boolean} `true` when the current time is inside the quiet window.
 */
export function isQuietHours(lifeConfig) {
  const envStart = process.env.QUIET_HOURS_START;
  const envEnd = process.env.QUIET_HOURS_END;

  // ── Path A: env vars are set (HH:mm format, minute-level precision) ──
  if (envStart && envEnd) {
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    const [startH, startM] = envStart.split(':').map(Number);
    const [endH, endM] = envEnd.split(':').map(Number);

    if (isNaN(startH) || isNaN(startM) || isNaN(endH) || isNaN(endM)) return false;

    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    // Supports ranges that cross midnight (e.g. 22:00 – 06:00)
    if (startMinutes <= endMinutes) {
      return currentMinutes >= startMinutes && currentMinutes < endMinutes;
    }
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }

  // ── Path B: fall back to YAML config → hardcoded defaults (hour-level) ──
  const quietStart = lifeConfig?.quiet_hours?.start ?? DEFAULT_START;
  const quietEnd = lifeConfig?.quiet_hours?.end ?? DEFAULT_END;
  const currentHour = new Date().getHours();

  if (quietStart <= quietEnd) {
    return currentHour >= quietStart && currentHour < quietEnd;
  }
  // Midnight-crossing support for integer-hour ranges too
  return currentHour >= quietStart || currentHour < quietEnd;
}
