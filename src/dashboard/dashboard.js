/**
 * KERNEL Dashboard — Page-specific render functions and state.
 * Depends on window.KERNEL from shared.js.
 */
(function() {
  const { esc, formatDuration, timeAgo, formatBytes, barColor, makeBar, $,
          startClock, setGauge, setMiniGauge, connectSSE, initParticleCanvas, initWaveform } = window.KERNEL;

  // ── State ──
  let configData = null, selfData = null;
  let activeMemTab = 'episodic', activeShareTab = 'pending', activeJournalDate = 'today';
  let lastKnowledge = [], lastSharesData = { pending: [], shared: [], todayCount: 0 };
  let lastMemories = [];

  // ── Init ──
  startClock();
  initParticleCanvas();
  initWaveform();

  // ── Init fetches ──
  fetch('/api/config').then(r=>r.json()).then(d => { configData = d; renderConfig(d); renderIntegrations(d); });
  fetch('/api/self').then(r=>r.json()).then(d => { selfData = d; renderSelf(d); });

  // ── SSE ──
  connectSSE(renderSnapshot);

  // ── Render snapshot ──
  function renderSnapshot(snap) {
    renderSystem(snap.system);
    renderJobs(snap.jobs);
    renderAutomations(snap.automations);
    renderLife(snap.life);
    lastMemories = snap.memories || [];
    if (activeMemTab === 'episodic') renderMemories(lastMemories);
    else renderKnowledge(snap.knowledge || []);
    lastKnowledge = snap.knowledge || [];
    renderJournal(snap.journal);
    renderEvolution(snap.evolution);
    renderLessons(snap.evolution?.lessons || []);
    renderConversations(snap.conversations);
    renderCharacter(snap.character);
    lastSharesData = snap.shares || { pending: [], shared: [], todayCount: 0 };
    renderShares(lastSharesData);
    renderCapabilities(snap.capabilities);
    renderIdeas(snap.life?.ideas || []);
    renderLogs(snap.logs);
    renderTicker(snap.logs);
    updateRightBar(snap);
    updatePulse(snap);
  }

  // ── Hero pulse live stats ──
  function updatePulse(snap) {
    const pBrain = $('pulse-brain');
    if (pBrain && configData) {
      const model = configData.brain?.model || '--';
      pBrain.textContent = model.length > 16 ? model.slice(0, 14) + '..' : model;
      pBrain.className = 'pulse-val active';
    }
    const pAct = $('pulse-activity');
    if (pAct) {
      const life = snap.life;
      if (life && life.paused) { pAct.textContent = 'PAUSED'; pAct.className = 'pulse-val warn'; }
      else if (life && life.status === 'active') { pAct.textContent = (life.lastActivity || 'ACTIVE').toUpperCase(); pAct.className = 'pulse-val active'; }
      else { pAct.textContent = 'IDLE'; pAct.className = 'pulse-val idle'; }
    }
    const pJobs = $('pulse-jobs');
    if (pJobs) {
      const jobs = snap.jobs || [];
      const running = jobs.filter(j => j.status === 'running').length;
      pJobs.textContent = running > 0 ? running + ' RUN' : jobs.length > 0 ? jobs.length + ' TOTAL' : '0';
      pJobs.className = 'pulse-val' + (running > 0 ? ' active' : ' idle');
    }
  }

  // ── Right bar quick stats ──
  function updateRightBar(snap) {
    const jobs = snap.jobs || [];
    const running = jobs.filter(j => j.status === 'running').length;
    const rbJobs = $('rb-jobs');
    if (rbJobs) { rbJobs.textContent = running; rbJobs.className = 'r-val' + (running > 0 ? '' : ' zero'); }
    const rbTotal = $('rb-total-jobs');
    if (rbTotal) { rbTotal.textContent = jobs.length; rbTotal.className = 'r-val' + (jobs.length > 0 ? '' : ' zero'); }

    const lifeDot = $('rb-life-dot');
    if (lifeDot) {
      const isActive = snap.life && !snap.life.paused && snap.life.status === 'active';
      const isPaused = snap.life && snap.life.paused;
      lifeDot.className = 'r-dot ' + (isActive ? 'on' : isPaused ? 'paused' : 'off');
    }
    const rbActs = $('rb-activities');
    if (rbActs) { const total = snap.life?.totalActivities || 0; rbActs.textContent = total; rbActs.className = 'r-val' + (total > 0 ? '' : ' zero'); }

    const rbMem = $('rb-mem');
    if (rbMem) { const c = (snap.memories || []).length; rbMem.textContent = c; rbMem.className = 'r-val' + (c > 0 ? '' : ' zero'); }

    const rbShares = $('rb-shares');
    if (rbShares) { const c = snap.shares?.pending?.length || 0; rbShares.textContent = c; rbShares.className = 'r-val' + (c > 0 ? '' : ' zero'); }

    const rbEvo = $('rb-evo');
    if (rbEvo) { const c = snap.evolution?.stats?.totalProposals || 0; rbEvo.textContent = c; rbEvo.className = 'r-val' + (c > 0 ? '' : ' zero'); }

    const rbConvs = $('rb-convs');
    if (rbConvs) { const c = (snap.conversations || []).length; rbConvs.textContent = c; rbConvs.className = 'r-val' + (c > 0 ? '' : ' zero'); }
  }

  function renderSystem(sys) {
    if (!sys) return;
    const hdrUp = $('hdr-uptime');
    if (hdrUp) hdrUp.textContent = formatDuration(sys.uptime);
    const hdrPid = $('hdr-pid');
    if (hdrPid) hdrPid.textContent = sys.pid;
    const hdrNode = $('hdr-node');
    if (hdrNode) hdrNode.textContent = sys.nodeVersion;

    const cores = sys.cpu.cores;
    const cpu1 = sys.cpu.load1 / cores * 100;
    const cpu5 = sys.cpu.load5 / cores * 100;
    const ramPct = parseFloat(sys.ram.percent);
    const heapPct = sys.process.heapTotal > 0 ? (sys.process.heap / sys.process.heapTotal * 100) : 0;

    setGauge('g-cpu1', cpu1, sys.cpu.load1.toFixed(2) + '/' + cores);
    setGauge('g-cpu5', cpu5, sys.cpu.load5.toFixed(2) + '/' + cores);
    setGauge('g-ram', ramPct, formatBytes(sys.ram.used));
    setGauge('g-heap', heapPct, formatBytes(sys.process.heap));
    setMiniGauge('sb-cpu', cpu1);
    setMiniGauge('sb-ram', ramPct);

    const pCpu = $('pulse-cpu');
    if (pCpu) { pCpu.textContent = cpu1.toFixed(0) + '%'; pCpu.className = 'pulse-val' + (cpu1 >= 80 ? ' warn' : cpu1 > 0 ? ' active' : ' idle'); }
    const pHeap = $('pulse-heap');
    if (pHeap) { pHeap.textContent = formatBytes(sys.process.heap); pHeap.className = 'pulse-val' + (heapPct >= 80 ? ' warn' : ' active'); }
    const pUp = $('pulse-uptime');
    if (pUp) { pUp.textContent = formatDuration(sys.uptime); pUp.className = 'pulse-val active'; }
  }

  function renderConfig(cfg) {
    if (!cfg) return;
    let h = '';
    h += `<div class="row"><span class="k">Orch Provider</span><span class="v">${esc(cfg.orchestrator.provider)}</span></div>`;
    h += `<div class="row"><span class="k">Orch Model</span><span class="v">${esc(cfg.orchestrator.model)}</span></div>`;
    h += `<div class="row"><span class="k">Orch Key</span><span class="v">${esc(cfg.orchestrator.api_key)}</span></div>`;
    h += `<div class="row"><span class="k">Brain Provider</span><span class="v">${esc(cfg.brain.provider)}</span></div>`;
    h += `<div class="row"><span class="k">Brain Model</span><span class="v">${esc(cfg.brain.model)}</span></div>`;
    h += `<div class="row"><span class="k">Brain Key</span><span class="v">${esc(cfg.brain.api_key)}</span></div>`;
    h += `<div class="row"><span class="k">Max Tool Depth</span><span class="v">${cfg.brain.max_tool_depth || '--'}</span></div>`;
    if (cfg.swarm) {
      h += `<div class="row"><span class="k">Max Jobs</span><span class="v">${cfg.swarm.max_concurrent_jobs || '--'}</span></div>`;
      h += `<div class="row"><span class="k">Job Timeout</span><span class="v">${cfg.swarm.job_timeout_seconds || '--'}s</span></div>`;
    }
    if (cfg.claude_code) {
      h += `<div class="row"><span class="k">Claude Code</span><span class="v">${esc(cfg.claude_code.model)}</span></div>`;
      h += `<div class="row"><span class="k">CC Auth</span><span class="v">${esc(cfg.claude_code.auth_mode)}</span></div>`;
      h += `<div class="row"><span class="k">CC Max Turns</span><span class="v">${cfg.claude_code.max_turns || '--'}</span></div>`;
    }
    if (cfg.life) {
      h += `<div class="row"><span class="k">Life</span><span class="v">${cfg.life.enabled ? 'ENABLED' : 'DISABLED'}</span></div>`;
      if (cfg.life.self_coding) h += `<div class="row"><span class="k">Self-Coding</span><span class="v">${cfg.life.self_coding.enabled ? 'ON' : 'OFF'}</span></div>`;
    }
    h += `<div class="row"><span class="k">Allowed Users</span><span class="v">${cfg.telegram.allowed_users}</span></div>`;
    $('config-body').innerHTML = h;
  }

  function renderIntegrations(cfg) {
    if (!cfg || !cfg.integrations) return;
    const items = [
      { key: 'telegram', label: 'TELEGRAM' },
      { key: 'github', label: 'GITHUB' },
      { key: 'claude_code', label: 'CLAUDE' },
      { key: 'linkedin', label: 'LINKEDIN' },
      { key: 'x', label: 'X' },
      { key: 'jira', label: 'JIRA' },
      { key: 'elevenlabs', label: '11LABS' },
    ];
    let h = '';
    for (const item of items) {
      const on = cfg.integrations[item.key];
      h += `<div class="integ-item"><span class="integ-dot ${on ? 'on' : 'off'}"></span>${item.label}</div>`;
    }
    $('integrations-bar').innerHTML = h;
  }

  function renderJobs(jobs) {
    if (!jobs || !jobs.length) { $('jobs-body').innerHTML = '<div class="empty-msg">NO JOBS</div>'; updateJobsTag(0, 0); return; }
    const order = { running: 0, queued: 1, completed: 2, failed: 3, cancelled: 4 };
    const sorted = [...jobs].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || (b.createdAt || 0) - (a.createdAt || 0));
    const running = sorted.filter(j => j.status === 'running').length;
    updateJobsTag(sorted.length, running);
    let h = '';
    for (const j of sorted) {
      h += `<div class="job-row" onclick="this.querySelector('.job-detail')?.classList.toggle('open')">`;
      h += `<div class="job-meta"><span class="job-id">${esc(j.id)}</span><span class="job-type">${esc(j.type)}</span><span class="badge ${j.status}">${j.status.toUpperCase()}</span><span style="color:var(--dim)">${formatDuration(j.duration)}</span><span style="color:var(--dim)">LLM:${j.llmCalls||0} T:${j.toolCalls||0}</span></div>`;
      h += `<div class="job-task">${esc((j.task||'').slice(0,120))}</div>`;
      if (j.status === 'running' && j.lastThinking) h += `<div class="job-sub">${esc(j.lastThinking.slice(0,100))}</div>`;
      if (j.status === 'running' && j.progress?.length) h += `<div class="job-sub">${esc(j.progress[j.progress.length-1])}</div>`;
      if (j.status === 'completed' && j.completedAt) h += `<div class="job-sub">Completed ${timeAgo(j.completedAt)}</div>`;
      if (j.status === 'failed') h += `<div class="job-sub" style="color:var(--red)">Failed ${timeAgo(j.completedAt)}</div>`;
      if (j.status === 'cancelled') h += `<div class="job-sub" style="color:var(--amber)">Cancelled ${timeAgo(j.completedAt)}</div>`;
      h += '<div class="job-detail">';
      if (j.error) h += `<div class="job-detail-section"><div class="job-detail-label">ERROR</div><div class="job-detail-val error">${esc(j.error)}</div></div>`;
      if (j.context) h += `<div class="job-detail-section"><div class="job-detail-label">CONTEXT</div><div class="job-detail-val">${esc(j.context.slice(0,300))}</div></div>`;
      if (j.dependsOn?.length) h += `<div class="job-detail-section"><div class="job-detail-label">DEPENDS ON</div><div class="job-detail-val">${j.dependsOn.map(d => `<span class="tool-tag">${esc(d)}</span>`).join('')}</div></div>`;
      if (j.timeoutMs) h += `<div class="job-detail-section"><div class="job-detail-label">TIMEOUT</div><div class="job-detail-val">${formatDuration(j.timeoutMs/1000)}</div></div>`;
      if (j.structuredResult) {
        const sr = j.structuredResult;
        if (sr.summary) h += `<div class="job-detail-section"><div class="job-detail-label">SUMMARY</div><div class="job-detail-val">${esc(sr.summary)}</div></div>`;
        if (sr.details) h += `<div class="job-detail-section"><div class="job-detail-label">DETAILS</div><div class="job-detail-val">${esc(sr.details.slice(0,500))}</div></div>`;
        if (sr.toolsUsed?.length) h += `<div class="job-detail-section"><div class="job-detail-label">TOOLS USED</div><div class="job-detail-val">${sr.toolsUsed.map(t => `<span class="tool-tag">${esc(t)}</span>`).join('')}</div></div>`;
        if (sr.artifacts?.length) h += `<div class="job-detail-section"><div class="job-detail-label">ARTIFACTS</div><div class="job-detail-val">${sr.artifacts.map(a => `<span class="artifact-tag">${esc(typeof a === 'string' ? a : JSON.stringify(a).slice(0,60))}</span>`).join('')}</div></div>`;
        if (sr.errors?.length) h += `<div class="job-detail-section"><div class="job-detail-label">ERRORS</div><div class="job-detail-val error">${sr.errors.map(e => esc(e)).join('<br>')}</div></div>`;
        if (sr.followUp) h += `<div class="job-detail-section"><div class="job-detail-label">FOLLOW-UP</div><div class="job-detail-val">${esc(sr.followUp)}</div></div>`;
      }
      if (j.progress?.length > 1) {
        h += `<div class="job-detail-section"><div class="job-detail-label">PROGRESS (${j.progress.length})</div><div class="job-progress-timeline">`;
        for (const p of j.progress) h += `<div>${esc(p)}</div>`;
        h += '</div></div>';
      }
      h += '</div></div>';
    }
    $('jobs-body').innerHTML = h;
  }

  function updateJobsTag(total, running) {
    const tag = $('jobs-count-tag');
    if (tag) tag.textContent = 'SWARM // ' + total + (running > 0 ? ' (' + running + ' ACTIVE)' : '');
  }

  function renderAutomations(autos) {
    if (!autos || !autos.length) { $('auto-body').innerHTML = '<div class="empty-msg">NO AUTOMATIONS</div>'; return; }
    let h = '';
    for (const a of autos) {
      const st = a.enabled ? '<span style="color:var(--accent)">ON</span>' : '<span style="color:var(--amber)">OFF</span>';
      const sched = a.schedule ? (a.schedule.expression || a.schedule.type + (a.schedule.minutes ? ' ' + a.schedule.minutes + 'm' : '')) : '--';
      h += `<div class="auto-item"><div><span class="auto-name">${esc(a.name)}</span> ${st}</div><div class="auto-detail">Sched: ${esc(sched)} | Runs: ${a.runCount}</div>`;
      if (a.lastError) h += `<div class="auto-detail" style="color:var(--red)">ERR: ${esc(a.lastError.slice(0,60))}</div>`;
      h += '</div>';
    }
    $('auto-body').innerHTML = h;
  }

  function renderLife(life) {
    if (!life || life.status === 'unknown') { $('life-body').innerHTML = '<div class="empty-msg">UNAVAILABLE</div>'; return; }
    let h = '';
    const sc = life.paused ? 'paused' : (life.status === 'active' ? 'active' : 'idle');
    h += `<div class="life-status ${sc}">${(life.paused ? 'PAUSED' : life.status || 'IDLE').toUpperCase()}</div>`;
    h += `<div class="row"><span class="k">Total Activities</span><span class="v">${life.totalActivities || 0}</span></div>`;
    h += `<div class="row"><span class="k">Last Activity</span><span class="v">${esc(life.lastActivity || 'none')} (${esc(life.lastActivityAgo || 'never')})</span></div>`;
    h += `<div class="row"><span class="k">Wake-Up</span><span class="v">${esc(life.lastWakeUpAgo || 'never')}</span></div>`;
    if (life.activityCounts) {
      const counts = life.activityCounts;
      const max = Math.max(1, ...Object.values(counts));
      h += '<div style="margin-top:6px">';
      for (const [n, c] of Object.entries(counts)) {
        h += `<div class="activity-bar"><span class="name">${esc(n)}</span><span class="bar"><span class="fill" style="width:${(c/max*100).toFixed(0)}%"></span></span><span class="count">${c}</span></div>`;
      }
      h += '</div>';
    }
    if (life.cooldowns) {
      h += '<div style="margin-top:8px;border-top:1px solid rgba(57,255,20,0.05);padding-top:6px">';
      h += '<div style="font-family:var(--font-hud);font-size:7px;letter-spacing:1.5px;color:var(--dim);margin-bottom:4px">COOLDOWNS</div>';
      const cdNames = { journal: 'JOURNAL', self_code: 'SELF CODE', code_review: 'CODE REV', reflect: 'REFLECT' };
      const cdMaxMs = { journal: 4*3600000, self_code: 2*3600000, code_review: 4*3600000, reflect: 4*3600000 };
      for (const [key, label] of Object.entries(cdNames)) {
        const ms = life.cooldowns[key] || 0;
        const maxMs = cdMaxMs[key];
        const pct = ms > 0 ? (ms / maxMs * 100) : 0;
        const ready = ms <= 0;
        const timeStr = ready ? 'READY' : formatDuration(Math.ceil(ms / 1000));
        h += `<div class="cooldown-row"><span class="cooldown-label">${label}</span><div class="cooldown-bar-track"><div class="cooldown-fill${ready ? ' ready' : ''}" style="width:${ready ? 100 : 100 - pct}%"></div></div><span class="cooldown-time">${timeStr}</span></div>`;
      }
      h += '</div>';
    }
    $('life-body').innerHTML = h;
  }

  function renderEvolution(evo) {
    if (!evo) { $('evo-body').innerHTML = '<div class="empty-msg">NO DATA</div>'; return; }
    let h = '';
    if (evo.stats) {
      const s = evo.stats;
      const total = (s.merged||0) + (s.rejected||0) + (s.failed||0);
      const rate = s.successRate || 0;
      const circ = 2 * Math.PI * 30;
      const merged = total > 0 ? (s.merged||0)/total*circ : 0;
      const rejected = total > 0 ? (s.rejected||0)/total*circ : 0;
      const failed = total > 0 ? (s.failed||0)/total*circ : 0;
      h += '<div class="evo-ring-row">';
      h += '<div class="evo-ring"><svg viewBox="0 0 80 80"><circle class="track" cx="40" cy="40" r="30"/>';
      if (total > 0) {
        h += `<circle cx="40" cy="40" r="30" fill="none" stroke="#39ff14" stroke-width="6" stroke-dasharray="${merged} ${circ-merged}" stroke-dashoffset="0"/>`;
        h += `<circle cx="40" cy="40" r="30" fill="none" stroke="#ffb000" stroke-width="6" stroke-dasharray="${rejected} ${circ-rejected}" stroke-dashoffset="${-merged}"/>`;
        h += `<circle cx="40" cy="40" r="30" fill="none" stroke="#ff3333" stroke-width="6" stroke-dasharray="${failed} ${circ-failed}" stroke-dashoffset="${-(merged+rejected)}"/>`;
      }
      h += '</svg><div class="evo-ring-center"><span class="pct">' + rate.toFixed(0) + '%</span><span class="lbl">SUCCESS</span></div></div>';
      h += '<div class="evo-legend">';
      h += `<div class="evo-legend-item"><span class="evo-legend-dot" style="background:#39ff14"></span>${s.merged||0} Merged</div>`;
      h += `<div class="evo-legend-item"><span class="evo-legend-dot" style="background:#ffb000"></span>${s.rejected||0} Rejected</div>`;
      h += `<div class="evo-legend-item"><span class="evo-legend-dot" style="background:#ff3333"></span>${s.failed||0} Failed</div>`;
      h += `<div class="evo-legend-item" style="color:var(--text-bright);margin-top:2px">${s.totalProposals||0} Total</div>`;
      h += '</div></div>';
    }
    if (evo.active) {
      const a = evo.active;
      h += `<div class="evo-proposal" style="border-left:2px solid var(--accent);padding-left:6px"><div style="color:var(--accent);font-family:var(--font-hud);font-size:9px;letter-spacing:1px">ACTIVE: ${esc(a.status)}</div><div style="color:var(--text);font-size:11px">${esc(a.trigger||'')}</div>`;
      if (a.branch) h += `<div style="color:var(--amber);font-size:10px">Branch: ${esc(a.branch)}</div>`;
      h += '</div>';
    }
    if (evo.recent?.length) {
      for (const p of evo.recent) {
        h += `<div class="evo-proposal"><span class="badge ${p.status==='merged'?'completed':p.status==='failed'?'failed':p.status==='rejected'?'cancelled':'queued'}">${esc(p.status)}</span> <span style="color:var(--text);font-size:11px">${esc((p.trigger||'').slice(0,50))}</span> <span style="color:var(--dim);font-size:9px">${timeAgo(p.createdAt)}</span></div>`;
      }
    }
    if (!evo.stats?.totalProposals && !evo.active && !evo.recent?.length) h = '<div class="empty-msg">NO DATA</div>';
    $('evo-body').innerHTML = h;
  }

  function renderMemories(mems) {
    if (!mems || !mems.length) { $('mem-body').innerHTML = '<div class="empty-msg">NO MEMORIES</div>'; return; }
    let h = '';
    for (const m of mems) {
      const imp = m.importance || 0;
      const impCls = imp >= 7 ? 'high' : '';
      h += `<div class="mem-item"><span class="mem-time">${timeAgo(m.timestamp)}</span> <span class="mem-type ${esc(m.type||'interaction')}">${esc((m.type||'').toUpperCase())}</span>`;
      if (imp > 0) h += `<span class="mem-importance ${impCls}">IMP:${imp}</span>`;
      h += `<div class="mem-summary">${esc((m.summary||'').slice(0,120))}</div>`;
      if (m.tags?.length) {
        h += '<div class="mem-tags">';
        for (const t of m.tags.slice(0, 5)) h += `<span class="mem-tag">${esc(t)}</span>`;
        h += '</div>';
      }
      h += '</div>';
    }
    $('mem-body').innerHTML = h;
  }

  function renderJournal(j) {
    if (!j) { $('journal-body').innerHTML = '<div class="empty-msg">NO JOURNAL DATA</div>'; return; }
    const tabsEl = $('journal-tabs');
    if (tabsEl && j.dates?.length) {
      let th = `<span class="panel-tab ${activeJournalDate === 'today' ? 'active' : ''}" data-tab="today">TODAY</span>`;
      for (const d of j.dates.slice(0, 6)) {
        if (d === j.dates[0] && activeJournalDate === 'today') continue;
        const short = d.slice(5);
        th += `<span class="panel-tab ${activeJournalDate === d ? 'active' : ''}" data-tab="${esc(d)}">${short}</span>`;
      }
      tabsEl.innerHTML = th;
    }
    const tag = $('journal-tag');
    if (tag) tag.textContent = activeJournalDate === 'today' ? 'TODAY' : activeJournalDate;
    const content = activeJournalDate === 'today' ? j.content : (j.recent?.find(r => r.date === activeJournalDate)?.content);
    if (!content) { $('journal-body').innerHTML = '<div class="empty-msg">NO ENTRY</div>'; return; }
    const escaped = esc(content).replace(/(\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:AM|PM))?)/gi, '<span class="ts-line">$1</span>');
    $('journal-body').innerHTML = `<div class="md-content">${escaped}</div>`;
  }

  function renderShares(data) {
    if (!data) { $('shares-body').innerHTML = '<div class="empty-msg">NO SHARES</div>'; return; }
    const tag = $('shares-tag');
    if (tag) tag.textContent = `OUTBOUND // ${data.todayCount || 0} TODAY`;
    const list = activeShareTab === 'pending' ? (data.pending || []) : (data.shared || []);
    if (!list.length) { $('shares-body').innerHTML = `<div class="empty-msg">${activeShareTab === 'pending' ? 'NO PENDING SHARES' : 'NO HISTORY'}</div>`; return; }
    let h = '';
    for (const s of list) {
      const cls = activeShareTab === 'shared' ? 'share-item share-shared' : 'share-item';
      h += `<div class="${cls}"><span class="share-pri ${esc(s.priority||'low')}">[${(s.priority||'low').toUpperCase()}]</span> <span style="color:var(--dim);font-size:9px">${esc(s.source||'')} · ${timeAgo(s.createdAt)}</span><div style="color:var(--text);font-size:11px">${esc((s.content||'').slice(0,100))}</div></div>`;
    }
    $('shares-body').innerHTML = h;
  }

  function renderCharacter(ch) {
    if (!ch) { $('char-body').innerHTML = '<div class="empty-msg">NO DATA</div>'; return; }
    let h = '';
    if (ch.active) {
      h += `<div class="char-active">${esc(ch.active.emoji||'')} ${esc(ch.active.name)}</div>`;
      if (ch.active.tagline) h += `<div style="color:var(--text);font-size:11px;margin-bottom:4px;font-style:italic">${esc(ch.active.tagline)}</div>`;
    }
    if (ch.origin) h += `<div class="row"><span class="k">Origin</span><span class="v">${esc(ch.origin)}</span></div>`;
    if (ch.age) h += `<div class="row"><span class="k">Age</span><span class="v">${esc(ch.age)}</span></div>`;
    if (ch.lastActiveAt) h += `<div class="row"><span class="k">Last Active</span><span class="v">${timeAgo(ch.lastActiveAt)}</span></div>`;
    if (ch.characters?.length) {
      h += '<div style="margin-top:4px;border-top:1px solid rgba(57,255,20,0.05);padding-top:4px">';
      for (const c of ch.characters) {
        const a = ch.active && c.id === ch.active.id;
        h += `<div class="char-item ${a?'active':''}">${esc(c.emoji||'')} ${esc(c.name)}</div>`;
      }
      h += '</div>';
    }
    $('char-body').innerHTML = h;
  }

  function renderConversations(convs) {
    if (!convs || !convs.length) { $('conv-body').innerHTML = '<div class="empty-msg">NONE</div>'; return; }
    let h = '';
    for (const c of convs) {
      h += `<div class="conv-item"><span class="chat-id ${c.chatId==='__life__'?'life':''}">${esc(c.chatId)}</span><span style="color:var(--dim)">${c.messageCount} msgs · ${timeAgo(c.lastTimestamp)}</span></div>`;
      if (c.userMessages || c.assistantMessages) {
        h += `<div style="font-size:9px;color:var(--dim);padding-left:4px">USR:${c.userMessages||0} BOT:${c.assistantMessages||0}`;
        if (c.activeSkill) h += ` <span style="color:var(--magenta)">SKILL:${esc(c.activeSkill)}</span>`;
        h += '</div>';
      }
    }
    $('conv-body').innerHTML = h;
  }

  function renderSelf(s) {
    if (!s || !s.content) {
      $('self-body').innerHTML = '<div class="empty-msg">NO DATA</div>';
      $('self-goals-body').innerHTML = '<div class="empty-msg">NO DATA</div>';
      return;
    }
    const lines = s.content.split('\n');
    let awareness = [], goals = [], inGoals = false;
    for (const line of lines) {
      if (/^#+\s*(goals|aspirations|objectives)/i.test(line)) { inGoals = true; goals.push(line); continue; }
      if (inGoals && /^#+\s/.test(line) && !/goals|aspirations|objectives/i.test(line)) { inGoals = false; }
      if (inGoals) goals.push(line); else awareness.push(line);
    }
    $('self-body').innerHTML = `<div class="md-content">${esc(awareness.join('\n') || s.content)}</div>`;
    $('self-goals-body').innerHTML = goals.length ? `<div class="md-content">${esc(goals.join('\n'))}</div>` : '<div class="empty-msg">NO GOALS DEFINED</div>';
  }

  function renderCapabilities(caps) {
    if (!caps || !caps.workers) { $('caps-body').innerHTML = '<div class="empty-msg">NO DATA</div>'; return; }
    const tag = $('caps-tag');
    if (tag) tag.textContent = `WORKERS // ${caps.totalTools || 0} TOOLS`;
    let h = '<div class="worker-grid">';
    const workerList = Array.isArray(caps.workers) ? caps.workers : Object.values(caps.workers);
    for (const w of workerList) {
      h += '<div class="worker-card">';
      h += `<div class="worker-card-head"><span class="worker-emoji">${esc(w.emoji)}</span><span class="worker-name">${esc(w.label)}</span></div>`;
      h += `<div class="worker-desc">${esc(w.description)}</div>`;
      h += `<div class="worker-meta"><span>Tools: <span class="v">${w.tools?.length || 0}</span></span><span>Timeout: <span class="v">${formatDuration(w.timeout)}</span></span></div>`;
      if (w.tools?.length) {
        h += '<div style="margin-top:3px">';
        for (const t of w.tools.slice(0, 8)) h += `<span class="tool-tag" style="font-size:8px">${esc(t)}</span>`;
        if (w.tools.length > 8) h += `<span style="color:var(--dim);font-size:8px">+${w.tools.length - 8}</span>`;
        h += '</div>';
      }
      h += '</div>';
    }
    h += '</div>';
    $('caps-body').innerHTML = h;
  }

  function renderKnowledge(topics) {
    if (!topics || !topics.length) { $('mem-body').innerHTML = '<div class="empty-msg">NO KNOWLEDGE</div>'; return; }
    const tag = $('mem-tag');
    if (tag) tag.textContent = 'SEMANTIC';
    let h = '';
    for (const t of topics) {
      h += '<div class="knowledge-item">';
      h += `<span class="knowledge-topic">${esc(t.topic)}</span>`;
      if (t.sources?.length) h += ` <span style="color:var(--dim);font-size:8px">${t.sources.length} sources</span>`;
      if (t.summary) h += `<div class="knowledge-summary">${esc(t.summary.slice(0, 120))}</div>`;
      if (t.relatedTopics?.length) h += `<div class="knowledge-related">Related: ${t.relatedTopics.slice(0, 4).map(r => esc(r)).join(', ')}</div>`;
      if (t.learnedAt) h += `<div style="font-size:8px;color:var(--dim)">${timeAgo(new Date(t.learnedAt).getTime())}</div>`;
      h += '</div>';
    }
    $('mem-body').innerHTML = h;
  }

  function renderIdeas(ideas) {
    if (!ideas || !ideas.length) { $('ideas-body').innerHTML = '<div class="empty-msg">NO IDEAS</div>'; return; }
    const tag = $('ideas-tag');
    if (tag) tag.textContent = `BRAIN // ${ideas.length}`;
    let h = '';
    for (const idea of ideas) {
      if (typeof idea === 'string') {
        const isImprove = idea.startsWith('IMPROVE:');
        h += `<div class="idea-item">${isImprove ? '<span class="improve-tag">IMPROVE</span>' : ''}${esc(isImprove ? idea.slice(8).trim() : idea)}</div>`;
      } else {
        h += `<div class="idea-item">`;
        if (idea.type) h += `<span class="improve-tag">${esc(idea.type.toUpperCase())}</span>`;
        h += `${esc(idea.text || idea.content || JSON.stringify(idea).slice(0, 80))}`;
        if (idea.timestamp) h += `<span class="idea-time">${timeAgo(idea.timestamp)}</span>`;
        h += '</div>';
      }
    }
    $('ideas-body').innerHTML = h;
  }

  function renderLessons(lessons) {
    if (!lessons || !lessons.length) { $('lessons-body').innerHTML = '<div class="empty-msg">NO LESSONS</div>'; return; }
    const tag = $('lessons-tag');
    if (tag) tag.textContent = `WISDOM // ${lessons.length}`;
    let h = '';
    for (const l of lessons) {
      h += '<div class="lesson-item">';
      if (l.category) h += `<span class="lesson-cat">${esc(l.category.toUpperCase())}</span>`;
      h += `<span class="lesson-text">${esc((l.lesson || l.text || '').slice(0, 120))}</span>`;
      if (l.importance) h += `<span class="lesson-importance">IMP:${l.importance}</span>`;
      h += '</div>';
    }
    $('lessons-body').innerHTML = h;
  }

  // ── Tab click handlers ──
  document.addEventListener('click', (e) => {
    const tab = e.target.closest('.panel-tab');
    if (!tab) return;
    const parent = tab.closest('.panel-tabs');
    if (!parent) return;
    const tabId = parent.id;
    const val = tab.dataset.tab;

    if (tabId === 'mem-tabs') {
      activeMemTab = val;
      parent.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const memTag = $('mem-tag');
      if (memTag) memTag.textContent = val === 'episodic' ? 'EPISODIC' : 'SEMANTIC';
      if (val === 'episodic') renderMemories(lastMemories);
      else renderKnowledge(lastKnowledge);
    } else if (tabId === 'shares-tabs') {
      activeShareTab = val;
      parent.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      renderShares(lastSharesData);
    } else if (tabId === 'journal-tabs') {
      activeJournalDate = val;
      parent.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
    }
  });

  function renderLogs(logs) {
    if (!logs || !logs.length) { $('logs-body').innerHTML = '<div class="empty-msg">NO LOGS</div>'; return; }
    const body = $('logs-body');
    const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 20;
    let h = '';
    for (const l of logs) {
      const lvl = (l.level||'info').toLowerCase();
      const ts = l.timestamp ? l.timestamp.replace(/^.*T/,'').replace(/\..*$/,'') : '';
      h += `<div class="log-line"><span class="ts">[${esc(ts)}]</span> <span class="lvl-${lvl}">${esc(lvl.toUpperCase().padEnd(5))}</span> <span class="msg">${esc(l.message)}</span></div>`;
    }
    body.innerHTML = h;
    if (atBottom) body.scrollTop = body.scrollHeight;
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
    const count = last.length;
    document.documentElement.style.setProperty('--ticker-duration', Math.max(count * 4, 30) + 's');
  }

  // ── Nav active state sync (sidebar + top bar) ──
  document.querySelectorAll('.nav-item[href^="#"]').forEach(item => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      item.classList.add('active');
      const href = item.getAttribute('href');
      document.querySelectorAll('.top-bar-nav-item[href^="#"]').forEach(n => n.classList.remove('active'));
      const match = document.querySelector(`.top-bar-nav-item[href="${href}"]`);
      if (match) match.classList.add('active');
    });
  });
  document.querySelectorAll('.top-bar-nav-item[href^="#"]').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      document.querySelectorAll('.top-bar-nav-item[href^="#"]').forEach(n => n.classList.remove('active'));
      item.classList.add('active');
      const href = item.getAttribute('href');
      document.querySelectorAll('.nav-item[href^="#"]').forEach(n => n.classList.remove('active'));
      const match = document.querySelector(`.nav-item[href="${href}"]`);
      if (match) match.classList.add('active');
      const target = document.querySelector(href);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

})();
