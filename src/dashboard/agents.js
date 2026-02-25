/**
 * KERNEL Agents — Interactive topology visualization.
 * Zoom/pan canvas, draggable nodes, animated message particles, minimap.
 * Depends on window.KERNEL from shared.js.
 */
(function() {
  const { esc, formatDuration, timeAgo, formatBytes, $,
          startClock, setMiniGauge, connectSSE, initParticleCanvas, initWaveform } = window.KERNEL;

  // ── Init shared ──
  startClock();
  initParticleCanvas();
  initWaveform();

  // ── State ──
  let capabilities = null;
  let configData = null;
  let lastSnap = null;
  let selectedNode = null;
  let prevRunningIds = new Set();

  // ── Zoom / Pan state ──
  let zoom = 1;
  let panX = 0, panY = 0;
  const ZOOM_MIN = 0.3, ZOOM_MAX = 3, ZOOM_STEP = 0.12;
  let isPanning = false;
  let panStartX = 0, panStartY = 0;
  let panStartPanX = 0, panStartPanY = 0;

  // ── Node drag state ──
  let isDragging = false;
  let dragNode = null;
  let dragStartX = 0, dragStartY = 0;
  let dragNodeStartX = 0, dragNodeStartY = 0;

  // ── Node positions (absolute px in canvas space) ──
  const nodePositions = {};

  // ── Particle animation state ──
  const particles = []; // { pathEl, progress, speed, id, burst }
  let particleAnimFrame = null;

  // ── Fetch config ──
  fetch('/api/config').then(r => r.json()).then(d => { configData = d; updateHeroPulse(); });

  // ══════════════════════════════════════════
  //  ZOOM & PAN
  // ══════════════════════════════════════════

  function applyTransform() {
    const canvas = $('workflow-canvas');
    if (canvas) canvas.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    $('zoom-level').textContent = Math.round(zoom * 100) + '%';
    updateMinimap();
  }

  function zoomTo(newZoom, cx, cy) {
    const container = $('workflow-container');
    if (!container) return;
    const rect = container.getBoundingClientRect();
    // Default center of container
    if (cx == null) cx = rect.width / 2;
    if (cy == null) cy = rect.height / 2;
    const old = zoom;
    zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newZoom));
    const scale = zoom / old;
    panX = cx - scale * (cx - panX);
    panY = cy - scale * (cy - panY);
    applyTransform();
  }

  // Mouse wheel zoom
  $('workflow-container').addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = $('workflow-container').getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
    zoomTo(zoom + delta, cx, cy);
  }, { passive: false });

  // Pan via mouse drag on empty space
  $('workflow-container').addEventListener('mousedown', (e) => {
    if (e.target.closest('.workflow-node') || e.target.closest('.zoom-controls') || e.target.closest('.minimap')) return;
    isPanning = true;
    panStartX = e.clientX;
    panStartY = e.clientY;
    panStartPanX = panX;
    panStartPanY = panY;
    $('workflow-container').classList.add('grabbing');
  });

  window.addEventListener('mousemove', (e) => {
    if (isPanning) {
      panX = panStartPanX + (e.clientX - panStartX);
      panY = panStartPanY + (e.clientY - panStartY);
      applyTransform();
    }
    if (isDragging && dragNode) {
      const dx = (e.clientX - dragStartX) / zoom;
      const dy = (e.clientY - dragStartY) / zoom;
      const id = dragNode.dataset.nodeId;
      const pos = nodePositions[id];
      if (pos) {
        pos.x = dragNodeStartX + dx;
        pos.y = dragNodeStartY + dy;
        dragNode.style.left = pos.x + 'px';
        dragNode.style.top = pos.y + 'px';
        updateConnectionPaths();
        updateMinimap();
      }
    }
  });

  window.addEventListener('mouseup', () => {
    if (isPanning) {
      isPanning = false;
      $('workflow-container').classList.remove('grabbing');
    }
    if (isDragging) {
      isDragging = false;
      if (dragNode) dragNode.classList.remove('dragging');
      $('workflow-container').classList.remove('dragging-node');
      dragNode = null;
    }
  });

  // Zoom buttons
  $('zoom-in').addEventListener('click', () => zoomTo(zoom + ZOOM_STEP));
  $('zoom-out').addEventListener('click', () => zoomTo(zoom - ZOOM_STEP));
  $('zoom-fit').addEventListener('click', fitToView);

  function fitToView() {
    const container = $('workflow-container');
    if (!container) return;
    const ids = Object.keys(nodePositions);
    if (!ids.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of ids) {
      const p = nodePositions[id];
      const node = $(`node-${id}`);
      if (!node) continue;
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + node.offsetWidth);
      maxY = Math.max(maxY, p.y + node.offsetHeight);
    }
    const pad = 60;
    const bw = maxX - minX + pad * 2;
    const bh = maxY - minY + pad * 2;
    const cw = container.offsetWidth;
    const ch = container.offsetHeight;
    zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.min(cw / bw, ch / bh)));
    panX = (cw - bw * zoom) / 2 - minX * zoom + pad * zoom;
    panY = (ch - bh * zoom) / 2 - minY * zoom + pad * zoom;
    applyTransform();
  }

  // ══════════════════════════════════════════
  //  NODE BUILDING & LAYOUT
  // ══════════════════════════════════════════

  function defaultLayout(caps) {
    // Default positions in canvas pixel space
    const positions = {
      user:         { x: 60,  y: 280 },
      orchestrator: { x: 380, y: 250 },
    };
    if (caps?.workers) {
      const workers = typeof caps.workers === 'object' && !Array.isArray(caps.workers)
        ? Object.keys(caps.workers) : [];
      const startY = 40;
      const gap = 110;
      for (let i = 0; i < workers.length; i++) {
        positions[workers[i]] = { x: 720, y: startY + i * gap };
      }
    }
    return positions;
  }

  function buildNodes(caps) {
    const container = $('workflow-nodes');
    container.innerHTML = '';

    // Compute default layout
    const defaults = defaultLayout(caps);
    for (const [id, pos] of Object.entries(defaults)) {
      if (!nodePositions[id]) nodePositions[id] = { ...pos };
    }

    // User node
    createNode(container, 'user', {
      emoji: '\u{1F4AC}',
      title: 'TELEGRAM',
      cls: 'user-node',
      body: '<div class="node-meta-row"><span class="k">Source</span><span class="v">USER INPUT</span></div>',
      ports: ['right'],
    });

    // Orchestrator
    const orchProvider = configData?.orchestrator?.provider || '--';
    const orchModel = configData?.orchestrator?.model || '--';
    createNode(container, 'orchestrator', {
      emoji: '\u{1F9E0}',
      title: 'ORCHESTRATOR',
      cls: 'orchestrator',
      body: `<div class="node-meta-row"><span class="k">Provider</span><span class="v">${esc(orchProvider)}</span></div>`
          + `<div class="node-meta-row"><span class="k">Model</span><span class="v">${esc(orchModel.length > 18 ? orchModel.slice(0,16)+'..' : orchModel)}</span></div>`
          + '<div class="node-meta-row"><span class="k">Tools</span><span class="v">dispatch / list / cancel</span></div>',
      ports: ['left', 'right'],
    });

    // Workers
    if (caps?.workers) {
      const workers = typeof caps.workers === 'object' && !Array.isArray(caps.workers)
        ? Object.entries(caps.workers) : [];
      for (const [type, w] of workers) {
        createNode(container, type, {
          emoji: w.emoji || '\u2699\uFE0F',
          title: w.label?.replace(' Worker', '').toUpperCase() || type.toUpperCase(),
          cls: '',
          body: `<div class="node-meta-row"><span class="k">Tools</span><span class="v">${w.tools?.length || 0}</span></div>`
              + `<div class="node-meta-row"><span class="k">Timeout</span><span class="v">${formatDuration(w.timeout)}</span></div>`
              + `<div class="node-meta-row"><span class="k">Categories</span><span class="v">${(w.categories||[]).length}</span></div>`,
          ports: ['left'],
        });
      }
    }

    positionNodes();
  }

  function createNode(container, id, opts) {
    const node = document.createElement('div');
    node.className = `workflow-node ${opts.cls || ''}`.trim();
    node.id = `node-${id}`;
    node.dataset.nodeId = id;

    let portsHtml = '';
    for (const side of (opts.ports || [])) {
      portsHtml += `<div class="node-port ${side}" data-port="${side}"></div>`;
    }

    node.innerHTML = `
      ${portsHtml}
      <div class="node-header">
        <span class="node-emoji">${opts.emoji}</span>
        <span class="node-title">${opts.title}</span>
        <span class="node-status-dot idle" id="status-${id}"></span>
      </div>
      <div class="node-body">${opts.body}</div>
      <div class="node-jobs" id="jobs-${id}"></div>
    `;

    // Node drag
    node.addEventListener('mousedown', (e) => {
      if (e.target.closest('.detail-panel')) return;
      e.stopPropagation();
      isDragging = true;
      dragNode = node;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      const pos = nodePositions[id];
      dragNodeStartX = pos ? pos.x : 0;
      dragNodeStartY = pos ? pos.y : 0;
      node.classList.add('dragging');
      $('workflow-container').classList.add('dragging-node');
    });

    // Click (only if not dragged)
    let clickStart = null;
    node.addEventListener('mousedown', (e) => { clickStart = { x: e.clientX, y: e.clientY }; });
    node.addEventListener('mouseup', (e) => {
      if (clickStart && Math.abs(e.clientX - clickStart.x) < 5 && Math.abs(e.clientY - clickStart.y) < 5) {
        openDetailPanel(id);
      }
      clickStart = null;
    });

    container.appendChild(node);
  }

  function positionNodes() {
    for (const [id, pos] of Object.entries(nodePositions)) {
      const node = $(`node-${id}`);
      if (!node) continue;
      node.style.left = pos.x + 'px';
      node.style.top = pos.y + 'px';
    }
    updateConnectionPaths();
    updateMinimap();
  }

  // ══════════════════════════════════════════
  //  SVG CONNECTIONS
  // ══════════════════════════════════════════

  function buildConnections(caps) {
    const svg = $('workflow-svg');
    svg.querySelectorAll('.connection-path, .msg-particle, .msg-trail').forEach(p => p.remove());

    createConnection(svg, 'user', 'orchestrator', 'conn-user-orch');

    if (caps?.workers) {
      const workers = typeof caps.workers === 'object' && !Array.isArray(caps.workers)
        ? Object.keys(caps.workers) : [];
      for (const type of workers) {
        createConnection(svg, 'orchestrator', type, `conn-orch-${type}`);
      }
    }
  }

  function createConnection(svg, fromId, toId, connId) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.id = connId;
    path.classList.add('connection-path');
    path.dataset.from = fromId;
    path.dataset.to = toId;
    svg.appendChild(path);
  }

  function getNodeCenter(id, side) {
    const node = $(`node-${id}`);
    const pos = nodePositions[id];
    if (!node || !pos) return { x: 0, y: 0 };
    const w = node.offsetWidth;
    const h = node.offsetHeight;
    if (side === 'right') return { x: pos.x + w, y: pos.y + h / 2 };
    if (side === 'left') return { x: pos.x, y: pos.y + h / 2 };
    return { x: pos.x + w / 2, y: pos.y + h / 2 };
  }

  function updateConnectionPaths() {
    const svg = $('workflow-svg');
    if (!svg) return;

    svg.querySelectorAll('.connection-path').forEach(path => {
      const fromId = path.dataset.from;
      const toId = path.dataset.to;
      const from = getNodeCenter(fromId, 'right');
      const to = getNodeCenter(toId, 'left');
      const dx = Math.abs(to.x - from.x) * 0.5;
      const d = `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
      path.setAttribute('d', d);
    });
  }

  // ══════════════════════════════════════════
  //  ANIMATED MESSAGE PARTICLES
  // ══════════════════════════════════════════

  function spawnParticle(connId, opts = {}) {
    const pathEl = document.getElementById(connId);
    if (!pathEl || pathEl.getTotalLength() === 0) return;

    const svg = $('workflow-svg');
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.classList.add('msg-particle');
    if (opts.burst) circle.classList.add('burst');
    circle.setAttribute('r', opts.burst ? 4 : 3);
    svg.appendChild(circle);

    // Glow trail
    const trail = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    trail.classList.add('msg-trail');
    svg.appendChild(trail);

    particles.push({
      pathEl,
      circle,
      trail,
      progress: 0,
      speed: opts.speed || (0.004 + Math.random() * 0.003),
      burst: !!opts.burst,
    });

    if (!particleAnimFrame) startParticleLoop();
  }

  function startParticleLoop() {
    function tick() {
      const svg = $('workflow-svg');
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.progress += p.speed;
        if (p.progress >= 1) {
          p.circle.remove();
          p.trail.remove();
          particles.splice(i, 1);
          continue;
        }
        const len = p.pathEl.getTotalLength();
        const pt = p.pathEl.getPointAtLength(p.progress * len);
        p.circle.setAttribute('cx', pt.x);
        p.circle.setAttribute('cy', pt.y);

        // Trail: draw a short segment behind the particle
        const trailStart = Math.max(0, p.progress - 0.08);
        const steps = 8;
        let d = '';
        for (let s = 0; s <= steps; s++) {
          const t = trailStart + (p.progress - trailStart) * (s / steps);
          const tp = p.pathEl.getPointAtLength(t * len);
          d += (s === 0 ? 'M' : 'L') + ` ${tp.x} ${tp.y}`;
        }
        p.trail.setAttribute('d', d);
      }
      if (particles.length > 0) {
        particleAnimFrame = requestAnimationFrame(tick);
      } else {
        particleAnimFrame = null;
      }
    }
    particleAnimFrame = requestAnimationFrame(tick);
  }

  // Spawn particles periodically for active connections
  let particleInterval = null;
  function startParticleSpawner(runningTypes) {
    if (particleInterval) clearInterval(particleInterval);
    if (runningTypes.size === 0) return;

    function spawn() {
      // User → orch
      if (runningTypes.size > 0) {
        spawnParticle('conn-user-orch');
      }
      // Orch → active workers
      for (const type of runningTypes) {
        spawnParticle(`conn-orch-${type}`, { burst: Math.random() < 0.2 });
      }
    }
    spawn();
    particleInterval = setInterval(spawn, 1800 + Math.random() * 600);
  }

  // ══════════════════════════════════════════
  //  MINIMAP
  // ══════════════════════════════════════════

  function updateMinimap() {
    const minimap = $('minimap');
    const viewport = $('minimap-viewport');
    const container = $('workflow-container');
    if (!minimap || !viewport || !container) return;

    const mmW = minimap.offsetWidth;
    const mmH = minimap.offsetHeight;

    // Compute world bounds from nodes
    const ids = Object.keys(nodePositions);
    if (!ids.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of ids) {
      const p = nodePositions[id];
      const node = $(`node-${id}`);
      if (!node) continue;
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + node.offsetWidth);
      maxY = Math.max(maxY, p.y + node.offsetHeight);
    }
    const pad = 40;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const worldW = maxX - minX;
    const worldH = maxY - minY;
    const scale = Math.min(mmW / worldW, mmH / worldH);

    // Clear existing minimap nodes
    minimap.querySelectorAll('.minimap-node').forEach(n => n.remove());

    // Draw mini nodes
    for (const id of ids) {
      const p = nodePositions[id];
      const node = $(`node-${id}`);
      if (!node) continue;
      const dot = document.createElement('div');
      dot.className = 'minimap-node';
      if (id === 'user') dot.classList.add('user');
      else if (id === 'orchestrator') dot.classList.add('orch');
      if (node.classList.contains('has-active-job')) dot.classList.add('active');
      dot.style.left = ((p.x - minX) * scale) + 'px';
      dot.style.top = ((p.y - minY) * scale) + 'px';
      dot.style.width = (node.offsetWidth * scale) + 'px';
      dot.style.height = (node.offsetHeight * scale) + 'px';
      minimap.appendChild(dot);
    }

    // Viewport rect (what the user can see)
    const cw = container.offsetWidth;
    const ch = container.offsetHeight;
    // Visible area in world coordinates
    const vx = (-panX / zoom);
    const vy = (-panY / zoom);
    const vw = cw / zoom;
    const vh = ch / zoom;
    viewport.style.left = ((vx - minX) * scale) + 'px';
    viewport.style.top = ((vy - minY) * scale) + 'px';
    viewport.style.width = (vw * scale) + 'px';
    viewport.style.height = (vh * scale) + 'px';
  }

  // ══════════════════════════════════════════
  //  SSE UPDATES
  // ══════════════════════════════════════════

  connectSSE(onSnapshot);

  function onSnapshot(snap) {
    lastSnap = snap;

    if (snap.capabilities && !capabilities) {
      capabilities = snap.capabilities;
      buildNodes(capabilities);
      buildConnections(capabilities);
      requestAnimationFrame(() => {
        positionNodes();
        fitToView();
      });
    }

    updateNodes(snap);
    updateConnections(snap);
    updateStats(snap);
    updateRightBar(snap);
    updateSystem(snap.system);
    renderTicker(snap.logs);
    detectNewJobs(snap);

    if (selectedNode) updateDetailPanel(selectedNode);
  }

  // ── Ripple effect on new job arrival ──
  function detectNewJobs(snap) {
    const jobs = snap.jobs || [];
    const currentRunning = new Set(jobs.filter(j => j.status === 'running').map(j => j.id));
    for (const id of currentRunning) {
      if (!prevRunningIds.has(id)) {
        // New job — find its worker type and ripple
        const job = jobs.find(j => j.id === id);
        if (job?.type) {
          const node = $(`node-${job.type}`);
          if (node) {
            node.classList.remove('ripple');
            void node.offsetWidth; // force reflow
            node.classList.add('ripple');
            setTimeout(() => node.classList.remove('ripple'), 900);
          }
          // Also ripple orchestrator
          const orch = $('node-orchestrator');
          if (orch) {
            orch.classList.remove('ripple');
            void orch.offsetWidth;
            orch.classList.add('ripple');
            setTimeout(() => orch.classList.remove('ripple'), 900);
          }
          // Spawn burst particle
          spawnParticle('conn-user-orch', { burst: true, speed: 0.008 });
          spawnParticle(`conn-orch-${job.type}`, { burst: true, speed: 0.006 });
        }
      }
    }
    prevRunningIds = currentRunning;
  }

  function updateNodes(snap) {
    const jobs = snap.jobs || [];
    const runningByType = {};
    for (const j of jobs) {
      if (j.status === 'running') {
        if (!runningByType[j.type]) runningByType[j.type] = [];
        runningByType[j.type].push(j);
      }
    }

    // Orchestrator
    const orchDot = $('status-orchestrator');
    const orchRunning = jobs.filter(j => j.status === 'running').length;
    if (orchDot) orchDot.className = 'node-status-dot ' + (orchRunning > 0 ? 'active' : 'idle');
    const orchNode = $('node-orchestrator');
    if (orchNode) orchNode.classList.toggle('has-active-job', orchRunning > 0);
    const orchJobs = $('jobs-orchestrator');
    if (orchJobs) {
      orchJobs.innerHTML = orchRunning > 0
        ? `<div class="node-job-indicator"><span class="job-pulse"></span><span class="job-task">${orchRunning} active job${orchRunning > 1 ? 's' : ''}</span></div>`
        : '';
    }

    // User
    const userDot = $('status-user');
    if (userDot) userDot.className = 'node-status-dot active';

    // Workers
    if (capabilities?.workers) {
      const workerTypes = typeof capabilities.workers === 'object' && !Array.isArray(capabilities.workers)
        ? Object.keys(capabilities.workers) : [];
      for (const type of workerTypes) {
        const dot = $(`status-${type}`);
        const node = $(`node-${type}`);
        const jobsEl = $(`jobs-${type}`);
        const running = runningByType[type] || [];
        if (dot) dot.className = 'node-status-dot ' + (running.length > 0 ? 'active' : 'idle');
        if (node) node.classList.toggle('has-active-job', running.length > 0);
        if (jobsEl) {
          if (running.length > 0) {
            let jh = '';
            for (const j of running.slice(0, 2)) {
              jh += `<div class="node-job-indicator"><span class="job-pulse"></span><span class="job-id">${esc(j.id)}</span><span class="job-task">${esc((j.task||'').slice(0,40))}</span></div>`;
            }
            if (running.length > 2) jh += `<div style="font-size:8px;color:var(--dim);padding:2px 6px">+${running.length - 2} more</div>`;
            jobsEl.innerHTML = jh;
          } else {
            jobsEl.innerHTML = '';
          }
        }
      }
    }
  }

  function updateConnections(snap) {
    const jobs = snap.jobs || [];
    const runningTypes = new Set();
    for (const j of jobs) {
      if (j.status === 'running') runningTypes.add(j.type);
    }

    const svg = $('workflow-svg');
    if (!svg) return;

    const userOrch = svg.querySelector('#conn-user-orch');
    if (userOrch) userOrch.classList.toggle('active', runningTypes.size > 0);

    svg.querySelectorAll('.connection-path').forEach(path => {
      if (path.id === 'conn-user-orch') return;
      const toType = path.dataset.to;
      path.classList.toggle('active', runningTypes.has(toType));
    });

    // Port dots
    document.querySelectorAll('.node-port').forEach(port => {
      const node = port.closest('.workflow-node');
      if (!node) return;
      const nodeId = node.dataset.nodeId;
      const isActive = nodeId === 'user' ? runningTypes.size > 0
        : nodeId === 'orchestrator' ? runningTypes.size > 0
        : runningTypes.has(nodeId);
      port.classList.toggle('active', isActive);
    });

    // Particle spawner
    startParticleSpawner(runningTypes);
  }

  function updateStats(snap) {
    const jobs = snap.jobs || [];
    const running = jobs.filter(j => j.status === 'running').length;
    const queued = jobs.filter(j => j.status === 'queued').length;
    const completed = jobs.filter(j => j.status === 'completed').length;
    const failed = jobs.filter(j => j.status === 'failed').length;

    const setVal = (id, val) => { const el = $(id); if (el) el.textContent = val; };
    setVal('stat-running', running);
    setVal('stat-queued', queued);
    setVal('stat-completed', completed);
    setVal('stat-failed', failed);
    setVal('stat-total-tools', snap.capabilities?.totalTools || 0);

    const pJobs = $('pulse-jobs');
    if (pJobs) {
      pJobs.textContent = running > 0 ? running : '0';
      pJobs.className = 'pulse-val' + (running > 0 ? ' active' : ' idle');
    }
    const pWorkers = $('pulse-workers');
    if (pWorkers && snap.capabilities?.workers) {
      const count = typeof snap.capabilities.workers === 'object'
        ? Object.keys(snap.capabilities.workers).length : 0;
      pWorkers.textContent = count;
    }
  }

  function updateHeroPulse() {
    if (!configData) return;
    const pOrch = $('pulse-orch');
    if (pOrch) {
      const m = configData.orchestrator?.model || '--';
      pOrch.textContent = m.length > 18 ? m.slice(0,16)+'..' : m;
      pOrch.className = 'pulse-val active';
    }
    const pBrain = $('pulse-brain');
    if (pBrain) {
      const m = configData.brain?.model || '--';
      pBrain.textContent = m.length > 18 ? m.slice(0,16)+'..' : m;
      pBrain.className = 'pulse-val active';
    }
  }

  function updateRightBar(snap) {
    const jobs = snap.jobs || [];
    const running = jobs.filter(j => j.status === 'running').length;
    const completed = jobs.filter(j => j.status === 'completed').length;
    const failed = jobs.filter(j => j.status === 'failed').length;
    const set = (id, val, cls) => { const el = $(id); if (el) { el.textContent = val; el.className = cls; } };
    set('rb-jobs', running, 'r-val' + (running > 0 ? '' : ' zero'));
    set('rb-total-jobs', jobs.length, 'r-val' + (jobs.length > 0 ? '' : ' zero'));
    set('rb-completed', completed, 'r-val' + (completed > 0 ? '' : ' zero'));
    set('rb-failed', failed, 'r-val' + (failed > 0 ? ' warn' : ' zero'));
  }

  function updateSystem(sys) {
    if (!sys) return;
    const hdrUp = $('hdr-uptime');
    if (hdrUp) hdrUp.textContent = formatDuration(sys.uptime);
    const cores = sys.cpu.cores;
    const cpu1 = sys.cpu.load1 / cores * 100;
    const ramPct = parseFloat(sys.ram.percent);
    setMiniGauge('sb-cpu', cpu1);
    setMiniGauge('sb-ram', ramPct);
  }

  function renderTicker(logs) {
    if (!logs || !logs.length) return;
    const last = logs.slice(-20);
    let items = '';
    for (const l of last) {
      const lvl = (l.level||'info').toLowerCase();
      const ts = l.timestamp ? l.timestamp.replace(/^.*T/,'').replace(/\..*$/,'') : '';
      items += `<span class="ticker-item"><span class="ts">[${esc(ts)}]</span> <span class="lvl-${lvl}">${esc(lvl.toUpperCase())}</span> <span class="msg">${esc((l.message||'').slice(0,80))}</span></span>`;
    }
    $('ticker-track').innerHTML = items + items;
    document.documentElement.style.setProperty('--ticker-duration', Math.max(last.length * 4, 30) + 's');
  }

  // ══════════════════════════════════════════
  //  DETAIL PANEL
  // ══════════════════════════════════════════

  function openDetailPanel(nodeId) {
    const panel = $('detail-panel');
    if (selectedNode === nodeId && panel.classList.contains('open')) {
      closeDetailPanel();
      return;
    }
    document.querySelectorAll('.workflow-node.selected').forEach(n => n.classList.remove('selected'));
    selectedNode = nodeId;
    const node = $(`node-${nodeId}`);
    if (node) node.classList.add('selected');
    updateDetailPanel(nodeId);
    panel.classList.add('open');
  }

  function closeDetailPanel() {
    $('detail-panel').classList.remove('open');
    document.querySelectorAll('.workflow-node.selected').forEach(n => n.classList.remove('selected'));
    selectedNode = null;
  }

  function updateDetailPanel(nodeId) {
    const title = $('detail-title');
    const body = $('detail-body');
    if (!title || !body) return;
    const jobs = lastSnap?.jobs || [];

    if (nodeId === 'user') {
      title.textContent = '\u{1F4AC} TELEGRAM USER';
      let h = '<div class="detail-section"><div class="detail-section-label">OVERVIEW</div>';
      h += '<div class="detail-row"><span class="k">Type</span><span class="v">User Input Source</span></div>';
      h += '<div class="detail-row"><span class="k">Protocol</span><span class="v">Telegram Bot API</span></div>';
      const convs = lastSnap?.conversations || [];
      h += `<div class="detail-row"><span class="k">Active Chats</span><span class="v">${convs.length}</span></div></div>`;
      if (convs.length) {
        h += '<div class="detail-section"><div class="detail-section-label">RECENT CHATS</div>';
        for (const c of convs.slice(0, 8)) {
          h += `<div class="detail-row"><span class="k">${esc(c.chatId)}</span><span class="v">${c.messageCount} msgs \u00b7 ${timeAgo(c.lastTimestamp)}</span></div>`;
        }
        h += '</div>';
      }
      body.innerHTML = h;

    } else if (nodeId === 'orchestrator') {
      title.textContent = '\u{1F9E0} ORCHESTRATOR';
      let h = '<div class="detail-section"><div class="detail-section-label">CONFIGURATION</div>';
      h += `<div class="detail-row"><span class="k">Provider</span><span class="v">${esc(configData?.orchestrator?.provider || '--')}</span></div>`;
      h += `<div class="detail-row"><span class="k">Model</span><span class="v">${esc(configData?.orchestrator?.model || '--')}</span></div>`;
      h += `<div class="detail-row"><span class="k">Max Tokens</span><span class="v">${configData?.orchestrator?.max_tokens || '--'}</span></div>`;
      h += `<div class="detail-row"><span class="k">Temperature</span><span class="v">${configData?.orchestrator?.temperature ?? '--'}</span></div></div>`;
      h += '<div class="detail-section"><div class="detail-section-label">WORKER BRAIN CONFIG</div>';
      h += `<div class="detail-row"><span class="k">Provider</span><span class="v">${esc(configData?.brain?.provider || '--')}</span></div>`;
      h += `<div class="detail-row"><span class="k">Model</span><span class="v">${esc(configData?.brain?.model || '--')}</span></div>`;
      h += `<div class="detail-row"><span class="k">Max Tool Depth</span><span class="v">${configData?.brain?.max_tool_depth || '--'}</span></div></div>`;
      const running = jobs.filter(j => j.status === 'running').length;
      const queued = jobs.filter(j => j.status === 'queued').length;
      h += '<div class="detail-section"><div class="detail-section-label">JOB OVERVIEW</div>';
      h += `<div class="detail-row"><span class="k">Running</span><span class="v">${running}</span></div>`;
      h += `<div class="detail-row"><span class="k">Queued</span><span class="v">${queued}</span></div>`;
      h += `<div class="detail-row"><span class="k">Total</span><span class="v">${jobs.length}</span></div>`;
      h += `<div class="detail-row"><span class="k">Concurrent Limit</span><span class="v">${configData?.swarm?.max_concurrent_jobs || '--'}</span></div></div>`;
      h += '<div class="detail-section"><div class="detail-section-label">TOOLS</div>';
      h += '<div><span class="detail-tool-tag">dispatch_task</span><span class="detail-tool-tag">list_jobs</span><span class="detail-tool-tag">cancel_job</span></div></div>';
      body.innerHTML = h;

    } else {
      const w = capabilities?.workers?.[nodeId];
      if (!w) return;
      title.textContent = `${w.emoji || '\u2699\uFE0F'} ${(w.label || nodeId).toUpperCase()}`;
      let h = '<div class="detail-section"><div class="detail-section-label">DESCRIPTION</div>';
      h += `<div style="font-size:10px;color:var(--text)">${esc(w.description || '--')}</div></div>`;
      h += '<div class="detail-section"><div class="detail-section-label">CONFIG</div>';
      h += `<div class="detail-row"><span class="k">Timeout</span><span class="v">${formatDuration(w.timeout)}</span></div>`;
      h += `<div class="detail-row"><span class="k">Tools</span><span class="v">${w.tools?.length || 0}</span></div>`;
      h += `<div class="detail-row"><span class="k">Categories</span><span class="v">${(w.categories||[]).length}</span></div></div>`;
      if (w.categories?.length) {
        h += '<div class="detail-section"><div class="detail-section-label">TOOL CATEGORIES</div><div>';
        for (const cat of w.categories) h += `<span class="detail-cat-tag">${esc(cat)}</span>`;
        h += '</div></div>';
      }
      if (w.tools?.length) {
        h += '<div class="detail-section"><div class="detail-section-label">TOOLS</div><div>';
        for (const t of w.tools) h += `<span class="detail-tool-tag">${esc(t)}</span>`;
        h += '</div></div>';
      }
      const workerJobs = jobs.filter(j => j.type === nodeId);
      const runningJobs = workerJobs.filter(j => j.status === 'running');
      const recentJobs = workerJobs.filter(j => j.status !== 'running').slice(0, 5);
      if (runningJobs.length) {
        h += '<div class="detail-section"><div class="detail-section-label">RUNNING JOBS</div>';
        for (const j of runningJobs) {
          h += '<div class="detail-job-item">';
          h += `<div class="detail-job-meta"><span class="badge running">RUNNING</span> <span style="color:var(--amber);font-family:var(--font-hud);font-size:8px">${esc(j.id)}</span> <span style="color:var(--dim);font-size:9px">${formatDuration(j.duration)}</span></div>`;
          h += `<div class="detail-job-task">${esc((j.task||'').slice(0,100))}</div>`;
          if (j.lastThinking) h += `<div class="detail-job-sub">${esc(j.lastThinking.slice(0,80))}</div>`;
          h += `<div class="detail-job-sub">LLM: ${j.llmCalls||0} \u00b7 Tools: ${j.toolCalls||0}</div></div>`;
        }
        h += '</div>';
      }
      if (recentJobs.length) {
        h += '<div class="detail-section"><div class="detail-section-label">RECENT JOBS</div>';
        for (const j of recentJobs) {
          const badgeCls = j.status === 'completed' ? 'completed' : j.status === 'failed' ? 'failed' : 'cancelled';
          h += '<div class="detail-job-item">';
          h += `<div class="detail-job-meta"><span class="badge ${badgeCls}">${j.status.toUpperCase()}</span> <span style="color:var(--amber);font-family:var(--font-hud);font-size:8px">${esc(j.id)}</span> <span style="color:var(--dim);font-size:9px">${timeAgo(j.completedAt)}</span></div>`;
          h += `<div class="detail-job-task">${esc((j.task||'').slice(0,80))}</div></div>`;
        }
        h += '</div>';
      }
      if (!runningJobs.length && !recentJobs.length) {
        h += '<div class="detail-section"><div style="color:var(--dim);font-style:italic;text-align:center;padding:12px 0;font-size:11px">NO JOBS</div></div>';
      }
      body.innerHTML = h;
    }
  }

  // ── Close panel handlers ──
  $('detail-close').addEventListener('click', closeDetailPanel);

  document.addEventListener('click', (e) => {
    if (!selectedNode) return;
    const panel = $('detail-panel');
    const isInsidePanel = panel.contains(e.target);
    const isInsideNode = e.target.closest('.workflow-node');
    if (!isInsidePanel && !isInsideNode) closeDetailPanel();
  });

  // ── Resize ──
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      updateConnectionPaths();
      updateMinimap();
    }, 150);
  });

})();
