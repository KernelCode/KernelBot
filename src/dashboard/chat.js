(function () {
  const { esc, $, startClock, setMiniGauge, connectSSE, initParticleCanvas } = window.KERNEL;

  startClock();
  initParticleCanvas();

  // ── State ────────────────────────────────────────────
  let sending = false;
  let messages = [];
  let characters = [];
  let activeCharId = '';
  const MAX_STORED_MESSAGES = 100;
  const STORAGE_PREFIX = 'kernel_chat_';

  // ── DOM refs ─────────────────────────────────────────
  const chatMessages = $('chat-messages');
  const chatInput = $('chat-input');
  const chatSend = $('chat-send');
  const chatStatus = $('chat-status');
  const charSelect = $('character-select');
  const clearBtn = $('chat-clear');
  const welcomeEl = $('chat-welcome');

  // ── SSE for system gauges ────────────────────────────
  connectSSE(function (snap) {
    if (snap.system) {
      const s = snap.system;
      setMiniGauge('sb-cpu', (s.cpu1 || 0) / 100);
      setMiniGauge('sb-ram', s.memUsed && s.memTotal ? s.memUsed / s.memTotal : 0);
    }
  });

  // ── Load characters ──────────────────────────────────
  function loadCharacters() {
    fetch('/api/character')
      .then(r => r.json())
      .then(data => {
        characters = data.characters || [];
        const currentActive = data.active?.id || '';
        renderCharacterDropdown(currentActive);
      })
      .catch(() => {
        charSelect.innerHTML = '<option value="">Default</option>';
      });
  }

  function renderCharacterDropdown(defaultId) {
    let h = '';
    for (const c of characters) {
      const label = (c.emoji ? c.emoji + ' ' : '') + c.name;
      const sel = c.id === defaultId ? ' selected' : '';
      h += `<option value="${esc(c.id)}"${sel}>${esc(label)}</option>`;
    }
    if (!h) h = '<option value="">Default</option>';
    charSelect.innerHTML = h;

    // Set active character
    activeCharId = charSelect.value;
    // Load stored history for this character
    loadHistory();
  }

  // ── Character switch ─────────────────────────────────
  charSelect.addEventListener('change', () => {
    // Save current history before switching
    saveHistory();
    activeCharId = charSelect.value;
    // Load history for new character
    loadHistory();
  });

  // ── localStorage persistence ─────────────────────────
  function storageKey() {
    return STORAGE_PREFIX + (activeCharId || 'default');
  }

  function saveHistory() {
    try {
      const toStore = messages.slice(-MAX_STORED_MESSAGES);
      localStorage.setItem(storageKey(), JSON.stringify(toStore));
    } catch { /* quota exceeded or unavailable */ }
  }

  function loadHistory() {
    messages = [];
    try {
      const stored = localStorage.getItem(storageKey());
      if (stored) {
        messages = JSON.parse(stored);
        if (!Array.isArray(messages)) messages = [];
        messages = messages.slice(-MAX_STORED_MESSAGES);
      }
    } catch { messages = []; }
    renderAllMessages();
  }

  function renderAllMessages() {
    // Clear chat area
    chatMessages.innerHTML = '';
    if (messages.length === 0) {
      // Show welcome
      chatMessages.innerHTML = `
        <div class="chat-welcome" id="chat-welcome">
          <div class="chat-welcome-icon">
            <svg viewBox="0 0 32 32" width="48" height="48">
              <path fill="rgba(57,255,20,0.35)" d="M10,2h10v2h-10z M8,4h2v2h-2z M6,6h2v4h-2z M4,10h2v8h-2z M6,18h2v2h-2z M8,20h2v2h-2z M10,22h14v2h-14z M24,18h2v4h-2z M26,8h2v10h-2z M24,6h2v2h-2z"/>
              <path fill="rgba(57,255,20,0.6)" d="M12,8h8v2h-8z M10,10h2v10h-2z M20,10h2v6h-2z M18,18h2v2h-2z M12,20h6v2h-6z"/>
              <path fill="#39ff14" d="M14,14h4v2h-2v2h-2z"/>
            </svg>
          </div>
          <div class="chat-welcome-title">KERNEL CHAT INTERFACE</div>
          <div class="chat-welcome-sub">Chat with your bot using its full personality. Select a character to switch personas.</div>
        </div>`;
      return;
    }
    // Render all stored messages
    for (const msg of messages) {
      appendMessageDOM(msg.role, msg.content, msg.time || '');
    }
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // ── Auto-resize textarea ─────────────────────────────
  chatInput.addEventListener('input', () => {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
  });

  // Send on Enter (Shift+Enter for newline)
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  chatSend.addEventListener('click', sendMessage);

  // ── Clear history ────────────────────────────────────
  clearBtn.addEventListener('click', () => {
    if (messages.length === 0) return;
    if (!confirm('Clear chat history for this character?')) return;
    messages = [];
    saveHistory();
    renderAllMessages();
  });

  // ── Send message ─────────────────────────────────────
  function sendMessage() {
    const text = chatInput.value.trim();
    if (!text || sending) return;

    // Remove welcome screen
    const welcome = chatMessages.querySelector('.chat-welcome');
    if (welcome) welcome.remove();

    // Add user message
    const time = nowTime();
    addMessage('user', text, time);
    chatInput.value = '';
    chatInput.style.height = 'auto';

    // Show typing indicator
    sending = true;
    chatSend.disabled = true;
    chatStatus.textContent = 'Processing...';
    chatStatus.className = 'chat-status';
    showTyping();

    // Send to API with characterId
    fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        history: messages.slice(-20),
        characterId: activeCharId || undefined,
      }),
    })
      .then(r => r.json())
      .then(data => {
        hideTyping();
        if (data.error) {
          chatStatus.textContent = 'Error: ' + data.error;
          chatStatus.className = 'chat-status error';
        } else {
          addMessage('assistant', data.reply || '(empty response)', nowTime());
          chatStatus.textContent = '';
        }
      })
      .catch(() => {
        hideTyping();
        chatStatus.textContent = 'Connection error';
        chatStatus.className = 'chat-status error';
      })
      .finally(() => {
        sending = false;
        chatSend.disabled = false;
        chatInput.focus();
      });
  }

  function addMessage(role, text, time) {
    messages.push({ role, content: text, time });
    // Cap messages
    if (messages.length > MAX_STORED_MESSAGES) {
      messages = messages.slice(-MAX_STORED_MESSAGES);
    }
    appendMessageDOM(role, text, time);
    saveHistory();
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function appendMessageDOM(role, text, time) {
    const charName = getCharacterName();
    const div = document.createElement('div');
    div.className = 'chat-msg ' + role;
    div.innerHTML =
      `<div class="chat-msg-header">${role === 'user' ? 'YOU' : esc(charName)}</div>` +
      `<div class="chat-msg-body">${formatMessage(text)}</div>` +
      `<div class="chat-msg-time">${esc(time || '')}</div>`;
    chatMessages.appendChild(div);
  }

  function getCharacterName() {
    const sel = charSelect.options[charSelect.selectedIndex];
    if (sel) {
      // Strip emoji prefix
      return sel.textContent.replace(/^[\p{Emoji}\s]+/u, '').trim() || 'KERNEL';
    }
    return 'KERNEL';
  }

  function nowTime() {
    const now = new Date();
    return now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
  }

  function formatMessage(text) {
    let out = esc(text);
    // Code blocks: ```...```
    out = out.replace(/```(\w*)\n?([\s\S]*?)```/g, '<pre style="background:rgba(0,0,0,0.4);padding:8px;border-left:2px solid var(--accent);margin:4px 0;overflow-x:auto;font-size:11px">$2</pre>');
    // Inline code: `...`
    out = out.replace(/`([^`]+)`/g, '<code style="background:rgba(57,255,20,0.08);padding:1px 4px;font-size:11px">$1</code>');
    // Bold: **...**
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong style="color:var(--text-bright)">$1</strong>');
    return out;
  }

  let typingEl = null;
  function showTyping() {
    if (typingEl) return;
    typingEl = document.createElement('div');
    typingEl.className = 'chat-typing';
    typingEl.innerHTML = '<div class="chat-typing-dot"></div><div class="chat-typing-dot"></div><div class="chat-typing-dot"></div>';
    chatMessages.appendChild(typingEl);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function hideTyping() {
    if (typingEl) {
      typingEl.remove();
      typingEl = null;
    }
  }

  // ── Init ─────────────────────────────────────────────
  loadCharacters();
  chatInput.focus();
})();
