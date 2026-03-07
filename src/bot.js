import TelegramBot from 'node-telegram-bot-api';
import { createReadStream, readFileSync } from 'fs';
import { isAllowedUser, getUnauthorizedMessage, alertAdmin } from './security/auth.js';
import { getLogger } from './utils/logger.js';
import { PROVIDERS } from './providers/models.js';
import {
  getSkillById,
  getCategoryList,
  getSkillsByCategory,
  loadAllSkills,
  saveCustomSkill,
  deleteCustomSkill,
  getCustomSkills,
} from './skills/loader.js';
import { TTSService } from './services/tts.js';
import { STTService } from './services/stt.js';
import { getClaudeAuthStatus, claudeLogout } from './claude-auth.js';
import { isQuietHours } from './utils/timeUtils.js';
import { CharacterBuilder } from './characters/builder.js';
import { LifeEngine } from './life/engine.js';
import { personaShield } from './utils/persona-shield.js';
import { OnboardingManager } from './onboarding/manager.js';
import { OnboardingFlow } from './onboarding/flow.js';

/**
 * Simulate a human-like typing delay based on response length.
 * Short replies (casual chat) get a brief pause; longer replies get more.
 * Keeps the typing indicator alive during the delay so the user sees "typing...".
 *
 * @param {TelegramBot} bot - Telegram bot instance
 * @param {number} chatId - Chat to show typing in
 * @param {string} text - The reply text (used to calculate delay)
 * @returns {Promise<void>}
 */
async function simulateTypingDelay(bot, chatId, text) {
  const length = (text || '').length;

  // ~25ms per character, clamped between 0.4s and 4s
  // Short "hey ❤️" (~6 chars) → 0.4s | Medium reply (~120 chars) → 3s | Long reply → 4s cap
  const delay = Math.min(4000, Math.max(400, length * 25));

  // Add a small random jitter (±15%) so it doesn't feel mechanical
  const jitter = delay * (0.85 + Math.random() * 0.3);
  const finalDelay = Math.round(jitter);

  // Keep the typing indicator alive during the delay
  bot.sendChatAction(chatId, 'typing').catch(() => {});

  return new Promise((resolve) => setTimeout(resolve, finalDelay));
}

/**
 * Simulate a brief pause between consecutive message chunks.
 * When a long reply is split into multiple Telegram messages, firing them
 * all instantly feels robotic. This adds a short, natural delay with a
 * typing indicator so multi-part replies feel more human.
 *
 * @param {TelegramBot} bot - Telegram bot instance
 * @param {number} chatId - Chat to show typing in
 * @param {string} nextChunk - The upcoming chunk (used to scale the pause)
 * @returns {Promise<void>}
 */
async function simulateInterChunkDelay(bot, chatId, nextChunk) {
  // Shorter than the initial typing delay: 0.3s – 1.5s based on chunk length
  const length = (nextChunk || '').length;
  const base = Math.min(1500, Math.max(300, length * 8));
  const jitter = base * (0.85 + Math.random() * 0.3);

  bot.sendChatAction(chatId, 'typing').catch(() => {});
  return new Promise((resolve) => setTimeout(resolve, Math.round(jitter)));
}

function splitMessage(text, maxLength = 4096) {
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline near the limit
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt < maxLength / 2) splitAt = maxLength;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  return chunks;
}

/**
 * Create an onUpdate callback that sends or edits Telegram messages.
 * Tries Markdown first, falls back to plain text.
 */
function createOnUpdate(bot, chatId) {
  const logger = getLogger();
  return async (update, opts = {}) => {
    if (opts.editMessageId) {
      try {
        const edited = await bot.editMessageText(update, {
          chat_id: chatId,
          message_id: opts.editMessageId,
          parse_mode: 'Markdown',
        });
        return edited.message_id;
      } catch (mdErr) {
        logger.debug(`[Bot] Markdown edit failed for chat ${chatId}, retrying plain: ${mdErr.message}`);
        try {
          const edited = await bot.editMessageText(update, {
            chat_id: chatId,
            message_id: opts.editMessageId,
          });
          return edited.message_id;
        } catch (plainErr) {
          logger.debug(`[Bot] Plain-text edit also failed for chat ${chatId}, sending new message: ${plainErr.message}`);
        }
      }
    }
    const parts = splitMessage(update);
    let lastMsgId = null;
    for (const part of parts) {
      try {
        const sent = await bot.sendMessage(chatId, part, { parse_mode: 'Markdown' });
        lastMsgId = sent.message_id;
      } catch (mdErr) {
        logger.debug(`[Bot] Markdown send failed for chat ${chatId}, falling back to plain: ${mdErr.message}`);
        try {
          const sent = await bot.sendMessage(chatId, part);
          lastMsgId = sent.message_id;
        } catch (plainErr) {
          logger.error(`[Bot] Plain-text send also failed for chat ${chatId}: ${plainErr.message}`);
        }
      }
    }
    return lastMsgId;
  };
}

/**
 * Create a sendPhoto callback that sends a photo with optional caption.
 * Tries Markdown caption first, falls back to plain caption.
 */
function createSendPhoto(bot, chatId, logger) {
  return async (filePath, caption) => {
    const fileOpts = { contentType: 'image/png' };
    try {
      await bot.sendPhoto(chatId, createReadStream(filePath), {
        caption: caption || '',
        parse_mode: 'Markdown',
      }, fileOpts);
    } catch {
      try {
        await bot.sendPhoto(chatId, createReadStream(filePath), {
          caption: caption || '',
        }, fileOpts);
      } catch (err) {
        logger.error(`Failed to send photo: ${err.message}`);
      }
    }
  };
}

/**
 * Create a sendReaction callback for reacting to messages with emoji.
 */
function createSendReaction(bot) {
  const logger = getLogger();
  return async (targetChatId, targetMsgId, emoji, isBig = false) => {
    try {
      await bot.setMessageReaction(targetChatId, targetMsgId, {
        reaction: [{ type: 'emoji', emoji }],
        is_big: isBig,
      });
    } catch (err) {
      logger.debug(`[Bot] Failed to set reaction for msg ${targetMsgId} in chat ${targetChatId}: ${err.message}`);
    }
  };
}

/**
 * Simple per-chat queue to serialize agent processing.
 * Each chat gets its own promise chain so messages are processed in order.
 * Automatically cleans up finished queues to avoid unbounded Map growth.
 */
class ChatQueue {
  constructor() {
    this.queues = new Map();
  }

  enqueue(chatId, fn) {
    const logger = getLogger();
    const key = String(chatId);
    const prev = this.queues.get(key) || Promise.resolve();
    const next = prev
      .then(() => fn())
      .catch((err) => {
        logger.error(`[ChatQueue] Error processing message for chat ${key}: ${err.message}`);
      })
      .finally(() => {
        // Clean up the queue entry once this is the last item in the chain,
        // preventing the Map from growing unboundedly over long-running sessions.
        if (this.queues.get(key) === next) {
          this.queues.delete(key);
        }
      });
    this.queues.set(key, next);
    return next;
  }
}

/**
 * Convert raw errors into user-friendly messages.
 * Uses the Persona Shield to hide technical details from end users.
 */
function _friendlyError(err) {
  return personaShield(err);
}

