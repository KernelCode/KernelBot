export class ConversationManager {
  constructor(config) {
    this.maxHistory = config.conversation.max_history;
    this.conversations = new Map();
  }

  getHistory(chatId) {
    if (!this.conversations.has(chatId)) {
      this.conversations.set(chatId, []);
    }
    return this.conversations.get(chatId);
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
  }

  clear(chatId) {
    this.conversations.delete(chatId);
  }

  clearAll() {
    this.conversations.clear();
  }
}
