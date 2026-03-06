import { getLogger } from '../utils/logger.js';
import {
  getProfilePrompt,
  getSkillsPrompt,
  getTrainingPrompt,
  getExtractionPrompt,
  getTrainingExtractionPrompt,
} from './prompts.js';
import {
  getCategoryList,
  getSkillsByCategory,
  getSkillById,
} from '../skills/loader.js';

/**
 * OnboardingFlow — conversational onboarding controller.
 * Routes messages to the current phase handler, uses LLM for natural conversation.
 */
export class OnboardingFlow {
  /**
   * @param {object} opts
   * @param {import('./manager.js').OnboardingManager} opts.onboardingManager
   * @param {object} opts.provider — LLM provider (orchestratorProvider)
   * @param {string} opts.characterName
   * @param {import('../brain/managers/persona-manager.js').BrainPersonaManager} opts.personaManager
   * @param {object} opts.conversationManager
   * @param {object} [opts.identityAwareness]
   */
  constructor({ onboardingManager, provider, characterName, personaManager, conversationManager, identityAwareness }) {
    this._manager = onboardingManager;
    this._provider = provider;
    this._characterName = characterName || 'KernelBot';
    this._personaManager = personaManager;
    this._conversationManager = conversationManager;
    this._identityAwareness = identityAwareness;
    // Per-user conversation history during onboarding (not persisted to main conversations)
    this._convHistory = new Map(); // userId -> [{role, content}]
  }

  /** Update character name (e.g. after character switch). */
  setCharacterName(name) {
    this._characterName = name;
  }

  /**
   * Initiate onboarding — sends the first welcome message.
   * @returns {Promise<string>} The welcome message to send.
   */
  async initiate(chatId, userId, user) {
    const logger = getLogger();
    const id = String(userId);
    this._convHistory.set(id, []);

    const prompt = getProfilePrompt(this._characterName, null);
    const greeting = user?.first_name || user?.username || 'there';

    try {
      const response = await this._provider.chat({
        system: prompt,
        messages: [
          { role: 'user', content: `Hi! (My name on Telegram is ${greeting})` },
        ],
      });

      let reply = (response.text || '').trim();
      // Strip the marker — user shouldn't see it
      reply = reply.replace(/\[PROFILE_COMPLETE\]/g, '').trim();

      this._convHistory.set(id, [
        { role: 'user', content: `Hi! (My name on Telegram is ${greeting})` },
        { role: 'assistant', content: reply },
      ]);

      logger.info(`[Onboarding] Initiated for user ${id}`);
      return reply;
    } catch (err) {
      logger.error(`[Onboarding] Initiate failed: ${err.message}`);
      return `Hey ${greeting}! I'd love to get to know you a bit so I can be most helpful. What's your name, and what do you do?`;
    }
  }

  /**
   * Process a message during onboarding.
   * @returns {Promise<{text: string|null, keyboard: object|null}>}
   *   text = reply text (null if onboarding just completed — fall through)
   *   keyboard = inline keyboard markup (for skills phase)
   */
  async processMessage(chatId, userId, message, user) {
    const state = this._manager.getState(userId);
    if (!state) return { text: null, keyboard: null };

    switch (state.phase) {
      case 'profile':
        return this._handleProfilePhase(userId, message, user);
      case 'skills':
        return this._handleSkillsPhase(userId, message, user, state);
      case 'training':
        return this._handleTrainingPhase(userId, message, user, state);
      default:
        return { text: null, keyboard: null };
    }
  }

  /**
   * Handle skill toggle callback from inline keyboard.
   * @returns {{ text: string, keyboard: object }} Updated message.
   */
  handleSkillToggle(userId, skillId) {
    const state = this._manager.getState(userId);
    if (!state || state.phase !== 'skills') return null;

    const current = state.selected_skills || [];
    let updated;
    if (current.includes(skillId)) {
      updated = current.filter(id => id !== skillId);
    } else {
      if (current.length >= 5) {
        return { alert: 'Maximum 5 skills. Remove one first.' };
      }
      updated = [...current, skillId];
    }
    this._manager.setSkills(userId, updated);

    return this._buildSkillKeyboard(userId, updated);
  }

