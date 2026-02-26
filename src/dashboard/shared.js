/**
 * KERNEL Dashboard — Shared utilities, SSE, gauges, canvas animations.
 * Exposed on window.KERNEL for use by page-specific scripts.
 */
(function() {
  // ── Utilities ──
  function esc(s) {
    if (!s) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function formatDuration(seconds) {
    if (seconds == null || seconds < 0) return '--';
    const s = Math.floor(seconds);
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s/60) + 'm ' + (s%60) + 's';
    return Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'm';
  }

  function timeAgo(ts) {
    if (!ts) return 'never';
    const s = Math.floor((Date.now() - ts)/1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s/60) + 'm ago';
    if (s < 86400) return Math.floor(s/3600) + 'h ago';
    return Math.floor(s/86400) + 'd ago';
  }

  function formatBytes(b) {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
    if (b < 1073741824) return (b/1048576).toFixed(1) + ' MB';
    return (b/1073741824).toFixed(2) + ' GB';
  }

  function barColor(pct) { return pct < 50 ? 'green' : pct < 80 ? 'amber' : 'red'; }

  function makeBar(label, pct, color) {
    return `<div class="row"><span class="k">${esc(label)}</span><span class="v">${pct.toFixed(1)}%</span></div><div class="bar-track"><div class="bar-fill ${color || barColor(pct)}" style="width:${Math.min(pct,100)}%"></div></div>`;
  }

  const $ = id => document.getElementById(id);

  // ── Clock ──
  function startClock() {
    setInterval(() => {
      const now = new Date();
      const p = n => String(n).padStart(2,'0');
      const full = now.getFullYear() + '.' + p(now.getMonth()+1) + '.' + p(now.getDate()) + ' ' + p(now.getHours()) + ':' + p(now.getMinutes()) + ':' + p(now.getSeconds());
      const hdrClock = $('hdr-clock');
      if (hdrClock) hdrClock.textContent = full;
      const rbClock = $('rb-clock');
      if (rbClock) rbClock.textContent = p(now.getHours()) + ':' + p(now.getMinutes());
    }, 1000);
  }

  // ── Gauge helpers ──
  function setGauge(id, pct, label) {
    const el = $(id);
    if (!el) return;
    const circumference = parseFloat(el.querySelector('.fill').getAttribute('stroke-dasharray'));
    const offset = circumference * (1 - Math.min(pct, 100) / 100);
    const fill = el.querySelector('.fill');
    fill.style.strokeDashoffset = offset;
    fill.classList.remove('amber', 'red');
    if (pct >= 80) fill.classList.add('red');
    else if (pct >= 50) fill.classList.add('amber');
    const pctEl = el.querySelector('.pct');
    if (pctEl) {
      pctEl.textContent = pct.toFixed(0) + '%';
      pctEl.classList.remove('amber','red');
      if (pct >= 80) pctEl.classList.add('red');
      else if (pct >= 50) pctEl.classList.add('amber');
    }
    const sub = el.querySelector('.sub');
    if (sub && label) sub.textContent = label;
  }

  function setMiniGauge(id, pct) {
    const el = $(id);
    if (!el) return;
    const fill = el.querySelector('.fill');
    const circumference = parseFloat(fill.getAttribute('stroke-dasharray'));
    fill.style.strokeDashoffset = circumference * (1 - Math.min(pct, 100) / 100);
    fill.classList.remove('amber','red');
    if (pct >= 80) fill.classList.add('red');
    else if (pct >= 50) fill.classList.add('amber');
    el.querySelector('.val').textContent = pct.toFixed(0) + '%';
  }

  // ── SSE Connection ──
  function connectSSE(onSnapshot) {
    let reconnectDelay = 1000;
    function connect() {
      const es = new EventSource('/events');
      es.onopen = () => {
        reconnectDelay = 1000;
        const connDot = $('conn-dot');
        if (connDot) connDot.classList.add('connected');
        const topConn = $('top-conn');
        if (topConn) topConn.classList.add('connected');
        const hdrStatus = $('hdr-status');
        if (hdrStatus) hdrStatus.textContent = 'ONLINE';
      };
      es.onmessage = (evt) => {
        try {
          const data = JSON.parse(evt.data);
          onSnapshot(data);
        } catch(e) {
          if (e instanceof SyntaxError) {
            console.debug('[Dashboard] Malformed SSE message (invalid JSON)');
          } else {
            console.warn('[Dashboard] Snapshot handler error:', e.message || e);
          }
        }
      };
      es.onerror = () => {
        es.close();
        const connDot = $('conn-dot');
        if (connDot) connDot.classList.remove('connected');
        const topConn = $('top-conn');
        if (topConn) topConn.classList.remove('connected');
        const hdrStatus = $('hdr-status');
        if (hdrStatus) hdrStatus.textContent = 'RECONNECTING';
        setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 1.5, 15000);
      };
    }
    connect();
  }

  // ── Particle Grid Canvas ──
  function initParticleCanvas() {
    const canvas = $('particle-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let w, h;
    const GRID = 50;

    function resize() {
      w = canvas.width = window.innerWidth;
      h = canvas.height = window.innerHeight;
      drawGrid();
    }

    function drawGrid() {
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(57,255,20,0.02)';
      ctx.lineWidth = 0.5;
      for (let x = 0; x <= w; x += GRID) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      }
      for (let y = 0; y <= h; y += GRID) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      }
    }

    resize();
    window.addEventListener('resize', resize);
  }

  // ── Waveform Canvas ──
  function initWaveform() {
    const canvas = $('waveform-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let w, h, phase = 0;

    function resize() {
      const parent = canvas.parentElement;
      w = canvas.width = parent.offsetWidth;
      h = canvas.height = parent.offsetHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    const waves = [
      { freq: 0.015, amp: 0.25, speed: 0.02, alpha: 0.5, width: 1.5 },
      { freq: 0.025, amp: 0.15, speed: 0.035, alpha: 0.3, width: 1 },
      { freq: 0.04,  amp: 0.08, speed: 0.05, alpha: 0.15, width: 0.8 },
    ];

    function draw() {
      requestAnimationFrame(draw);
      ctx.clearRect(0, 0, w, h);
      for (const wave of waves) {
        ctx.beginPath();
        ctx.strokeStyle = `rgba(57,255,20,${wave.alpha})`;
        ctx.lineWidth = wave.width;
        for (let x = 0; x < w; x++) {
          const y = h/2 + Math.sin(x * wave.freq + phase * wave.speed * 60) * h * wave.amp
                       + Math.sin(x * wave.freq * 2.3 + phase * wave.speed * 40) * h * wave.amp * 0.4;
          x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      phase += 0.016;
    }
    requestAnimationFrame(draw);
  }

  // ── Expose on window.KERNEL ──
  window.KERNEL = {
    esc,
    formatDuration,
    timeAgo,
    formatBytes,
    barColor,
    makeBar,
    $,
    startClock,
    setGauge,
    setMiniGauge,
    connectSSE,
    initParticleCanvas,
    initWaveform,
  };
})();
