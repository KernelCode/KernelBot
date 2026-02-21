/**
 * Quiet Hours utility — Ramadan context-awareness.
 *
 * During Ramadan, daytime hours (roughly 05:00–18:00) are fasting hours.
 * KernelBot can use this to be more considerate: lower notification
 * frequency, softer tone, or skip non-urgent automations while the
 * user is fasting or resting.
 */

/**
 * Check whether the current time falls within "quiet hours".
 *
 * @returns {boolean} `true` if the current hour is between 05:00 and 17:59 (inclusive)
 */
export function isQuietHours() {
  const hour = new Date().getHours();
  return hour >= 5 && hour < 18;
}
