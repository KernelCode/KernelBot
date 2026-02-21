/**
 * Get the millisecond timestamp for the start of today (midnight 00:00:00.000).
 *
 * @returns {number} Epoch ms at the start of today
 */
export function getStartOfDayMs() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Get today's date as an ISO date string (YYYY-MM-DD).
 *
 * @returns {string} e.g. "2026-02-21"
 */
export function todayDateStr() {
  return new Date().toISOString().slice(0, 10);
}
