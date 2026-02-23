import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getLogger } from '../utils/logger.js';

export function isAllowedUser(userId, config) {
  const allowed = config.telegram.allowed_users;

  // Auto-register the first user as owner when no allowed users exist
  if (!allowed || allowed.length === 0) {
    config.telegram.allowed_users = [userId];
    _persistOwner(userId);
    const logger = getLogger();
    logger.info(`[Auth] Auto-registered first user ${userId} as owner`);
    return true;
  }

  return allowed.includes(userId);
}

/**
 * Persist the auto-registered owner ID to ~/.kernelbot/.env
 */
function _persistOwner(userId) {
  try {
    const configDir = join(homedir(), '.kernelbot');
    mkdirSync(configDir, { recursive: true });
    const envPath = join(configDir, '.env');

    let content = '';
    if (existsSync(envPath)) {
      content = readFileSync(envPath, 'utf-8').trimEnd() + '\n';
    }

    const regex = /^OWNER_TELEGRAM_ID=.*$/m;
    const line = `OWNER_TELEGRAM_ID=${userId}`;
    if (regex.test(content)) {
      content = content.replace(regex, line);
    } else {
      content += line + '\n';
    }
    writeFileSync(envPath, content);
  } catch {
    // Non-fatal — owner is still in memory for this session
  }
}

export function getUnauthorizedMessage() {
  return 'Access denied. You are not authorized to use this bot.';
}

/**
 * Send an alert to the admin when an unauthorized user attempts access.
 */
export async function alertAdmin(bot, { userId, username, firstName, text, type }) {
  const adminId = Number(process.env.OWNER_TELEGRAM_ID);
  if (!adminId) return;

  const userTag = username ? `@${username}` : 'بدون معرّف';
  const name = firstName || 'غير معروف';
  const content = text || '—';
  const updateType = type || 'message';

  const alert =
    `🚨 *محاولة وصول غير مصرح بها\\!*\n\n` +
    `👤 *المستخدم:* ${escapeMarkdown(userTag)} \\(ID: \`${userId}\`\\)\n` +
    `📛 *الاسم:* ${escapeMarkdown(name)}\n` +
    `📩 *النوع:* ${escapeMarkdown(updateType)}\n` +
    `💬 *المحتوى:* ${escapeMarkdown(content)}`;

  try {
    await bot.sendMessage(adminId, alert, { parse_mode: 'MarkdownV2' });
  } catch {
    // Fallback to plain text if MarkdownV2 fails
    const plain =
      `🚨 محاولة وصول غير مصرح بها!\n\n` +
      `👤 المستخدم: ${userTag} (ID: ${userId})\n` +
      `📛 الاسم: ${name}\n` +
      `📩 النوع: ${updateType}\n` +
      `💬 المحتوى: ${content}`;
    await bot.sendMessage(adminId, plain).catch(() => {});
  }
}

function escapeMarkdown(text) {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}
