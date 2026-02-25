/**
 * KERNEL Agents — Topology visualization with n8n-style workflow.
 * Depends on window.KERNEL from shared.js.
 */
(function() {
  const { esc, formatDuration, timeAgo, formatBytes, $,
          startClock, setMiniGauge, connectSSE, initParticleCanvas, initWaveform } = window.KERNEL;

  // ── Init shared ──
  startClock();
  initParticleCanvas();
  initWaveform();

  // ── Worker type definitions (loaded from API) ──
  let capabilities = null;
  let configData = null;
  let lastSnap = null;
  let selectedNode = null;

  // ── Fetch initial config ──
  fetch('/api/config').then(r => r.json()).then(d => { configData = d; updateHeroPulse(); });

  // ── Node layout ──
  // Fixed positions (percentages of container)
  const NODE_LAYOUT = {
    user:         { x: 5,  yPct: 50 },
    orchestrator: { x: 35, yPct: 50 },
    // Workers stacked on the right
    coding:       { x: 70, yPct: 10 },
    browser:      { x: 70, yPct: 26 },
    system:       { x: 70, yPct: 42 },
    devops:       { x: 70, yPct: 58 },
    research:     { x: 70, yPct: 74 },
    social:       { x: 70, yPct: 90 },
  };

  // ── Build nodes ──
  function buildNodes(caps) {
    const container = $('workflow-nodes');
    container.innerHTML = '';

    // User node
    createNode(container, 'user', {
      emoji: '💬',
      title: 'TELEGRAM',
      cls: 'user-node',
      body: '<div class="node-meta-row"><span class="k">Source</span><span class="v">USER INPUT</span></div>',
      ports: ['right'],
    });

    // Orchestrator node
    const orchProvider = configData?.orchestrator?.provider || '--';
    const orchModel = configData?.orchestrator?.model || '--';
    createNode(container, 'orchestrator', {
      emoji: '🧠',
      title: 'ORCHESTRATOR',
      cls: 'orchestrator',
      body: `<div class="node-meta-row"><span class="k">Provider</span><span class="v">${esc(orchProvider)}</span></div>`
          + `<div class="node-meta-row"><span class="k">Model</span><span class="v">${esc(orchModel.length > 18 ? orchModel.slice(0,16)+'..' : orchModel)}</span></div>`
          + '<div class="node-meta-row"><span class="k">Tools</span><span class="v">dispatch / list / cancel</span></div>',
      ports: ['left', 'right'],
    });

    // Worker nodes
    if (caps?.workers) {
      const workers = typeof caps.workers === 'object' && !Array.isArray(caps.workers)
        ? Object.entries(caps.workers)
        : [];

      for (const [type, w] of workers) {
        createNode(container, type, {
          emoji: w.emoji || '⚙️',
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

    node.addEventListener('click', () => openDetailPanel(id));
    container.appendChild(node);
  }

  function positionNodes() {
    const container = $('workflow-container');
    if (!container) return;
    const cw = container.offsetWidth;
    const ch = container.offsetHeight;

    for (const [id, pos] of Object.entries(NODE_LAYOUT)) {
      const node = $(`node-${id}`);
      if (!node) continue;
      const x = (pos.x / 100) * cw;
      const y = (pos.yPct / 100) * ch;
      node.style.left = `${x}px`;
      node.style.top = `${y - node.offsetHeight / 2}px`;
    }

    updateConnectionPaths();
  }

  // ── Build SVG connections ──
  function buildConnections(caps) {
    const svg = $('workflow-svg');
    // Clear existing paths (keep defs)
    svg.querySelectorAll('.connection-path').forEach(p => p.remove());

    // User → Orchestrator
    createConnection(svg, 'user', 'orchestrator', 'conn-user-orch');

    // Orchestrator → each worker
    if (caps?.workers) {
      const workers = typeof caps.workers === 'object' && !Array.isArray(caps.workers)
        ? Object.keys(caps.workers)
        : [];
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

  function updateConnectionPaths() {
    const svg = $('workflow-svg');
    if (!svg) return;
    const container = $('workflow-container');
    if (!container) return;
    const containerRect = container.getBoundingClientRect();

    svg.querySelectorAll('.connection-path').forEach(path => {
      const fromId = path.dataset.from;
      const toId = path.dataset.to;
      const fromNode = $(`node-${fromId}`);
      const toNode = $(`node-${toId}`);
      if (!fromNode || !toNode) return;

      const fromRect = fromNode.getBoundingClientRect();
      const toRect = toNode.getBoundingClientRect();

      // Right center of source → left center of target
      const x1 = fromRect.right - containerRect.left;
      const y1 = fromRect.top + fromRect.height / 2 - containerRect.top;
      const x2 = toRect.left - containerRect.left;
      const y2 = toRect.top + toRect.height / 2 - containerRect.top;

      // Cubic bezier
      const dx = Math.abs(x2 - x1) * 0.5;
      const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
      path.setAttribute('d', d);
    });
  }

  // ── SSE Updates ──
  connectSSE(onSnapshot);

  function onSnapshot(snap) {
    lastSnap = snap;

    // Build nodes on first snapshot with capabilities
    if (snap.capabilities && !capabilities) {
      capabilities = snap.capabilities;
      buildNodes(capabilities);
      buildConnections(capabilities);
      // Reposition after a tick to get accurate sizes
      requestAnimationFrame(() => positionNodes());
    }

    updateNodes(snap);
    updateConnections(snap);
    updateStats(snap);
    updateRightBar(snap);
    updateSystem(snap.system);
    renderTicker(snap.logs);

    // Update detail panel if open
    if (selectedNode) {
      updateDetailPanel(selectedNode);
    }
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

    // Update orchestrator
    const orchDot = $('status-orchestrator');
    const orchRunning = jobs.filter(j => j.status === 'running').length;
    if (orchDot) {
      orchDot.className = 'node-status-dot ' + (orchRunning > 0 ? 'active' : 'idle');
    }
    const orchNode = $('node-orchestrator');
    if (orchNode) orchNode.classList.toggle('has-active-job', orchRunning > 0);
    const orchJobs = $('jobs-orchestrator');
    if (orchJobs) {
      if (orchRunning > 0) {
        orchJobs.innerHTML = `<div class="node-job-indicator"><span class="job-pulse"></span><span class="job-task">${orchRunning} active job${orchRunning > 1 ? 's' : ''}</span></div>`;
      } else {
        orchJobs.innerHTML = '';
      }
    }

    // Update user node
    const userDot = $('status-user');
    if (userDot) userDot.className = 'node-status-dot active';

    // Update worker nodes
    if (capabilities?.workers) {
      const workerTypes = typeof capabilities.workers === 'object' && !Array.isArray(capabilities.workers)
        ? Object.keys(capabilities.workers)
        : [];

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

    // User → Orchestrator always active if any running
    const userOrch = svg.querySelector('#conn-user-orch');
    if (userOrch) userOrch.classList.toggle('active', runningTypes.size > 0);

    // Orchestrator → worker active if that worker type has running jobs
    svg.querySelectorAll('.connection-path').forEach(path => {
      if (path.id === 'conn-user-orch') return;
      const toType = path.dataset.to;
      path.classList.toggle('active', runningTypes.has(toType));
    });

    // Update port dots
    document.querySelectorAll('.node-port').forEach(port => {
      const node = port.closest('.workflow-node');
      if (!node) return;
      const nodeId = node.dataset.nodeId;
      const isActive = nodeId === 'user' ? runningTypes.size > 0
        : nodeId === 'orchestrator' ? runningTypes.size > 0
        : runningTypes.has(nodeId);
      port.classList.toggle('active', isActive);
    });
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

    // Hero pulse
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

    const set = (id, val, cls) => {
      const el = $(id);
      if (el) { el.textContent = val; el.className = cls; }
    };
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

  // ── Detail Panel ──
  function openDetailPanel(nodeId) {
    const panel = $('detail-panel');
    if (selectedNode === nodeId && panel.classList.contains('open')) {
      closeDetailPanel();
      return;
    }

    // Deselect previous
    document.querySelectorAll('.workflow-node.selected').forEach(n => n.classList.remove('selected'));

    selectedNode = nodeId;
    const node = $(`node-${nodeId}`);
    if (node) node.classList.add('selected');

    updateDetailPanel(nodeId);
    panel.classList.add('open');
  }

  function closeDetailPanel() {
    const panel = $('detail-panel');
    panel.classList.remove('open');
    document.querySelectorAll('.workflow-node.selected').forEach(n => n.classList.remove('selected'));
    selectedNode = null;
  }

  function updateDetailPanel(nodeId) {
    const title = $('detail-title');
    const body = $('detail-body');
    if (!title || !body) return;

    const jobs = lastSnap?.jobs || [];

    if (nodeId === 'user') {
      title.textContent = '💬 TELEGRAM USER';
      let h = '';
      h += '<div class="detail-section"><div class="detail-section-label">OVERVIEW</div>';
      h += '<div class="detail-row"><span class="k">Type</span><span class="v">User Input Source</span></div>';
      h += '<div class="detail-row"><span class="k">Protocol</span><span class="v">Telegram Bot API</span></div>';
      const convs = lastSnap?.conversations || [];
      h += `<div class="detail-row"><span class="k">Active Chats</span><span class="v">${convs.length}</span></div>`;
      h += '</div>';
      if (convs.length) {
        h += '<div class="detail-section"><div class="detail-section-label">RECENT CHATS</div>';
        for (const c of convs.slice(0, 8)) {
          h += `<div class="detail-row"><span class="k">${esc(c.chatId)}</span><span class="v">${c.messageCount} msgs · ${timeAgo(c.lastTimestamp)}</span></div>`;
        }
        h += '</div>';
      }
      body.innerHTML = h;
    } else if (nodeId === 'orchestrator') {
      title.textContent = '🧠 ORCHESTRATOR';
      let h = '';
      h += '<div class="detail-section"><div class="detail-section-label">CONFIGURATION</div>';
      h += `<div class="detail-row"><span class="k">Provider</span><span class="v">${esc(configData?.orchestrator?.provider || '--')}</span></div>`;
      h += `<div class="detail-row"><span class="k">Model</span><span class="v">${esc(configData?.orchestrator?.model || '--')}</span></div>`;
      h += `<div class="detail-row"><span class="k">Max Tokens</span><span class="v">${configData?.orchestrator?.max_tokens || '--'}</span></div>`;
      h += `<div class="detail-row"><span class="k">Temperature</span><span class="v">${configData?.orchestrator?.temperature ?? '--'}</span></div>`;
      h += '</div>';

      h += '<div class="detail-section"><div class="detail-section-label">WORKER BRAIN CONFIG</div>';
      h += `<div class="detail-row"><span class="k">Provider</span><span class="v">${esc(configData?.brain?.provider || '--')}</span></div>`;
      h += `<div class="detail-row"><span class="k">Model</span><span class="v">${esc(configData?.brain?.model || '--')}</span></div>`;
      h += `<div class="detail-row"><span class="k">Max Tool Depth</span><span class="v">${configData?.brain?.max_tool_depth || '--'}</span></div>`;
      h += '</div>';

      const running = jobs.filter(j => j.status === 'running').length;
      const queued = jobs.filter(j => j.status === 'queued').length;
      h += '<div class="detail-section"><div class="detail-section-label">JOB OVERVIEW</div>';
      h += `<div class="detail-row"><span class="k">Running</span><span class="v">${running}</span></div>`;
      h += `<div class="detail-row"><span class="k">Queued</span><span class="v">${queued}</span></div>`;
      h += `<div class="detail-row"><span class="k">Total</span><span class="v">${jobs.length}</span></div>`;
      const limit = configData?.swarm?.max_concurrent_jobs || '--';
      h += `<div class="detail-row"><span class="k">Concurrent Limit</span><span class="v">${limit}</span></div>`;
      h += '</div>';

      h += '<div class="detail-section"><div class="detail-section-label">TOOLS</div>';
      h += '<div><span class="detail-tool-tag">dispatch_task</span><span class="detail-tool-tag">list_jobs</span><span class="detail-tool-tag">cancel_job</span></div>';
      h += '</div>';

      body.innerHTML = h;
    } else {
      // Worker node
      const w = capabilities?.workers?.[nodeId];
      if (!w) return;

      title.textContent = `${w.emoji || '⚙️'} ${(w.label || nodeId).toUpperCase()}`;
      let h = '';

      h += '<div class="detail-section"><div class="detail-section-label">DESCRIPTION</div>';
      h += `<div style="font-size:10px;color:var(--text)">${esc(w.description || '--')}</div>`;
      h += '</div>';

      h += '<div class="detail-section"><div class="detail-section-label">CONFIG</div>';
      h += `<div class="detail-row"><span class="k">Timeout</span><span class="v">${formatDuration(w.timeout)}</span></div>`;
      h += `<div class="detail-row"><span class="k">Tools</span><span class="v">${w.tools?.length || 0}</span></div>`;
      h += `<div class="detail-row"><span class="k">Categories</span><span class="v">${(w.categories||[]).length}</span></div>`;
      h += '</div>';

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

      // Running jobs for this worker type
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
          h += `<div class="detail-job-sub">LLM: ${j.llmCalls||0} · Tools: ${j.toolCalls||0}</div>`;
          h += '</div>';
        }
        h += '</div>';
      }

      if (recentJobs.length) {
        h += '<div class="detail-section"><div class="detail-section-label">RECENT JOBS</div>';
        for (const j of recentJobs) {
          const badgeCls = j.status === 'completed' ? 'completed' : j.status === 'failed' ? 'failed' : 'cancelled';
          h += '<div class="detail-job-item">';
          h += `<div class="detail-job-meta"><span class="badge ${badgeCls}">${j.status.toUpperCase()}</span> <span style="color:var(--amber);font-family:var(--font-hud);font-size:8px">${esc(j.id)}</span> <span style="color:var(--dim);font-size:9px">${timeAgo(j.completedAt)}</span></div>`;
          h += `<div class="detail-job-task">${esc((j.task||'').slice(0,80))}</div>`;
          h += '</div>';
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
    if (!isInsidePanel && !isInsideNode) {
      closeDetailPanel();
    }
  });

  // ── Resize handler ──
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      positionNodes();
    }, 150);
  });

})();