  /**
   * Confirm skill selection and advance to training phase.
   * @returns {Promise<{text: string, keyboard: object|null}>}
   */
  async confirmSkills(userId) {
    const logger = getLogger();
    const state = this._manager.getState(userId);
    if (!state || state.phase !== 'skills') return { text: 'Not in skills phase.', keyboard: null };

    const selectedIds = state.selected_skills || [];
    const selectedSkills = selectedIds.map(id => getSkillById(id)).filter(Boolean);
    const skillNames = selectedSkills.map(s => `${s.emoji} ${s.name}`).join(', ');

    this._manager.advancePhase(userId, 'training');
    this._convHistory.set(String(userId), []); // Reset conv for training phase

    logger.info(`[Onboarding] User ${userId} confirmed ${selectedIds.length} skills: ${selectedIds.join(', ')}`);

    const profile = state.profile_data;
    const prompt = getTrainingPrompt(this._characterName, profile, selectedSkills);

    try {
      const response = await this._provider.chat({
        system: prompt,
        messages: [
          { role: 'user', content: `I've selected these skills: ${skillNames || 'none'}. What's next?` },
        ],
      });

      let reply = (response.text || '').trim();
      reply = reply.replace(/\[TRAINING_COMPLETE\]/g, '').trim();

      this._convHistory.set(String(userId), [
        { role: 'user', content: `I've selected these skills: ${skillNames || 'none'}` },
        { role: 'assistant', content: reply },
      ]);

      return { text: reply, keyboard: null };
    } catch (err) {
      logger.error(`[Onboarding] Training intro failed: ${err.message}`);
      return {
        text: `${selectedIds.length > 0 ? `${skillNames} locked in.` : 'No skills selected.'} Last thing: any specific context that'll help me do my best work? Brand voice, workflows, tools? Or say "skip" to finish.`,
        keyboard: null,
      };
    }
  }

  /**
   * Skip remaining onboarding and complete.
   */
  async skip(userId) {
    const logger = getLogger();
    this._manager.complete(userId);
    this._convHistory.delete(String(userId));
    await this._seedDownstreamSystems(userId);
    logger.info(`[Onboarding] User ${userId} skipped remaining onboarding`);
  }

  // ── Phase Handlers ──────────────────────────────────────────────

  async _handleProfilePhase(userId, message, user) {
    const logger = getLogger();
    const id = String(userId);
    const history = this._convHistory.get(id) || [];

    history.push({ role: 'user', content: message });

    const state = this._manager.getState(userId);
    const prompt = getProfilePrompt(this._characterName, state?.profile_data);

    try {
      const response = await this._provider.chat({
        system: prompt,
        messages: history,
      });

      let reply = (response.text || '').trim();
      const isComplete = reply.includes('[PROFILE_COMPLETE]');
      reply = reply.replace(/\[PROFILE_COMPLETE\]/g, '').trim();

      history.push({ role: 'assistant', content: reply });
      this._convHistory.set(id, history);

      if (isComplete) {
        // Extract profile data in background
        await this._extractAndSaveProfile(userId, history);
        this._manager.advancePhase(userId, 'skills');
        this._convHistory.set(id, []); // Reset for next phase

        // Build skills recommendation
        const state2 = this._manager.getState(userId);
        const recommended = this._recommendSkills(state2.profile_data);
        const kb = this._buildSkillKeyboard(userId, []);

        const categories = getCategoryList();
        const skillsPrompt = getSkillsPrompt(this._characterName, state2.profile_data, recommended, categories);

        try {
          const skillsResponse = await this._provider.chat({
            system: skillsPrompt,
            messages: [{ role: 'user', content: 'What skills do you recommend for me?' }],
          });
          const skillsReply = (skillsResponse.text || '').trim();
          return { text: `${reply}\n\n${skillsReply}`, keyboard: kb.keyboard };
        } catch {
          return { text: `${reply}\n\nNow let's pick some skills! Toggle the ones you want below, then hit Done.`, keyboard: kb.keyboard };
        }
      }

      return { text: reply, keyboard: null };
    } catch (err) {
      logger.error(`[Onboarding] Profile phase error: ${err.message}`);
      return { text: 'Tell me a bit about yourself — what do you do?', keyboard: null };
    }
  }

