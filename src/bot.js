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

export function startBot(config, agent, conversationManager) {
  const logger = getLogger();
  const bot = new TelegramBot(config.telegram.bot_token, { polling: true });

  // Load previous conversations from disk
  const loaded = conversationManager.load();
  if (loaded) {
    logger.info('Loaded previous conversations from disk');
  }

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

    let text = msg.text.trim();

    // Handle commands
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

    if (text === '/help') {
      await bot.sendMessage(chatId, [
        '*KernelBot Commands*',
        '',
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

    logger.info(`Message from ${username} (${userId}): ${text.slice(0, 100)}`);

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

      const reply = await agent.processMessage(chatId, text, {
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
