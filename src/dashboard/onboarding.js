(function () {
  const { esc, timeAgo, $, startClock, setMiniGauge, connectSSE, initParticleCanvas, initWaveform } = window.KERNEL;

  startClock();
  initParticleCanvas();
  initWaveform();

  let activeTab = 'all';
  let selectedUserId = null;
  let onboardingData = null;

  // Tab click handler
  document.addEventListener('click', (e) => {
    if (e.target.classList.contains('panel-tab') && e.target.closest('#users-tabs')) {
      activeTab = e.target.dataset.tab;
      document.querySelectorAll('#users-tabs .panel-tab').forEach(t => t.classList.remove('active'));
      e.target.classList.add('active');
      renderTable(onboardingData);
    }
  });

  // Fetch onboarding data
  function loadData() {
    fetch('/api/onboarding')
      .then(r => r.json())
      .then(data => {
        onboardingData = data;
        renderStats(data);
        renderTable(data);
        if (selectedUserId) renderDetail(selectedUserId, data);
      })
      .catch(() => {});
  }

  // Initial load + periodic refresh
  loadData();
  setInterval(loadData, 5000);

  // Also update system gauges from SSE
  connectSSE(function (snap) {
    if (snap.system) {
      const s = snap.system;
      setMiniGauge('sb-cpu', (s.cpu1 || 0) / 100);
      setMiniGauge('sb-ram', s.memUsed && s.memTotal ? s.memUsed / s.memTotal : 0);
    }
  });

  function renderStats(data) {
    if (!data || !data.users) return;
    const users = data.users;
    const total = users.length;
    const complete = users.filter(u => u.phase === 'complete').length;
    const inProgress = users.filter(u => u.phase !== 'complete').length;
    const totalSkills = users.reduce((sum, u) => {
      const skills = u.selected_skills ? JSON.parse(u.selected_skills || '[]') : [];
      return sum + skills.length;
    }, 0);
    const avgSkills = total > 0 ? (totalSkills / total).toFixed(1) : '--';

    // Hero pulse
    const pt = $('pulse-total'); if (pt) pt.textContent = total;
    const pc = $('pulse-complete'); if (pc) pc.textContent = complete;
    const pp = $('pulse-progress'); if (pp) { pp.textContent = inProgress; pp.classList.toggle('idle', inProgress === 0); }
    const pa = $('pulse-avg-skills'); if (pa) pa.textContent = avgSkills;

    // Right bar
    const rt = $('rb-total'); if (rt) { rt.textContent = total; rt.classList.toggle('zero', total === 0); }
    const rc = $('rb-complete'); if (rc) { rc.textContent = complete; rc.classList.toggle('zero', complete === 0); }
    const rp = $('rb-progress'); if (rp) { rp.textContent = inProgress; rp.classList.toggle('zero', inProgress === 0); }
    const rs = $('rb-skills'); if (rs) { rs.textContent = totalSkills; rs.classList.toggle('zero', totalSkills === 0); }
  }

  function renderTable(data) {
    const body = $('users-body');
    if (!data || !data.users || !data.users.length) {
      body.innerHTML = '<div class="ob-empty">NO ONBOARDING DATA</div>';
      return;
    }

    let users = data.users;
    if (activeTab === 'complete') users = users.filter(u => u.phase === 'complete');
    else if (activeTab === 'active') users = users.filter(u => u.phase !== 'complete');

    const tag = $('users-tag');
    if (tag) tag.textContent = activeTab.toUpperCase() + ' // ' + users.length;

    if (!users.length) {
      body.innerHTML = '<div class="ob-empty">NO USERS IN THIS CATEGORY</div>';
      return;
    }

    let h = '<table class="ob-table"><thead><tr>';
    h += '<th>User ID</th><th>Name</th><th>Phase</th><th>Occupation</th><th>Location</th><th>Skills</th><th>Started</th><th>Completed</th>';
    h += '</tr></thead><tbody>';

    for (const u of users) {
      const profile = u.profile_data ? (typeof u.profile_data === 'string' ? JSON.parse(u.profile_data) : u.profile_data) : {};
      const skills = u.selected_skills ? (typeof u.selected_skills === 'string' ? JSON.parse(u.selected_skills) : u.selected_skills) : [];
      const sel = selectedUserId === u.user_id ? ' selected' : '';

      h += `<tr class="${sel}" data-uid="${esc(u.user_id)}">`;
      h += `<td>${esc(u.user_id)}</td>`;
      h += `<td>${esc(profile.name || '--')}</td>`;
      h += `<td><span class="phase-badge ${esc(u.phase)}">${esc(u.phase)}</span></td>`;
      h += `<td>${esc(profile.occupation || '--')}</td>`;
      h += `<td>${esc(profile.location || '--')}</td>`;
      h += `<td>${skills.length}</td>`;
      h += `<td>${u.started_at ? timeAgo(u.started_at) : '--'}</td>`;
      h += `<td>${u.completed_at ? timeAgo(u.completed_at) : '--'}</td>`;
      h += '</tr>';
    }

    h += '</tbody></table>';
    body.innerHTML = h;

    // Row click handler
    body.querySelectorAll('tr[data-uid]').forEach(row => {
      row.addEventListener('click', () => {
        selectedUserId = row.dataset.uid;
        renderTable(onboardingData);
        renderDetail(selectedUserId, onboardingData);
      });
    });
  }

  function renderDetail(userId, data) {
    if (!data || !data.users) return;
    const user = data.users.find(u => u.user_id === userId);
    if (!user) return;

    const detailPanel = $('p-detail');
    const trainingPanel = $('p-training');
    detailPanel.style.display = '';
    trainingPanel.style.display = '';

    const profile = user.profile_data ? (typeof user.profile_data === 'string' ? JSON.parse(user.profile_data) : user.profile_data) : {};
    const skills = user.selected_skills ? (typeof user.selected_skills === 'string' ? JSON.parse(user.selected_skills) : user.selected_skills) : [];
    const training = user.training_notes ? (typeof user.training_notes === 'string' ? JSON.parse(user.training_notes) : user.training_notes) : {};

    const tag = $('detail-tag');
    if (tag) tag.textContent = profile.name || userId;

    // Profile panel
    let h = '';
    const fields = [
      ['User ID', userId],
      ['Name', profile.name],
      ['Location', profile.location],
      ['Timezone', profile.timezone],
      ['Age', profile.age],
      ['Occupation', profile.occupation],
      ['Company', profile.company],
      ['Role', profile.role],
      ['Team', profile.team_context],
      ['Interests', profile.interests],
      ['Tools', profile.tools],
      ['Phase', user.phase],
      ['Started', user.started_at ? new Date(user.started_at).toLocaleString() : '--'],
      ['Completed', user.completed_at ? new Date(user.completed_at).toLocaleString() : '--'],
    ];

    for (const [k, v] of fields) {
      if (!v) continue;
      h += `<div class="detail-row"><span class="dk">${esc(k)}</span><span class="dv">${esc(String(v))}</span></div>`;
    }

    if (skills.length > 0) {
      h += '<div class="detail-row"><span class="dk">Skills</span><span class="dv">';
      for (const s of skills) h += `<span class="skill-chip">${esc(s)}</span>`;
      h += '</span></div>';
    }

    $('detail-body').innerHTML = h || '<div class="ob-empty">NO PROFILE DATA</div>';

    // Training panel
    let th = '';
    const trainingFields = [
      ['Brand Voice', training.brand_voice],
      ['Workflows', training.workflows],
      ['Instructions', training.custom_instructions],
      ['Tools', training.tools],
    ];

    for (const [k, v] of trainingFields) {
      if (!v) continue;
      th += `<div style="margin-bottom:8px"><div class="training-label">${esc(k)}</div><div class="training-block">${esc(v)}</div></div>`;
    }

    $('training-body').innerHTML = th || '<div class="ob-empty">NO TRAINING DATA</div>';
  }

})();
