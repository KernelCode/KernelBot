(function () {
  const { esc, $, startClock, setMiniGauge, connectSSE, initParticleCanvas } = window.KERNEL;

  startClock();
  initParticleCanvas();

  let sending = false;
  const messages = [];

  // SSE for system gauges
  connectSSE(function (snap) {
    if (snap.system) {
      const s = snap.system;
      setMiniGauge('sb-cpu', (s.cpu1 || 0) / 100);
      setMiniGauge('sb-ram', s.memUsed && s.memTotal ? s.memUsed / s.memTotal : 0);
    }
  });

  const chatMessages = $('chat-messages');
  const chatInput = $('chat-input');
  const chatSend = $('chat-send');
  const chatStatus = $('chat-status');

  // Auto-resize textarea
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

  function sendMessage() {
    const text = chatInput.value.trim();
    if (!text || sending) return;

    // Remove welcome screen
    const welcome = chatMessages.querySelector('.chat-welcome');
    if (welcome) welcome.remove();

    // Add user message
    addMessage('user', text);
    chatInput.value = '';
    chatInput.style.height = 'auto';

    // Show typing indicator
    sending = true;
    chatSend.disabled = true;
    chatStatus.textContent = 'Processing...';
    chatStatus.className = 'chat-status';
    showTyping();

    // Send to API
    fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, history: messages.slice(-20) }),
    })
      .then(r => r.json())
      .then(data => {
        hideTyping();
        if (data.error) {
          chatStatus.textContent = 'Error: ' + data.error;
          chatStatus.className = 'chat-status error';
        } else {
          addMessage('assistant', data.reply || '(empty response)');
          chatStatus.textContent = '';
        }
      })
      .catch(err => {
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

  function addMessage(role, text) {
    messages.push({ role, content: text });

    const now = new Date();
    const time = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');

    const div = document.createElement('div');
    div.className = 'chat-msg ' + role;
    div.innerHTML =
      `<div class="chat-msg-header">${role === 'user' ? 'YOU' : 'KERNEL'}</div>` +
      `<div class="chat-msg-body">${formatMessage(text)}</div>` +
      `<div class="chat-msg-time">${time}</div>`;

    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function formatMessage(text) {
    // Basic formatting: escape HTML, then handle code blocks and bold
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
    typingEl.id = 'chat-typing';
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

  chatInput.focus();
})();
