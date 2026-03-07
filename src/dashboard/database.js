(function () {
  const { esc, $, startClock, setMiniGauge, connectSSE, initParticleCanvas } = window.KERNEL;

  startClock();
  initParticleCanvas();

  // ── State ────────────────────────────────────────────
  let tables = [];
  let activeTable = null;
  let tableData = null;
  let currentPage = 0;
  let pageSize = 50;
  let sortCol = null;
  let sortDir = 'ASC';
  let searchTerm = '';

  // ── DOM refs ─────────────────────────────────────────
  const tableSelect = $('table-select');
  const searchInput = $('db-search');
  const gridWrap = $('db-grid-wrap');
  const emptyState = $('db-empty');
  const infoText = $('db-info');
  const pageLbl = $('db-page');
  const btnPrev = $('btn-prev');
  const btnNext = $('btn-next');
  const perPage = $('per-page');
  const btnDownload = $('btn-download');
  const btnUpload = $('btn-upload');
  const fileUpload = $('file-upload');
  const modalOverlay = $('modal-overlay');
  const modalBody = $('modal-body');
  const modalTitle = $('modal-title');
  const modalClose = $('modal-close');
  const infoBar = $('db-info-bar');

  // ── SSE for system gauges ────────────────────────────
  connectSSE(function (snap) {
    if (snap.system) {
      const s = snap.system;
      setMiniGauge('sb-cpu', (s.cpu1 || 0) / 100);
      setMiniGauge('sb-ram', s.memUsed && s.memTotal ? s.memUsed / s.memTotal : 0);
    }
  });

  // ── Load tables ──────────────────────────────────────
  function loadTables() {
    fetch('/api/braindb')
      .then(r => r.json())
      .then(data => {
        if (data.error) {
          emptyState.textContent = data.error;
          return;
        }
        tables = data.tables || [];
        renderTableDropdown();
      })
      .catch(() => {});
  }

  function renderTableDropdown() {
    let h = '<option value="">-- SELECT TABLE --</option>';
    for (const t of tables) {
      const sel = activeTable === t.name ? ' selected' : '';
      h += `<option value="${esc(t.name)}"${sel}>${esc(t.name)} (${t.count})</option>`;
    }
    tableSelect.innerHTML = h;
  }

  // ── Table select ─────────────────────────────────────
  tableSelect.addEventListener('change', () => {
    const val = tableSelect.value;
    if (!val) {
      activeTable = null;
      tableData = null;
      gridWrap.innerHTML = '<div class="db-empty-state">SELECT A TABLE TO EXPLORE</div>';
      infoText.textContent = '';
      pageLbl.textContent = '--';
      btnPrev.disabled = true;
      btnNext.disabled = true;
      return;
    }
    activeTable = val;
    currentPage = 0;
    sortCol = null;
    sortDir = 'ASC';
    searchInput.value = '';
    searchTerm = '';
    loadTableData();
  });

  // ── Per-page change ──────────────────────────────────
  perPage.addEventListener('change', () => {
    pageSize = parseInt(perPage.value, 10);
    currentPage = 0;
    loadTableData();
  });

  // ── Search ───────────────────────────────────────────
  searchInput.addEventListener('input', () => {
    searchTerm = searchInput.value.trim().toLowerCase();
    filterRows();
  });

  function filterRows() {
    const rows = gridWrap.querySelectorAll('tbody tr');
    if (!searchTerm) {
      rows.forEach(tr => tr.classList.remove('search-hidden'));
      return;
    }
    rows.forEach(tr => {
      const text = tr.textContent.toLowerCase();
      tr.classList.toggle('search-hidden', !text.includes(searchTerm));
    });
  }

  // ── Load table data ──────────────────────────────────
  function loadTableData() {
    if (!activeTable) return;
    const offset = currentPage * pageSize;
    let url = `/api/braindb/table?name=${encodeURIComponent(activeTable)}&limit=${pageSize}&offset=${offset}`;
    if (sortCol) {
      url += `&sort=${encodeURIComponent(sortCol)}&order=${sortDir}`;
    }
    fetch(url)
      .then(r => r.json())
      .then(data => {
        tableData = data;
        renderGrid();
        updatePagination();
      })
      .catch(() => {});
  }

  // ── Render grid ──────────────────────────────────────
  function renderGrid() {
    if (!tableData || !tableData.columns || !tableData.columns.length) {
      gridWrap.innerHTML = '<div class="db-empty-state">NO DATA IN THIS TABLE</div>';
      return;
    }

    const cols = tableData.columns;
    let h = '<table class="db-grid"><thead><tr>';
    for (const col of cols) {
      const isSort = sortCol === col;
      const cls = isSort ? ' class="sort-active"' : '';
      const arrow = isSort ? (sortDir === 'ASC' ? '&#9650;' : '&#9660;') : '&#9650;';
      h += `<th${cls} data-col="${esc(col)}">${esc(col)}<span class="sort-arrow">${arrow}</span></th>`;
    }
    h += '</tr></thead><tbody>';

    const rows = tableData.rows;
    const fullRows = tableData.fullRows || rows;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      h += `<tr data-row-idx="${i}">`;
      for (let j = 0; j < cols.length; j++) {
        const val = row[cols[j]];
        const cellClass = getCellClass(val, cols[j], j);
        const display = formatCellValue(val);
        h += `<td class="${cellClass}" title="Click to copy">${display}</td>`;
      }
      h += '</tr>';
    }
    h += '</tbody></table>';
    gridWrap.innerHTML = h;

    // ── Attach events ──
    // Sort headers
    gridWrap.querySelectorAll('th[data-col]').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.col;
        if (sortCol === col) {
          sortDir = sortDir === 'ASC' ? 'DESC' : 'ASC';
        } else {
          sortCol = col;
          sortDir = 'ASC';
        }
        currentPage = 0;
        loadTableData();
      });
    });

    // Row click → modal
    gridWrap.querySelectorAll('tr[data-row-idx]').forEach(tr => {
      tr.addEventListener('click', (e) => {
        // If user clicked a cell directly, copy value
        if (e.target.tagName === 'TD') {
          copyCell(e.target);
        }
        const idx = parseInt(tr.dataset.rowIdx);
        openRowModal(fullRows[idx] || rows[idx], cols);
      });
    });

    // Apply search filter
    if (searchTerm) filterRows();
  }

  function getCellClass(val, colName, colIdx) {
    if (val === null || val === undefined) return 'cell-null';
    if (colIdx === 0) return 'pk';
    if (typeof val === 'number') return 'cell-number';
    if (typeof val === 'string') {
      if (isTimestamp(val, colName)) return 'cell-timestamp';
      if (isJSON(val)) return 'cell-json';
    }
    return '';
  }

  function formatCellValue(val) {
    if (val === null || val === undefined) return '<em>NULL</em>';
    if (typeof val === 'number' && isTimestampNum(val)) {
      return esc(formatTimestamp(val));
    }
    if (typeof val === 'string' && isTimestamp(val)) {
      return esc(formatTimestamp(val));
    }
    return esc(String(val));
  }

  function isJSON(str) {
    if (!str || typeof str !== 'string') return false;
    const c = str.trim()[0];
    return c === '{' || c === '[';
  }

  function isTimestamp(val, colName) {
    if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}/.test(val)) return true;
    if (colName && /(_at|_time|timestamp|created|updated|date)$/i.test(colName)) return true;
    return false;
  }

  function isTimestampNum(val) {
    // Unix ms timestamps (2020-2030 range)
    return val > 1577836800000 && val < 1893456000000;
  }

  function formatTimestamp(val) {
    try {
      const d = new Date(typeof val === 'number' ? val : val);
      if (isNaN(d.getTime())) return String(val);
      return d.toLocaleString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
    } catch { return String(val); }
  }

  // ── Copy cell ────────────────────────────────────────
  function copyCell(td) {
    const text = td.innerText;
    navigator.clipboard.writeText(text).then(() => {
      td.classList.add('copied');
      setTimeout(() => td.classList.remove('copied'), 400);
    }).catch(() => {});
  }

  // ── Pagination ───────────────────────────────────────
  function updatePagination() {
    if (!tableData) return;
    const total = tableData.total || 0;
    const offset = currentPage * pageSize;
    const showing = Math.min(pageSize, total - offset);
    const totalPages = Math.ceil(total / pageSize) || 1;

    infoText.textContent = total > 0
      ? `SHOWING ${offset + 1}-${offset + showing} OF ${total} ROWS`
      : 'NO ROWS';
    pageLbl.textContent = `${currentPage + 1} / ${totalPages}`;
    btnPrev.disabled = currentPage === 0;
    btnNext.disabled = (offset + pageSize) >= total;
  }

  btnPrev.addEventListener('click', () => {
    if (currentPage > 0) { currentPage--; loadTableData(); }
  });
  btnNext.addEventListener('click', () => {
    if (tableData && (currentPage + 1) * pageSize < tableData.total) {
      currentPage++;
      loadTableData();
    }
  });

  // ── Row Detail Modal ─────────────────────────────────
  function openRowModal(row, columns) {
    modalTitle.textContent = activeTable.toUpperCase() + ' // ROW DETAIL';
    let h = '';
    for (const col of columns) {
      const val = row[col];
      h += '<div class="db-field">';
      h += `<span class="db-field-key">${esc(col)}</span>`;
      if (val === null || val === undefined) {
        h += '<span class="db-field-val null">NULL</span>';
      } else if (typeof val === 'string' && isJSON(val)) {
        try {
          const formatted = JSON.stringify(JSON.parse(val), null, 2);
          h += `<span class="db-field-val json" title="Click to copy">${esc(formatted)}</span>`;
        } catch {
          h += `<span class="db-field-val" title="Click to copy">${esc(val)}</span>`;
        }
      } else if (typeof val === 'number' && isTimestampNum(val)) {
        h += `<span class="db-field-val timestamp" title="Click to copy">${esc(formatTimestamp(val))}<br><span style="font-size:9px;color:var(--dim)">(${val})</span></span>`;
      } else {
        h += `<span class="db-field-val" title="Click to copy">${esc(String(val))}</span>`;
      }
      h += '</div>';
    }
    modalBody.innerHTML = h;

    // Copy on click for field values
    modalBody.querySelectorAll('.db-field-val').forEach(el => {
      el.addEventListener('click', () => {
        navigator.clipboard.writeText(el.innerText).then(() => {
          showToast('COPIED TO CLIPBOARD');
        }).catch(() => {});
      });
    });

    modalOverlay.classList.add('open');
  }

  function closeModal() {
    modalOverlay.classList.remove('open');
  }

  modalClose.addEventListener('click', closeModal);
  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });

  // ── Toast ────────────────────────────────────────────
  function showToast(msg) {
    const existing = document.querySelector('.db-toast');
    if (existing) existing.remove();
    const el = document.createElement('div');
    el.className = 'db-toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1500);
  }

  // ── Brain Download ───────────────────────────────────
  btnDownload.addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = '/api/brain/download';
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
    showToast('DOWNLOADING BRAIN.SQLITE');
  });

  // ── Brain Upload ─────────────────────────────────────
  btnUpload.addEventListener('click', () => {
    fileUpload.click();
  });

  fileUpload.addEventListener('change', () => {
    const file = fileUpload.files[0];
    if (!file) return;

    if (!confirm(`Upload "${file.name}" and replace the current brain database?\n\nA backup will be created automatically.`)) {
      fileUpload.value = '';
      return;
    }

    const formData = new FormData();
    formData.append('file', file);

    showToast('UPLOADING...');
    fetch('/api/brain/upload', {
      method: 'POST',
      body: formData,
    })
      .then(r => r.json())
      .then(data => {
        if (data.error) {
          alert('Upload failed: ' + data.error);
        } else {
          showToast('BRAIN DATABASE REPLACED');
          // Reload tables
          setTimeout(() => {
            activeTable = null;
            tableData = null;
            loadTables();
            gridWrap.innerHTML = '<div class="db-empty-state">SELECT A TABLE TO EXPLORE</div>';
          }, 500);
        }
      })
      .catch(err => {
        alert('Upload error: ' + err.message);
      })
      .finally(() => {
        fileUpload.value = '';
      });
  });

  // ── Init ─────────────────────────────────────────────
  loadTables();
})();
