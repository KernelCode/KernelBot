import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

function getConversationsPath() {
  const dir = join(homedir(), '.kernelbot');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'conversations.json');
}

export class ConversationManager {
  constructor(config) {
    this.maxHistory = config.conversation.max_history;
    this.recentWindow = config.conversation.recent_window || 10;
    this.conversations = new Map();
    this.filePath = getConversationsPath();
  }

  load() {
    if (!existsSync(this.filePath)) return false;
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const data = JSON.parse(raw);
      for (const [chatId, messages] of Object.entries(data)) {
        this.conversations.set(String(chatId), messages);
      }
      return this.conversations.size > 0;
    } catch {
      return false;
    }
  }

  save() {
    try {
      const data = {};
      for (const [chatId, messages] of this.conversations) {
        data[chatId] = messages;
      }
      writeFileSync(this.filePath, JSON.stringify(data, null, 2));
    } catch {
      // Silent fail — don't crash the bot over persistence
    }
  }

  getHistory(chatId) {
    const key = String(chatId);
    if (!this.conversations.has(key)) {
      this.conversations.set(key, []);
    }
    return this.conversations.get(key);
  }

  /**
   * Get history with older messages compressed into a summary.
   * Keeps the last `recentWindow` messages verbatim and summarizes older ones.
   */
  getSummarizedHistory(chatId) {
    const history = this.getHistory(chatId);

    if (history.length <= this.recentWindow) {
      return [...history];
    }

    const olderMessages = history.slice(0, history.length - this.recentWindow);
    const recentMessages = history.slice(history.length - this.recentWindow);

    // Compress older messages into a single summary
    const summaryLines = olderMessages.map((msg) => {
      const content = typeof msg.content === 'string'
        ? msg.content.slice(0, 200)
        : JSON.stringify(msg.content).slice(0, 200);
      return `[${msg.role}]: ${content}`;
    });

    const summaryMessage = {
      role: 'user',
      content: `[CONVERSATION SUMMARY - ${olderMessages.length} earlier messages]\n${summaryLines.join('\n')}`,
    };

    // Ensure result starts with user role
    const result = [summaryMessage, ...recentMessages];

    // If the first real message after summary is assistant, that's fine since
    // our summary is role:user. But ensure recent starts correctly.
    return result;
  }

  addMessage(chatId, role, content) {
    const history = this.getHistory(chatId);
    history.push({ role, content });

    // Trim to max history
    while (history.length > this.maxHistory) {
      history.shift();
    }

    // Ensure conversation starts with user role
    while (history.length > 0 && history[0].role !== 'user') {
      history.shift();
    }

    this.save();
  }

  clear(chatId) {
    this.conversations.delete(String(chatId));
    this.save();
  }

  clearAll() {
    this.conversations.clear();
    this.save();
  }

  getMessageCount(chatId) {
    const history = this.getHistory(chatId);
    return history.length;
  }
}
