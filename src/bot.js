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

export function startBot(config, agent, conversationManager) {
  const logger = getLogger();
  const bot = new TelegramBot(config.telegram.bot_token, { polling: true });
  const chatQueue = new ChatQueue();
  const batchWindowMs = config.telegram.batch_window_ms || 3000;

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

        const result = await agent.switchBrain(providerKey, modelId);
        if (result && typeof result === 'object' && result.error) {
          // Validation failed — keep current model
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
          await bot.answerCallbackQuery(query.id, { text: 'Unknown skill' });
          return;
        }

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
        const activeSkill = agent.getActiveSkill(chatId);
        if (activeSkill && activeSkill.id === skillId) {
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
      }
    } catch (err) {
      logger.error(`Callback query error: ${err.message}`);
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

    if (!msg.text) return; // ignore non-text (and non-document) messages

    let text = msg.text.trim();

    // Handle pending brain API key input
    if (pendingBrainKey.has(chatId)) {
      const pending = pendingBrainKey.get(chatId);
      pendingBrainKey.delete(chatId);

      if (text.toLowerCase() === 'cancel') {
        await bot.sendMessage(chatId, 'Brain change cancelled.');
        return;
      }

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
      agent.clearSkill(chatId);
      await bot.sendMessage(chatId, '🔄 Skill cleared — back to default persona.');
      return;
    }

    if (text === '/skills' || text === '/skill') {
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

        const reply = await agent.processMessage(chatId, mergedText, {
          id: userId,
          username,
        }, onUpdate, sendPhoto);

        clearInterval(typingInterval);

        const chunks = splitMessage(reply || 'Done.');
        for (const chunk of chunks) {
          try {
            await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
          } catch {
            // Fallback to plain text if Markdown fails
            await bot.sendMessage(chatId, chunk);
          }
        }
      } catch (err) {
        clearInterval(typingInterval);
        logger.error(`Error processing message: ${err.message}`);
        await bot.sendMessage(chatId, `Error: ${err.message}`);
      }
    });
  });

  bot.on('polling_error', (err) => {
    logger.error(`Telegram polling error: ${err.message}`);
  });

  return bot;
}
