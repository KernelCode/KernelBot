import TelegramBot from 'node-telegram-bot-api';
import { createReadStream, readFileSync } from 'fs';
import { isAllowedUser, getUnauthorizedMessage } from './security/auth.js';
import { getLogger } from './utils/logger.js';
import { PROVIDERS } from './providers/models.js';
import {
  getUnifiedSkillById,
  getUnifiedCategoryList,
  getUnifiedSkillsByCategory,
  loadCustomSkills,
  addCustomSkill,
  deleteCustomSkill,
  getCustomSkills,
} from './skills/custom.js';
import { TTSService } from './services/tts.js';
import { STTService } from './services/stt.js';

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
 * Simple per-chat queue to serialize agent processing.
 * Each chat gets its own promise chain so messages are processed in order.
 */
class ChatQueue {
  constructor() {
    this.queues = new Map();
  }

  enqueue(chatId, fn) {
    const key = String(chatId);
    const prev = this.queues.get(key) || Promise.resolve();
    const next = prev.then(() => fn()).catch(() => {});
    this.queues.set(key, next);
    return next;
  }
}

export function startBot(config, agent, conversationManager, jobManager, automationManager) {
  const logger = getLogger();
  const bot = new TelegramBot(config.telegram.bot_token, { polling: true });
  const chatQueue = new ChatQueue();
  const batchWindowMs = config.telegram.batch_window_ms || 3000;

  // Initialize voice services
  const ttsService = new TTSService(config);
  const sttService = new STTService(config);
  if (ttsService.isAvailable()) logger.info('[Bot] TTS service enabled (ElevenLabs)');
  if (sttService.isAvailable()) logger.info('[Bot] STT service enabled');

  // Per-chat message batching: chatId -> { messages[], timer, resolve }
  const chatBatches = new Map();

  // Load previous conversations from disk
  const loaded = conversationManager.load();
  if (loaded) {
    logger.info('Loaded previous conversations from disk');
  }

  // Load custom skills from disk
  loadCustomSkills();

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
      const onUpdate = async (update, opts = {}) => {
        if (opts.editMessageId) {
          try {
            const edited = await bot.editMessageText(update, {
              chat_id: chatId,
              message_id: opts.editMessageId,
              parse_mode: 'Markdown',
            });
            return edited.message_id;
          } catch {
            try {
              const edited = await bot.editMessageText(update, {
                chat_id: chatId,
                message_id: opts.editMessageId,
              });
              return edited.message_id;
            } catch {
              return opts.editMessageId;
            }
          }
        }
        const parts = splitMessage(update);
        let lastMsgId = null;
        for (const part of parts) {
          try {
            const sent = await bot.sendMessage(chatId, part, { parse_mode: 'Markdown' });
            lastMsgId = sent.message_id;
          } catch {
            const sent = await bot.sendMessage(chatId, part);
            lastMsgId = sent.message_id;
          }
        }
        return lastMsgId;
      };

      const sendPhoto = async (filePath, caption) => {
        const fileOpts = { contentType: 'image/png' };
        try {
          await bot.sendPhoto(chatId, createReadStream(filePath), { caption: caption || '', parse_mode: 'Markdown' }, fileOpts);
        } catch {
          try {
            await bot.sendPhoto(chatId, createReadStream(filePath), { caption: caption || '' }, fileOpts);
          } catch (err) {
            logger.error(`[Automation] Failed to send photo: ${err.message}`);
          }
        }
      };

      return { agent, onUpdate, sendPhoto };
    };

    automationManager.init({ sendMessage: sendMsg, sendChatAction: sendAction, agentFactory, config });
    automationManager.startAll();
    logger.info('[Bot] Automation manager initialized and started');
  }

  // Track pending brain API key input: chatId -> { providerKey, modelId }
  const pendingBrainKey = new Map();

  // Track pending custom skill creation: chatId -> { step: 'name' | 'prompt', name?: string }
  const pendingCustomSkill = new Map();

  // Handle inline keyboard callbacks for /brain
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (!isAllowedUser(query.from.id, config)) {
      await bot.answerCallbackQuery(query.id, { text: 'Unauthorized' });
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
        const [, providerKey, modelId] = data.split(':');
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

      // ── Skill callbacks ──────────────────────────────────────────
      } else if (data.startsWith('skill_category:')) {
        const categoryKey = data.split(':')[1];
        const skills = getUnifiedSkillsByCategory(categoryKey);
        const categories = getUnifiedCategoryList();
        const cat = categories.find((c) => c.key === categoryKey);
        if (!skills.length) {
          await bot.answerCallbackQuery(query.id, { text: 'No skills in this category' });
          return;
        }

        const activeSkill = agent.getActiveSkill(chatId);
        const buttons = skills.map((s) => ([{
          text: `${s.emoji} ${s.name}${activeSkill && activeSkill.id === s.id ? ' ✓' : ''}`,
          callback_data: `skill_select:${s.id}`,
        }]));
        buttons.push([
          { text: '« Back', callback_data: 'skill_back' },
          { text: 'Cancel', callback_data: 'skill_cancel' },
        ]);

        await bot.editMessageText(
          `${cat ? cat.emoji : ''} *${cat ? cat.name : categoryKey}* — select a skill:`,
          {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons },
          },
        );
        await bot.answerCallbackQuery(query.id);

      } else if (data.startsWith('skill_select:')) {
        const skillId = data.split(':')[1];
        const skill = getUnifiedSkillById(skillId);
        if (!skill) {
          logger.warn(`[Bot] Unknown skill selected: ${skillId}`);
          await bot.answerCallbackQuery(query.id, { text: 'Unknown skill' });
          return;
        }

        logger.info(`[Bot] Skill activated: ${skill.name} (${skillId}) for chat ${chatId}`);
        agent.setSkill(chatId, skillId);
        await bot.editMessageText(
          `${skill.emoji} *${skill.name}* activated!\n\n_${skill.description}_\n\nThe agent will now respond as this persona. Use /skills reset to return to default.`,
          {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'Markdown',
          },
        );
        await bot.answerCallbackQuery(query.id);

      } else if (data === 'skill_reset') {
        logger.info(`[Bot] Skill reset for chat ${chatId}`);
        agent.clearSkill(chatId);
        await bot.editMessageText('🔄 Skill cleared — back to default persona.', {
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
        const activeSkill = agent.getActiveSkill(chatId);
        if (activeSkill && activeSkill.id === skillId) {
          logger.info(`[Bot] Clearing active skill before deletion: ${skillId}`);
          agent.clearSkill(chatId);
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
        const categories = getUnifiedCategoryList();
        const activeSkill = agent.getActiveSkill(chatId);
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
        if (activeSkill) {
          footerRow.unshift({ text: '🔄 Reset to Default', callback_data: 'skill_reset' });
        }
        buttons.push(footerRow);

        const header = activeSkill
          ? `🎭 *Active skill:* ${activeSkill.emoji} ${activeSkill.name}\n\nSelect a category:`
          : '🎭 *Skills* — select a category:';

        await bot.editMessageText(header, {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: buttons },
        });
        await bot.answerCallbackQuery(query.id);

      } else if (data === 'skill_cancel') {
        await bot.editMessageText('Skill selection cancelled.', {
          chat_id: chatId,
          message_id: query.message.message_id,
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
      }
      return;
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
          const skill = addCustomSkill({ name: pending.name, systemPrompt: content });
          logger.info(`[Bot] Custom skill created from file: "${skill.name}" (${skill.id}) — ${content.length} chars, by ${username} in chat ${chatId}`);
          agent.setSkill(chatId, skill.id);
          await bot.sendMessage(
            chatId,
            `✅ Custom skill *${skill.name}* created and activated!\n\n_Prompt loaded from file (${content.length} chars)_`,
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
        const skill = addCustomSkill({ name: pending.name, systemPrompt: text });
        logger.info(`[Bot] Custom skill created: "${skill.name}" (${skill.id}) by ${username} in chat ${chatId}`);
        agent.setSkill(chatId, skill.id);
        await bot.sendMessage(
          chatId,
          `✅ Custom skill *${skill.name}* created and activated!`,
          { parse_mode: 'Markdown' },
        );
        return;
      }
    }

    // Handle commands — these bypass batching entirely
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

    if (text === '/skills reset' || text === '/skill reset') {
      logger.info(`[Bot] /skills reset from ${username} (${userId}) in chat ${chatId}`);
      agent.clearSkill(chatId);
      await bot.sendMessage(chatId, '🔄 Skill cleared — back to default persona.');
      return;
    }

    if (text === '/skills' || text === '/skill') {
      logger.info(`[Bot] /skills command from ${username} (${userId}) in chat ${chatId}`);
      const categories = getUnifiedCategoryList();
      const activeSkill = agent.getActiveSkill(chatId);
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
      if (activeSkill) {
        footerRow.unshift({ text: '🔄 Reset to Default', callback_data: 'skill_reset' });
      }
      buttons.push(footerRow);

      const header = activeSkill
        ? `🎭 *Active skill:* ${activeSkill.emoji} ${activeSkill.name}\n\nSelect a category:`
        : '🎭 *Skills* — select a category:';

      await bot.sendMessage(chatId, header, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: buttons },
      });
      return;
    }

    if (text === '/clean' || text === '/clear' || text === '/reset') {
      conversationManager.clear(chatId);
      logger.info(`Conversation cleared for chat ${chatId} by ${username}`);
      await bot.sendMessage(chatId, '🧹 Conversation cleared. Starting fresh.');
      return;
    }

    if (text === '/history') {
      const count = conversationManager.getMessageCount(chatId);
      await bot.sendMessage(chatId, `📝 This chat has *${count}* messages in memory.`, { parse_mode: 'Markdown' });
      return;
    }

    if (text === '/context') {
      const info = agent.getBrainInfo();
      const activeSkill = agent.getActiveSkill(chatId);
      const msgCount = conversationManager.getMessageCount(chatId);
      const history = conversationManager.getHistory(chatId);
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

      const lines = [
        '📋 *Conversation Context*',
        '',
        `🧠 *Brain:* ${info.providerName} / ${info.modelLabel}`,
        activeSkill
          ? `🎭 *Skill:* ${activeSkill.emoji} ${activeSkill.name}`
          : '🎭 *Skill:* Default persona',
        `💬 *Messages in memory:* ${msgCount} / ${maxHistory}`,
        `📌 *Recent window:* ${recentWindow} messages`,
      ];

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

    if (text === '/help') {
      const activeSkill = agent.getActiveSkill(chatId);
      const skillLine = activeSkill
        ? `\n🎭 *Active skill:* ${activeSkill.emoji} ${activeSkill.name}\n`
        : '';
      await bot.sendMessage(chatId, [
        '*KernelBot Commands*',
        skillLine,
        '/brain — Show current AI model and switch provider/model',
        '/skills — Browse and activate persona skills',
        '/skills reset — Clear active skill back to default',
        '/jobs — List running and recent jobs',
        '/cancel — Cancel running job(s)',
        '/auto — Manage recurring automations',
        '/context — Show current conversation context and brain info',
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
        const onUpdate = async (update, opts = {}) => {
          // Edit an existing message instead of sending a new one
          if (opts.editMessageId) {
            try {
              const edited = await bot.editMessageText(update, {
                chat_id: chatId,
                message_id: opts.editMessageId,
                parse_mode: 'Markdown',
              });
              return edited.message_id;
            } catch {
              try {
                const edited = await bot.editMessageText(update, {
                  chat_id: chatId,
                  message_id: opts.editMessageId,
                });
                return edited.message_id;
              } catch {
                return opts.editMessageId;
              }
            }
          }

          // Send new message(s)
          const parts = splitMessage(update);
          let lastMsgId = null;
          for (const part of parts) {
            try {
              const sent = await bot.sendMessage(chatId, part, { parse_mode: 'Markdown' });
              lastMsgId = sent.message_id;
            } catch {
              const sent = await bot.sendMessage(chatId, part);
              lastMsgId = sent.message_id;
            }
          }
          return lastMsgId;
        };

        const sendPhoto = async (filePath, caption) => {
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

        logger.debug(`[Bot] Sending to orchestrator: chat ${chatId}, text="${mergedText.slice(0, 80)}"`);
        const reply = await agent.processMessage(chatId, mergedText, {
          id: userId,
          username,
        }, onUpdate, sendPhoto);

        clearInterval(typingInterval);

        logger.info(`[Bot] Reply for chat ${chatId}: ${(reply || '').length} chars`);
        const chunks = splitMessage(reply || 'Done.');
        for (const chunk of chunks) {
          try {
            await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
          } catch {
            // Fallback to plain text if Markdown fails
            await bot.sendMessage(chatId, chunk);
          }
        }

        // Send voice reply if TTS is available and the reply isn't too short
        if (ttsService.isAvailable() && reply && reply.length > 5) {
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
        await bot.sendMessage(chatId, `Error: ${err.message}`);
      }
    });
  });

  bot.on('polling_error', (err) => {
    logger.error(`Telegram polling error: ${err.message}`);
  });

  return bot;
}