  async _handleSkillsPhase(userId, message) {
    // During skills phase, text messages are informational — actual selection via buttons
    // But if user types "done", treat as confirmation
    const lower = message.toLowerCase().trim();
    if (lower === 'done' || lower === 'next' || lower === "that's it") {
      return this.confirmSkills(userId);
    }
    if (lower === 'skip') {
      await this.skip(userId);
      return { text: null, keyboard: null };
    }

    // Otherwise, provide helpful response about skills
    return {
      text: 'Use the buttons above to toggle skills on/off, then hit *Done* when ready. Or type "skip" to move on.',
      keyboard: null,
    };
  }

  async _handleTrainingPhase(userId, message, user, state) {
    const logger = getLogger();
    const id = String(userId);
    const history = this._convHistory.get(id) || [];

    history.push({ role: 'user', content: message });

    const selectedSkills = (state.selected_skills || []).map(sid => getSkillById(sid)).filter(Boolean);
    const prompt = getTrainingPrompt(this._characterName, state.profile_data, selectedSkills);

    try {
      const response = await this._provider.chat({
        system: prompt,
        messages: history,
      });

      let reply = (response.text || '').trim();
      const isComplete = reply.includes('[TRAINING_COMPLETE]');
      reply = reply.replace(/\[TRAINING_COMPLETE\]/g, '').trim();

      history.push({ role: 'assistant', content: reply });
      this._convHistory.set(id, history);

      if (isComplete) {
        // Extract training notes
        await this._extractAndSaveTraining(userId, history);
        this._manager.complete(userId);
        this._convHistory.delete(id);
        await this._seedDownstreamSystems(userId);

        return { text: reply, keyboard: null, complete: true };
      }

      return { text: reply, keyboard: null };
    } catch (err) {
      logger.error(`[Onboarding] Training phase error: ${err.message}`);
      return { text: 'Got it. Anything else you want me to know? Or say "done" to finish.', keyboard: null };
    }
  }

  // ── Extraction & Seeding ─────────────────────────────────────────