export function startBot(config, agent, conversationManager, jobManager, automationManager, lifeDeps = {}) {
  let { lifeEngine, memoryManager, journalManager, shareQueue, evolutionTracker, codebaseKnowledge, characterManager, dashboardHandle, dashboardDeps, consolidation, synthesisLoop, identityAwareness } = lifeDeps;
  const logger = getLogger();
  const bot = new TelegramBot(config.telegram.bot_token, {
    polling: {
      params: {
        allowed_updates: ['message', 'callback_query', 'message_reaction'],
      },
    },
  });
  const chatQueue = new ChatQueue();
  const batchWindowMs = config.telegram.batch_window_ms || 3000;

  // Initialize voice services
  const ttsService = new TTSService(config);
  const sttService = new STTService(config);
  if (ttsService.isAvailable()) logger.info('[Bot] TTS service enabled (ElevenLabs)');
  if (sttService.isAvailable()) logger.info('[Bot] STT service enabled');

  /**
   * Rebuild the life engine for a different character.
   * Stops the current engine, creates a new one with scoped managers, and starts it.
   */
  function rebuildLifeEngine(charCtx) {
    if (lifeEngine) {
      lifeEngine.stop();
    }

    // Update module-level manager refs so other bot.js code uses the right ones
    memoryManager = charCtx.memoryManager;
    journalManager = charCtx.journalManager;
    shareQueue = charCtx.shareQueue;
    evolutionTracker = charCtx.evolutionTracker;

    // Switch conversation file to the new character's conversations.json
    conversationManager.switchFile(charCtx.conversationFilePath);

    const lifeEnabled = config.life?.enabled !== false;
    if (!lifeEnabled) {
      lifeEngine = null;
      return;
    }

    lifeEngine = new LifeEngine({
      config,
      agent,
      memoryManager: charCtx.memoryManager,
      journalManager: charCtx.journalManager,
      shareQueue: charCtx.shareQueue,
      evolutionTracker: charCtx.evolutionTracker,
      codebaseKnowledge,
      selfManager: charCtx.selfManager,
      basePath: charCtx.lifeBasePath,
      characterId: charCtx.characterId,
      consolidation,
    });

    lifeEngine.wakeUp().then(() => {
      lifeEngine.start();
      logger.info(`[Bot] Life engine rebuilt for character: ${charCtx.characterId}`);
    }).catch(err => {
      logger.error(`[Bot] Life engine wake-up failed: ${err.message}`);
      lifeEngine.start();
    });
  }

  // ── Onboarding ──────────────────────────────────────────────────
  let onboardingManager = null;
  let onboardingFlow = null;
  const onboardingEnabled = config.onboarding?.enabled !== false;

  if (onboardingEnabled && agent._brainDB?.isOpen) {
    onboardingManager = new OnboardingManager(agent._brainDB);
    onboardingFlow = new OnboardingFlow({
      onboardingManager,
      provider: agent.orchestratorProvider,
      characterName: config.bot?.name || 'KernelBot',
      personaManager: agent.personaManager,
      conversationManager,
      identityAwareness,
    });
    agent.onboardingManager = onboardingManager;
    logger.info('[Bot] Onboarding system initialized');
  }

  // Per-chat message batching: chatId -> { messages[], timer, resolve }
  const chatBatches = new Map();

  // Load previous conversations from disk
  const loaded = conversationManager.load();
  if (loaded) {
    logger.info('Loaded previous conversations from disk');
  }

  // Load custom skills from disk
  loadAllSkills();

  // Register commands in Telegram's menu button
  bot.setMyCommands([
    { command: 'character', description: 'Switch or manage characters' },
    { command: 'brain', description: 'Switch worker AI model/provider' },
    { command: 'orchestrator', description: 'Switch orchestrator AI model/provider' },
    { command: 'claudemodel', description: 'Switch Claude Code model' },
    { command: 'claude', description: 'Manage Claude Code authentication' },
    { command: 'skills', description: 'Browse and activate persona skills' },
    { command: 'jobs', description: 'List running and recent jobs' },
    { command: 'cancel', description: 'Cancel running job(s)' },
    { command: 'auto', description: 'Manage recurring automations' },
    { command: 'life', description: 'Inner life engine status and control' },
    { command: 'journal', description: 'View today\'s journal or a past date' },
    { command: 'memories', description: 'View recent memories or search' },
    { command: 'senders', description: 'List known senders with trust levels' },
    { command: 'whois', description: 'Show sender profile (/whois username)' },
    { command: 'trust', description: 'Promote user to trusted (/trust username)' },
    { command: 'restrict', description: 'Demote user to unknown (/restrict username)' },
    { command: 'registerbot', description: 'Register AI agent (/registerbot bot purpose)' },
    { command: 'privacy', description: 'Show knowledge scope stats' },
    { command: 'evolution', description: 'Self-evolution status, history, and lessons' },
    { command: 'linkedin', description: 'Link/unlink LinkedIn account' },
    { command: 'x', description: 'Link/unlink X (Twitter) account' },
    { command: 'dashboard', description: 'Start/stop the monitoring dashboard' },
    { command: 'onboarding', description: 'Show onboarding status or reset' },
    { command: 'context', description: 'Show all models, auth, and context info' },
    { command: 'clean', description: 'Clear conversation and start fresh' },
    { command: 'history', description: 'Show message count in memory' },
    { command: 'help', description: 'Show all available commands' },
  ]).catch((err) => logger.warn(`Failed to set bot commands menu: ${err.message}`));

  logger.info('Telegram bot started with polling');

  // Initialize automation manager with bot context
  if (automationManager) {
    const sendMsg = async (chatId, text) => {
      try {
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
      } catch {
        await bot.sendMessage(chatId, text);
      }
    };

    const sendAction = (chatId, action) => bot.sendChatAction(chatId, action).catch(() => {});

    const agentFactory = (chatId) => {
      const onUpdate = createOnUpdate(bot, chatId);
      const sendPhoto = createSendPhoto(bot, chatId, logger);
      return { agent, onUpdate, sendPhoto };
    };

    automationManager.init({ sendMessage: sendMsg, sendChatAction: sendAction, agentFactory, config });
    automationManager.startAll();
    logger.info('[Bot] Automation manager initialized and started');
  }

  // Track pending brain API key input: chatId -> { providerKey, modelId }
  const pendingBrainKey = new Map();

  // Track pending orchestrator API key input: chatId -> { providerKey, modelId }
  const pendingOrchKey = new Map();

  // Track pending Claude Code auth input: chatId -> { type: 'api_key' | 'oauth_token' }
  const pendingClaudeAuth = new Map();

  // Track pending custom skill creation: chatId -> { step: 'name' | 'prompt', name?: string }
  const pendingCustomSkill = new Map();

  // Track pending custom character build: chatId -> { answers: {}, step: number }
  const pendingCharacterBuild = new Map();

  // Handle inline keyboard callbacks for /brain
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (!isAllowedUser(query.from.id, config)) {
      await bot.answerCallbackQuery(query.id, { text: 'Unauthorized' });
      await alertAdmin(bot, {
        userId: query.from.id,
        username: query.from.username,
        firstName: query.from.first_name,
        text: `🔘 زر: ${query.data || 'unknown'}`,
        type: 'callback',
      });
      return;
    }

    try {
      logger.info(`[Bot] Callback query from chat ${chatId}: ${data}`);

      if (data.startsWith('brain_provider:')) {
        // User picked a provider — show model list
        const providerKey = data.split(':')[1];
        const providerDef = PROVIDERS[providerKey];
        if (!providerDef) {
          await bot.answerCallbackQuery(query.id, { text: 'Unknown provider' });
          return;
        }

        const modelButtons = providerDef.models.map((m) => ([{
          text: m.label,
          callback_data: `brain_model:${providerKey}:${m.id}`,
        }]));
        modelButtons.push([{ text: 'Cancel', callback_data: 'brain_cancel' }]);

        await bot.editMessageText(`Select a *${providerDef.name}* model:`, {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: modelButtons },
        });
        await bot.answerCallbackQuery(query.id);

      } else if (data.startsWith('brain_model:')) {
        // User picked a model — attempt switch
        // Use split with limit to avoid truncating model IDs containing colons
        const parts = data.split(':');
        const providerKey = parts[1];
        const modelId = parts.slice(2).join(':');
        const providerDef = PROVIDERS[providerKey];
        const modelEntry = providerDef?.models.find((m) => m.id === modelId);
        const modelLabel = modelEntry ? modelEntry.label : modelId;

        await bot.editMessageText(
          `⏳ Verifying *${providerDef.name}* / *${modelLabel}*...`,
          {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'Markdown',
          },
        );

        logger.info(`[Bot] Brain switch request: ${providerKey}/${modelId} from chat ${chatId}`);
        const result = await agent.switchBrain(providerKey, modelId);
        if (result && typeof result === 'object' && result.error) {
          // Validation failed — keep current model
          logger.warn(`[Bot] Brain switch failed: ${result.error}`);
          const current = agent.getBrainInfo();
          await bot.editMessageText(
            `❌ Failed to switch: ${result.error}\n\nKeeping *${current.providerName}* / *${current.modelLabel}*`,
            {
              chat_id: chatId,
              message_id: query.message.message_id,
              parse_mode: 'Markdown',
            },
          );
        } else if (result) {
          // API key missing — ask for it
          logger.info(`[Bot] Brain switch needs API key: ${result} for ${providerKey}/${modelId}`);
          pendingBrainKey.set(chatId, { providerKey, modelId });
          await bot.editMessageText(
            `🔑 *${providerDef.name}* API key is required.\n\nPlease send your \`${result}\` now.\n\nOr send *cancel* to abort.`,
            {
              chat_id: chatId,
              message_id: query.message.message_id,
              parse_mode: 'Markdown',
            },
          );
        } else {
          const info = agent.getBrainInfo();
          logger.info(`[Bot] Brain switched successfully to ${info.providerName}/${info.modelLabel}`);
          await bot.editMessageText(
            `🧠 Brain switched to *${info.providerName}* / *${info.modelLabel}*`,
            {
              chat_id: chatId,
              message_id: query.message.message_id,
              parse_mode: 'Markdown',
            },
          );
        }
        await bot.answerCallbackQuery(query.id);

      } else if (data === 'brain_cancel') {
        pendingBrainKey.delete(chatId);
        await bot.editMessageText('Brain change cancelled.', {
          chat_id: chatId,
          message_id: query.message.message_id,
        });
        await bot.answerCallbackQuery(query.id);

      // ── Skill callbacks (multi-skill toggle) ─────────────────────
      } else if (data.startsWith('skill_category:')) {
        const categoryKey = data.split(':')[1];
        const skills = getSkillsByCategory(categoryKey);
        const categories = getCategoryList();
        const cat = categories.find((c) => c.key === categoryKey);
        if (!skills.length) {
          await bot.answerCallbackQuery(query.id, { text: 'No skills in this category' });
          return;
        }

        const activeIds = new Set(agent.getActiveSkillIds(chatId));
        const buttons = skills.map((s) => ([{
          text: `${activeIds.has(s.id) ? '✅ ' : ''}${s.emoji} ${s.name}`,
          callback_data: `skill_toggle:${s.id}:${categoryKey}`,
        }]));
        buttons.push([
          { text: '« Back', callback_data: 'skill_back' },
          { text: 'Done', callback_data: 'skill_cancel' },
        ]);

        const activeSkills = agent.getActiveSkills(chatId);
        const activeLine = activeSkills.length > 0
          ? `Active (${activeSkills.length}): ${activeSkills.map(s => `${s.emoji} ${s.name}`).join(', ')}\n\n`
          : '';

        await bot.editMessageText(
          `${activeLine}${cat ? cat.emoji : ''} *${cat ? cat.name : categoryKey}* — tap to toggle:`,
          {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons },
          },
        );
        await bot.answerCallbackQuery(query.id);

      } else if (data.startsWith('skill_toggle:')) {
        const parts = data.split(':');
        const skillId = parts[1];
        const categoryKey = parts[2]; // to refresh the category view
        const skill = getSkillById(skillId);
        if (!skill) {
          await bot.answerCallbackQuery(query.id, { text: 'Unknown skill' });
          return;
        }

        const { added, skills: currentSkills } = agent.toggleSkill(chatId, skillId);
        if (!added && currentSkills.includes(skillId)) {
          // Wasn't added because at max
          await bot.answerCallbackQuery(query.id, { text: `Max ${5} skills reached. Remove one first.` });
          return;
        }

        logger.info(`[Bot] Skill ${added ? 'activated' : 'deactivated'}: ${skill.name} (${skillId}) for chat ${chatId} — now ${currentSkills.length} active`);

        // Refresh the category view with updated toggles
        const catSkills = getSkillsByCategory(categoryKey);
        const categories = getCategoryList();
        const cat = categories.find((c) => c.key === categoryKey);
        const activeIds = new Set(agent.getActiveSkillIds(chatId));

        const buttons = catSkills.map((s) => ([{
          text: `${activeIds.has(s.id) ? '✅ ' : ''}${s.emoji} ${s.name}`,
          callback_data: `skill_toggle:${s.id}:${categoryKey}`,
        }]));
        buttons.push([
          { text: '« Back', callback_data: 'skill_back' },
          { text: 'Done', callback_data: 'skill_cancel' },
        ]);

        const activeSkills = agent.getActiveSkills(chatId);
        const activeLine = activeSkills.length > 0
          ? `Active (${activeSkills.length}): ${activeSkills.map(s => `${s.emoji} ${s.name}`).join(', ')}\n\n`
          : '';

        await bot.editMessageText(
          `${activeLine}${cat ? cat.emoji : ''} *${cat ? cat.name : categoryKey}* — tap to toggle:`,
          {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons },
          },
        );
        await bot.answerCallbackQuery(query.id, { text: added ? `✅ ${skill.name} on` : `❌ ${skill.name} off` });

      } else if (data === 'skill_reset') {
        logger.info(`[Bot] Skills cleared for chat ${chatId}`);
        agent.clearSkill(chatId);
        await bot.editMessageText('🔄 All skills cleared — back to default persona.', {
          chat_id: chatId,
          message_id: query.message.message_id,
        });
        await bot.answerCallbackQuery(query.id);

      } else if (data === 'skill_custom_add') {
        pendingCustomSkill.set(chatId, { step: 'name' });
        await bot.editMessageText(
          '✏️ Send me a *name* for your custom skill:',
          {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'Markdown',
          },
        );
        await bot.answerCallbackQuery(query.id);

      } else if (data === 'skill_custom_manage') {
        const customs = getCustomSkills();
        if (!customs.length) {
          await bot.answerCallbackQuery(query.id, { text: 'No custom skills yet' });
          return;
        }
        const buttons = customs.map((s) => ([{
          text: `🗑️ ${s.name}`,
          callback_data: `skill_custom_delete:${s.id}`,
        }]));
        buttons.push([{ text: '« Back', callback_data: 'skill_back' }]);

        await bot.editMessageText('🛠️ *Custom Skills* — tap to delete:', {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: buttons },
        });
        await bot.answerCallbackQuery(query.id);

      } else if (data.startsWith('skill_custom_delete:')) {
        const skillId = data.slice('skill_custom_delete:'.length);
        logger.info(`[Bot] Custom skill delete request: ${skillId} from chat ${chatId}`);
        // Remove from active skills if present
        const activeIds = agent.getActiveSkillIds(chatId);
        if (activeIds.includes(skillId)) {
          logger.info(`[Bot] Removing deleted skill from active set: ${skillId}`);
          agent.toggleSkill(chatId, skillId);
        }
        const deleted = deleteCustomSkill(skillId);
        const msg = deleted ? '🗑️ Custom skill deleted.' : 'Skill not found.';
        await bot.editMessageText(msg, {
          chat_id: chatId,
          message_id: query.message.message_id,
        });
        await bot.answerCallbackQuery(query.id);

      } else if (data === 'skill_back') {
        // Re-show category list
        const categories = getCategoryList();
        const activeSkills = agent.getActiveSkills(chatId);
        const buttons = categories.map((cat) => ([{
          text: `${cat.emoji} ${cat.name} (${cat.count})`,
          callback_data: `skill_category:${cat.key}`,
        }]));
        // Custom skill management row
        const customRow = [{ text: '➕ Add Custom', callback_data: 'skill_custom_add' }];
        if (getCustomSkills().length > 0) {
          customRow.push({ text: '🗑️ Manage Custom', callback_data: 'skill_custom_manage' });
        }
        buttons.push(customRow);
        const footerRow = [{ text: 'Done', callback_data: 'skill_cancel' }];
        if (activeSkills.length > 0) {
          footerRow.unshift({ text: '🔄 Clear All', callback_data: 'skill_reset' });
        }
        buttons.push(footerRow);

        const activeLine = activeSkills.length > 0
          ? `Active (${activeSkills.length}): ${activeSkills.map(s => `${s.emoji} ${s.name}`).join(', ')}\n\n`
          : '';
        const header = `${activeLine}🎭 *Skills* — select a category:`;

        await bot.editMessageText(header, {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: buttons },
        });
        await bot.answerCallbackQuery(query.id);

      } else if (data === 'skill_cancel') {
        const activeSkills = agent.getActiveSkills(chatId);
        const msg = activeSkills.length > 0
          ? `🎭 Active skills (${activeSkills.length}): ${activeSkills.map(s => `${s.emoji} ${s.name}`).join(', ')}`
          : 'No skills active.';
        await bot.editMessageText(msg, {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'Markdown',
        });
        await bot.answerCallbackQuery(query.id);

      // ── Job cancellation callbacks ────────────────────────────────
      } else if (data.startsWith('cancel_job:')) {
        const jobId = data.slice('cancel_job:'.length);
        logger.info(`[Bot] Job cancel request via callback: ${jobId} from chat ${chatId}`);
        const job = jobManager.cancelJob(jobId);
        if (job) {
          logger.info(`[Bot] Job cancelled via callback: ${jobId} [${job.workerType}]`);
          await bot.editMessageText(`🚫 Cancelled job \`${jobId}\` (${job.workerType})`, {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'Markdown',
          });
        } else {
          await bot.editMessageText(`Job \`${jobId}\` not found or already finished.`, {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'Markdown',
          });
        }
        await bot.answerCallbackQuery(query.id);

      } else if (data === 'cancel_all_jobs') {
        logger.info(`[Bot] Cancel all jobs request via callback from chat ${chatId}`);
        const cancelled = jobManager.cancelAllForChat(chatId);
        const msg = cancelled.length > 0
          ? `🚫 Cancelled ${cancelled.length} job(s).`
          : 'No running jobs to cancel.';
        await bot.editMessageText(msg, {
          chat_id: chatId,
          message_id: query.message.message_id,
        });
        await bot.answerCallbackQuery(query.id);

      // ── Automation callbacks ─────────────────────────────────────────
      } else if (data.startsWith('auto_pause:')) {
        const autoId = data.slice('auto_pause:'.length);
        logger.info(`[Bot] Automation pause request: ${autoId} from chat ${chatId}`);
        const auto = automationManager?.update(autoId, { enabled: false });
        const msg = auto ? `⏸️ Paused automation \`${autoId}\` (${auto.name})` : `Automation \`${autoId}\` not found.`;
        await bot.editMessageText(msg, { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' });
        await bot.answerCallbackQuery(query.id);

      } else if (data.startsWith('auto_resume:')) {
        const autoId = data.slice('auto_resume:'.length);
        logger.info(`[Bot] Automation resume request: ${autoId} from chat ${chatId}`);
        const auto = automationManager?.update(autoId, { enabled: true });
        const msg = auto ? `▶️ Resumed automation \`${autoId}\` (${auto.name})` : `Automation \`${autoId}\` not found.`;
        await bot.editMessageText(msg, { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' });
        await bot.answerCallbackQuery(query.id);

      } else if (data.startsWith('auto_delete:')) {
        const autoId = data.slice('auto_delete:'.length);
        logger.info(`[Bot] Automation delete request: ${autoId} from chat ${chatId}`);
        const deleted = automationManager?.delete(autoId);
        const msg = deleted ? `🗑️ Deleted automation \`${autoId}\`` : `Automation \`${autoId}\` not found.`;
        await bot.editMessageText(msg, { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' });
        await bot.answerCallbackQuery(query.id);

      // ── Orchestrator callbacks ─────────────────────────────────────
      } else if (data.startsWith('orch_provider:')) {
        const providerKey = data.split(':')[1];
        const providerDef = PROVIDERS[providerKey];
        if (!providerDef) {
          await bot.answerCallbackQuery(query.id, { text: 'Unknown provider' });
          return;
        }

        const modelButtons = providerDef.models.map((m) => ([{
          text: m.label,
          callback_data: `orch_model:${providerKey}:${m.id}`,
        }]));
        modelButtons.push([{ text: 'Cancel', callback_data: 'orch_cancel' }]);

        await bot.editMessageText(`Select a *${providerDef.name}* model for orchestrator:`, {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: modelButtons },
        });
        await bot.answerCallbackQuery(query.id);

      } else if (data.startsWith('orch_model:')) {
        // Use split with limit to avoid truncating model IDs containing colons
        const parts = data.split(':');
        const providerKey = parts[1];
        const modelId = parts.slice(2).join(':');
        const providerDef = PROVIDERS[providerKey];
        const modelEntry = providerDef?.models.find((m) => m.id === modelId);
        const modelLabel = modelEntry ? modelEntry.label : modelId;

        await bot.editMessageText(
          `⏳ Verifying *${providerDef.name}* / *${modelLabel}* for orchestrator...`,
          { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' },
        );

        logger.info(`[Bot] Orchestrator switch request: ${providerKey}/${modelId} from chat ${chatId}`);
        const result = await agent.switchOrchestrator(providerKey, modelId);
        if (result && typeof result === 'object' && result.error) {
          const current = agent.getOrchestratorInfo();
          await bot.editMessageText(
            `❌ Failed to switch: ${result.error}\n\nKeeping *${current.providerName}* / *${current.modelLabel}*`,
            { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' },
          );
        } else if (result) {
          // API key missing
          logger.info(`[Bot] Orchestrator switch needs API key: ${result} for ${providerKey}/${modelId}`);
          pendingOrchKey.set(chatId, { providerKey, modelId });
          await bot.editMessageText(
            `🔑 *${providerDef.name}* API key is required.\n\nPlease send your \`${result}\` now.\n\nOr send *cancel* to abort.`,
            { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' },
          );
        } else {
          const info = agent.getOrchestratorInfo();
          await bot.editMessageText(
            `🎛️ Orchestrator switched to *${info.providerName}* / *${info.modelLabel}*`,
            { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' },
          );
        }
        await bot.answerCallbackQuery(query.id);

      } else if (data === 'orch_cancel') {
        pendingOrchKey.delete(chatId);
        await bot.editMessageText('Orchestrator change cancelled.', {
          chat_id: chatId, message_id: query.message.message_id,
        });
        await bot.answerCallbackQuery(query.id);

      // ── Claude Code model callbacks ────────────────────────────────
      } else if (data.startsWith('ccmodel:')) {
        const modelId = data.slice('ccmodel:'.length);
        agent.switchClaudeCodeModel(modelId);
        const info = agent.getClaudeCodeInfo();
        logger.info(`[Bot] Claude Code model switched to ${info.modelLabel} from chat ${chatId}`);
        await bot.editMessageText(
          `💻 Claude Code model switched to *${info.modelLabel}*`,
          { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' },
        );
        await bot.answerCallbackQuery(query.id);

      } else if (data === 'ccmodel_cancel') {
        await bot.editMessageText('Claude Code model change cancelled.', {
          chat_id: chatId, message_id: query.message.message_id,
        });
        await bot.answerCallbackQuery(query.id);

      // ── Claude Code auth callbacks ─────────────────────────────────
      } else if (data === 'claude_apikey') {
        pendingClaudeAuth.set(chatId, { type: 'api_key' });
        await bot.editMessageText(
          '🔑 Send your *Anthropic API key* for Claude Code.\n\nOr send *cancel* to abort.',
          { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' },
        );
        await bot.answerCallbackQuery(query.id);

      } else if (data === 'claude_oauth') {
        pendingClaudeAuth.set(chatId, { type: 'oauth_token' });
        await bot.editMessageText(
          '🔑 Run `claude setup-token` locally and paste the *OAuth token* here.\n\nThis uses your Pro/Max subscription instead of an API key.\n\nOr send *cancel* to abort.',
          { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' },
        );
        await bot.answerCallbackQuery(query.id);

      } else if (data === 'claude_system') {
        agent.setClaudeCodeAuth('system', null);
        logger.info(`[Bot] Claude Code auth set to system from chat ${chatId}`);
        await bot.editMessageText(
          '🔓 Claude Code set to *system auth* — using host machine credentials.',
          { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' },
        );
        await bot.answerCallbackQuery(query.id);

      } else if (data === 'claude_status') {
        await bot.answerCallbackQuery(query.id, { text: 'Checking...' });
        const status = await getClaudeAuthStatus();
        const authConfig = agent.getClaudeAuthConfig();
        await bot.editMessageText(
          `🔐 *Claude Code Auth*\n\n*Mode:* ${authConfig.mode}\n*Credential:* ${authConfig.credential}\n\n*CLI Status:*\n\`\`\`\n${status.output.slice(0, 500)}\n\`\`\``,
          { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' },
        );

      } else if (data === 'claude_logout') {
        await bot.answerCallbackQuery(query.id, { text: 'Logging out...' });
        const result = await claudeLogout();
        await bot.editMessageText(
          `🚪 Claude Code logout: ${result.output || 'Done.'}`,
          { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' },
        );

      } else if (data === 'claude_cancel') {
        pendingClaudeAuth.delete(chatId);
        await bot.editMessageText('Claude Code auth management dismissed.', {
          chat_id: chatId, message_id: query.message.message_id,
        });
        await bot.answerCallbackQuery(query.id);

      // ── Character callbacks ────────────────────────────────────────
      } else if (data.startsWith('char_select:')) {
        const charId = data.slice('char_select:'.length);
        if (!characterManager) {
          await bot.answerCallbackQuery(query.id, { text: 'Character system not available' });
          return;
        }
        const character = characterManager.getCharacter(charId);
        if (!character) {
          await bot.answerCallbackQuery(query.id, { text: 'Character not found' });
          return;
        }
        const activeId = agent.getActiveCharacterInfo()?.id;
        const isActive = activeId === charId;
        const buttons = [];
        if (!isActive) {
          buttons.push([{ text: `Switch to ${character.emoji} ${character.name}`, callback_data: `char_confirm:${charId}` }]);
        }
        buttons.push([
          { text: '« Back', callback_data: 'char_back' },
          { text: 'Cancel', callback_data: 'char_cancel' },
        ]);

        const artBlock = character.asciiArt ? `\n\`\`\`\n${character.asciiArt}\n\`\`\`\n` : '\n';
        await bot.editMessageText(
          `${character.emoji} *${character.name}*\n_${character.origin || 'Original'}_${artBlock}\n"${character.tagline}"\n\n*Age:* ${character.age}\n${isActive ? '_(Currently active)_' : ''}`,
          {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons },
          },
        );
        await bot.answerCallbackQuery(query.id);

      } else if (data.startsWith('char_confirm:')) {
        const charId = data.slice('char_confirm:'.length);
        if (!characterManager) {
          await bot.answerCallbackQuery(query.id, { text: 'Character system not available' });
          return;
        }

        await bot.editMessageText(
          `Switching character...`,
          { chat_id: chatId, message_id: query.message.message_id },
        );

        try {
          const charCtx = await agent.switchCharacter(charId);

          // Rebuild life engine with new character's scoped managers
          rebuildLifeEngine(charCtx);

          const character = characterManager.getCharacter(charId);
          if (onboardingFlow) onboardingFlow.setCharacterName(character.name);
          logger.info(`[Bot] Character switched to ${character.name} (${charId})`);

          await bot.editMessageText(
            `${character.emoji} *${character.name}* is now active!\n\n"${character.tagline}"`,
            { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' },
          );
        } catch (err) {
          logger.error(`[Bot] Character switch failed: ${err.message}`);
          await bot.editMessageText(
            `Failed to switch character: ${err.message}`,
            { chat_id: chatId, message_id: query.message.message_id },
          );
        }
        await bot.answerCallbackQuery(query.id);

      } else if (data === 'char_custom') {
        pendingCharacterBuild.set(chatId, { answers: {}, step: 0 });
        const builder = new CharacterBuilder(agent.orchestratorProvider);
        const nextQ = builder.getNextQuestion({});
        if (nextQ) {
          await bot.editMessageText(
            `*Custom Character Builder* (1/${builder.getTotalQuestions()})\n\n${nextQ.question}\n\n_Examples: ${nextQ.examples}_\n\nSend *cancel* to abort.`,
            { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' },
          );
        }
        await bot.answerCallbackQuery(query.id);

      } else if (data.startsWith('char_delete:')) {
        const charId = data.slice('char_delete:'.length);
        if (!characterManager) {
          await bot.answerCallbackQuery(query.id, { text: 'Character system not available' });
          return;
        }
        const buttons = [
          [{ text: `Yes, delete`, callback_data: `char_delete_confirm:${charId}` }],
          [{ text: 'Cancel', callback_data: 'char_back' }],
        ];
        const character = characterManager.getCharacter(charId);
        await bot.editMessageText(
          `Are you sure you want to delete *${character?.name || charId}*?\n\nThis will remove all their memories, journals, and conversation history.`,
          {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons },
          },
        );
        await bot.answerCallbackQuery(query.id);

      } else if (data.startsWith('char_delete_confirm:')) {
        const charId = data.slice('char_delete_confirm:'.length);
        try {
          characterManager.removeCharacter(charId);
          await bot.editMessageText(`Character deleted.`, {
            chat_id: chatId, message_id: query.message.message_id,
          });
        } catch (err) {
          await bot.editMessageText(`Cannot delete: ${err.message}`, {
            chat_id: chatId, message_id: query.message.message_id,
          });
        }
        await bot.answerCallbackQuery(query.id);

      } else if (data === 'char_back') {
        // Re-show character gallery
        if (!characterManager) {
          await bot.answerCallbackQuery(query.id, { text: 'Character system not available' });
          return;
        }
        const characters = characterManager.listCharacters();
        const activeInfo = agent.getActiveCharacterInfo();
        const buttons = [];
        const row1 = [], row2 = [];
        for (const c of characters) {
          const label = `${c.emoji} ${c.name}${activeInfo?.id === c.id ? ' \u2713' : ''}`;
          const btn = { text: label, callback_data: `char_select:${c.id}` };
          if (row1.length < 3) row1.push(btn);
          else row2.push(btn);
        }
        if (row1.length > 0) buttons.push(row1);
        if (row2.length > 0) buttons.push(row2);

        // Custom character + delete buttons
        const mgmtRow = [{ text: 'Build Custom', callback_data: 'char_custom' }];
        const customChars = characters.filter(c => c.type === 'custom');
        if (customChars.length > 0) {
          mgmtRow.push({ text: 'Delete Custom', callback_data: 'char_delete_pick' });
        }
        buttons.push(mgmtRow);
        buttons.push([{ text: 'Cancel', callback_data: 'char_cancel' }]);

        await bot.editMessageText(
          `*Active:* ${activeInfo?.emoji || ''} ${activeInfo?.name || 'None'}\n_"${activeInfo?.tagline || ''}"_\n\nSelect a character:`,
          {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons },
          },
        );
        await bot.answerCallbackQuery(query.id);

      } else if (data === 'char_delete_pick') {
        const customChars = characterManager.listCharacters().filter(c => c.type === 'custom');
        if (customChars.length === 0) {
          await bot.answerCallbackQuery(query.id, { text: 'No custom characters' });
          return;
        }
        const buttons = customChars.map(c => ([{
          text: `${c.emoji} ${c.name}`,
          callback_data: `char_delete:${c.id}`,
        }]));
        buttons.push([{ text: '« Back', callback_data: 'char_back' }]);
        await bot.editMessageText('Select a custom character to delete:', {
          chat_id: chatId,
          message_id: query.message.message_id,
          reply_markup: { inline_keyboard: buttons },
        });
        await bot.answerCallbackQuery(query.id);

      } else if (data === 'char_cancel') {
        pendingCharacterBuild.delete(chatId);
        await bot.editMessageText('Character selection dismissed.', {
          chat_id: chatId, message_id: query.message.message_id,
        });
        await bot.answerCallbackQuery(query.id);

      // ── Onboarding callbacks ───────────────────────────────────────
      } else if (data.startsWith('onboard_select:')) {
        const charId = data.slice('onboard_select:'.length);
        if (!characterManager) {
          await bot.answerCallbackQuery(query.id, { text: 'Not available' });
          return;
        }

        characterManager.completeOnboarding(charId);
        const charCtx = await agent.loadCharacter(charId);
        const character = characterManager.getCharacter(charId);

        // Start life engine for the selected character
        rebuildLifeEngine(charCtx);

        // Update onboarding flow with character name
        if (onboardingFlow) onboardingFlow.setCharacterName(character.name);

        logger.info(`[Bot] Onboarding complete — character: ${character.name} (${charId})`);

        await bot.editMessageText(
          `${character.emoji} *${character.name}* activated!\n\n"${character.tagline}"\n\nSend me a message to start chatting.`,
          { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' },
        );
        await bot.answerCallbackQuery(query.id);

      } else if (data === 'onboard_custom') {
        // Start custom builder during onboarding — install builtins first
        if (characterManager?.needsOnboarding) {
          // Complete onboarding with kernel as default, then build custom
          characterManager.completeOnboarding('kernel');
          const kernelCtx = await agent.loadCharacter('kernel');
          rebuildLifeEngine(kernelCtx);
        }

        pendingCharacterBuild.set(chatId, { answers: {}, step: 0 });
        const builder = new CharacterBuilder(agent.orchestratorProvider);
        const nextQ = builder.getNextQuestion({});
        if (nextQ) {
          await bot.editMessageText(
            `*Custom Character Builder* (1/${builder.getTotalQuestions()})\n\n${nextQ.question}\n\n_Examples: ${nextQ.examples}_\n\nSend *cancel* to abort.`,
            { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' },
          );
        }
        await bot.answerCallbackQuery(query.id);

      // ── User onboarding callbacks ────────────────────────────────
      } else if (data.startsWith('onboard_skill:') && onboardingFlow) {
        const skillId = data.slice('onboard_skill:'.length);
        const result = onboardingFlow.handleSkillToggle(query.from.id, skillId);
        if (!result) {
          await bot.answerCallbackQuery(query.id, { text: 'Not in skills phase' });
          return;
        }
        if (result.alert) {
          await bot.answerCallbackQuery(query.id, { text: result.alert, show_alert: true });
          return;
        }
        // Update the inline keyboard
        try {
          await bot.editMessageReplyMarkup(result.keyboard, {
            chat_id: chatId,
            message_id: query.message.message_id,
          });
        } catch { /* message might not have changed */ }
        await bot.answerCallbackQuery(query.id);

      } else if (data === 'onboard_skills_done' && onboardingFlow) {
        await bot.answerCallbackQuery(query.id);
        const result = await onboardingFlow.confirmSkills(query.from.id);
        if (result.text) {
          await bot.sendMessage(chatId, result.text, { parse_mode: 'Markdown' });
        }

      } else if (data === 'onboard_skip' && onboardingFlow) {
        await bot.answerCallbackQuery(query.id);
        await onboardingFlow.skip(query.from.id);
        await bot.sendMessage(chatId, 'Onboarding skipped. You can always run /onboarding reset to start over.\n\nWhat can I help you with?');
      }
    } catch (err) {
      logger.error(`[Bot] Callback query error for "${data}" in chat ${chatId}: ${err.message}`);
      await bot.answerCallbackQuery(query.id, { text: 'Error' });
    }
  });

  /**
   * Batch messages for a chat. Returns the merged text for the first message,
   * or null for subsequent messages (they get merged into the first).
   */
  function batchMessage(chatId, text) {
    return new Promise((resolve) => {
      const key = String(chatId);
      let batch = chatBatches.get(key);

      if (!batch) {
        batch = { messages: [], timer: null, resolvers: [] };
        chatBatches.set(key, batch);
      }

      batch.messages.push(text);
      batch.resolvers.push(resolve);

      // Reset timer on each new message
      if (batch.timer) clearTimeout(batch.timer);

      batch.timer = setTimeout(() => {
        chatBatches.delete(key);
        const merged = batch.messages.length === 1
          ? batch.messages[0]
          : batch.messages.map((m, i) => `[${i + 1}]: ${m}`).join('\n\n');

        if (batch.messages.length > 1) {
          logger.info(`[Bot] Batch merged ${batch.messages.length} messages for chat ${key}`);
        }

        // First resolver gets the merged text, rest get null (skip)
        batch.resolvers[0](merged);
        for (let i = 1; i < batch.resolvers.length; i++) {
          batch.resolvers[i](null);
        }
      }, batchWindowMs);
    });
  }

  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username || msg.from.first_name || 'unknown';

    // Auth check
    if (!isAllowedUser(userId, config)) {
      if (msg.text || msg.document) {
        logger.warn(`Unauthorized access attempt from ${username} (${userId})`);
        await bot.sendMessage(chatId, getUnauthorizedMessage());
        await alertAdmin(bot, {
          userId,
          username: msg.from.username,
          firstName: msg.from.first_name,
          text: msg.text || (msg.document ? `📎 ملف: ${msg.document.file_name || 'unknown'}` : undefined),
          type: 'رسالة',
        });
      }
      return;
    }

    // ── Character onboarding ─────────────────────────────────────
    // On first-ever message, show character selection gallery
    if (characterManager?.needsOnboarding) {
      logger.info(`[Bot] First message from ${username} — showing character onboarding`);

      const characters = characterManager.listCharacters();
      const buttons = [];
      const row1 = [], row2 = [];
      for (const c of characters) {
        const btn = { text: `${c.emoji} ${c.name}`, callback_data: `onboard_select:${c.id}` };
        if (row1.length < 3) row1.push(btn);
        else row2.push(btn);
      }
      if (row1.length > 0) buttons.push(row1);
      if (row2.length > 0) buttons.push(row2);
      buttons.push([{ text: 'Build Custom', callback_data: 'onboard_custom' }]);

      await bot.sendMessage(chatId, [
        '*Choose Your Character*',
        '',
        'Pick who you want me to be. Each character has their own personality, memories, and story that evolves with you.',
        '',
        ...characters.map(c => `${c.emoji} *${c.name}* — _${c.tagline}_`),
        '',
        'Select below:',
      ].join('\n'), {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: buttons },
      });
      return;
    }

    // ── User onboarding ───────────────────────────────────────────
    // After character is chosen, onboard the user (profile → skills → training)
    if (onboardingManager && onboardingFlow) {
      // Check for /onboarding command first (bypass intercept)
      if (msg.text && msg.text.trim().startsWith('/onboarding')) {
        // Handled below in the commands section
      } else if (onboardingManager.needsOnboarding(userId)) {
        // Skip owner if configured
        const skipOwner = config.onboarding?.skip_for_owner && config.identity?.owner_id && String(config.identity.owner_id) === String(userId);
        if (!skipOwner) {
          onboardingManager.start(userId);
          const reply = await onboardingFlow.initiate(chatId, userId, msg.from);
          if (reply) {
            await bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
          }
          return;
        }
      } else if (onboardingManager.isOnboarding(userId)) {
        // Skip owner if configured (in case they got stuck mid-onboarding before fix)
        const skipOwnerMid = config.onboarding?.skip_for_owner && config.identity?.owner_id && String(config.identity.owner_id) === String(userId);
        if (skipOwnerMid) {
          onboardingManager.complete(userId);
          // Fall through to normal message processing
        } else {
          // User is mid-onboarding — route to flow
          if (!msg.text) return;
          const text = msg.text.trim();
          const result = await onboardingFlow.processMessage(chatId, userId, text, msg.from);
          if (result.text) {
            const sendOpts = { parse_mode: 'Markdown' };
            if (result.keyboard) sendOpts.reply_markup = result.keyboard;
            await bot.sendMessage(chatId, result.text, sendOpts);
          }
          if (!result.text && !result.keyboard) {
            // Onboarding just completed — activate selected skills for this chat
            const state = onboardingManager.getState(userId);
            if (state?.selected_skills?.length > 0) {
              const key = agent._chatKey ? agent._chatKey(chatId) : String(chatId);
              for (const skillId of state.selected_skills) {
                conversationManager.addSkill(key, skillId);
              }
              logger.info(`[Bot] Activated ${state.selected_skills.length} onboarding skills for chat ${chatId}`);
            }
            // Fall through to normal message processing
          } else {
            return;
          }
        }
      }
    }

    // Handle file upload for pending custom skill prompt step
    if (msg.document && pendingCustomSkill.has(chatId)) {
      const pending = pendingCustomSkill.get(chatId);
      if (pending.step === 'prompt') {
        const doc = msg.document;
        const mime = doc.mime_type || '';
        const fname = doc.file_name || '';
        if (!fname.endsWith('.md') && mime !== 'text/markdown' && mime !== 'text/plain') {
          await bot.sendMessage(chatId, 'Please upload a `.md` or plain text file, or type the prompt directly.');
          return;
        }
        try {
          const filePath = await bot.downloadFile(doc.file_id, '/tmp');
          const content = readFileSync(filePath, 'utf-8').trim();
          if (!content) {
            await bot.sendMessage(chatId, 'The file appears to be empty. Please try again.');
            return;
          }
          pendingCustomSkill.delete(chatId);
          const skill = saveCustomSkill({ name: pending.name, body: content });
          logger.info(`[Bot] Custom skill created from file: "${skill.name}" (${skill.id}) — ${content.length} chars, by ${username} in chat ${chatId}`);
          agent.toggleSkill(chatId, skill.id);
          await bot.sendMessage(
            chatId,
            `✅ Custom skill *${skill.name}* created and added to active skills!\n\n_Prompt loaded from file (${content.length} chars)_`,
            { parse_mode: 'Markdown' },
          );
        } catch (err) {
          logger.error(`Custom skill file upload error: ${err.message}`);
          await bot.sendMessage(chatId, `Failed to read file: ${err.message}`);
        }
        return;
      }
    }

    // Handle voice messages — transcribe and process as text
    if (msg.voice && sttService.isAvailable()) {
      logger.info(`[Bot] Voice message from ${username} (${userId}) in chat ${chatId}, duration: ${msg.voice.duration}s`);
      let tmpPath = null;
      try {
        const fileUrl = await bot.getFileLink(msg.voice.file_id);
        tmpPath = await sttService.downloadAudio(fileUrl);
        const transcribed = await sttService.transcribe(tmpPath);
        if (!transcribed) {
          await bot.sendMessage(chatId, 'Could not transcribe the voice message. Please try again or send text.');
          return;
        }
        logger.info(`[Bot] Transcribed voice: "${transcribed.slice(0, 100)}" from ${username} in chat ${chatId}`);
        // Show the user what was heard
        await bot.sendMessage(chatId, `🎤 _"${transcribed}"_`, { parse_mode: 'Markdown' });
        // Process as a normal text message (fall through below)
        msg.text = transcribed;
      } catch (err) {
        logger.error(`[Bot] Voice transcription failed: ${err.message}`);
        await bot.sendMessage(chatId, 'Failed to process voice message. Please try sending text instead.');
        return;
      } finally {
        if (tmpPath) sttService.cleanup(tmpPath);
      }
    }

    // Handle photo messages — download, convert to base64, and pass to LLM for vision analysis
    let imageAttachment = null;
    if (msg.photo && msg.photo.length > 0) {
      logger.info(`[Bot] Photo message from ${username} (${userId}) in chat ${chatId}`);
      try {
        // Use highest resolution (last item in array)
        const photo = msg.photo[msg.photo.length - 1];
        const fileLink = await bot.getFileLink(photo.file_id);
        const response = await fetch(fileLink);
        if (!response.ok) throw new Error(`Failed to download photo: ${response.statusText}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        const base64Data = buffer.toString('base64');

        // Determine media type from URL extension, default to jpeg
        const ext = fileLink.split('.').pop().split('?')[0].toLowerCase();
        const extToMime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
        const mediaType = extToMime[ext] || 'image/jpeg';

        imageAttachment = { type: 'base64', media_type: mediaType, data: base64Data };
        // Use caption as text, or default prompt
        if (!msg.text) {
          msg.text = msg.caption || 'What do you see in this image? Describe it in detail.';
        }
        logger.info(`[Bot] Photo downloaded and encoded (${Math.round(base64Data.length / 1024)}KB base64, ${mediaType})`);
      } catch (err) {
        logger.error(`[Bot] Photo processing failed: ${err.message}`);
        await bot.sendMessage(chatId, 'Failed to process the image. Please try again.');
        return;
      }
    }

    if (!msg.text) return; // ignore non-text (and non-document) messages

    let text = msg.text.trim();

    // Handle pending brain API key input
    if (pendingBrainKey.has(chatId)) {
      const pending = pendingBrainKey.get(chatId);
      pendingBrainKey.delete(chatId);

      if (text.toLowerCase() === 'cancel') {
        logger.info(`[Bot] Brain key input cancelled by ${username} in chat ${chatId}`);
        await bot.sendMessage(chatId, 'Brain change cancelled.');
        return;
      }

      logger.info(`[Bot] Brain key received for ${pending.providerKey}/${pending.modelId} from ${username} in chat ${chatId}`);
      await bot.sendMessage(chatId, '⏳ Verifying API key...');
      const switchResult = await agent.switchBrainWithKey(pending.providerKey, pending.modelId, text);
      if (switchResult && switchResult.error) {
        const current = agent.getBrainInfo();
        await bot.sendMessage(
          chatId,
          `❌ Failed to switch: ${switchResult.error}\n\nKeeping *${current.providerName}* / *${current.modelLabel}*`,
          { parse_mode: 'Markdown' },
        );
      } else {
        const info = agent.getBrainInfo();
        await bot.sendMessage(
          chatId,
          `🧠 Brain switched to *${info.providerName}* / *${info.modelLabel}*\n\nAPI key saved.`,
          { parse_mode: 'Markdown' },
        );
      }
      return;
    }

    // Handle pending orchestrator API key input
    if (pendingOrchKey.has(chatId)) {
      const pending = pendingOrchKey.get(chatId);
      pendingOrchKey.delete(chatId);

      if (text.toLowerCase() === 'cancel') {
        logger.info(`[Bot] Orchestrator key input cancelled by ${username} in chat ${chatId}`);
        await bot.sendMessage(chatId, 'Orchestrator change cancelled.');
        return;
      }

      logger.info(`[Bot] Orchestrator key received for ${pending.providerKey}/${pending.modelId} from ${username} in chat ${chatId}`);
      await bot.sendMessage(chatId, '⏳ Verifying API key...');
      const switchResult = await agent.switchOrchestratorWithKey(pending.providerKey, pending.modelId, text);
      if (switchResult && switchResult.error) {
        const current = agent.getOrchestratorInfo();
        await bot.sendMessage(
          chatId,
          `❌ Failed to switch: ${switchResult.error}\n\nKeeping *${current.providerName}* / *${current.modelLabel}*`,
          { parse_mode: 'Markdown' },
        );
      } else {
        const info = agent.getOrchestratorInfo();
        await bot.sendMessage(
          chatId,
          `🎛️ Orchestrator switched to *${info.providerName}* / *${info.modelLabel}*\n\nAPI key saved.`,
          { parse_mode: 'Markdown' },
        );
      }
      return;
    }

    // Handle pending Claude Code auth input
    if (pendingClaudeAuth.has(chatId)) {
      const pending = pendingClaudeAuth.get(chatId);
      pendingClaudeAuth.delete(chatId);

      if (text.toLowerCase() === 'cancel') {
        logger.info(`[Bot] Claude Code auth input cancelled by ${username} in chat ${chatId}`);
        await bot.sendMessage(chatId, 'Claude Code auth setup cancelled.');
        return;
      }

      agent.setClaudeCodeAuth(pending.type, text);
      const label = pending.type === 'api_key' ? 'API Key' : 'OAuth Token';
      logger.info(`[Bot] Claude Code ${label} saved from ${username} in chat ${chatId}`);
      await bot.sendMessage(
        chatId,
        `🔐 Claude Code *${label}* saved and activated.\n\nNext Claude Code spawn will use this credential.`,
        { parse_mode: 'Markdown' },
      );
      return;
    }

    // Handle pending custom skill creation (text input for name or prompt)
    if (pendingCustomSkill.has(chatId)) {
      const pending = pendingCustomSkill.get(chatId);

      if (text.toLowerCase() === 'cancel') {
        pendingCustomSkill.delete(chatId);
        await bot.sendMessage(chatId, 'Custom skill creation cancelled.');
        return;
      }

      if (pending.step === 'name') {
        pending.name = text;
        pending.step = 'prompt';
        pendingCustomSkill.set(chatId, pending);
        await bot.sendMessage(
          chatId,
          `Got it: *${text}*\n\nNow send the system prompt — type it out or upload a \`.md\` file:`,
          { parse_mode: 'Markdown' },
        );
        return;
      }

      if (pending.step === 'prompt') {
        pendingCustomSkill.delete(chatId);
        const skill = saveCustomSkill({ name: pending.name, body: text });
        logger.info(`[Bot] Custom skill created: "${skill.name}" (${skill.id}) by ${username} in chat ${chatId}`);
        agent.toggleSkill(chatId, skill.id);
        await bot.sendMessage(
          chatId,
          `✅ Custom skill *${skill.name}* created and added to active skills!`,
          { parse_mode: 'Markdown' },
        );
        return;
      }
    }

    // Handle pending custom character build
    if (pendingCharacterBuild.has(chatId)) {
      const pending = pendingCharacterBuild.get(chatId);

      if (text.toLowerCase() === 'cancel') {
        pendingCharacterBuild.delete(chatId);
        await bot.sendMessage(chatId, 'Character creation cancelled.');
        return;
      }

      const builder = new CharacterBuilder(agent.orchestratorProvider);
      const nextQ = builder.getNextQuestion(pending.answers);
      if (nextQ) {
        pending.answers[nextQ.id] = text;
        pending.step++;
        pendingCharacterBuild.set(chatId, pending);

        const followUp = builder.getNextQuestion(pending.answers);
        if (followUp) {
          const { answered, total } = builder.getProgress(pending.answers);
          await bot.sendMessage(
            chatId,
            `*Custom Character Builder* (${answered + 1}/${total})\n\n${followUp.question}\n\n_Examples: ${followUp.examples}_`,
            { parse_mode: 'Markdown' },
          );
        } else {
          // All questions answered — generate character
          pendingCharacterBuild.delete(chatId);
          await bot.sendMessage(chatId, 'Creating your character...');

          try {
            const result = await builder.generateCharacter(pending.answers);
            const profile = characterManager.addCharacter(
              {
                id: result.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
                type: 'custom',
                name: result.name,
                origin: 'Custom',
                age: result.age,
                emoji: result.emoji,
                tagline: result.tagline,
              },
              result.personaMd,
              result.selfDefaults,
            );

            // Auto-switch to the new character and rebuild life engine
            const charCtx = await agent.switchCharacter(profile.id);
            rebuildLifeEngine(charCtx);

            await bot.sendMessage(
              chatId,
              `${profile.emoji} *${profile.name}* has been created and activated!\n\n"${profile.tagline}"\n\n_Use /character to switch between characters._`,
              { parse_mode: 'Markdown' },
            );
            logger.info(`[Bot] Custom character created: ${profile.name} (${profile.id}) by ${username}`);
          } catch (err) {
            logger.error(`[Bot] Character generation failed: ${err.message}`);
            await bot.sendMessage(chatId, `Failed to create character: ${err.message}\n\nUse /character to try again.`);
          }
        }
      }
      return;
    }

    // Handle commands — these bypass batching entirely
    if (text === '/character') {
      logger.info(`[Bot] /character command from ${username} (${userId}) in chat ${chatId}`);
      if (!characterManager) {
        await bot.sendMessage(chatId, 'Character system not available.');
        return;
      }
      const characters = characterManager.listCharacters();
      const activeInfo = agent.getActiveCharacterInfo();
      const buttons = [];
      const row1 = [], row2 = [];
      for (const c of characters) {
        const label = `${c.emoji} ${c.name}${activeInfo?.id === c.id ? ' \u2713' : ''}`;
        const btn = { text: label, callback_data: `char_select:${c.id}` };
        if (row1.length < 3) row1.push(btn);
        else row2.push(btn);
      }
      if (row1.length > 0) buttons.push(row1);
      if (row2.length > 0) buttons.push(row2);

      // Custom character + delete buttons
      const mgmtRow = [{ text: 'Build Custom', callback_data: 'char_custom' }];
      const customChars = characters.filter(c => c.type === 'custom');
      if (customChars.length > 0) {
        mgmtRow.push({ text: 'Delete Custom', callback_data: 'char_delete_pick' });
      }
      buttons.push(mgmtRow);
      buttons.push([{ text: 'Cancel', callback_data: 'char_cancel' }]);

      await bot.sendMessage(
        chatId,
        `*Active:* ${activeInfo?.emoji || ''} ${activeInfo?.name || 'None'}\n_"${activeInfo?.tagline || ''}"_\n\nSelect a character:`,
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: buttons },
        },
      );
      return;
    }

    if (text === '/brain') {
      logger.info(`[Bot] /brain command from ${username} (${userId}) in chat ${chatId}`);
      const info = agent.getBrainInfo();
      const providerKeys = Object.keys(PROVIDERS);
      const buttons = providerKeys.map((key) => ([{
        text: `${PROVIDERS[key].name}${key === info.provider ? ' ✓' : ''}`,
        callback_data: `brain_provider:${key}`,
      }]));
      buttons.push([{ text: 'Cancel', callback_data: 'brain_cancel' }]);

      await bot.sendMessage(
        chatId,
        `🧠 *Current brain:* ${info.providerName} / ${info.modelLabel}\n\nSelect a provider to switch:`,
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: buttons },
        },
      );
      return;
    }

    if (text === '/orchestrator') {
      logger.info(`[Bot] /orchestrator command from ${username} (${userId}) in chat ${chatId}`);
      const info = agent.getOrchestratorInfo();
      const providerKeys = Object.keys(PROVIDERS);
      const buttons = providerKeys.map((key) => ([{
        text: `${PROVIDERS[key].name}${key === info.provider ? ' ✓' : ''}`,
        callback_data: `orch_provider:${key}`,
      }]));
      buttons.push([{ text: 'Cancel', callback_data: 'orch_cancel' }]);

      await bot.sendMessage(
        chatId,
        `🎛️ *Current orchestrator:* ${info.providerName} / ${info.modelLabel}\n\nSelect a provider to switch:`,
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: buttons },
        },
      );
      return;
    }

    if (text === '/claudemodel') {
      logger.info(`[Bot] /claudemodel command from ${username} (${userId}) in chat ${chatId}`);
      const info = agent.getClaudeCodeInfo();
      const anthropicModels = PROVIDERS.anthropic.models;
      const buttons = anthropicModels.map((m) => ([{
        text: `${m.label}${m.id === info.model ? ' ✓' : ''}`,
        callback_data: `ccmodel:${m.id}`,
      }]));
      buttons.push([{ text: 'Cancel', callback_data: 'ccmodel_cancel' }]);

      await bot.sendMessage(
        chatId,
        `💻 *Current Claude Code model:* ${info.modelLabel}\n\nSelect a model:`,
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: buttons },
        },
      );
      return;
    }

    if (text === '/claude') {
      logger.info(`[Bot] /claude command from ${username} (${userId}) in chat ${chatId}`);
      const authConfig = agent.getClaudeAuthConfig();
      const ccInfo = agent.getClaudeCodeInfo();

      const modeLabels = { system: '🔓 System Login', api_key: '🔑 API Key', oauth_token: '🎫 OAuth Token (Pro/Max)' };
      const modeLabel = modeLabels[authConfig.mode] || authConfig.mode;

      const buttons = [
        [{ text: '🔑 Set API Key', callback_data: 'claude_apikey' }],
        [{ text: '🎫 Set OAuth Token (Pro/Max)', callback_data: 'claude_oauth' }],
        [{ text: '🔓 Use System Auth', callback_data: 'claude_system' }],
        [
          { text: '🔄 Refresh Status', callback_data: 'claude_status' },
          { text: '🚪 Logout', callback_data: 'claude_logout' },
        ],
        [{ text: 'Cancel', callback_data: 'claude_cancel' }],
      ];

      await bot.sendMessage(
        chatId,
        `🔐 *Claude Code Auth*\n\n*Auth Mode:* ${modeLabel}\n*Credential:* ${authConfig.credential}\n*Model:* ${ccInfo.modelLabel}\n\nSelect an action:`,
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: buttons },
        },
      );
      return;
    }

    // ── /skills forge subcommands ──────────────────────────────
    if (text === '/skills forge' || text === '/skill forge') {
      logger.info(`[Bot] /skills forge from ${username} (${userId}) in chat ${chatId}`);
      const forge = agent.skillForge;
      const status = forge.getForgeStatus();

      if (status.total === 0) {
        await bot.sendMessage(chatId, '🔨 *Skill Forge*\n\nNo learned skills yet. Use `/skills forge learn <topic>` to start learning.', { parse_mode: 'Markdown' });
        return;
      }

      const statusEmoji = { seed: '🌱', growing: '🌿', mature: '🌳', contributed: '🎁' };
      const skillLines = status.skills.map(s =>
        `${statusEmoji[s.status] || '📦'} *${s.topic}* — ${s.status} (${s.maturity}/10) — ${s.researchCount} research sessions`
      ).join('\n');

      const summary = [
        '🔨 *Skill Forge*',
        '',
        `Total: ${status.total} | 🌱 ${status.byStatus.seed || 0} seed | 🌿 ${status.byStatus.growing || 0} growing | 🌳 ${status.byStatus.mature || 0} mature | 🎁 ${status.byStatus.contributed || 0} contributed`,
        '',
        skillLines,
      ].join('\n');

      await bot.sendMessage(chatId, summary, { parse_mode: 'Markdown' });
      return;
    }

    if (text.startsWith('/skills forge learn ') || text.startsWith('/skill forge learn ')) {
      const topic = text.replace(/^\/skills? forge learn\s+/, '').trim();
      if (!topic) {
        await bot.sendMessage(chatId, '❌ Please provide a topic: `/skills forge learn <topic>`', { parse_mode: 'Markdown' });
        return;
      }
      logger.info(`[Bot] /skills forge learn "${topic}" from ${username} (${userId}) in chat ${chatId}`);
      const forge = agent.skillForge;
      const meta = await forge.seedSkill(topic);
      if (meta) {
        await bot.sendMessage(chatId, `🌱 Started learning about *${topic}*!\n\nThe skill will grow through autonomous research during my inner life activities. You can also trigger growth with \`/life trigger learn\`.`, { parse_mode: 'Markdown' });
      } else {
        await bot.sendMessage(chatId, `❌ Failed to create skill for "${topic}".`);
      }
      return;
    }

    if (text.startsWith('/skills forge grow ') || text.startsWith('/skill forge grow ')) {
      const skillIdOrTopic = text.replace(/^\/skills? forge grow\s+/, '').trim();
      if (!skillIdOrTopic) {
        await bot.sendMessage(chatId, '❌ Please provide a skill ID: `/skills forge grow <skill_id>`', { parse_mode: 'Markdown' });
        return;
      }
      logger.info(`[Bot] /skills forge grow "${skillIdOrTopic}" from ${username} (${userId}) in chat ${chatId}`);
      const forge = agent.skillForge;

      // Try to find by ID first, then by topic match
      let meta = forge.getSkillMeta(skillIdOrTopic);
      if (!meta) {
        const allSkills = Object.values(forge._data.skills);
        meta = allSkills.find(s => s.topic.toLowerCase() === skillIdOrTopic.toLowerCase());
      }

      if (!meta) {
        await bot.sendMessage(chatId, `❌ Skill "${skillIdOrTopic}" not found in forge. Use \`/skills forge\` to see available skills.`, { parse_mode: 'Markdown' });
        return;
      }

      await bot.sendMessage(chatId, `🌿 Triggering growth for *${meta.topic}*... This will dispatch a research worker.`, { parse_mode: 'Markdown' });
      // Process through the agent so a research worker gets dispatched
      await agent.processMessage(chatId, `Research and find the latest developments about "${meta.topic}". Focus on what's new, best practices, and practical insights. This is to grow my knowledge skill about this topic.`, { id: userId, username }, onUpdate, sendPhoto);
      return;
    }

    if (text === '/skills forge contribute' || text === '/skill forge contribute') {
      logger.info(`[Bot] /skills forge contribute from ${username} (${userId}) in chat ${chatId}`);
      const forge = agent.skillForge;
      const mature = forge.getMatureSkills();

      if (mature.length === 0) {
        await bot.sendMessage(chatId, '🔨 No skills are mature enough for contribution yet. Skills need maturity 7+ to be contributed.', { parse_mode: 'Markdown' });
        return;
      }

      const lines = mature.map(s => `🌳 *${s.topic}* (maturity ${s.maturity}/10)`).join('\n');
      await bot.sendMessage(chatId,
        `🎁 *Ready for Contribution*\n\n${lines}\n\nTo contribute these skills as a PR, dispatch a coding worker to prepare and submit them.`,
        { parse_mode: 'Markdown' },
      );
      return;
    }

    if (text === '/skills reset' || text === '/skill reset') {
      logger.info(`[Bot] /skills reset from ${username} (${userId}) in chat ${chatId}`);
      agent.clearSkill(chatId);
      await bot.sendMessage(chatId, '🔄 All skills cleared — back to default persona.');
      return;
    }

    if (text === '/skills' || text === '/skill') {
      logger.info(`[Bot] /skills command from ${username} (${userId}) in chat ${chatId}`);
      const categories = getCategoryList();
      const activeSkills = agent.getActiveSkills(chatId);
      const buttons = categories.map((cat) => ([{
        text: `${cat.emoji} ${cat.name} (${cat.count})`,
        callback_data: `skill_category:${cat.key}`,
      }]));
      // Custom skill management row
      const customRow = [{ text: '➕ Add Custom', callback_data: 'skill_custom_add' }];
      if (getCustomSkills().length > 0) {
        customRow.push({ text: '🗑️ Manage Custom', callback_data: 'skill_custom_manage' });
      }
      buttons.push(customRow);
      const footerRow = [{ text: 'Cancel', callback_data: 'skill_cancel' }];
      if (activeSkills.length > 0) {
        footerRow.unshift({ text: '🔄 Clear All', callback_data: 'skill_reset' });
      }
      buttons.push(footerRow);

      const activeLine = activeSkills.length > 0
        ? `Active (${activeSkills.length}): ${activeSkills.map(s => `${s.emoji} ${s.name}`).join(', ')}\n\n`
        : '';
      const header = `${activeLine}🎭 *Skills* — select a category:`;

      await bot.sendMessage(chatId, header, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: buttons },
      });
      return;
    }

    if (text === '/clean' || text === '/clear' || text === '/reset') {
      agent.clearConversation(chatId);
      logger.info(`Conversation cleared for chat ${chatId} by ${username}`);
      await bot.sendMessage(chatId, '🧹 Conversation cleared. Starting fresh.');
      return;
    }

    if (text === '/history') {
      const count = agent.getMessageCount(chatId);
      await bot.sendMessage(chatId, `📝 This chat has *${count}* messages in memory.`, { parse_mode: 'Markdown' });
      return;
    }

    if (text === '/context') {
      const info = agent.getBrainInfo();
      const orchInfo = agent.getOrchestratorInfo();
      const ccInfo = agent.getClaudeCodeInfo();
      const authConfig = agent.getClaudeAuthConfig();
      const activeSkills = agent.getActiveSkills(chatId);
      const msgCount = agent.getMessageCount(chatId);
      const history = agent.getConversationHistory(chatId);
      const maxHistory = conversationManager.maxHistory;
      const recentWindow = conversationManager.recentWindow;

      // Build recent topics from last few user messages
      const recentUserMsgs = history
        .filter((m) => m.role === 'user')
        .slice(-5)
        .map((m) => {
          const txt = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
          return txt.length > 80 ? txt.slice(0, 80) + '…' : txt;
        });

      const activeChar = agent.getActiveCharacterInfo();

      const lines = [
        '📋 *Conversation Context*',
        '',
        activeChar
          ? `${activeChar.emoji} *Character:* ${activeChar.name}`
          : '',
        `🎛️ *Orchestrator:* ${orchInfo.providerName} / ${orchInfo.modelLabel}`,
        `🧠 *Brain (Workers):* ${info.providerName} / ${info.modelLabel}`,
        `💻 *Claude Code:* ${ccInfo.modelLabel} (auth: ${authConfig.mode})`,
        activeSkills.length > 0
          ? `🎭 *Skills (${activeSkills.length}):* ${activeSkills.map(s => `${s.emoji} ${s.name}`).join(', ')}`
          : '🎭 *Skills:* None (default persona)',
        `💬 *Messages in memory:* ${msgCount} / ${maxHistory}`,
        `📌 *Recent window:* ${recentWindow} messages`,
      ].filter(Boolean);

      if (recentUserMsgs.length > 0) {
        lines.push('', '🕐 *Recent topics:*');
        recentUserMsgs.forEach((msg) => lines.push(`  • ${msg}`));
      } else {
        lines.push('', '_No messages yet — start chatting!_');
      }

      await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
      return;
    }

    if (text === '/jobs') {
      logger.info(`[Bot] /jobs command from ${username} (${userId}) in chat ${chatId}`);
      const jobs = jobManager.getJobsForChat(chatId);
      if (jobs.length === 0) {
        await bot.sendMessage(chatId, 'No jobs for this chat.');
        return;
      }
      const lines = ['*Jobs*', ''];
      for (const job of jobs.slice(0, 15)) {
        lines.push(job.toSummary());
      }
      if (jobs.length > 15) {
        lines.push(`\n_... and ${jobs.length - 15} more_`);
      }
      await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
      return;
    }

    if (text === '/cancel') {
      logger.info(`[Bot] /cancel command from ${username} (${userId}) in chat ${chatId}`);
      const running = jobManager.getRunningJobsForChat(chatId);
      if (running.length === 0) {
        logger.debug(`[Bot] /cancel — no running jobs for chat ${chatId}`);
        await bot.sendMessage(chatId, 'No running jobs to cancel.');
        return;
      }
      if (running.length === 1) {
        logger.info(`[Bot] /cancel — single job ${running[0].id}, cancelling directly`);
        const job = jobManager.cancelJob(running[0].id);
        if (job) {
          await bot.sendMessage(chatId, `🚫 Cancelled \`${job.id}\` (${job.workerType})`, { parse_mode: 'Markdown' });
        }
        return;
      }
      // Multiple running — show inline keyboard
      logger.info(`[Bot] /cancel — ${running.length} running jobs, showing picker`);
      const buttons = running.map((j) => ([{
        text: `🚫 ${j.workerType} (${j.id})`,
        callback_data: `cancel_job:${j.id}`,
      }]));
      buttons.push([{ text: '🚫 Cancel All', callback_data: 'cancel_all_jobs' }]);
      await bot.sendMessage(chatId, `*${running.length} running jobs* — select one to cancel:`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: buttons },
      });
      return;
    }

    // ── /life command ──────────────────────────────────────────────
    if (text === '/life' || text.startsWith('/life ')) {
      logger.info(`[Bot] /life command from ${username} (${userId}) in chat ${chatId}`);
      const args = text.slice('/life'.length).trim();

      if (!lifeEngine) {
        await bot.sendMessage(chatId, 'Life engine is not available.');
        return;
      }

      if (args === 'pause') {
        lifeEngine.pause();
        await bot.sendMessage(chatId, '⏸️ Inner life paused. Use `/life resume` to restart.', { parse_mode: 'Markdown' });
        return;
      }
      if (args === 'resume') {
        lifeEngine.resume();
        await bot.sendMessage(chatId, '▶️ Inner life resumed!');
        return;
      }
      if (args.startsWith('trigger')) {
        const activityType = args.split(/\s+/)[1] || null;
        const validTypes = ['think', 'browse', 'journal', 'create', 'self_code', 'code_review', 'reflect'];
        if (activityType && !validTypes.includes(activityType)) {
          await bot.sendMessage(chatId, `Unknown activity type. Available: ${validTypes.join(', ')}`);
          return;
        }
        await bot.sendMessage(chatId, `⚡ Triggering ${activityType || 'random'} activity...`);
        lifeEngine.triggerNow(activityType).catch(err => {
          logger.error(`[Bot] Life trigger failed: ${err.message}`);
        });
        return;
      }
      if (args === 'review') {
        if (evolutionTracker) {
          const active = evolutionTracker.getActiveProposal();
          const openPRs = evolutionTracker.getPRsToCheck();
          const lines = ['*Evolution Status*', ''];
          if (active) {
            lines.push(`Active: \`${active.id}\` — ${active.status}`);
            lines.push(`  ${(active.triggerContext || '').slice(0, 150)}`);
          } else {
            lines.push('_No active proposals._');
          }
          if (openPRs.length > 0) {
            lines.push('', '*Open PRs:*');
            for (const p of openPRs) {
              lines.push(`  • PR #${p.prNumber}: ${p.prUrl || 'no URL'}`);
            }
          }
          lines.push('', '_Use `/evolution` for full evolution status._');
          await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
        } else {
          await bot.sendMessage(chatId, 'Evolution system not available. Use `/evolution` for details.', { parse_mode: 'Markdown' });
        }
        return;
      }

      // Default: show status
      const status = lifeEngine.getStatus();
      const lines = [
        '🌱 *Inner Life*',
        '',
        `*Status:* ${status.paused ? '⏸️ Paused' : status.status === 'active' ? '🟢 Active' : '⚪ Idle'}`,
        `*Total activities:* ${status.totalActivities}`,
        `*Last activity:* ${status.lastActivity || 'none'} (${status.lastActivityAgo})`,
        `*Last wake-up:* ${status.lastWakeUpAgo}`,
        '',
        '*Activity counts:*',
        `  💭 Think: ${status.activityCounts.think || 0}`,
        `  🌐 Browse: ${status.activityCounts.browse || 0}`,
        `  📓 Journal: ${status.activityCounts.journal || 0}`,
        `  🎨 Create: ${status.activityCounts.create || 0}`,
        `  🔧 Self-code: ${status.activityCounts.self_code || 0}`,
        `  🔍 Code review: ${status.activityCounts.code_review || 0}`,
        `  🪞 Reflect: ${status.activityCounts.reflect || 0}`,
        '',
        '_Commands:_',
        '`/life pause` — Pause activities',
        '`/life resume` — Resume activities',
        '`/life trigger [think|browse|journal|create|self_code|code_review|reflect]` — Trigger now',
      ];
      await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
      return;
    }

    // ── /dashboard command ────────────────────────────────────────
    if (text === '/dashboard' || text.startsWith('/dashboard ')) {
      logger.info(`[Bot] /dashboard command from ${username} (${userId}) in chat ${chatId}`);
      const args = text.slice('/dashboard'.length).trim();
      const port = config.dashboard?.port || 3000;

      if (args === 'start') {
        if (dashboardHandle) {
          await bot.sendMessage(chatId, `Dashboard already running at http://localhost:${port}`);
          return;
        }
        try {
          const { startDashboard } = await import('./dashboard/server.js');
          dashboardHandle = startDashboard({ port, ...dashboardDeps });
          logger.info(`[Dashboard] Started via /dashboard command on port ${port}`);
          await bot.sendMessage(chatId, `🖥️ Dashboard started at http://localhost:${port}`);
        } catch (err) {
          logger.error(`[Dashboard] Failed to start: ${err.message}`);
          await bot.sendMessage(chatId, `Failed to start dashboard: ${err.message}`);
        }
        return;
      }

      if (args === 'stop') {
        if (!dashboardHandle) {
          await bot.sendMessage(chatId, 'Dashboard is not running.');
          return;
        }
        try {
          dashboardHandle.stop();
          dashboardHandle = null;
          logger.info('[Dashboard] Stopped via /dashboard command');
          await bot.sendMessage(chatId, '🛑 Dashboard stopped.');
        } catch (err) {
          logger.error(`[Dashboard] Failed to stop: ${err.message}`);
          await bot.sendMessage(chatId, `Failed to stop dashboard: ${err.message}`);
        }
        return;
      }

      // Default: show status
      const running = !!dashboardHandle;
      const lines = [
        '🖥️ *Dashboard*',
        '',
        `*Status:* ${running ? '🟢 Running' : '⚪ Stopped'}`,
        `*Port:* ${port}`,
        running ? `*URL:* http://localhost:${port}` : '',
        '',
        '_Commands:_',
        '`/dashboard start` — Start the dashboard',
        '`/dashboard stop` — Stop the dashboard',
      ].filter(Boolean);
      await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
      return;
    }

    // ── /journal command ─────────────────────────────────────────
    if (text === '/journal' || text.startsWith('/journal ')) {
      logger.info(`[Bot] /journal command from ${username} (${userId}) in chat ${chatId}`);

      if (!journalManager) {
        await bot.sendMessage(chatId, 'Journal system is not available.');
        return;
      }

      const args = text.slice('/journal'.length).trim();

      if (args && /^\d{4}-\d{2}-\d{2}$/.test(args)) {
        const entry = journalManager.getEntry(args);
        if (!entry) {
          await bot.sendMessage(chatId, `No journal entry for ${args}.`);
          return;
        }
        const chunks = splitMessage(entry);
        for (const chunk of chunks) {
          try { await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' }); }
          catch { await bot.sendMessage(chatId, chunk); }
        }
        return;
      }

      if (args === 'list') {
        const dates = journalManager.list(15);
        if (dates.length === 0) {
          await bot.sendMessage(chatId, 'No journal entries yet.');
          return;
        }
        const lines = ['📓 *Journal Entries*', '', ...dates.map(d => `  • \`${d}\``)];
        lines.push('', '_Use `/journal YYYY-MM-DD` to read an entry._');
        await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
        return;
      }

      // Default: show today's journal
      const today = journalManager.getToday();
      if (!today) {
        await bot.sendMessage(chatId, '📓 No journal entries today yet.\n\n_Use `/journal list` to see past entries._', { parse_mode: 'Markdown' });
        return;
      }
      const chunks = splitMessage(today);
      for (const chunk of chunks) {
        try { await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' }); }
        catch { await bot.sendMessage(chatId, chunk); }
      }
      return;
    }

    // ── /memories command ────────────────────────────────────────
    if (text === '/memories' || text.startsWith('/memories ')) {
      logger.info(`[Bot] /memories command from ${username} (${userId}) in chat ${chatId}`);

      if (!memoryManager) {
        await bot.sendMessage(chatId, 'Memory system is not available.');
        return;
      }

      const args = text.slice('/memories'.length).trim();

      if (args.startsWith('about ')) {
        const query = args.slice('about '.length).trim();
        const results = await memoryManager.searchEpisodic(query, 10);
        if (results.length === 0) {
          await bot.sendMessage(chatId, `No memories matching "${query}".`);
          return;
        }
        const lines = [`🧠 *Memories about "${query}"*`, ''];
        for (const m of results) {
          const date = new Date(m.timestamp).toLocaleDateString();
          lines.push(`• ${m.summary} _(${date}, importance: ${m.importance})_`);
        }
        await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
        return;
      }

      // Default: show last 10 memories
      const recent = memoryManager.getRecentEpisodic(168, 10); // last 7 days
      if (recent.length === 0) {
        await bot.sendMessage(chatId, '🧠 No memories yet.');
        return;
      }
      const lines = ['🧠 *Recent Memories*', ''];
      for (const m of recent) {
        const ago = Math.round((Date.now() - m.timestamp) / 60000);
        const timeLabel = ago < 60 ? `${ago}m ago` : ago < 1440 ? `${Math.round(ago / 60)}h ago` : `${Math.round(ago / 1440)}d ago`;
        const icon = { interaction: '💬', discovery: '🔍', thought: '💭', creation: '🎨' }[m.type] || '•';
        lines.push(`${icon} ${m.summary} _(${timeLabel})_`);
      }
      lines.push('', '_Use `/memories about <topic>` to search._');
      await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
      return;
    }

    // ── /synthesis command ──────────────────────────────────────────
    if (text === '/synthesis' || text.startsWith('/synthesis ')) {
      logger.info(`[Bot] /synthesis command from ${username} (${userId}) in chat ${chatId}`);
      const args = text.slice('/synthesis'.length).trim();

      if (!synthesisLoop) {
        await bot.sendMessage(chatId, 'Synthesis loop is not available (requires brain\\_db).');
        return;
      }

      if (args === 'trigger') {
        await bot.sendMessage(chatId, '⚡ Running synthesis cycle...');
        try {
          const { action, measurement } = await synthesisLoop.runCycle();
          if (lifeEngine) lifeEngine._recordSynthesisActivity(action.action);
          await bot.sendMessage(chatId, `✅ *${action.action}* → ${measurement.quality} (${measurement.duration_ms}ms)\nReason: ${action.reason}`, { parse_mode: 'Markdown' });
        } catch (err) {
          await bot.sendMessage(chatId, `Failed: ${err.message}`);
        }
        return;
      }

      // Default: show status
      const status = synthesisLoop.getStatus();
      const lines = ['🔄 *Synthesis Loop*', ''];

      // Weights
      lines.push('*Action Weights:*');
      const sortedWeights = Object.entries(status.weights).sort((a, b) => b[1].current_weight - a[1].current_weight);
      for (const [action, w] of sortedWeights) {
        const cooldownMin = Math.round(w.cooldown_ms / 60000);
        const lastRun = w.last_run_at ? `${Math.round((Date.now() - w.last_run_at) / 60000)}m ago` : 'never';
        lines.push(`  \`${action}\` — w=${w.current_weight.toFixed(2)} sr=${(w.success_rate * 100).toFixed(0)}% runs=${w.total_runs} cd=${cooldownMin}m last=${lastRun}`);
      }

      // Recent outcomes
      if (status.recentOutcomes.length > 0) {
        lines.push('', '*Recent Outcomes:*');
        for (const o of status.recentOutcomes.slice(0, 5)) {
          const ago = Math.round((Date.now() - o.created_at) / 60000);
          const icon = o.result_quality === 'productive' ? '✅' : '❌';
          lines.push(`  ${icon} ${o.action_type} (u=${o.urgency_score?.toFixed(2) || '?'}) ${o.duration_ms}ms — ${ago}m ago`);
        }
      }

      // Last cycle
      if (status.lastCycle) {
        const ago = Math.round((Date.now() - status.lastCycle.timestamp) / 60000);
        lines.push('', `*Last cycle:* ${status.lastCycle.action} → ${status.lastCycle.quality} (${ago}m ago)`);
      }

      lines.push('', '_Commands:_', '`/synthesis` — Status', '`/synthesis trigger` — Run one cycle');
      await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
      return;
    }

    // ── /senders command ──────────────────────────────────────────
    if (text === '/senders') {
      logger.info(`[Bot] /senders command from ${username} (${userId}) in chat ${chatId}`);
      if (!identityAwareness) {
        await bot.sendMessage(chatId, 'Identity awareness is not available (brain_db disabled).');
        return;
      }
      const senders = identityAwareness.listSenders(20);
      if (senders.length === 0) {
        await bot.sendMessage(chatId, 'No known senders yet.');
        return;
      }
      const lines = ['*Known Senders*', ''];
      for (const s of senders) {
        const icon = { owner: '👑', trusted: '🤝', known: '👤', unknown: '❓', agent: '🤖', system: '⚙️' }[s.sender_type] || '•';
        const name = s.display_name || s.username || s.user_id;
        const ago = Math.round((Date.now() - s.last_seen) / 60000);
        const timeLabel = ago < 60 ? `${ago}m ago` : ago < 1440 ? `${Math.round(ago / 60)}h ago` : `${Math.round(ago / 1440)}d ago`;
        lines.push(`${icon} *${name}* — ${s.sender_type} (trust: ${s.trust_level}) | ${s.message_count} msgs | ${timeLabel}`);
      }
      await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
      return;
    }

    // ── /whois command ──────────────────────────────────────────
    if (text.startsWith('/whois ')) {
      logger.info(`[Bot] /whois command from ${username} (${userId}) in chat ${chatId}`);
      if (!identityAwareness) {
        await bot.sendMessage(chatId, 'Identity awareness is not available.');
        return;
      }
      const target = text.slice('/whois '.length).trim().replace(/^@/, '');
      // Try by username first, then by userId
      const senders = identityAwareness.listSenders(100);
      const match = senders.find(s => s.username === target || s.user_id === target || (s.display_name && s.display_name.toLowerCase() === target.toLowerCase()));
      if (!match) {
        await bot.sendMessage(chatId, `No sender found matching "${target}".`);
        return;
      }
      const lines = [
        `*Sender Profile: ${match.display_name || match.username || match.user_id}*`,
        '',
        `*User ID:* \`${match.user_id}\``,
        `*Username:* ${match.username || 'N/A'}`,
        `*Type:* ${match.sender_type}`,
        `*Trust Level:* ${match.trust_level}`,
        `*Bot:* ${match.is_bot ? 'Yes' : 'No'}`,
        `*Messages:* ${match.message_count}`,
        `*Quality:* ${(match.interaction_quality || 0).toFixed(2)}`,
        `*First Seen:* ${new Date(match.first_seen).toLocaleString()}`,
        `*Last Seen:* ${new Date(match.last_seen).toLocaleString()}`,
      ];
      if (match.org_role) lines.push(`*Role:* ${match.org_role}`);
      if (match.team) lines.push(`*Team:* ${match.team}`);
      if (match.agent_purpose) lines.push(`*Agent Purpose:* ${match.agent_purpose}`);
      if (match.agent_owner) lines.push(`*Agent Owner:* ${match.agent_owner}`);
      await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
      return;
    }

    // ── /trust command ──────────────────────────────────────────
    if (text.startsWith('/trust ')) {
      logger.info(`[Bot] /trust command from ${username} (${userId}) in chat ${chatId}`);
      if (!identityAwareness) {
        await bot.sendMessage(chatId, 'Identity awareness is not available.');
        return;
      }
      const target = text.slice('/trust '.length).trim().replace(/^@/, '');
      const senders = identityAwareness.listSenders(100);
      const match = senders.find(s => s.username === target || s.user_id === target);
      if (!match) {
        await bot.sendMessage(chatId, `No sender found matching "${target}".`);
        return;
      }
      identityAwareness.setTrustLevel(match.user_id, 'trusted', 'manual_promote');
      await bot.sendMessage(chatId, `🤝 *${match.display_name || match.username || match.user_id}* promoted to *trusted*.`, { parse_mode: 'Markdown' });
      return;
    }

    // ── /restrict command ──────────────────────────────────────
    if (text.startsWith('/restrict ')) {
      logger.info(`[Bot] /restrict command from ${username} (${userId}) in chat ${chatId}`);
      if (!identityAwareness) {
        await bot.sendMessage(chatId, 'Identity awareness is not available.');
        return;
      }
      const target = text.slice('/restrict '.length).trim().replace(/^@/, '');
      const senders = identityAwareness.listSenders(100);
      const match = senders.find(s => s.username === target || s.user_id === target);
      if (!match) {
        await bot.sendMessage(chatId, `No sender found matching "${target}".`);
        return;
      }
      identityAwareness.setTrustLevel(match.user_id, 'unknown', 'manual_restrict');
      await bot.sendMessage(chatId, `❓ *${match.display_name || match.username || match.user_id}* restricted to *unknown*.`, { parse_mode: 'Markdown' });
      return;
    }

    // ── /registerbot command ──────────────────────────────────────
    if (text.startsWith('/registerbot ')) {
      logger.info(`[Bot] /registerbot command from ${username} (${userId}) in chat ${chatId}`);
      if (!identityAwareness) {
        await bot.sendMessage(chatId, 'Identity awareness is not available.');
        return;
      }
      const parts = text.slice('/registerbot '.length).trim().split(/\s+/);
      const botTarget = parts[0]?.replace(/^@/, '');
      const purpose = parts.slice(1).join(' ') || 'general';
      if (!botTarget) {
        await bot.sendMessage(chatId, 'Usage: `/registerbot <bot_username> <purpose>`', { parse_mode: 'Markdown' });
        return;
      }
      identityAwareness.registerAgent(botTarget, purpose, String(userId));
      await bot.sendMessage(chatId, `🤖 Registered agent *${botTarget}* — purpose: ${purpose}`, { parse_mode: 'Markdown' });
      return;
    }

    // ── /privacy command ──────────────────────────────────────────
    if (text === '/privacy') {
      logger.info(`[Bot] /privacy command from ${username} (${userId}) in chat ${chatId}`);
      if (!identityAwareness) {
        await bot.sendMessage(chatId, 'Identity awareness is not available.');
        return;
      }
      try {
        const scopeStats = identityAwareness._db.all(`
          SELECT COALESCE(scope, 'unscoped') as scope_type, COUNT(*) as count
          FROM memories GROUP BY scope_type ORDER BY count DESC
        `);
        const lines = ['*Knowledge Scope Stats*', ''];
        for (const row of scopeStats) {
          lines.push(`• *${row.scope_type}*: ${row.count} memories`);
        }
        if (scopeStats.length === 0) lines.push('No memories yet.');
        await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
      } catch (err) {
        await bot.sendMessage(chatId, `Failed to get stats: ${err.message}`);
      }
      return;
    }

    // ── /evolution command ──────────────────────────────────────────
    if (text === '/evolution' || text.startsWith('/evolution ')) {
      logger.info(`[Bot] /evolution command from ${username} (${userId}) in chat ${chatId}`);
      const args = text.slice('/evolution'.length).trim();

      if (!evolutionTracker) {
        await bot.sendMessage(chatId, 'Evolution system is not available.');
        return;
      }

      if (args === 'history') {
        const proposals = evolutionTracker.getRecentProposals(10);
        if (proposals.length === 0) {
          await bot.sendMessage(chatId, 'No evolution proposals yet.');
          return;
        }
        const lines = ['*Evolution History*', ''];
        for (const p of proposals.reverse()) {
          const statusIcon = { research: '🔬', planned: '📋', coding: '💻', pr_open: '🔄', merged: '✅', rejected: '❌', failed: '💥' }[p.status] || '•';
          const age = Math.round((Date.now() - p.createdAt) / 3600_000);
          const ageLabel = age < 24 ? `${age}h ago` : `${Math.round(age / 24)}d ago`;
          lines.push(`${statusIcon} \`${p.id}\` — ${p.status} (${ageLabel})`);
          lines.push(`  ${(p.triggerContext || '').slice(0, 100)}`);
          if (p.prUrl) lines.push(`  PR: ${p.prUrl}`);
          lines.push('');
        }
        await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
        return;
      }

      if (args === 'lessons') {
        const lessons = evolutionTracker.getRecentLessons(15);
        if (lessons.length === 0) {
          await bot.sendMessage(chatId, 'No evolution lessons learned yet.');
          return;
        }
        const lines = ['*Evolution Lessons*', ''];
        for (const l of lessons.reverse()) {
          lines.push(`• [${l.category}] ${l.lesson}`);
          if (l.fromProposal) lines.push(`  _from ${l.fromProposal}_`);
          lines.push('');
        }
        await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
        return;
      }

      if (args === 'trigger') {
        if (!lifeEngine) {
          await bot.sendMessage(chatId, 'Life engine is not available.');
          return;
        }
        await bot.sendMessage(chatId, '⚡ Triggering evolution cycle...');
        lifeEngine.triggerNow('self_code').catch(err => {
          logger.error(`[Bot] Evolution trigger failed: ${err.message}`);
        });
        return;
      }

      if (args === 'scan') {
        if (!codebaseKnowledge) {
          await bot.sendMessage(chatId, 'Codebase knowledge is not available.');
          return;
        }
        await bot.sendMessage(chatId, '🔍 Scanning codebase...');
        codebaseKnowledge.scanChanged().then(count => {
          bot.sendMessage(chatId, `✅ Scanned ${count} changed files.`).catch(() => {});
        }).catch(err => {
          bot.sendMessage(chatId, `Failed: ${err.message}`).catch(() => {});
        });
        return;
      }

      // Default: show status
      const active = evolutionTracker.getActiveProposal();
      const stats = evolutionTracker.getStats();
      const openPRs = evolutionTracker.getPRsToCheck();

      const lines = [
        '🧬 *Self-Evolution*',
        '',
        `*Stats:* ${stats.totalProposals} total | ${stats.merged} merged | ${stats.rejected} rejected | ${stats.failed} failed`,
        `*Success rate:* ${stats.successRate}%`,
        `*Open PRs:* ${openPRs.length}`,
      ];

      if (active) {
        const statusIcon = { research: '🔬', planned: '📋', coding: '💻', pr_open: '🔄' }[active.status] || '•';
        lines.push('');
        lines.push(`*Active proposal:* ${statusIcon} \`${active.id}\` — ${active.status}`);
        lines.push(`  ${(active.triggerContext || '').slice(0, 120)}`);
        if (active.prUrl) lines.push(`  PR: ${active.prUrl}`);
      } else {
        lines.push('', '_No active proposal_');
      }

      lines.push(
        '',
        '_Commands:_',
        '`/evolution history` — Recent proposals',
        '`/evolution lessons` — Learned lessons',
        '`/evolution trigger` — Trigger evolution now',
        '`/evolution scan` — Scan codebase',
      );

      await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
      return;
    }

    // ── /linkedin command ───────────────────────────────────────────
    if (text === '/linkedin' || text.startsWith('/linkedin ')) {
      logger.info(`[Bot] /linkedin command from ${username} (${userId}) in chat ${chatId}`);
      const args = text.slice('/linkedin'.length).trim();

      // /linkedin link <token> — validate token and save
      if (args.startsWith('link')) {
        const token = args.slice('link'.length).trim();
        if (!token) {
          await bot.sendMessage(chatId, [
            '🔗 *Connect your LinkedIn account*',
            '',
            '1. Go to https://www.linkedin.com/developers/tools/oauth/token-generator',
            '2. Select your app, pick scopes: `openid`, `profile`, `email`, `w_member_social`',
            '3. Authorize and copy the token',
            '4. Run: `/linkedin link <your-token>`',
          ].join('\n'), { parse_mode: 'Markdown' });
          return;
        }

        await bot.sendMessage(chatId, '⏳ Validating token...');

        try {
          // Try /v2/userinfo (requires "Sign in with LinkedIn" product → openid+profile scopes)
          const res = await fetch('https://api.linkedin.com/v2/userinfo', {
            headers: { 'Authorization': `Bearer ${token}` },
          });

          const { saveCredential } = await import('./utils/config.js');

          if (res.ok) {
            const profile = await res.json();
            const personUrn = `urn:li:person:${profile.sub}`;

            saveCredential(config, 'LINKEDIN_ACCESS_TOKEN', token);
            saveCredential(config, 'LINKEDIN_PERSON_URN', personUrn);

            await bot.sendMessage(chatId, [
              '✅ *LinkedIn connected!*',
              '',
              `👤 *${profile.name}*`,
              profile.email ? `📧 ${profile.email}` : '',
              '',
              'You can now ask me to post on LinkedIn, view your posts, comment, and more.',
            ].filter(Boolean).join('\n'), { parse_mode: 'Markdown' });
          } else if (res.status === 401) {
            throw new Error('Invalid or expired token.');
          } else {
            // 403 = token works but missing profile scopes → save token, ask for URN
            saveCredential(config, 'LINKEDIN_ACCESS_TOKEN', token);

            await bot.sendMessage(chatId, [
              '⚠️ *Token saved* but profile auto-detect unavailable.',
              '',
              'Your token lacks `openid`+`profile` scopes (only `w_member_social`).',
              'To fix: add *"Sign in with LinkedIn using OpenID Connect"* to your app at the Developer Portal, then regenerate the token.',
              '',
              'For now, send your person URN to complete setup:',
              '`/linkedin urn urn:li:person:XXXXX`',
              '',
              'Find your sub value in your LinkedIn Developer app → Auth tab.',
            ].join('\n'), { parse_mode: 'Markdown' });
          }
        } catch (err) {
          logger.error(`[Bot] LinkedIn token validation failed: ${err.message}`);
          await bot.sendMessage(chatId, `❌ Token validation failed: ${err.message}`);
        }
        return;
      }

      // /linkedin urn <value> — manually set person URN
      if (args.startsWith('urn')) {
        const urn = args.slice('urn'.length).trim();
        if (!urn) {
          await bot.sendMessage(chatId, 'Usage: `/linkedin urn urn:li:person:XXXXX`', { parse_mode: 'Markdown' });
          return;
        }
        const personUrn = urn.startsWith('urn:li:person:') ? urn : `urn:li:person:${urn}`;
        const { saveCredential } = await import('./utils/config.js');
        saveCredential(config, 'LINKEDIN_PERSON_URN', personUrn);

        await bot.sendMessage(chatId, `✅ Person URN saved: \`${personUrn}\``, { parse_mode: 'Markdown' });
        return;
      }

      // /linkedin unlink — clear saved token
      if (args === 'unlink') {
        if (!config.linkedin?.access_token) {
          await bot.sendMessage(chatId, 'Your LinkedIn account is not connected.');
          return;
        }

        const { saveCredential } = await import('./utils/config.js');
        saveCredential(config, 'LINKEDIN_ACCESS_TOKEN', '');
        saveCredential(config, 'LINKEDIN_PERSON_URN', '');
        // Clear from live config
        config.linkedin.access_token = null;
        config.linkedin.person_urn = null;

        await bot.sendMessage(chatId, '✅ LinkedIn account disconnected.');
        return;
      }

      // /linkedin (status) — show connection status
      if (!config.linkedin?.access_token) {
        await bot.sendMessage(chatId, [
          '📱 *LinkedIn — Not Connected*',
          '',
          'Use `/linkedin link <token>` to connect your account.',
          '',
          'Get a token: https://www.linkedin.com/developers/tools/oauth/token-generator',
        ].join('\n'), { parse_mode: 'Markdown' });
        return;
      }

      await bot.sendMessage(chatId, [
        '📱 *LinkedIn — Connected*',
        '',
        `🔑 Token: \`${config.linkedin.access_token.slice(0, 8)}...${config.linkedin.access_token.slice(-4)}\``,
        config.linkedin.person_urn ? `👤 URN: \`${config.linkedin.person_urn}\`` : '',
        '',
        '`/linkedin unlink` — Disconnect account',
      ].filter(Boolean).join('\n'), { parse_mode: 'Markdown' });
      return;
    }

    // ── /x command ─────────────────────────────────────────────────
    if (text === '/x' || text.startsWith('/x ')) {
      logger.info(`[Bot] /x command from ${username} (${userId}) in chat ${chatId}`);
      const args = text.slice('/x'.length).trim();

      // /x link <consumer_key> <consumer_secret> <access_token> <access_token_secret>
      if (args.startsWith('link')) {
        const keys = args.slice('link'.length).trim().split(/\s+/);
        if (keys.length !== 4) {
          await bot.sendMessage(chatId, [
            '🔗 *Connect your X (Twitter) account*',
            '',
            'You need 4 credentials from your X Developer App:',
            '1. Consumer Key (API Key)',
            '2. Consumer Secret (API Secret)',
            '3. Access Token',
            '4. Access Token Secret',
            '',
            'Run: `/x link <consumer_key> <consumer_secret> <access_token> <access_token_secret>`',
            '',
            '⚠️ Make sure your app has *Read and Write* permissions for posting tweets.',
          ].join('\n'), { parse_mode: 'Markdown' });
          return;
        }

        const [consumerKey, consumerSecret, accessToken, accessTokenSecret] = keys;
        await bot.sendMessage(chatId, '⏳ Validating credentials...');

        try {
          const { XApi } = await import('./services/x-api.js');
          const client = new XApi({ consumerKey, consumerSecret, accessToken, accessTokenSecret });
          const profile = await client.getMe();

          const { saveCredential } = await import('./utils/config.js');
          saveCredential(config, 'X_CONSUMER_KEY', consumerKey);
          saveCredential(config, 'X_CONSUMER_SECRET', consumerSecret);
          saveCredential(config, 'X_ACCESS_TOKEN', accessToken);
          saveCredential(config, 'X_ACCESS_TOKEN_SECRET', accessTokenSecret);

          await bot.sendMessage(chatId, [
            '✅ *X (Twitter) connected!*',
            '',
            `👤 *${profile.name}* (@${profile.username})`,
            profile.description ? `📝 ${profile.description}` : '',
            '',
            'You can now ask me to tweet, search tweets, like, retweet, and more.',
          ].filter(Boolean).join('\n'), { parse_mode: 'Markdown' });
        } catch (err) {
          logger.error(`[Bot] X token validation failed: ${err.message}`);
          const detail = err.response?.data?.detail || err.response?.data?.title || err.message;
          await bot.sendMessage(chatId, `❌ Validation failed: ${detail}`);
        }
        return;
      }

      // /x unlink — clear saved credentials
      if (args === 'unlink') {
        if (!config.x?.consumer_key) {
          await bot.sendMessage(chatId, 'Your X account is not connected.');
          return;
        }

        const { saveCredential } = await import('./utils/config.js');
        saveCredential(config, 'X_CONSUMER_KEY', '');
        saveCredential(config, 'X_CONSUMER_SECRET', '');
        saveCredential(config, 'X_ACCESS_TOKEN', '');
        saveCredential(config, 'X_ACCESS_TOKEN_SECRET', '');
        config.x = {};

        await bot.sendMessage(chatId, '✅ X (Twitter) account disconnected.');
        return;
      }

      // /x (status) — show connection status
      if (!config.x?.consumer_key) {
        await bot.sendMessage(chatId, [
          '🐦 *X (Twitter) — Not Connected*',
          '',
          'Use `/x link <consumer_key> <consumer_secret> <access_token> <access_token_secret>` to connect.',
          '',
          'Get credentials from https://developer.x.com/en/portal/dashboard',
        ].join('\n'), { parse_mode: 'Markdown' });
        return;
      }

      await bot.sendMessage(chatId, [
        '🐦 *X (Twitter) — Connected*',
        '',
        `🔑 Consumer Key: \`${config.x.consumer_key.slice(0, 6)}...${config.x.consumer_key.slice(-4)}\``,
        `🔑 Access Token: \`${config.x.access_token.slice(0, 6)}...${config.x.access_token.slice(-4)}\``,
        '',
        '`/x unlink` — Disconnect account',
      ].join('\n'), { parse_mode: 'Markdown' });
      return;
    }

    if (text === '/onboarding' || text === '/onboarding reset') {
      logger.info(`[Bot] /onboarding command from ${username} (${userId}) in chat ${chatId}`);
      if (!onboardingManager) {
        await bot.sendMessage(chatId, 'Onboarding system not available (brain\\_db required).');
        return;
      }

      if (text === '/onboarding reset') {
        onboardingManager.reset(userId);
        await bot.sendMessage(chatId, 'Onboarding reset. Send any message to start fresh.');
        return;
      }

      const state = onboardingManager.getState(userId);
      if (!state) {
        await bot.sendMessage(chatId, 'No onboarding data found. Send any message to start onboarding.');
        return;
      }

      const phaseEmoji = { profile: '\uD83D\uDCDD', skills: '\uD83C\uDFAF', training: '\uD83C\uDFD3', complete: '\u2705' };
      const lines = [
        `*Onboarding Status*`,
        '',
        `Phase: ${phaseEmoji[state.phase] || ''} ${state.phase}`,
        `Started: ${new Date(state.started_at).toLocaleDateString()}`,
      ];
      if (state.completed_at) lines.push(`Completed: ${new Date(state.completed_at).toLocaleDateString()}`);
      if (state.profile_data) {
        const p = state.profile_data;
        lines.push('', '*Profile:*');
        if (p.name) lines.push(`  Name: ${p.name}`);
        if (p.occupation) lines.push(`  Occupation: ${p.occupation}`);
        if (p.location) lines.push(`  Location: ${p.location}`);
      }
      if (state.selected_skills?.length > 0) {
        lines.push('', `*Skills:* ${state.selected_skills.join(', ')}`);
      }
      if (state.training_notes) {
        lines.push('', '*Training:* configured');
      }
      lines.push('', '_Use /onboarding reset to re-run onboarding._');

      await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
      return;
    }

    if (text === '/help') {
      const activeSkills = agent.getActiveSkills(chatId);
      const skillLine = activeSkills.length > 0
        ? `\n🎭 *Active skills:* ${activeSkills.map(s => `${s.emoji} ${s.name}`).join(', ')}\n`
        : '';
      await bot.sendMessage(chatId, [
        '*KernelBot Commands*',
        skillLine,
        '/character — Switch or manage characters',
        '/brain — Switch worker AI model/provider',
        '/orchestrator — Switch orchestrator AI model/provider',
        '/claudemodel — Switch Claude Code model',
        '/claude — Manage Claude Code authentication',
        '/skills — Browse and toggle persona skills (multi-skill)',
        '/skills reset — Clear all active skills',
        '/jobs — List running and recent jobs',
        '/cancel — Cancel running job(s)',
        '/auto — Manage recurring automations',
        '/life — Inner life engine status & control',
        '/journal — View today\'s journal or a past date',
        '/memories — View recent memories or search',
        '/senders — List known senders with trust levels',
        '/whois <user> — Show sender profile',
        '/trust <user> — Promote to trusted',
        '/restrict <user> — Demote to unknown',
        '/registerbot <bot> <purpose> — Register AI agent',
        '/privacy — Show knowledge scope stats',
        '/synthesis — Synthesis loop status & manual trigger',
        '/evolution — Self-evolution status, history, lessons',
        '/onboarding — View onboarding status or reset',
        '/dashboard — Start/stop the monitoring dashboard',
        '/linkedin — Link/unlink your LinkedIn account',
        '/x — Link/unlink your X (Twitter) account',
        '/context — Show all models, auth, and context info',
        '/clean — Clear conversation and start fresh',
        '/history — Show message count in memory',
        '/browse <url> — Browse a website and get a summary',
        '/screenshot <url> — Take a screenshot of a website',
        '/extract <url> <selector> — Extract content using CSS selector',
        '/help — Show this help message',
        '',
        'Or just send any message to chat with the agent.',
      ].join('\n'), { parse_mode: 'Markdown' });
      return;
    }

    // ── /auto command ──────────────────────────────────────────────
    if (text === '/auto' || text.startsWith('/auto ')) {
      logger.info(`[Bot] /auto command from ${username} (${userId}) in chat ${chatId}`);
      const args = text.slice('/auto'.length).trim();

      if (!automationManager) {
        await bot.sendMessage(chatId, 'Automation system not available.');
        return;
      }

      // /auto (no args) — list automations
      if (!args) {
        const autos = automationManager.listForChat(chatId);
        if (autos.length === 0) {
          await bot.sendMessage(chatId, [
            '⏰ *No automations set up yet.*',
            '',
            'Tell me what to automate in natural language, e.g.:',
            '  "check my server health every hour"',
            '  "send me a news summary every morning at 9am"',
            '',
            'Or use `/auto` subcommands:',
            '  `/auto pause <id>` — pause an automation',
            '  `/auto resume <id>` — resume an automation',
            '  `/auto delete <id>` — delete an automation',
            '  `/auto run <id>` — trigger immediately',
          ].join('\n'), { parse_mode: 'Markdown' });
          return;
        }

        const lines = ['⏰ *Automations*', ''];
        for (const auto of autos) {
          lines.push(auto.toSummary());
        }
        lines.push('', '_Use `/auto pause|resume|delete|run <id>` to manage._');

        // Build inline keyboard for quick actions
        const buttons = autos.map((a) => {
          const row = [];
          if (a.enabled) {
            row.push({ text: `⏸️ Pause ${a.id}`, callback_data: `auto_pause:${a.id}` });
          } else {
            row.push({ text: `▶️ Resume ${a.id}`, callback_data: `auto_resume:${a.id}` });
          }
          row.push({ text: `🗑️ Delete ${a.id}`, callback_data: `auto_delete:${a.id}` });
          return row;
        });

        await bot.sendMessage(chatId, lines.join('\n'), {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: buttons },
        });
        return;
      }

      // /auto pause <id>
      if (args.startsWith('pause ')) {
        const autoId = args.slice('pause '.length).trim();
        const auto = automationManager.update(autoId, { enabled: false });
        await bot.sendMessage(chatId, auto
          ? `⏸️ Paused automation \`${autoId}\` (${auto.name})`
          : `Automation \`${autoId}\` not found.`, { parse_mode: 'Markdown' });
        return;
      }

      // /auto resume <id>
      if (args.startsWith('resume ')) {
        const autoId = args.slice('resume '.length).trim();
        const auto = automationManager.update(autoId, { enabled: true });
        await bot.sendMessage(chatId, auto
          ? `▶️ Resumed automation \`${autoId}\` (${auto.name})`
          : `Automation \`${autoId}\` not found.`, { parse_mode: 'Markdown' });
        return;
      }

      // /auto delete <id>
      if (args.startsWith('delete ')) {
        const autoId = args.slice('delete '.length).trim();
        const deleted = automationManager.delete(autoId);
        await bot.sendMessage(chatId, deleted
          ? `🗑️ Deleted automation \`${autoId}\``
          : `Automation \`${autoId}\` not found.`, { parse_mode: 'Markdown' });
        return;
      }

      // /auto run <id> — trigger immediately
      if (args.startsWith('run ')) {
        const autoId = args.slice('run '.length).trim();
        try {
          await automationManager.runNow(autoId);
        } catch (err) {
          await bot.sendMessage(chatId, `Failed: ${err.message}`);
        }
        return;
      }

      // /auto <anything else> — treat as natural language automation request
      text = `Set up an automation: ${args}`;
      // Fall through to normal message processing below
    }

    // Web browsing shortcut commands — rewrite as natural language for the agent
    if (text.startsWith('/browse ')) {
      const browseUrl = text.slice('/browse '.length).trim();
      if (!browseUrl) {
        await bot.sendMessage(chatId, 'Usage: /browse <url>');
        return;
      }
      text = `Browse this website and give me a summary: ${browseUrl}`;
    } else if (text.startsWith('/screenshot ')) {
      const screenshotUrl = text.slice('/screenshot '.length).trim();
      if (!screenshotUrl) {
        await bot.sendMessage(chatId, 'Usage: /screenshot <url>');
        return;
      }
      text = `Take a screenshot of this website: ${screenshotUrl}`;
    } else if (text.startsWith('/extract ')) {
      const extractParts = text.slice('/extract '.length).trim().split(/\s+/);
      if (extractParts.length < 2) {
        await bot.sendMessage(chatId, 'Usage: /extract <url> <css-selector>');
        return;
      }
      const extractUrl = extractParts[0];
      const extractSelector = extractParts.slice(1).join(' ');
      text = `Extract content from ${extractUrl} using the CSS selector: ${extractSelector}`;
    }

    // Batch messages — wait for the batch window to close
    const mergedText = await batchMessage(chatId, text);
    if (mergedText === null) {
      // This message was merged into another batch — skip
      return;
    }

    logger.info(`Message from ${username} (${userId}): ${mergedText.slice(0, 100)}`);

    // Enqueue into per-chat queue for serialized processing
    chatQueue.enqueue(chatId, async () => {
      // Show typing and keep refreshing it
      const typingInterval = setInterval(() => {
        bot.sendChatAction(chatId, 'typing').catch(() => {});
      }, 4000);
      bot.sendChatAction(chatId, 'typing').catch(() => {});

      try {
        const onUpdate = createOnUpdate(bot, chatId);
        const sendPhoto = createSendPhoto(bot, chatId, logger);
        const sendReaction = createSendReaction(bot);

        logger.debug(`[Bot] Sending to orchestrator: chat ${chatId}, text="${mergedText.slice(0, 80)}"`);
        const telegramUser = msg.from;
        const chatInfo = { id: msg.chat.id, type: msg.chat.type, title: msg.chat.title };
        const reply = await agent.processMessage(chatId, mergedText, {
          id: userId,
          username,
        }, onUpdate, sendPhoto, { sendReaction, messageId: msg.message_id, imageAttachment, telegramUser, chatInfo });

        clearInterval(typingInterval);

        // Simulate human-like typing delay before sending the reply
        await simulateTypingDelay(bot, chatId, reply || '');

        logger.info(`[Bot] Reply for chat ${chatId}: ${(reply || '').length} chars`);
        const chunks = splitMessage(reply || 'Done.');
        for (let i = 0; i < chunks.length; i++) {
          // Brief pause between consecutive chunks so multi-part replies feel natural
          if (i > 0) await simulateInterChunkDelay(bot, chatId, chunks[i]);
          try {
            await bot.sendMessage(chatId, chunks[i], { parse_mode: 'Markdown' });
          } catch {
            // Fallback to plain text if Markdown fails
            await bot.sendMessage(chatId, chunks[i]);
          }
        }

        // Send voice reply only when the user explicitly requests it
        const voiceKeywords = ['صوت', 'صوتك', 'صوتية', 'صوتي', 'voice', 'speak', 'hear you'];
        const wantsVoice = voiceKeywords.some((kw) => mergedText.toLowerCase().includes(kw));
        if (wantsVoice && ttsService.isAvailable() && reply && reply.length > 5) {
          try {
            const audioPath = await ttsService.synthesize(reply);
            if (audioPath) {
              await bot.sendVoice(chatId, createReadStream(audioPath));
            }
          } catch (err) {
            logger.warn(`[Bot] TTS voice reply failed: ${err.message}`);
          }
        }
      } catch (err) {
        clearInterval(typingInterval);
        logger.error(`[Bot] Error processing message in chat ${chatId}: ${err.message}`);
        // Show a friendly message instead of raw error details
        const friendly = _friendlyError(err);
        await bot.sendMessage(chatId, friendly);
      }
    });
  });

  // Handle message reactions (love, like, etc.)
  bot.on('message_reaction', async (reaction) => {
    const chatId = reaction.chat.id;
    const userId = reaction.user?.id;
    const username = reaction.user?.username || reaction.user?.first_name || 'unknown';

    if (!userId || !isAllowedUser(userId, config)) {
      if (userId) {
        await alertAdmin(bot, {
          userId,
          username: reaction.user?.username,
          firstName: reaction.user?.first_name,
          text: `${(reaction.new_reaction || []).filter(r => r.type === 'emoji').map(r => r.emoji).join(' ') || 'reaction'}`,
          type: 'تفاعل',
        });
      }
      return;
    }

    const newReactions = reaction.new_reaction || [];
    const emojis = newReactions
      .filter(r => r.type === 'emoji')
      .map(r => r.emoji);

    if (emojis.length === 0) return;

    logger.info(`[Bot] Reaction from ${username} (${userId}) in chat ${chatId}: ${emojis.join(' ')}`);

    const reactionText = `[User reacted with ${emojis.join(' ')} to your message]`;

    chatQueue.enqueue(chatId, async () => {
      // Show typing indicator while processing the reaction
      const typingInterval = setInterval(() => {
        bot.sendChatAction(chatId, 'typing').catch(() => {});
      }, 4000);
      bot.sendChatAction(chatId, 'typing').catch(() => {});

      try {
        const onUpdate = createOnUpdate(bot, chatId);
        const sendReaction = createSendReaction(bot);

        const reply = await agent.processMessage(chatId, reactionText, {
          id: userId,
          username,
        }, onUpdate, null, { sendReaction, messageId: reaction.message_id });

        clearInterval(typingInterval);

        if (reply && reply.trim()) {
          // Simulate human-like typing delay before responding to the reaction
          await simulateTypingDelay(bot, chatId, reply);

          const chunks = splitMessage(reply);
          for (let i = 0; i < chunks.length; i++) {
            if (i > 0) await simulateInterChunkDelay(bot, chatId, chunks[i]);
            try {
              await bot.sendMessage(chatId, chunks[i], { parse_mode: 'Markdown' });
            } catch {
              await bot.sendMessage(chatId, chunks[i]);
            }
          }
        }
      } catch (err) {
        clearInterval(typingInterval);
        logger.error(`[Bot] Error processing reaction in chat ${chatId}: ${err.message}`);
      }
    });
  });

  bot.on('polling_error', (err) => {
    logger.error(`Telegram polling error: ${err.message}`);
  });

  // ── Resume active chats after restart ────────────────────────
  setTimeout(async () => {
    const sendMsg = async (chatId, text) => {
      try {
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
      } catch {
        await bot.sendMessage(chatId, text);
      }
    };
    try {
      await agent.resumeActiveChats(sendMsg);
    } catch (err) {
      logger.error(`[Bot] Resume active chats failed: ${err.message}`);
    }
  }, 5000);

  // ── Proactive share delivery (randomized, self-rearming) ────
  const armShareDelivery = (delivered) => {
    // If we just delivered something, wait longer (1–4h) before next check
    // If nothing was delivered, check again sooner (10–45min) in case new shares appear
    const minMin = delivered ? 60 : 10;
    const maxMin = delivered ? 240 : 45;
    const delayMs = (minMin + Math.random() * (maxMin - minMin)) * 60_000;

    logger.debug(`[Bot] Next share check in ${Math.round(delayMs / 60_000)}m`);

    setTimeout(async () => {
      // Respect quiet hours (env vars → YAML config → defaults 02:00–06:00)
      if (isQuietHours(config.life)) {
        armShareDelivery(false);
        return;
      }

      const sendMsg = async (chatId, text) => {
        try {
          await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
        } catch {
          await bot.sendMessage(chatId, text);
        }
      };

      let didDeliver = false;
      try {
        const before = shareQueue ? shareQueue.getPending(null, 1).length : 0;
        await agent.deliverPendingShares(sendMsg);
        const after = shareQueue ? shareQueue.getPending(null, 1).length : 0;
        didDeliver = before > 0 && after < before;
      } catch (err) {
        logger.error(`[Bot] Proactive share delivery failed: ${err.message}`);
      }

      armShareDelivery(didDeliver);
    }, delayMs);
  };

  // Start the first check after a random 10–30 min
  armShareDelivery(false);

  return bot;
}
