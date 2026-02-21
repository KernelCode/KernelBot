import { randomBytes } from 'crypto';

/**
 * Generate a short, unique ID with a given prefix.
 * Format: `<prefix>_<8-hex-chars>` (e.g. "evo_a3f1b2c4").
 *
 * @param {string} prefix - Short prefix for the ID (e.g. 'evo', 'sh', 'imp', 'ep')
 * @returns {string} Unique identifier
 */
export function genId(prefix) {
  return `${prefix}_${randomBytes(4).toString('hex')}`;
}
