import { getLogger } from '../utils/logger.js';

/**
 * OnboardingManager — SQLite-backed state machine for user onboarding.
 * Phases: profile → skills → training → complete
 */
export class OnboardingManager {
  constructor(db) {
    this._db = db;
  }

  /** Get the full onboarding state for a user, or null if not started. */
  getState(userId) {
    const id = String(userId);
    const row = this._db.get(
      'SELECT * FROM user_onboarding WHERE user_id = :userId',
      { userId: id },
    );
    if (!row) return null;
    return {
      ...row,
      profile_data: row.profile_data ? JSON.parse(row.profile_data) : null,
      selected_skills: row.selected_skills ? JSON.parse(row.selected_skills) : [],
      training_notes: row.training_notes ? JSON.parse(row.training_notes) : null,
    };
  }

  /**
   * True if user genuinely needs onboarding.
   * Checks: no onboarding row AND no existing conversation/persona data.
   * This prevents triggering onboarding for existing users who were active
   * before the onboarding system was added.
   */
  needsOnboarding(userId) {
    const id = String(userId);

    // Already has an onboarding record — no need
    const row = this._db.get(
      'SELECT 1 FROM user_onboarding WHERE user_id = :userId',
      { userId: id },
    );
    if (row) return false;

    // Check if user has existing data (conversations or persona) — they're not new
    const hasConversations = this._db.get(
      'SELECT 1 FROM conversations WHERE chat_id LIKE :pattern LIMIT 1',
      { pattern: `%${id}%` },
    );
    if (hasConversations) {
      // Auto-complete onboarding for existing users
      this._autoCompleteExisting(id);
      return false;
    }

    const hasPersona = this._db.get(
      'SELECT 1 FROM user_personas WHERE user_id = :userId LIMIT 1',
      { userId: id },
    );
    if (hasPersona) {
      this._autoCompleteExisting(id);
      return false;
    }

    return true;
  }

  /** Silently mark an existing user as onboarding-complete (they pre-date the system). */
  _autoCompleteExisting(userId) {
    const logger = getLogger();
    const now = Date.now();
    this._db.run(`
      INSERT OR IGNORE INTO user_onboarding (user_id, phase, started_at, updated_at, completed_at)
      VALUES (:userId, 'complete', :now, :now, :now)
    `, { userId, now });
    logger.info(`[Onboarding] Auto-completed for existing user ${userId} (pre-dates onboarding system)`);
  }

  /** True if onboarding has started but isn't complete. */
  isOnboarding(userId) {
    const id = String(userId);
    const row = this._db.get(
      'SELECT phase FROM user_onboarding WHERE user_id = :userId',
      { userId: id },
    );
    return row ? row.phase !== 'complete' : false;
  }

  /** Start onboarding for a user. */
  start(userId) {
    const logger = getLogger();
    const id = String(userId);
    const now = Date.now();
    this._db.run(`
      INSERT OR IGNORE INTO user_onboarding (user_id, phase, started_at, updated_at)
      VALUES (:userId, 'profile', :now, :now)
    `, { userId: id, now });
    logger.info(`[Onboarding] Started for user ${id}`);
  }

  /** Merge profile data (partial update). */
  updateProfile(userId, data) {
    const id = String(userId);
    const existing = this.getState(id);
    const merged = { ...(existing?.profile_data || {}), ...data };
    this._db.run(`
      UPDATE user_onboarding SET profile_data = :data, updated_at = :now
      WHERE user_id = :userId
    `, { userId: id, data: JSON.stringify(merged), now: Date.now() });
  }

  /** Advance to a new phase. */
  advancePhase(userId, phase) {
    const logger = getLogger();
    const id = String(userId);
    this._db.run(`
      UPDATE user_onboarding SET phase = :phase, updated_at = :now
      WHERE user_id = :userId
    `, { userId: id, phase, now: Date.now() });
    logger.info(`[Onboarding] User ${id} advanced to phase: ${phase}`);
  }

  /** Set selected skill IDs. */
  setSkills(userId, skillIds) {
    const id = String(userId);
    this._db.run(`
      UPDATE user_onboarding SET selected_skills = :skills, updated_at = :now
      WHERE user_id = :userId
    `, { userId: id, skills: JSON.stringify(skillIds), now: Date.now() });
  }

  /** Set training notes. */
  setTraining(userId, notes) {
    const id = String(userId);
    this._db.run(`
      UPDATE user_onboarding SET training_notes = :notes, updated_at = :now
      WHERE user_id = :userId
    `, { userId: id, notes: JSON.stringify(notes), now: Date.now() });
  }

  /** Mark onboarding as complete. */
  complete(userId) {
    const logger = getLogger();
    const id = String(userId);
    const now = Date.now();
    this._db.run(`
      UPDATE user_onboarding SET phase = 'complete', completed_at = :now, updated_at = :now
      WHERE user_id = :userId
    `, { userId: id, now });
    logger.info(`[Onboarding] Completed for user ${id}`);
  }

  /** Reset onboarding (delete row so it re-triggers). */
  reset(userId) {
    const logger = getLogger();
    const id = String(userId);
    this._db.run('DELETE FROM user_onboarding WHERE user_id = :userId', { userId: id });
    logger.info(`[Onboarding] Reset for user ${id}`);
  }
}
