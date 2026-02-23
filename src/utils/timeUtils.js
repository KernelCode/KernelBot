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
 * Resolve the active quiet-hours window into a normalised { startMinutes, endMinutes } pair.
 * Both values are in "minutes since midnight" (0 – 1439).
 *
 * @param {object} [lifeConfig] - Optional `config.life` object from YAML.
 * @returns {{ startMinutes: number, endMinutes: number }}
 */
function resolveWindow(lifeConfig) {
  const envStart = process.env.QUIET_HOURS_START;
  const envEnd = process.env.QUIET_HOURS_END;

  if (envStart && envEnd) {
    const [startH, startM] = envStart.split(':').map(Number);
    const [endH, endM] = envEnd.split(':').map(Number);

    if (!isNaN(startH) && !isNaN(startM) && !isNaN(endH) && !isNaN(endM)) {
      return { startMinutes: startH * 60 + startM, endMinutes: endH * 60 + endM };
    }
  }

  const startHour = lifeConfig?.quiet_hours?.start ?? DEFAULT_START;
  const endHour = lifeConfig?.quiet_hours?.end ?? DEFAULT_END;
  return { startMinutes: startHour * 60, endMinutes: endHour * 60 };
}

/**
 * Check whether a given "minutes since midnight" value falls inside a quiet window.
 *
 * @param {number} current - Current minutes since midnight.
 * @param {number} start   - Window start (minutes since midnight).
 * @param {number} end     - Window end   (minutes since midnight).
 * @returns {boolean}
 */
function insideWindow(current, start, end) {
  if (start <= end) {
    return current >= start && current < end;
  }
  // Window crosses midnight (e.g. 22:00 – 06:00)
  return current >= start || current < end;
}

/**
 * Check whether the current time falls within "quiet hours".
 *
 * @param {object} [lifeConfig] - Optional `config.life` object from YAML.
 *   When provided, `lifeConfig.quiet_hours.start` / `.end` (integer hours)
 *   act as the second-priority source before the hardcoded defaults.
 * @returns {boolean} `true` when the current time is inside the quiet window.
 */
export function isQuietHours(lifeConfig) {
  const { startMinutes, endMinutes } = resolveWindow(lifeConfig);
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  return insideWindow(currentMinutes, startMinutes, endMinutes);
}

/**
 * Return the resolved quiet-hours configuration for logging / status display.
 *
 * @param {object} [lifeConfig] - Optional `config.life` object from YAML.
 * @returns {{ start: string, end: string, active: boolean }}
 *   `start` / `end` are formatted as "HH:MM", `active` reflects the current state.
 */
export function getQuietHoursConfig(lifeConfig) {
  const { startMinutes, endMinutes } = resolveWindow(lifeConfig);
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  return {
    start: fmt(startMinutes),
    end: fmt(endMinutes),
    active: isQuietHours(lifeConfig),
  };
}

/**
 * Calculate the number of milliseconds remaining until the current quiet-hours
 * window ends.  Returns `0` when quiet hours are not active.
 *
 * Useful for deferring non-essential work until the window closes.
 *
 * @param {object} [lifeConfig] - Optional `config.life` object from YAML.
 * @returns {number} Milliseconds until quiet hours end (0 if not currently quiet).
 */
export function msUntilQuietEnd(lifeConfig) {
  if (!isQuietHours(lifeConfig)) return 0;

  const { endMinutes } = resolveWindow(lifeConfig);
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  let diff = endMinutes - currentMinutes;
  if (diff <= 0) diff += 24 * 60; // crosses midnight

  return diff * 60_000;
}
