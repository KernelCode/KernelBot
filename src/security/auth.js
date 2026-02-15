export function isAllowedUser(userId, config) {
  const allowed = config.telegram.allowed_users;
  if (!allowed || allowed.length === 0) return true; // dev mode
  return allowed.includes(userId);
}

export function getUnauthorizedMessage() {
  return 'Access denied. You are not authorized to use this bot.';
}
