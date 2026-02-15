import TelegramBot from 'node-telegram-bot-api';
import { isAllowedUser, getUnauthorizedMessage } from './security/auth.js';
import { getLogger } from './utils/logger.js';

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

export function startBot(config, agent) {
  const logger = getLogger();
  const bot = new TelegramBot(config.telegram.bot_token, { polling: true });

  logger.info('Telegram bot started with polling');

  bot.on('message', async (msg) => {
    if (!msg.text) return; // ignore non-text

    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username || msg.from.first_name || 'unknown';

    // Auth check
    if (!isAllowedUser(userId, config)) {
      logger.warn(`Unauthorized access attempt from ${username} (${userId})`);
      await bot.sendMessage(chatId, getUnauthorizedMessage());
      return;
    }

    logger.info(`Message from ${username} (${userId}): ${msg.text.slice(0, 100)}`);

    // Show typing and keep refreshing it
    const typingInterval = setInterval(() => {
      bot.sendChatAction(chatId, 'typing').catch(() => {});
    }, 4000);
    bot.sendChatAction(chatId, 'typing').catch(() => {});

    try {
      const onUpdate = async (text) => {
        const parts = splitMessage(text);
        for (const part of parts) {
          try {
            await bot.sendMessage(chatId, part, { parse_mode: 'Markdown' });
          } catch {
            await bot.sendMessage(chatId, part);
          }
        }
      };

      const reply = await agent.processMessage(chatId, msg.text, {
        id: userId,
        username,
      }, onUpdate);

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

  bot.on('polling_error', (err) => {
    logger.error(`Telegram polling error: ${err.message}`);
  });

  return bot;
}
