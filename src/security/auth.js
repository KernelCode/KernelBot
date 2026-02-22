export function isAllowedUser(userId, config) {
  const allowed = config.telegram.allowed_users;
  if (!allowed || allowed.length === 0) return false;
  return allowed.includes(userId);
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
