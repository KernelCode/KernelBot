(function () {
  const { esc, $, startClock, setMiniGauge, connectSSE, initParticleCanvas, initWaveform } = window.KERNEL;

  startClock();
  initParticleCanvas();
  initWaveform();

  let tables = [];
  let activeTable = null;
  let tableData = null;
  let currentPage = 0;
  const PAGE_SIZE = 50;

  // SSE for system gauges
  connectSSE(function (snap) {
    if (snap.system) {
      const s = snap.system;
      setMiniGauge('sb-cpu', (s.cpu1 || 0) / 100);
      setMiniGauge('sb-ram', s.memUsed && s.memTotal ? s.memUsed / s.memTotal : 0);
    }
  });

  // Load table list
  function loadTables() {
    fetch('/api/braindb')
      .then(r => r.json())
      .then(data => {
        if (data.error) {
          $('tables-body').innerHTML = '<div class="ob-empty">' + esc(data.error) + '</div>';
          return;
        }
        tables = data.tables || [];
        renderTableList();
        renderStats();
      })
      .catch(() => {});
  }

  function renderStats() {
    const totalTables = tables.length;
    const totalRows = tables.reduce((sum, t) => sum + (t.count || 0), 0);

    const pt = $('pulse-tables'); if (pt) pt.textContent = totalTables;
    const pr = $('pulse-rows'); if (pr) pr.textContent = totalRows.toLocaleString();

    const rt = $('rb-tables'); if (rt) { rt.textContent = totalTables; rt.classList.toggle('zero', totalTables === 0); }
    const rr = $('rb-rows'); if (rr) { rr.textContent = totalRows.toLocaleString(); rr.classList.toggle('zero', totalRows === 0); }
  }

  function renderTableList() {
    const body = $('tables-body');
    if (!tables.length) {
      body.innerHTML = '<div class="ob-empty">NO TABLES FOUND</div>';
      return;
    }

    let h = '';
    for (const t of tables) {
      const active = activeTable === t.name ? ' active' : '';
      h += `<div class="db-table-item${active}" data-table="${esc(t.name)}">`;
      h += `<span class="db-table-name">${esc(t.name)}</span>`;
      h += `<span class="db-table-count">${t.count} rows</span>`;
      h += '</div>';
    }
    body.innerHTML = h;

    body.querySelectorAll('.db-table-item').forEach(el => {
      el.addEventListener('click', () => {
        activeTable = el.dataset.table;
        currentPage = 0;
        loadTableData();
        renderTableList();
      });
    });
  }

  function loadTableData() {
    if (!activeTable) return;
    const offset = currentPage * PAGE_SIZE;
    fetch(`/api/braindb/table?name=${encodeURIComponent(activeTable)}&limit=${PAGE_SIZE}&offset=${offset}`)
      .then(r => r.json())
      .then(data => {
        tableData = data;
        renderTableData();
      })
      .catch(() => {});
  }

  function renderTableData() {
    const tag = $('data-tag');
    if (tag) tag.textContent = activeTable ? activeTable.toUpperCase() : 'SELECT A TABLE';

    const toolbar = $('db-toolbar');
    const body = $('data-body');

    if (!tableData || !tableData.columns || !tableData.columns.length) {
      toolbar.style.display = 'none';
      body.innerHTML = '<div class="ob-empty">NO DATA IN THIS TABLE</div>';
      return;
    }

    toolbar.style.display = '';

    // Info
    const total = tableData.total || 0;
    const offset = currentPage * PAGE_SIZE;
    const showing = Math.min(PAGE_SIZE, total - offset);
    $('db-info').textContent = `SHOWING ${offset + 1}-${offset + showing} OF ${total} ROWS`;
    $('db-page').textContent = `PAGE ${currentPage + 1}`;

    // Pagination
    const btnPrev = $('btn-prev');
    const btnNext = $('btn-next');
    btnPrev.disabled = currentPage === 0;
    btnNext.disabled = (offset + PAGE_SIZE) >= total;

    // Table
    const cols = tableData.columns;
    let h = '<table class="db-grid"><thead><tr>';
    for (const col of cols) h += `<th>${esc(col)}</th>`;
    h += '</tr></thead><tbody>';

    for (let i = 0; i < tableData.rows.length; i++) {
      const row = tableData.rows[i];
      h += `<tr data-row-idx="${i}">`;
      for (let j = 0; j < cols.length; j++) {
        const val = row[cols[j]];
        const cls = j === 0 ? ' class="pk"' : '';
        const display = val === null ? '<span style="color:var(--dim);font-style:italic">NULL</span>' : esc(String(val));
        h += `<td${cls}>${display}</td>`;
      }
      h += '</tr>';
    }
    h += '</tbody></table>';
    body.innerHTML = h;

    // Row click → detail
    body.querySelectorAll('tr[data-row-idx]').forEach(tr => {
      tr.addEventListener('click', () => {
        const idx = parseInt(tr.dataset.rowIdx);
        renderRowDetail(tableData.rows[idx], tableData.columns);
      });
    });
  }

  function renderRowDetail(row, columns) {
    const panel = $('p-row-detail');
    const body = $('row-detail-body');
    const tag = $('row-tag');
    panel.style.display = '';

    if (tag) tag.textContent = activeTable.toUpperCase() + ' // ROW';

    let h = '';
    for (const col of columns) {
      const val = row[col];
      h += '<div class="db-field">';
      h += `<span class="db-field-key">${esc(col)}</span>`;
      if (val === null || val === undefined) {
        h += '<span class="db-field-val null">NULL</span>';
      } else if (typeof val === 'string' && val.length > 50 && isJSON(val)) {
        try {
          const formatted = JSON.stringify(JSON.parse(val), null, 2);
          h += `<span class="db-field-val json">${esc(formatted)}</span>`;
        } catch {
          h += `<span class="db-field-val">${esc(val)}</span>`;
        }
      } else {
        h += `<span class="db-field-val">${esc(String(val))}</span>`;
      }
      h += '</div>';
    }
    body.innerHTML = h;
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function isJSON(str) {
    if (!str || typeof str !== 'string') return false;
    const c = str.trim()[0];
    return c === '{' || c === '[';
  }

  // Pagination buttons
  $('btn-prev').addEventListener('click', () => {
    if (currentPage > 0) { currentPage--; loadTableData(); }
  });
  $('btn-next').addEventListener('click', () => {
    if (tableData && (currentPage + 1) * PAGE_SIZE < tableData.total) { currentPage++; loadTableData(); }
  });

  // Initial load
  loadTables();
})();