  async _extractAndSaveProfile(userId, history) {
    const logger = getLogger();
    try {
      const conversationText = history
        .map(m => `${m.role === 'user' ? 'User' : 'Bot'}: ${m.content}`)
        .join('\n');

      const response = await this._provider.chat({
        system: getExtractionPrompt(),
        messages: [{ role: 'user', content: conversationText }],
      });

      const text = (response.text || '').trim();
      // Extract JSON from response (may be wrapped in code block)
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[0]);
        // Filter out null values
        const clean = {};
        for (const [k, v] of Object.entries(data)) {
          if (v !== null && v !== 'null' && v !== '') clean[k] = v;
        }
        this._manager.updateProfile(userId, clean);
        logger.info(`[Onboarding] Extracted profile for user ${userId}: ${Object.keys(clean).join(', ')}`);
      }
    } catch (err) {
      logger.warn(`[Onboarding] Profile extraction failed: ${err.message}`);
    }
  }

  async _extractAndSaveTraining(userId, history) {
    const logger = getLogger();
    try {
      const conversationText = history
        .map(m => `${m.role === 'user' ? 'User' : 'Bot'}: ${m.content}`)
        .join('\n');

      const response = await this._provider.chat({
        system: getTrainingExtractionPrompt(),
        messages: [{ role: 'user', content: conversationText }],
      });

      const text = (response.text || '').trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[0]);
        const clean = {};
        for (const [k, v] of Object.entries(data)) {
          if (v !== null && v !== 'null' && v !== '') clean[k] = v;
        }
        this._manager.setTraining(userId, clean);
        logger.info(`[Onboarding] Extracted training for user ${userId}: ${Object.keys(clean).join(', ')}`);
      }
    } catch (err) {
      logger.warn(`[Onboarding] Training extraction failed: ${err.message}`);
    }
  }

  async _seedDownstreamSystems(userId) {
    const logger = getLogger();
    const state = this._manager.getState(userId);
    if (!state) return;

    // 1. Seed persona with rich profile data
    if (this._personaManager && state.profile_data) {
      const p = state.profile_data;
      const lines = ['# User Profile\n'];

      lines.push('## Basic Info');
      if (p.name) lines.push(`- Name: ${p.name}`);
      if (p.location) lines.push(`- Location: ${p.location}`);
      if (p.timezone) lines.push(`- Timezone: ${p.timezone}`);
      if (p.age) lines.push(`- Age: ${p.age}`);
      if (p.occupation && p.company) lines.push(`- Occupation: ${p.occupation} at ${p.company}`);
      else if (p.occupation) lines.push(`- Occupation: ${p.occupation}`);
      if (p.role) lines.push(`- Role: ${p.role}`);
      if (p.team_context) lines.push(`- Team: ${p.team_context}`);

      if (p.interests) {
        lines.push('\n## Interests');
        lines.push(p.interests);
      }

      if (p.tools) {
        lines.push('\n## Tools & Tech');
        lines.push(p.tools);
      }

      lines.push('\n## Preferences');
      lines.push('(Learned during onboarding — will evolve over time)');

      lines.push('\n## Communication Style');
      lines.push('(Will be learned from interactions)');

      this._personaManager.save(String(userId), lines.join('\n'));
      logger.info(`[Onboarding] Seeded persona for user ${userId}`);
    }

    // 2. Update identity awareness (known_senders table)
    if (this._identityAwareness && state.profile_data) {
      try {
        const p = state.profile_data;
        const sender = this._identityAwareness.getSender(String(userId));
        if (sender) {
          const sets = [];
          const params = { userId: String(userId), characterId: sender.character_id };
          if (p.name) { sets.push('display_name = :displayName'); params.displayName = p.name; }
          if (p.role) { sets.push('org_role = :orgRole'); params.orgRole = p.role; }
          if (p.team_context) { sets.push('team = :team'); params.team = p.team_context; }
          if (sets.length > 0) {
            this._identityAwareness._db.run(
              `UPDATE known_senders SET ${sets.join(', ')} WHERE user_id = :userId AND character_id = :characterId`,
              params,
            );
          }
        }
      } catch (err) {
        logger.warn(`[Onboarding] Identity update failed: ${err.message}`);
      }
    }

    // 3. Set selected skills as chat defaults
    if (this._conversationManager && state.selected_skills?.length > 0) {
      // Skills are per-chat, but we don't have chatId here — they'll be applied on first message
      logger.info(`[Onboarding] ${state.selected_skills.length} skills ready to activate for user ${userId}`);
    }

    logger.info(`[Onboarding] Downstream seeding complete for user ${userId}`);
  }

  // ── Skill Helpers ───────────────────────────────────────────────

  _recommendSkills(profile) {
    const categories = getCategoryList();
    const recommended = [];

    // Simple keyword-based matching against profile
    const profileText = profile
      ? Object.values(profile).filter(Boolean).join(' ').toLowerCase()
      : '';

    for (const cat of categories) {
      const skills = getSkillsByCategory(cat.key);
      for (const skill of skills) {
        const keywords = [
          skill.name.toLowerCase(),
          ...(skill.tags || []).map(t => t.toLowerCase()),
          (skill.description || '').toLowerCase(),
        ].join(' ');

        // Check for overlap between profile text and skill keywords
        const profileWords = profileText.split(/\s+/);
        const matches = profileWords.filter(w => w.length > 3 && keywords.includes(w));
        if (matches.length > 0) {
          recommended.push({ ...skill, matchScore: matches.length });
        }
      }
    }

    // Sort by match score, take top 5
    recommended.sort((a, b) => b.matchScore - a.matchScore);
    return recommended.slice(0, 5);
  }

  _buildSkillKeyboard(userId, selectedIds) {
    const categories = getCategoryList();
    const buttons = [];

    // Show recommended skills + all category skills
    const allSkills = [];
    for (const cat of categories) {
      const skills = getSkillsByCategory(cat.key);
      for (const skill of skills) {
        if (!allSkills.find(s => s.id === skill.id)) {
          allSkills.push(skill);
        }
      }
    }

    // Build rows of 2 buttons each
    for (let i = 0; i < Math.min(allSkills.length, 10); i += 2) {
      const row = [];
      for (let j = i; j < Math.min(i + 2, allSkills.length, 10); j++) {
        const s = allSkills[j];
        const isSelected = selectedIds.includes(s.id);
        row.push({
          text: `${isSelected ? '\u2705' : '\u2B1C'} ${s.emoji || ''} ${s.name}`,
          callback_data: `onboard_skill:${s.id}`,
        });
      }
      buttons.push(row);
    }

    buttons.push([
      { text: 'Done', callback_data: 'onboard_skills_done' },
      { text: 'Skip', callback_data: 'onboard_skip' },
    ]);

    return {
      keyboard: { inline_keyboard: buttons },
    };
  }
}
