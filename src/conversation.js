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
