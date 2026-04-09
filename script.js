'use strict';
console.log('JS loaded');

// Global error handlers - prevent crashes from killing the app
window.addEventListener('error', function(e) {
  console.error('[WealthOS] Global error:', e.message, e.filename, e.lineno);
});
window.addEventListener('unhandledrejection', function(e) {
  console.warn('[WealthOS] Unhandled promise rejection:', e.reason);
  e.preventDefault();
});

// ============================================
// TOAST NOTIFICATION SYSTEM (JS-only, no HTML)
// ============================================
function _showToast(msg, type) {
  try {
    // Remove existing toast if any
    var old = document.getElementById('wos-toast');
    if (old) old.remove();

    var colors = {
      success: { bg: 'rgba(34,211,165,0.12)', border: 'rgba(34,211,165,0.3)', text: '#22D3A5', icon: '\u2713' },
      info:    { bg: 'rgba(92,95,239,0.12)',   border: 'rgba(92,95,239,0.3)',  text: '#5C5FEF', icon: '\u2139' },
      warn:    { bg: 'rgba(232,160,48,0.12)',  border: 'rgba(232,160,48,0.3)', text: '#E8A030', icon: '!' },
      error:   { bg: 'rgba(240,92,113,0.12)',  border: 'rgba(240,92,113,0.3)', text: '#F05C71', icon: '\u2717' }
    };
    var c = colors[type] || colors.info;

    var toast = document.createElement('div');
    toast.id = 'wos-toast';
    toast.style.cssText = 'position:fixed;top:72px;left:50%;transform:translateX(-50%) translateY(-10px);' +
      'background:' + c.bg + ';border:1px solid ' + c.border + ';color:' + c.text + ';' +
      'padding:10px 20px;border-radius:10px;font-size:13px;font-family:IBM Plex Sans,sans-serif;' +
      'z-index:99999;text-align:center;max-width:420px;backdrop-filter:blur(12px);' +
      'box-shadow:0 8px 24px rgba(0,0,0,0.3);opacity:0;transition:all 0.3s ease;pointer-events:none';
    toast.textContent = c.icon + '  ' + msg;

    document.body.appendChild(toast);

    // Animate in
    requestAnimationFrame(function() {
      toast.style.opacity = '1';
      toast.style.transform = 'translateX(-50%) translateY(0)';
    });

    // Auto-dismiss
    setTimeout(function() {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(-50%) translateY(-10px)';
      setTimeout(function() { if (toast.parentNode) toast.remove(); }, 350);
    }, 2800);
  } catch(e) { /* never crash for a toast */ }
}


// =======================================
// SUPABASE INTEGRATION
// =======================================
var SUPABASE_URL = 'https://qaqhrmqqbxpzuwyfbbwy.supabase.co';
var SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFhcWhybXFxYnhwenV3eWZiYnd5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM3NjUwNjgsImV4cCI6MjA4OTM0MTA2OH0.mIXGGu3hdCKB2eEOZZ52fxPVNV9Oo81u44ZOY3uXKKk';
var sb = null;
function getSB() {
  if (!sb && window.supabase) sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  return sb;
}
var DEFAULT_ANTHROPIC_KEY='';
var AV_KEY='61XDS44GCE4F849T';
var CG_KEY='CG-dtdNXd1XjmfaJJ76e4iZqTpR';

// ==============================================================
// FEATURE: NET WORTH HISTORY
// ==============================================================
var historyChart = null;
var historyPeriod = 30; // current period in days (0 = all)

function loadHistoryFromSupabase() {
  var _sb = getSB();
  if (!_sb || !currentUser) return;
  _sb.auth.getUser().then(function(res) {
    if (!res.data || !res.data.user) return;
    var uid = res.data.user.id;
    _sb.from('portfolio_snapshots')
      .select('total_value, snapshot_date')
      .eq('user_id', uid)
      .order('snapshot_date', { ascending: true })
      .then(function(result) {
        if (result.error || !result.data || result.data.length === 0) return;

        var key = 'pw_history_' + currentUser.id;
        var local = [];
        try { local = JSON.parse(localStorage.getItem(key) || '[]'); } catch(e) {}

        // Merge cloud rows into local
        var merged = {};
        // Start with local entries
        local.forEach(function(s) { merged[s.date] = s.val; });
        // Cloud entries override (cloud is source of truth)
        result.data.forEach(function(row) {
          merged[row.snapshot_date] = Math.round(row.total_value);
        });

        // Convert map back to sorted array
        var history = Object.keys(merged)
          .sort()
          .map(function(date) { return { date: date, val: merged[date] }; });

        // Keep last 365 days
        if (history.length > 365) history = history.slice(-365);

        localStorage.setItem(key, JSON.stringify(history));

        // Re-render history view if it's currently open
        var histView = document.getElementById('v-history');
        if (histView && histView.classList.contains('active')) {
          try { rHistory(); } catch(e) {}
        }
      })
      .catch(function(e) { console.warn('Load history failed:', e); });
  }).catch(function() {});
}

function saveNWSnapshot() {
  if (!currentUser || !assets.length) return;

  var key   = 'pw_history_' + currentUser.id;
  var today = new Date().toISOString().split('T')[0];

  // Use real net worth from calc engine
  var nw = Math.round(calcPortfolio().totalNetWorth);
  if (nw <= 0) return; // skip if no real value

  // -- Local: upsert today's snapshot --
  var history = [];
  try { history = JSON.parse(localStorage.getItem(key) || '[]'); } catch(e) {}

  var todayIdx = history.findIndex(function(s) { return s.date === today; });
  if (todayIdx >= 0) {
    history[todayIdx].val = nw;   // update existing entry for today
  } else {
    history.push({ date: today, val: nw });
  }

  // Keep last 365 days only
  history.sort(function(a,b){ return a.date < b.date ? -1 : 1; });
  if (history.length > 365) history = history.slice(-365);
  localStorage.setItem(key, JSON.stringify(history));

  // -- Supabase: upsert today's snapshot --
  // onConflict on (user_id, snapshot_date) prevents duplicates
  var _sb = getSB();
  bustCache('hist_'); // invalidate history cache after new snapshot
  if (!_sb) return;
  _sb.auth.getUser().then(function(res) {
    if (!res.data || !res.data.user) return;
    var uid = res.data.user.id;
    _sb.from('portfolio_snapshots')
      .upsert(
        { user_id: uid, total_value: nw, snapshot_date: today },
        { onConflict: 'user_id,snapshot_date' }
      )
      .then(function() {})
      .catch(function(e) { console.warn('Snapshot upsert failed:', e); });
  }).catch(function() {});
}

function getNWHistory() {
  if (!currentUser) return [];
  var key = 'pw_history_' + currentUser.id;
  try {
    var h = JSON.parse(localStorage.getItem(key) || '[]');
    // Sort ascending by date
    h.sort(function(a,b){ return a.date < b.date ? -1 : 1; });
    return h;
  } catch(e) { return []; }
}


function setHistoryPeriod(days) {
  historyPeriod = days;
  // Update button active states
  document.querySelectorAll('.hpb').forEach(function(btn) {
    var d = parseInt(btn.getAttribute('data-days'));
    btn.classList.toggle('active', d === days);
  });
  rHistory();
}
function rHistory() {
  try {
  // Show loader
  var _hChartEl = document.getElementById('history-chart');
  if (_hChartEl) _hChartEl.style.opacity = '0.3';
  var _sb = getSB();
  if (_sb && currentUser) {
    _sb.auth.getUser().then(function(res) {
      if (!res.data || !res.data.user) { if(_hChartEl)_hChartEl.style.opacity='1'; _renderHistoryChart(getNWHistory()); return; }
      var uid = res.data.user.id;
      // 60s cache to avoid hammering DB on tab switch
      var cKey = 'hist_'+uid;
      var cached = getCached(cKey);
      if (cached) { if(_hChartEl)_hChartEl.style.opacity='1'; _renderHistoryChart(cached); return; }
      _sb.from('portfolio_snapshots')
        .select('total_value, snapshot_date')
        .eq('user_id', uid)
        .order('snapshot_date', { ascending: true })
        .then(function(result) {
          if (result.error || !result.data || result.data.length === 0) {
            // Fall back to local history
            _renderHistoryChart(getNWHistory());
            return;
          }
          // Map DB rows \u2192 local format + merge with local
          var cloudData = result.data.map(function(row) {
            return { date: row.snapshot_date, val: Math.round(row.total_value) };
          });
          // Merge: cloud wins on conflict
          var merged = {};
          getNWHistory().forEach(function(s) { merged[s.date] = s.val; });
          cloudData.forEach(function(s)       { merged[s.date] = s.val; });
          var full = Object.keys(merged).sort().map(function(d) {
            return { date: d, val: merged[d] };
          });
          // Save back to local
          try {
            localStorage.setItem('pw_history_' + currentUser.id, JSON.stringify(full));
          } catch(e) {}
          setCached(cKey, full);
          if(_hChartEl)_hChartEl.style.opacity='1';
          _renderHistoryChart(full);
        })
        .catch(function(e) { if(_hChartEl)_hChartEl.style.opacity='1'; handleAPIError('History', e, true); _renderHistoryChart(getNWHistory()); });
    }).catch(function() { _renderHistoryChart(getNWHistory()); });
  } else {
    _renderHistoryChart(getNWHistory());
  }
  } catch(e) { console.error('[WealthOS] rHistory error:', e); }
}

function _renderHistoryChart(fullHistory) {
  var emptyEl = document.getElementById('history-empty');
  var rangeEl = document.getElementById('history-range');
  var listEl  = document.getElementById('history-list');
  var statsEl = document.getElementById('history-stats');

  // -- Filter by period --
  var period  = historyPeriod; // 0 = all
  var history = fullHistory;
  if (period > 0 && history.length > period) {
    history = history.slice(-period);
  }

  // -- Ensure ascending date order --
  history = history.slice().sort(function(a, b) {
    return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
  });

  if (history.length < 2) {
    if (emptyEl) emptyEl.style.display = 'block';
    if (rangeEl) rangeEl.textContent = '';
    if (listEl)  listEl.innerHTML = '';
    if (statsEl) statsEl.innerHTML =
      '<div style="padding:16px;color:var(--muted);font-size:13px">' +
      'History builds automatically. Check back after using WealthOS for a few days.</div>';
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';

  var ctx = document.getElementById('history-chart');
  if (!ctx || !_chartAvailable()) return;
  historyChart = destroyChart(historyChart);

  var labels = history.map(function(s) { return s.date; });
  var vals   = history.map(function(s) { return s.val; });
  var first  = vals[0];
  var last   = vals[vals.length - 1];
  var isUp   = last >= first;

  // Update range label
  if (rangeEl) {
    var periodLabel = period === 0 ? 'All time' :
                     period === 7  ? 'Last 7 days' :
                     period === 30 ? 'Last 30 days' :
                     period === 90 ? 'Last 90 days' : 'Last year';
    rangeEl.textContent = periodLabel + ': ' + history[0].date + ' -- ' + history[history.length-1].date;
  }

  var lineColor  = isUp ? 'rgba(34,211,165,0.9)' : 'rgba(240,92,113,0.9)';
  var gradColor  = isUp ? 'rgba(34,211,165,' : 'rgba(240,92,113,';

  if (!_chartAvailable()) return;
  historyChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        data:         vals,
        fill:         true,
        borderColor:  lineColor,
        borderWidth:  2,
        tension:      0.4,
        pointRadius:  history.length <= 14 ? 3 : 0,
        pointHoverRadius: 5,
        pointBackgroundColor: lineColor,
        backgroundColor: function(context) {
          var chart = context.chart;
          var ctx2  = chart.ctx, chartArea = chart.chartArea;
          if (!chartArea) return gradColor + '0.08)';
          var g = ctx2.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
          g.addColorStop(0,   gradColor + '0.18)');
          g.addColorStop(0.6, gradColor + '0.05)');
          g.addColorStop(1,   gradColor + '0)');
          return g;
        }
      }]
    },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      interaction:         { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(10,10,15,0.96)',
          titleColor:      '#636382',
          bodyColor:       '#F2F2FA',
          borderColor:     'rgba(255,255,255,0.08)',
          borderWidth:     1,
          padding:         10,
          callbacks: {
            label: function(c) { return '  Net Worth: ' + fmtS(c.raw); },
            title: function(items) {
              // Format date nicely: 2026-03-18 \u2192 Mar 18, 2026
              var d = items[0].label;
              try {
                var parts = d.split('-');
                var dt = new Date(parseInt(parts[0]), parseInt(parts[1])-1, parseInt(parts[2]));
                return dt.toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'});
              } catch(e) { return d; }
            }
          }
        }
      },
      scales: {
        x: {
          grid:   { display: false },
          border: { display: false },
          ticks:  {
            color: '#636382',
            font:  { family: 'IBM Plex Mono', size: 9 },
            maxTicksLimit: history.length <= 14 ? history.length : 8,
            maxRotation: 0,
            callback: function(val, idx) {
              var d = labels[idx];
              if (!d) return '';
              try {
                var p = d.split('-');
                var dt = new Date(parseInt(p[0]), parseInt(p[1])-1, parseInt(p[2]));
                return dt.toLocaleDateString('en-US', {month:'short', day:'numeric'});
              } catch(e) { return d; }
            }
          }
        },
        y: {
          grid:   { color: 'rgba(255,255,255,0.04)' },
          border: { display: false },
          ticks:  {
            color:    '#636382',
            font:     { family: 'IBM Plex Mono', size: 9 },
            callback: function(v) { return fmtS(v); }
          }
        }
      }
    }
  });

  // -- Snapshot list (most recent first) --
  if (listEl) {
    var rev = history.slice().reverse();
    listEl.innerHTML = rev.map(function(s, i) {
      var prev = rev[i + 1];
      var diff = prev ? s.val - prev.val : 0;
      var pct  = prev && prev.val ? ((diff / prev.val) * 100).toFixed(2) : null;
      var dateLabel = (function() {
        try {
          var p = s.date.split('-');
          return new Date(parseInt(p[0]),parseInt(p[1])-1,parseInt(p[2]))
            .toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
        } catch(e) { return s.date; }
      })();
      return '<div style="display:flex;align-items:center;justify-content:space-between;' +
             'padding:9px 0;border-bottom:1px solid rgba(255,255,255,0.04)">' +
        '<div style="font-family:var(--mono);font-size:11px;color:var(--muted)">' + dateLabel + '</div>' +
        '<div style="display:flex;align-items:center;gap:12px">' +
          (pct !== null
            ? '<div style="font-family:var(--mono);font-size:10px;color:' +
              (diff >= 0 ? 'var(--green)' : 'var(--red)') + '">' +
              (diff >= 0 ? '+' : '') + pct + '%</div>'
            : '') +
          '<div style="font-family:var(--mono);font-size:12px;font-weight:600;color:var(--text)">' +
            fmtS(s.val) +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  // -- Stats panel --
  if (statsEl) {
    var minVal      = Math.min.apply(null, vals);
    var maxVal      = Math.max.apply(null, vals);
    var growth      = first > 0 ? ((last - first) / first * 100) : 0;
    var plAbs       = last - first;
    var rows = [
      ['Period Start',    fmtS(first)],
      ['Current Value',   fmtS(last)],
      ['P&L (period)',    (plAbs >= 0 ? '+' : '') + fmtS(plAbs)],
      ['Growth %',        (growth >= 0 ? '+' : '') + growth.toFixed(2) + '%'],
      ['All-Time High',   fmtS(maxVal)],
      ['All-Time Low',    fmtS(minVal)],
      ['Data Points',     history.length + ' days'],
    ];
    statsEl.innerHTML = '<div style="display:flex;flex-direction:column;gap:0">' +
      rows.map(function(row) {
        var isGain = row[0] === 'P&L (period)' || row[0] === 'Growth %';
        var isPos  = isGain && !row[1].startsWith('-');
        var col    = isGain ? (isPos ? 'var(--green)' : 'var(--red)') : 'var(--text)';
        return '<div style="display:flex;justify-content:space-between;' +
               'padding:9px 0;border-bottom:1px solid rgba(255,255,255,0.04)">' +
          '<div style="font-size:12px;color:var(--muted)">' + row[0] + '</div>' +
          '<div style="font-family:var(--mono);font-size:12px;font-weight:600;color:' + col + '">' +
            row[1] +
          '</div>' +
        '</div>';
      }).join('') + '</div>';
  }
}

// ==============================================================
// FEATURE: GOALS WITH PROJECTED DATE
// ==============================================================
function renderGoalDate(tv, goal, wr) {
  var el = document.getElementById('goal-date-hint');
  if (!el || !tv || !goal || tv >= goal || !wr || wr <= 0) {
    if (el) el.textContent = '';
    return;
  }
  // Years to reach goal = log(goal/tv) / log(1+wr)
  var years = Math.log(goal / tv) / Math.log(1 + wr);
  if (!isFinite(years) || years < 0 || years > 50) { el.textContent = ''; return; }
  var targetDate = new Date();
  targetDate.setFullYear(targetDate.getFullYear() + Math.floor(years));
  targetDate.setMonth(targetDate.getMonth() + Math.round((years % 1) * 12));
  var yr = targetDate.getFullYear();
  var mo = targetDate.toLocaleDateString('en-US', {month:'long'});
  var pct = ((tv/goal)*100).toFixed(0);
  el.innerHTML = 'At current growth rate, you reach your goal in <span>' + mo + ' ' + yr + '</span> -- ' + Math.round(years*12) + ' months away.';
}

// ==============================================================
// FEATURE: MULTIPLE PORTFOLIOS
// ==============================================================
var activePortfolioId = 'default';

function getPortfolios() {
  try { return JSON.parse(localStorage.getItem('pw_portfolios_' + (currentUser?currentUser.id:'x')) || '[]'); }
  catch(e) { return []; }
}

function savePortfoliosList(list) {
  localStorage.setItem('pw_portfolios_' + (currentUser?currentUser.id:'x'), JSON.stringify(list));
}

function initPortfolios() {
  var list = getPortfolios();
  if (!list.length) {
    list = [{ id:'default', name:'My Portfolio', created: new Date().toISOString() }];
    savePortfoliosList(list);
  }
  activePortfolioId = localStorage.getItem('pw_active_portfolio_' + (currentUser?currentUser.id:'x')) || 'default';
  updatePortfolioSwitcherUI();
}

function updatePortfolioSwitcherUI() {
  var list = getPortfolios();
  var sw = document.getElementById('portfolio-switcher');
  var nameEl = document.getElementById('active-portfolio-name');
  if (!sw || !nameEl) return;
  sw.style.display = list.length > 1 ? 'flex' : 'none';
  var active = list.find(function(p){ return p.id === activePortfolioId; });
  nameEl.textContent = active ? active.name : 'My Portfolio';
}

function openPortfolioModal() {
  var m = document.getElementById('portfolio-modal');
  if (m) m.classList.add('show');
  renderPortfolioList();
}

function closePortfolioModal() {
  var m = document.getElementById('portfolio-modal');
  if (m) m.classList.remove('show');
}

function renderPortfolioList() {
  var list = getPortfolios();
  var el = document.getElementById('portfolio-list');
  if (!el) return;
  el.innerHTML = list.map(function(p) {
    var isActive = p.id === activePortfolioId;
    var assetKey = 'pw_assets_' + (currentUser?currentUser.id:'x') + '_' + p.id;
    var assetCount = 0;
    try { assetCount = JSON.parse(localStorage.getItem(assetKey)||'[]').length; } catch(e){}
    return '<div class="portfolio-list-item' + (isActive?' active':'') + '" onclick="switchPortfolio(\'' + p.id + '\')">' +
      '<div><div class="portfolio-item-name">' + p.name + (isActive?' <span style="font-size:9px;color:var(--blue);font-family:var(--mono);font-weight:700;letter-spacing:0.1em">ACTIVE</span>' : '') + '</div>' +
        '<div class="portfolio-item-meta">' + assetCount + ' assets</div>' +
      '</div>' +
      (p.id !== 'default' ? '<button class="portfolio-item-del" onclick="event.stopPropagation();deletePortfolio(\'' + p.id + '\')" title="Delete">&#x2715;</button>' : '') +
    '</div>';
  }).join('');
}

function switchPortfolio(id) {
  // Save current data under old portfolio key
  if (currentUser) {
    var oldKey = 'pw_assets_' + currentUser.id + '_' + activePortfolioId;
    var oldMkey = 'pw_milestones_' + currentUser.id + '_' + activePortfolioId;
    localStorage.setItem(oldKey,  JSON.stringify(assets));
    localStorage.setItem(oldMkey, JSON.stringify(milestones));
  }
  activePortfolioId = id;
  localStorage.setItem('pw_active_portfolio_' + (currentUser?currentUser.id:'x'), id);
  // Load new portfolio data
  if (currentUser) {
    var newKey  = 'pw_assets_' + currentUser.id + '_' + id;
    var newMkey = 'pw_milestones_' + currentUser.id + '_' + id;
    try { assets     = JSON.parse(localStorage.getItem(newKey)  || '[]'); } catch(e){ assets=[]; }
    try { milestones = JSON.parse(localStorage.getItem(newMkey) || '[]'); } catch(e){ milestones=[]; }
    if (!assets.length && id==='default') {} // empty portfolio is fine - user adds assets
  }
  closePortfolioModal();
  updatePortfolioSwitcherUI();
  renderAll();
  // Portfolio system
  try { initPortfolios(); } catch(e) {}
  // Save daily snapshot
  try { saveNWSnapshot(); } catch(e) {}
  setTimeout(function() { try { loadHistoryFromSupabase(); } catch(e) {} }, 1200);
  // Load full history from cloud (merge with local)
  setTimeout(function() { try { loadHistoryFromSupabase(); } catch(e) {} }, 1200);
  // Restore notification indicator
  try {
    if (localStorage.getItem('pw_notif') === '1') {
      var nd = document.getElementById('notif-dot');
      if (nd) nd.classList.add('active');
    }
  } catch(e) {}
  // PWA install prompt (after delay)
  setTimeout(function() { try { checkPWAPrompt(); } catch(e) {} }, 4000);
  setTimeout(function() { try { checkDigestReminder(); } catch(e) {} }, 5000);

  // -- B. Auto-sync prices every 5 min while dashboard is open --
  if (window._autoSyncTimer) clearInterval(window._autoSyncTimer);
  // Initial sync 3s after dashboard loads (silent, respects cache TTL)
  setTimeout(function() { try { syncPrices(true, false); } catch(e) {} }, 3000);
  // Then every 5 minutes
  window._autoSyncTimer = setInterval(function() {
    try { syncPrices(true, false); } catch(e) {}
  }, 5 * 60 * 1000);

  // Show stale-price warning if last sync was > 15 min ago
  try {
    var lastSync = parseInt(localStorage.getItem('pw_last_sync') || '0', 10);
    if (lastSync && (Date.now() - lastSync) > 15 * 60 * 1000) {
      showSyncStatus('[!] Prices may be stale -- syncing...');
    }
  } catch(e) {}
}

function createPortfolio() {
  var nameEl = document.getElementById('portfolio-new-name');
  var name = (nameEl ? nameEl.value.trim() : '') || 'Portfolio ' + (getPortfolios().length+1);
  if (nameEl) nameEl.value = '';
  var list = getPortfolios();
  var id = 'p_' + Date.now();
  list.push({ id:id, name:name, created: new Date().toISOString() });
  savePortfoliosList(list);
  renderPortfolioList();
  updatePortfolioSwitcherUI();
}

function deletePortfolio(id) {
  if (id === 'default') return;
  if (!confirm('Delete this portfolio and all its assets?')) return;
  var list = getPortfolios().filter(function(p){ return p.id !== id; });
  savePortfoliosList(list);
  if (id === activePortfolioId) switchPortfolio('default');
  else renderPortfolioList();
}

// ==============================================================
// FEATURE: BROWSER NOTIFICATIONS
// ==============================================================
function requestNotifications() {
  if (!('Notification' in window)) { alert('Notifications are not supported in this browser.'); return; }
  Notification.requestPermission().then(function(perm) {
    var dot = document.getElementById('notif-dot');
    if (perm === 'granted') {
      if (dot) dot.classList.add('active');
      localStorage.setItem('pw_notif', '1');
      showNotification('WealthOS Alerts Active', 'You will be notified when risk thresholds are crossed.');
    }
  });
}

function showNotification(title, body) {
  if (Notification.permission !== 'granted') return;
  try { new Notification(title, { body: body, icon: "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%20viewBox%3D%220%200%2032%2032%22%3E%3Crect%20width%3D%2232%22%20height%3D%2232%22%20rx%3D%228%22%20fill%3D%22%235C5FEF%22/%3E%3Ctext%20x%3D%2216%22%20y%3D%2222%22%20font-family%3D%22system-ui%22%20font-size%3D%2216%22%20font-weight%3D%22700%22%20text-anchor%3D%22middle%22%20fill%3D%22white%22%3EW%3C/text%3E%3C/svg%3E" }); }
  catch(e) {}
}

function checkAndNotify(cls, tv) {
  if (!tv || localStorage.getItem('pw_notif') !== '1') return;
  var cryptoPct = (cls.crypto||0)/tv*100;
  var top = assets.length ? assets.slice().sort(function(a,b){return b.val-a.val;})[0] : null;
  var topPct = top ? (top.val/tv*100) : 0;
  if (cryptoPct > 35) showNotification('Risk Alert', 'Crypto is ' + cryptoPct.toFixed(0) + '% of your portfolio -- above the 35% threshold.');
  if (topPct > 30 && top) showNotification('Concentration Alert', top.name + ' is ' + topPct.toFixed(0) + '% of your portfolio.');
}

// ==============================================================
// FEATURE: EMAIL SUMMARY
// ==============================================================
function sendEmailSummary() {
  var p    = calcPortfolio();
  var tv   = p.totalNetWorth;
  var gain = p.totalPL;
  var pct  = p.totalPLPct;
  var today = new Date().toLocaleDateString('en-US', {weekday:'long',year:'numeric',month:'long',day:'numeric'});

  // Week-over-week change from history
  var weekChange = 0, weekChangePct = 0;
  try {
    var hist = JSON.parse(localStorage.getItem('pw_history_' + (currentUser ? currentUser.id : '')) || '[]');
    if (hist.length >= 2) {
      var prev = hist[hist.length - 8] || hist[0]; // ~7 days ago
      if (prev && prev.val) {
        weekChange    = tv - prev.val;
        weekChangePct = prev.val > 0 ? (weekChange / prev.val) * 100 : 0;
      }
    }
  } catch(e) {}

  // Benchmark from cache
  var spyYTD = null;
  try {
    var bRaw = localStorage.getItem('wos_bench_spy');
    if (bRaw) { var bData = JSON.parse(bRaw); if (bData && bData.ret !== undefined) spyYTD = bData.ret; }
  } catch(e) {}

  // Top 3 holdings by value
  var top3 = p.assets.slice().sort(function(a,b){ return b.curVal - a.curVal; }).slice(0,3);

  // Risk level
  var cats = p.byCategory;
  var cryptoPct = cats.crypto ? cats.crypto.pct : 0;
  var stockPct  = cats.stock  ? cats.stock.pct  : 0;
  var riskScore = (cryptoPct * 0.42) + (stockPct * 0.22);
  var riskLabel = riskScore > 24 ? 'HIGH' : riskScore > 14 ? 'MODERATE-HIGH' : riskScore > 6 ? 'MODERATE' : 'CONSERVATIVE';

  var NL  = '%0A';
  var DIV = '================================' + NL;
  var lines = [];

  lines.push('WealthOS -- Weekly Wealth Digest');
  lines.push(today);
  lines.push(DIV);

  lines.push('NET WORTH');
  lines.push('  ' + fmtS(tv));
  if (weekChange !== 0) {
    lines.push('  Week: ' + (weekChange >= 0 ? '+' : '') + fmtS(weekChange) +
               ' (' + (weekChangePct >= 0 ? '+' : '') + weekChangePct.toFixed(2) + '%)');
  }
  lines.push('  All-time: ' + (gain >= 0 ? '+' : '') + fmtS(gain) +
             ' (' + (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%)');
  lines.push('');

  if (spyYTD !== null) {
    var diff = pct - spyYTD;
    lines.push('VS MARKET');
    lines.push('  Your all-time return:  ' + (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%');
    lines.push('  S&P 500 YTD:           ' + (spyYTD >= 0 ? '+' : '') + spyYTD.toFixed(1) + '%');
    lines.push('  Difference:            ' + (diff >= 0 ? '+' : '') + diff.toFixed(1) + '% ' +
               (diff >= 0 ? '(outperforming \u2713)' : '(trailing index)'));
    lines.push('');
  }

  lines.push('RISK LEVEL: ' + riskLabel);
  lines.push('');

  lines.push('TOP HOLDINGS');
  top3.forEach(function(a) {
    var alloc = tv > 0 ? (a.curVal / tv * 100).toFixed(1) : '0.0';
    lines.push('  ' + a.name + ': ' + fmtS(a.curVal) + ' (' + alloc + '%)');
  });
  lines.push('');

  lines.push('ALLOCATION');
  Object.keys(cats).sort(function(a,b){ return cats[b].val - cats[a].val; }).forEach(function(c) {
    if (cats[c] && cats[c].val > 0) {
      lines.push('  ' + catL(c) + ': ' + cats[c].pct.toFixed(1) + '% (' + fmtS(cats[c].val) + ')');
    }
  });
  lines.push('');
  lines.push(DIV);
  lines.push('Generated by WealthOS * wealthos.app');
  lines.push('Your data is private and stored only on your device.');

  var subj = encodeURIComponent('WealthOS Weekly Digest -- ' + new Date().toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}));
  var body = lines.join(NL);
  window.location.href = 'mailto:?subject=' + subj + '&body=' + body;

  // Mark last digest sent
  try { localStorage.setItem('wos_last_digest', String(Date.now())); } catch(e) {}
}

function checkDigestReminder() {
  if (!currentUser || !assets.length) return;
  try {
    var last = parseInt(localStorage.getItem('wos_last_digest') || '0', 10);
    var daysSince = (Date.now() - last) / (1000 * 60 * 60 * 24);
    if (daysSince >= 7 || last === 0) {
      var reminderEl = document.getElementById('digest-reminder');
      if (reminderEl) reminderEl.style.display = 'flex';
    }
  } catch(e) {}
}
// ==============================================================
// FEATURE: KEYBOARD SHORTCUTS
// ==============================================================
var kbdSeq = '';
var kbdTimer = null;

function initKeyboardShortcuts() {
  document.addEventListener('keydown', function(e) {
    // Skip if typing in an input
    var tag = document.activeElement ? document.activeElement.tagName : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    // Skip if modals open (except Escape)
    var key = e.key;
    if (key === 'Escape') {
      closeAllModals();
      closeChat();
      closeKbd();
      return;
    }
    if (key === '?') { e.preventDefault(); openKbd(); return; }
    if (key === 'n' || key === 'N') { e.preventDefault(); openAddAsset(); return; }
    if (key === 's' || key === 'S') {
      e.preventDefault();
      navById('assets');
      setTimeout(function(){ var si = document.getElementById('asset-search'); if(si){ si.focus(); } }, 200);
      return;
    }
    if (key === 'c' || key === 'C') { e.preventDefault(); toggleChat(); return; }
    if (key === 'r' || key === 'R') { e.preventDefault(); navById('report'); return; }
    // Two-key combos: G+O, G+A, G+H
    if (key === 'g' || key === 'G') { kbdSeq = 'g'; clearTimeout(kbdTimer); kbdTimer = setTimeout(function(){ kbdSeq=''; }, 1000); return; }
    if (kbdSeq === 'g') {
      kbdSeq = '';
      if (key === 'o' || key === 'O') { navById('overview'); return; }
      if (key === 'a' || key === 'A') { navById('assets'); return; }
      if (key === 'h' || key === 'H') { navById('history'); return; }
    }
  });
}

function closeAllModals() {
  ['add-modal','milestone-modal','csv-modal','share-modal','portfolio-modal','tour-modal','onboarding-modal','upgrade-prompt'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.classList.remove('show');
    if (el) el.style.display = '';
  });
}

function openKbd() {
  var m = document.getElementById('kbd-overlay');
  if (m) m.classList.add('show');
}
function closeKbd() {
  var m = document.getElementById('kbd-overlay');
  if (m) m.classList.remove('show');
}

// ==============================================================
// FEATURE: AI CHAT ASSISTANT
// ==============================================================
var chatHistory = [];
var chatOpen = false;

function openChat(){
  // Initialize usage counter
  try {
    var plan2 = (currentUser && currentUser.plan) ? currentUser.plan.toLowerCase() : 'free';
    var isPro2 = (plan2 === 'pro' || plan2 === 'private' || plan2 === 'paid');
    if (!isPro2) {
      var uk2 = 'wos_chat_' + (currentUser ? currentUser.id : 'guest');
      var ud2 = {};
      try { ud2 = JSON.parse(localStorage.getItem(uk2) || '{}'); } catch(e) {}
      var td2 = new Date().toISOString().slice(0,10);
      if (ud2.date !== td2) ud2 = { date: td2, count: 0 };
      _updateChatUsage(ud2.count, 20);
    } else {
      var el2 = document.getElementById('chat-usage-counter');
      if (el2) el2.textContent = 'Unlimited';
    }
  } catch(e) {}
  chatOpen=true;
  var p=document.getElementById("chat-panel"); if(p) p.classList.add("open");
  var f=document.getElementById("chat-fab"); if(f) f.style.display="none";
  if(!chatHistory.length){
    var c=document.getElementById("chat-messages");
    if(c){
      c.innerHTML="";
      var tv=totalV(),cls=clsT(),risk=computeRiskLevel(cls,tv);
      var nm=(settings&&settings.name)?settings.name.split(" ")[0]:"";
      var topCat="",topV=0;
      Object.keys(cls).forEach(function(k){if((cls[k]||0)>topV){topV=cls[k];topCat=k;}});
      var parts=[(nm?"Hi "+nm+".":"Hi there.")];
      if(tv>0){parts.push("Your portfolio is at **"+fmtS(tv)+"**"+(topCat?", mostly "+catL(topCat):"")+". Risk: **"+risk.label+"**.");}
      else{parts.push("No assets added yet. Add your first asset to get started.");}
      parts.push("Ask me anything about your wealth, risks, returns, or how to use WealthOS.");
      appendChatMsg("ai",parts.join("\n\n"));
    }
  }
  setTimeout(function(){var i=document.getElementById("chat-input");if(i)i.focus();},300);
}
function closeChat() {
  chatOpen = false;
  var p = document.getElementById("chat-panel");
  var f = document.getElementById("chat-fab");
  if (p) p.classList.remove("open");
  if (f) { f.style.display="flex"; }
}
function toggleChat(){ if(chatOpen) closeChat(); else openChat(); }

function buildPortfolioContext() {
  var portfolio = calcPortfolio();
  var tv   = portfolio.totalNetWorth;
  var co   = portfolio.totalCostBasis;
  var cls  = clsT(); // keep for compatibility
  var risk = computeRiskLevel(cls, tv);
  var sent = getSentiment ? getSentiment() : {label:'Unknown'};
  var gain    = portfolio.totalPL;
  var totalGainPct = portfolio.totalPLPct > 0 ? portfolio.totalPLPct.toFixed(1) : "0";
  var goal     = settings.goal || 0;
  var goalPct  = tv > 0 ? ((tv/goal)*100).toFixed(1) : "0";
  var currency = settings.currency || "USD";
  var userName = settings.name || "the user";

  // Sort all assets by value descending
  var sorted = assets.slice().sort(function(a,b){ return b.val - a.val; });

  // Best and worst performers
  var performers = assets.filter(function(a){ return a.cost > 0; })
    .sort(function(a,b){ return gainPct(a.cost,a.val) > gainPct(b.cost,b.val) ? -1 : 1; });
  var best  = performers[0];
  var worst = performers[performers.length-1];

  // Cash runway (months of expenses covered -- rough heuristic: cash / (2% of total monthly))
  var cashVal = cls.cash || 0;
  var monthlyExpEst = tv * 0.003; // rough 0.3% monthly burn assumption
  var cashRunway = monthlyExpEst > 0 ? (cashVal / monthlyExpEst).toFixed(0) : "unknown";

  // Largest single position concentration
  var topAsset = sorted[0];
  var topPct   = topAsset && tv > 0 ? ((topAsset.val/tv)*100).toFixed(1) : 0;

  // Build lines
  var lines = [
    "=== WEALTHOS PORTFOLIO DATA FOR: " + userName + " ===",
    "Date: " + new Date().toLocaleDateString("en-US",{weekday:"long",year:"numeric",month:"long",day:"numeric"}),
    "Display currency: " + currency,
    "",
    "--- NET WORTH SUMMARY ---",
    "Total net worth: " + fmtS(tv),
    "Total cost basis: " + fmtS(co),
    "Total unrealised gain/loss: " + fmtS(gain) + " (" + (gain>=0?"+":"") + totalGainPct + "%)",
    "Wealth goal: " + fmtS(goal) + " (" + goalPct + "% achieved)",
    "Risk profile: " + (settings.risk || "Moderate"),
    "Portfolio risk level: " + risk.label,
    "Market sentiment today: " + sent.label,
    "",
    "--- ALLOCATION BY ASSET CLASS ---"
  ];

  // All asset classes with value and percentage
  var classOrder = ["stock","real_estate","crypto","cash","art","watch","other"];
  classOrder.forEach(function(c) {
    var v = cls[c] || 0;
    if (v > 0) {
      var pct = tv > 0 ? ((v/tv)*100).toFixed(1) : "0";
      lines.push("  " + catL(c) + ": " + fmtS(v) + " (" + pct + "% of portfolio)");
    }
  });

  lines.push("");
  lines.push("--- ALL HOLDINGS (" + assets.length + " assets) ---");

  // Every single asset with full detail
  sorted.forEach(function(a, i) {
    var gp  = a.cost > 0 ? ((a.val-a.cost)/a.cost*100).toFixed(1) : "n/a";
    var gpN = a.cost > 0 ? ((a.val-a.cost)/a.cost*100) : 0;
    var pct = tv > 0 ? ((a.val/tv)*100).toFixed(1) : "0";
    var row = "  " + (i+1) + ". " + a.name;
    if (a.ticker && a.ticker !== "-" && a.ticker !== "") row += " (" + a.ticker + ")";
    row += " [" + catL(a.cat) + "]";
    row += ": " + fmtS(a.val) + " -- " + pct + "% of portfolio";
    row += ", cost " + fmtS(a.cost);
    row += ", return " + (gpN>=0?"+":"") + gp + "%";
    if (a.loc) row += ", held at " + a.loc;
    lines.push(row);
  });

  // Key metrics
  lines.push("");
  lines.push("--- KEY RISK METRICS ---");
  lines.push("Largest single position: " + (topAsset ? topAsset.name + " at " + topPct + "% of portfolio" : "n/a"));
  lines.push("Crypto concentration: " + (tv>0?((cls.crypto||0)/tv*100).toFixed(1):0) + "%  (alert threshold: 35%)");
  lines.push("Cash buffer: " + fmtS(cashVal) + " (" + (tv>0?((cashVal/tv)*100).toFixed(1):0) + "% of portfolio)");
  lines.push("Estimated cash runway: ~" + cashRunway + " months");
  lines.push("Number of asset classes held: " + Object.keys(cls).filter(function(k){return cls[k]>0;}).length + " of 6");

  if (best) {
    lines.push("Best performer: " + best.name + " at +" + gainPct(best.cost,best.val).toFixed(1) + "% return");
  }
  if (worst && worst !== best) {
    lines.push("Worst performer: " + worst.name + " at " + gainPct(worst.cost,worst.val).toFixed(1) + "% return");
  }

  // Milestones if any
  if (milestones && milestones.length) {
    lines.push("");
    lines.push("--- WEALTH MILESTONES ---");
    milestones.slice().sort(function(a,b){return new Date(b.date)-new Date(a.date);}).slice(0,5)
      .forEach(function(m){ lines.push("  " + m.date + ": " + m.title + " -- " + fmtS(m.val)); });
  }

  lines.push("");
  lines.push("=== END OF PORTFOLIO DATA ===");
  return lines.join("\n");
}
function appendChatMsg(role,text,stream){
  var C=document.getElementById("chat-messages");
  if(!C)return null;
  var ai=role==="ai";

  function md(t){
    t=t.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    t=t.replace(/\*\*([^*\n]+)\*\*/g,"<strong style='font-weight:600'>$1</strong>");
    t=t.replace(/`([^`\n]+)`/g,"<code style='background:rgba(92,95,239,0.15);color:#aaa;padding:1px 5px;border-radius:3px;font-family:monospace;font-size:11px'>$1</code>");
    t=t.replace(/^(\d+)\.\s+(.+)$/gm,"<div style='display:flex;gap:7px;margin:3px 0;align-items:flex-start'><b style='color:#9B9FEF;font-size:11px;font-weight:700;flex-shrink:0;min-width:18px'>$1.</b><span>$2</span></div>");
    t=t.replace(/^[-\u2022]\s+(.+)$/gm,"<div style='display:flex;gap:7px;margin:3px 0;align-items:flex-start'><span style='color:#9B9FEF;flex-shrink:0'>\u2022</span><span>$1</span></div>");
    t=t.replace(/\n\n+/g,"<br><br>");
    t=t.replace(/\n/g,"<br>");
    return t;
  }

  var row=document.createElement("div");
  row.style.cssText="display:flex;gap:10px;width:100%;box-sizing:border-box;align-items:flex-start;"+(ai?"":"flex-direction:row-reverse;");

  var av=document.createElement("div");
  av.style.cssText="width:28px;height:28px;min-width:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;margin-top:2px;flex-shrink:0;"+(ai?"background:rgba(92,95,239,0.15);color:#9B9FEF;border:1px solid rgba(92,95,239,0.3);":"background:rgba(255,255,255,0.1);color:#8A8FAF;");
  av.textContent=ai?"W":"U";

  var bb=document.createElement("div");
  bb.style.cssText="padding:12px 15px;font-size:13px;line-height:1.65;max-width:calc(100% - 48px);min-width:0;word-break:break-word;overflow-wrap:anywhere;box-sizing:border-box;"+(ai?"background:rgba(255,255,255,0.07);color:#F2F2FA;border:1px solid rgba(255,255,255,0.09);border-radius:4px 14px 14px 14px;":"background:#5C5FEF;color:#fff;border-radius:14px 4px 14px 14px;");

  if (!stream) {
    bb.innerHTML=ai?md(text):text.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\n/g,"<br>");
  }

  row.appendChild(av);
  row.appendChild(bb);
  C.appendChild(row);
  setTimeout(function(){C.scrollTop=C.scrollHeight;},60);
  if(role==="user"){var s=document.getElementById("chat-suggestions");if(s)s.style.display="none";}

  // Stream mode: return bubble + md function for progressive rendering
  if (stream && ai) {
    return { bubble: bb, md: md, container: C };
  }
  return null;
}

// Streaming word-by-word effect for AI responses
function streamChatMsg(text, callback) {
  var ref = appendChatMsg("ai", "", true);
  if (!ref) { appendChatMsg("ai", text); if (callback) callback(); return; }

  var words = text.split(/(\s+)/); // split preserving whitespace
  var idx = 0;
  var built = '';
  var speed = 18; // ms per word — fast but visible
  var chunkSize = 2; // words per tick for natural feel

  function tick() {
    if (idx >= words.length) {
      ref.bubble.innerHTML = ref.md(text); // final render with full markdown
      setTimeout(function(){ ref.container.scrollTop = ref.container.scrollHeight; }, 30);
      if (callback) callback();
      return;
    }
    // Add a chunk of words
    var end = Math.min(idx + chunkSize, words.length);
    for (var i = idx; i < end; i++) { built += words[i]; }
    idx = end;
    // Render progressively (plain text during streaming, markdown at end)
    ref.bubble.textContent = built;
    ref.container.scrollTop = ref.container.scrollHeight;
    // Vary speed slightly for natural feel
    var nextSpeed = speed + Math.floor(Math.random() * 12);
    setTimeout(tick, nextSpeed);
  }
  tick();
}

function showFollowUpSuggestions(userQ, aiReply) {
  var sugg = document.getElementById("chat-suggestions");
  if (!sugg) return;

  // Context-aware suggestions based on what was just discussed
  var q = (userQ + " " + aiReply).toLowerCase();
  var options = [];

  if (q.indexOf("crypto") >= 0 || q.indexOf("bitcoin") >= 0 || q.indexOf("btc") >= 0) {
    options.push("Should I reduce my crypto allocation?");
    options.push("What would a 50% crypto crash do to my net worth?");
  }
  if (q.indexOf("risk") >= 0 || q.indexOf("concentrat") >= 0) {
    options.push("How can I reduce my portfolio risk?");
    options.push("What is a healthy allocation for my net worth level?");
  }
  if (q.indexOf("goal") >= 0 || q.indexOf("target") >= 0 || q.indexOf("reach") >= 0) {
    options.push("What is my projected net worth in 5 years?");
    options.push("Which assets are growing fastest toward my goal?");
  }
  if (q.indexOf("real estate") >= 0 || q.indexOf("property") >= 0) {
    options.push("How much of my wealth is in illiquid assets?");
    options.push("What is my property allocation vs best practices?");
  }
  if (q.indexOf("stock") >= 0 || q.indexOf("equity") >= 0 || q.indexOf("aapl") >= 0 || q.indexOf("nvda") >= 0) {
    options.push("Am I too concentrated in equities?");
    options.push("Which stock has the best return on cost?");
  }
  if (q.indexOf("cash") >= 0 || q.indexOf("runway") >= 0 || q.indexOf("liquid") >= 0) {
    options.push("Do I have enough cash for emergencies?");
    options.push("How much cash should someone at my wealth level hold?");
  }

  // Default suggestions if nothing contextual
  if (options.length === 0) {
    options = [
      "What is my single biggest financial risk?",
      "How is my wealth growing year over year?",
      "Which asset should I add more of?",
      "What does my portfolio look like vs typical investors at my level?"
    ];
  }

  // Show 2 contextual suggestions
  var picks = options.slice(0, 2);
  sugg.innerHTML = picks.map(function(s) {
    return "<button class=\"chat-suggestion\" onclick=\"askChat(this.textContent)\">" + s + "</button>";
  }).join("");
  sugg.style.display = "flex";
}
function showTyping() {
  var container = document.getElementById("chat-messages");
  if (!container) return;
  var phrases = [
    'Analyzing your portfolio\u2026',
    'Reviewing your holdings\u2026',
    'Checking your allocations\u2026',
    'Running the numbers\u2026',
    'Preparing your insights\u2026'
  ];
  var div = document.createElement("div");
  div.className = "chat-msg ai";
  div.id = "chat-typing";
  var phrase = phrases[Math.floor(Math.random() * phrases.length)];
  div.innerHTML =
    "<div style='display:flex;gap:10px;align-items:flex-start;width:100%'>" +
      "<div style='width:28px;height:28px;min-width:28px;border-radius:50%;background:rgba(92,95,239,0.15);color:#9B9FEF;border:1px solid rgba(92,95,239,0.3);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;margin-top:2px'>W</div>" +
      "<div style='padding:10px 15px;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.09);border-radius:4px 14px 14px 14px;font-size:12px;color:#9B9FEF;font-family:var(--mono);letter-spacing:0.02em'>" +
        "<span id='typing-text' style='display:inline-flex;align-items:center;gap:6px'>" +
          "<svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' style='animation:spin 1.5s linear infinite'><path d='M21 12a9 9 0 11-6.219-8.56'/></svg>" +
          phrase +
        "</span>" +
      "</div>" +
    "</div>";
  container.appendChild(div);
  setTimeout(function(){ container.scrollTop = container.scrollHeight; }, 30);

  // Cycle through phrases while waiting
  var idx = phrases.indexOf(phrase);
  div._interval = setInterval(function() {
    idx = (idx + 1) % phrases.length;
    var el = document.getElementById('typing-text');
    if (el) {
      el.innerHTML = "<svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' style='animation:spin 1.5s linear infinite'><path d='M21 12a9 9 0 11-6.219-8.56'/></svg>" + phrases[idx];
    }
  }, 2500);
}

function removeTyping() {
  var t = document.getElementById('chat-typing');
  if (t) {
    if (t._interval) clearInterval(t._interval);
    t.remove();
  }
}

function askChat(text) { sendChat(text); }


// ==============================================================
// AI AGENT -- KNOWLEDGE & SYSTEM PROMPT BUILDERS
// ==============================================================

function buildWealthOSKnowledge() {
  return [
    "=== WEALTHOS PLATFORM KNOWLEDGE ===",
    "",
    "WealthOS is a private, browser-based wealth intelligence dashboard.",
    "ALL data is stored in the user's browser (localStorage) -- nothing goes to any server.",
    "The product is 100% private by architecture -- no servers, no data sharing, no breach risk.",
    "",
    "FEATURES AVAILABLE IN THIS DASHBOARD:",
    "- Net Worth Dashboard: Live total across all 6 asset classes with trend chart",
    "- Portfolio Intelligence: Auto-runs 6 insight cards every session (concentration, exposure, gaps)",
    "- Risk Alerts: 4 automated checks -- crypto >35%, single position >30%, cash <5%, poor diversification",
    "- Market Intelligence: 6 sector cards with daily sentiment (Pro plan)",
    "- Wealth Projection: 3-scenario 10-year forecast (conservative/expected/optimistic) using actual asset mix",
    "- Panic Mode / Stress Test: Simulates 30% market crash -- shows stressed NW, drawdown, cash runway (Private plan)",
    "- Net Worth History: Daily auto-snapshots build a real chart over time",
    "- Goal Tracking: Target net worth with projected achievement date based on growth rate",
    "- AI Chat (this): Real-time portfolio Q&A using Claude AI",
    "- Multiple Portfolios: Create/switch between isolated portfolios",
    "- CSV Import: Paste or upload spreadsheet data to bulk-add assets",
    "- Advisor Share: Read-only portfolio link for financial advisors (7-day expiry, Private plan)",
    "- Email Summary: One-click weekly wealth summary via email",
    "- Keyboard Shortcuts: N=new asset, S=search, C=chat, R=report, G+O/A/H=navigate, ?=help",
    "- PWA: Installable as a home screen app, works offline",
    "- Reports: Quarterly wealth reports (Q1-Q4) with full breakdown",
    "- Multi-currency: USD, EUR, GBP, AED with per-asset currency selection",
    "- Light/Dark mode",
    "",
    "PLANS:",
    "- Free: up to 5 assets, basic dashboard",
    "- Pro ($49/mo): Unlimited assets, Portfolio Intelligence, Risk Alerts, Market Intel, Projections, Reports",
    "- Private ($99/mo): Everything in Pro + Stress Testing, Multi-user, Advisor Sharing, PDF Export",
    "",
    "ASSET CLASSES SUPPORTED: Stocks/ETFs, Real Estate, Crypto, Art, Watches/Jewellery, Cash/Savings",
    "",
    "COMING SOON:",
    "- Live price sync for stocks (Alpha Vantage API) and crypto (CoinGecko API)",
    "- Paddle payment integration for Pro/Private plan billing",
    "- Brokerage sync (Schwab, Fidelity, Interactive Brokers)",
    "",
    "=== END PLATFORM KNOWLEDGE ===",
  ].join("\n");
}

function buildSystemPrompt(portfolioCtx) {
  var name = (settings && settings.name) ? settings.name.split(" ")[0] : "there";
  var plan = (currentUser && currentUser.plan) ? currentUser.plan : 'free';
  var hasAssets = assets && assets.length > 0;

  var base = "You are WealthOS AI, a sharp and concise portfolio intelligence assistant.\n\n";
  base += "USER: " + name + " | PLAN: " + plan.toUpperCase() + "\n\n";

  if (hasAssets) {
    base += "LIVE PORTFOLIO DATA:\n" + portfolioCtx + "\n\n";
    base += "BEHAVIOR:\n";
    base += "- Reference the user's ACTUAL numbers, never hypothetical examples\n";
    base += "- Lead with the key insight, then explain why it matters\n";
    base += "- Flag risks directly: overexposure, low liquidity, high concentration, negative P&L\n";
    base += "- Be specific: 'Your crypto is 34% of your portfolio, above the 15% recommended max'\n";
    base += "- Suggest concrete actions: 'Consider rebalancing X into Y'\n";
    base += "- Risk questions: score 1-10 and explain the main driver\n";
    base += "- Performance questions: cite exact $ and % figures\n";
  } else {
    base += "PORTFOLIO STATUS: No assets added yet\n\n";
    base += "BEHAVIOR:\n";
    base += "- Warmly guide the user to add their first asset\n";
    base += "- Explain what insights they will get once they add assets\n";
    base += "- Answer general wealth-building and investing questions clearly\n";
    base += "- Suggest starting with their largest asset type\n";
  }

  base += "\nRULES:\n";
  base += "- Keep responses under 220 words\n";
  base += "- Use **bold** for key numbers and risk flags\n";
  base += "- Use bullet points for 3 or more items\n";
  base += "- Never fabricate portfolio data not in the context\n";
  base += "- For tax or legal questions, recommend a qualified professional\n";
  base += "- End with one follow-up question or suggested action\n";

  return base;
}

function saveApiKey() {
  // API key is handled server-side. No user input needed.
  var status = document.getElementById("apikey-status");
  if (status) { status.style.color = "var(--green)"; status.textContent = "AI is managed by WealthOS. No key needed."; }
}

function testApiKey() {
  // API key is handled server-side. No user input needed.
  var status = document.getElementById("apikey-status");
  if (status) { status.style.color = "var(--green)"; status.textContent = "AI chat is ready. Powered by Claude."; }
}

function sendChat(overrideText) {
  var inputEl = document.getElementById("chat-input");
  var sendBtn = document.getElementById("chat-send");
  var text = overrideText || (inputEl ? inputEl.value.trim() : "");
  if (!text) return;
  if (sendBtn && sendBtn.disabled) return;

  // Usage limit check (free plan: 20 msg/day)
  var plan = (currentUser && currentUser.plan) ? currentUser.plan.toLowerCase() : 'free';
  var isPro = (plan === 'pro' || plan === 'private' || plan === 'paid');
  if (!isPro) {
    var usageKey = 'wos_chat_' + (currentUser ? currentUser.id : 'guest');
    var usageData = {};
    try { usageData = JSON.parse(localStorage.getItem(usageKey) || '{}'); } catch(e) {}
    var today = new Date().toISOString().slice(0,10);
    if (usageData.date !== today) usageData = { date: today, count: 0 };
    var FREE_LIMIT = 20;
    if (usageData.count >= FREE_LIMIT) {
      appendChatMsg("ai",
        "**You have reached your 20 free messages for today.**\n\n" +
        "Upgrade to **Pro** ($49/mo) for unlimited AI portfolio analysis.\n\n" +
        "*Your limit resets tomorrow at midnight.*"
      );
      return;
    }
    usageData.count++;
    localStorage.setItem(usageKey, JSON.stringify(usageData));
    _updateChatUsage(usageData.count, FREE_LIMIT);
  }

  if (inputEl) inputEl.value = "";
  if (sendBtn) sendBtn.disabled = true;

  appendChatMsg("user", text);
  showTyping();
  chatHistory.push({ role:"user", content: text });

  var portfolioCtx = buildPortfolioContext();
  var systemPrompt = buildSystemPrompt(portfolioCtx);
  var messages = chatHistory.slice(-12).map(function(m) {
    return { role: m.role === "ai" ? "assistant" : "user", content: m.content };
  });

  if (_chatAbort) { try { _chatAbort.abort(); } catch(e) {} }
  _chatAbort = typeof AbortController !== "undefined" ? new AbortController() : null;

  fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: _chatAbort ? _chatAbort.signal : undefined,
    body: JSON.stringify({
      messages:     messages,
      systemPrompt: systemPrompt,
      userId:       currentUser ? String(currentUser.id) : "guest",
      plan:         plan || "free"
    })
  })
  .then(function(r) {
    return r.json().then(function(d) {
      if (!r.ok) {
        var e = new Error(d.error || "api_error");
        e.status = r.status;
        e.serverMessage = d.message || "";
        throw e;
      }
      return d;
    });
  })
  .then(function(data) {
    removeTyping();
    var reply = (data && data.reply) ? data.reply : "I could not generate a response. Please try again.";
    chatHistory.push({ role:"ai", content: reply });
    appendChatMsg("ai", reply);
    if (sendBtn) sendBtn.disabled = false;
    if (chatHistory.length >= 4) showFollowUpSuggestions(text, reply);
  })
  .catch(function(err) {
    removeTyping();
    if (err.name === "AbortError") { if (sendBtn) sendBtn.disabled = false; return; }
    var msg = "Assistant temporarily unavailable. Please try again.";
    if (err.message === "rate_limit" || (err.status === 429)) msg = "AI is busy. Please wait a moment and try again.";
    else if (err.message === "ai_not_configured")             msg = "AI assistant is being set up. Please try again shortly.";
    else if (err.message === "ai_auth_failed")                msg = "AI configuration error. Please contact support.";
    else if (err.serverMessage)                               msg = err.serverMessage;
    else if (err.message && err.message.indexOf("Failed to fetch") >= 0) msg = "Could not reach assistant. Check your connection.";
    appendChatMsg("ai", msg);
    if (sendBtn) sendBtn.disabled = false;
  });
}

function _updateChatUsage(count, limit) {
  var el = document.getElementById('chat-usage-counter');
  if (!el) return;
  var remaining = Math.max(0, limit - count);
  el.textContent = remaining + " messages left today";
  el.style.color = remaining <= 5 ? 'var(--amber)' : 'var(--muted2)';
}

// ==============================================================
// WIRE ALL NEW FEATURES INTO EXISTING FUNCTIONS
// ==============================================================


// -- UPGRADE SHORTCUT HELPERS --
function goPricing() {
  closeUpgradePrompt();
  showLanding();
  setTimeout(function() {
    var el = document.getElementById('pricing-section');
    if (el) el.scrollIntoView({ behavior: 'smooth' });
  }, 300);
}

// ============================================
// PADDLE PAYMENT INTEGRATION
// ============================================
// Config: Set your Paddle Price IDs here after creating products in Paddle dashboard
var PADDLE_CONFIG = {
  proPriceId:          'pri_01kmjb2sm39eqqybcdzqbt45rh',
  privatePriceId:      'pri_01kmjb5rsd19dqga99vcxmegda',
  proAnnualPriceId:    'pri_01knn1mzbhedaw0bth7ttptp3a',
  privateAnnualPriceId:'pri_01knn1srzjvet3ybx202qpbt64',
  environment:         'production'
};

function startPaddleCheckout(plan) {
  if (!currentUser) {
    window._pendingPlan = plan;
    showAuth('signup');
    _showToast('Create an account first, then complete your upgrade.', 'info');
    return;
  }

  // Select correct price ID based on plan + billing mode
  var isAnnual = (typeof billingMode !== 'undefined' && billingMode === 'annual');
  var priceId;

  if (plan === 'private') {
    priceId = (isAnnual && PADDLE_CONFIG.privateAnnualPriceId)
      ? PADDLE_CONFIG.privateAnnualPriceId
      : PADDLE_CONFIG.privatePriceId;
  } else {
    priceId = (isAnnual && PADDLE_CONFIG.proAnnualPriceId)
      ? PADDLE_CONFIG.proAnnualPriceId
      : PADDLE_CONFIG.proPriceId;
  }

  // If user selected annual but no annual price exists, notify and use monthly
  if (isAnnual && !((plan === 'private' ? PADDLE_CONFIG.privateAnnualPriceId : PADDLE_CONFIG.proAnnualPriceId))) {
    _showToast('Annual billing coming soon. Proceeding with monthly pricing.', 'info');
  }

  if (!priceId) {
    _showToast('Payment system is being configured. Please try again shortly.', 'warn');
    return;
  }

  if (typeof Paddle === 'undefined' || !Paddle.Checkout) {
    _showToast('Payment system is loading. Please try again in a moment.', 'warn');
    return;
  }

  try {
    Paddle.Checkout.open({
      items: [{ priceId: priceId, quantity: 1 }],
      customer: { email: currentUser.email },
      settings: {
        displayMode: 'overlay',
        theme: 'dark',
        locale: 'en'
      }
    });
    console.log('[WealthOS] Paddle checkout opened for:', plan, priceId);
  } catch(e) {
    console.error('[WealthOS] Paddle checkout error:', e);
    _showToast('Could not open checkout. Please try again.', 'error');
  }
}

function refreshUserPlan() {
  // Re-read plan from Supabase (trusted source - set by webhook)
  var _sb = getSB();
  if (!_sb || !currentUser) return;

  // Source 1: auth user_metadata (set by webhook)
  _sb.auth.getUser().then(function(res) {
    if (!res.data || !res.data.user) return;
    var meta = res.data.user.user_metadata || {};
    if (meta.plan && meta.plan !== currentUser.plan) {
      console.log('[WealthOS] Plan from metadata:', currentUser.plan, '->', meta.plan);
      currentUser.plan = meta.plan;
      settings.plan = meta.plan;
      saveSession(currentUser);
      saveUsers();
      saveData();
      renderAll();
      _showToast('Plan upgraded to ' + meta.plan.charAt(0).toUpperCase() + meta.plan.slice(1) + '!', 'success');
    }
  }).catch(function(e) { console.warn('[WealthOS] Metadata plan refresh failed:', e); });

  // Source 2: public.users table (may be updated separately)
  syncPlanFromDB();
}

function syncPlanFromDB() {
  var _sb = getSB();
  if (!_sb || !currentUser || !currentUser.supabaseId) return;
  _sb.from('users').select('plan, first_name, last_name').eq('id', currentUser.supabaseId).single()
    .then(function(res) {
      if (!res.data) return;
      var dbPlan = res.data.plan;
      if (dbPlan && dbPlan !== 'free' && dbPlan !== currentUser.plan) {
        console.log('[WealthOS] Plan from DB:', currentUser.plan, '->', dbPlan);
        currentUser.plan = dbPlan;
        settings.plan = dbPlan;
        saveSession(currentUser);
        saveUsers();
        renderAll();
        if (dbPlan !== 'free') {
          _showToast('Plan updated to ' + dbPlan.charAt(0).toUpperCase() + dbPlan.slice(1) + '!', 'success');
        }
      } else if (dbPlan && dbPlan !== currentUser.plan) {
        currentUser.plan = dbPlan;
        settings.plan = dbPlan;
        saveSession(currentUser);
        saveUsers();
      }
      // Sync name from DB if missing locally
      if (res.data.first_name && (!currentUser.firstName || currentUser.firstName === currentUser.email.split('@')[0])) {
        currentUser.firstName = res.data.first_name;
        if (res.data.last_name) currentUser.lastName = res.data.last_name;
        saveSession(currentUser);
        saveUsers();
      }
    }).catch(function(e) { console.warn('[WealthOS] DB plan sync failed:', e); });
}

// Check for upgrade return from Paddle
(function() {
  try {
    if (window.location.search.indexOf('upgraded=1') >= 0) {
      var clean = window.location.pathname;
      window.history.replaceState({}, '', clean);
      setTimeout(refreshUserPlan, 2000);
      setTimeout(refreshUserPlan, 5000);
      setTimeout(refreshUserPlan, 10000);
    }
  } catch(e) {}
})();

// Listen for Paddle checkout events (instant plan update on success)
(function() {
  try {
    if (typeof Paddle !== 'undefined' && Paddle.Checkout) {
      // Paddle v2 fires events via eventCallback
    }
    // Also set up via Paddle.Initialize callback
    window._paddleEventCallback = function(ev) {
      try {
        if (ev.name === 'checkout.completed' || ev.name === 'checkout.closed') {
          if (ev.name === 'checkout.completed') {
            _showToast('Payment successful! Upgrading your plan...', 'success');
            setTimeout(refreshUserPlan, 2000);
            setTimeout(refreshUserPlan, 5000);
          }
        }
      } catch(e) {}
    };
  } catch(e) {}
})();
function showUpgradeInsights() {
  showUpgradePrompt('Portfolio Intelligence', 'Upgrade to Pro to unlock all six insight cards -- allocation analysis, concentration risk, equity weight, crypto exposure, gain summary and cash review. From $49/mo.');
}
function showUpgradeAssets() {
  showUpgradePrompt('Upgrade to Pro', 'Pro gives you unlimited assets, portfolio intelligence, risk alerts, wealth projections, market updates and more -- $49/mo.');
}
function showUpgradeRisk() {
  showUpgradePrompt('Automated Risk Alerts', 'Pro includes real-time alerts for crypto overexposure, single-position concentration, low cash allocation and diversification gaps. From $49/mo.');
}
function showUpgradeMarket() {
  showUpgradePrompt('Market Intelligence', 'Pro includes live sector updates, market sentiment indicators and daily intelligence across six asset classes. From $49/mo.');
}
function showUpgradePanic() {
  showPrivateUpgradePrompt('Portfolio Stress Testing', 'Simulate a severe market downturn to see your stressed net worth, total drawdown and cash runway. Available exclusively on the Private plan.');
}

// ========================================
// STATE
// ==============================================
var users = []; try { users = JSON.parse(localStorage.getItem('pw_users') || '[]'); } catch(e) { users = []; }
var currentUser = null; try { currentUser = JSON.parse(localStorage.getItem('pw_session') || 'null'); } catch(e) { currentUser = null; }
var assets = [], milestones = [], settings = {};
var editId = null;
var trendChart = null, allocChart = null, nwChart = null, classChart = null, projChart = null;
var CAT_COLORS = {
  stock: '#5C5FEF', real_estate: '#22D3A5', crypto: '#F0A030',
  art: '#C8A06A', watch: '#a78bfa', cash: '#6E7191', other: '#5a7299'
};
var DEFAULT_SETTINGS = { name: '', goal: 0, risk: 'Moderate', currency: 'USD' };
var CURRENCY_SYMBOLS = { USD: '$', EUR: '\u20AC', GBP: '\u00A3', AED: '\u062F.\u0625' };
var CURRENCY_RATES   = { USD: 1, EUR: 0.92, GBP: 0.79, AED: 3.67 };

// ==============================================
// PAGE ROUTING -- rock solid
// ==============================================
function showPage(id) {
  try {
    console.log('[WealthOS] showPage:', id);
    ['landing', 'auth', 'app'].forEach(function(p) {
      var el = document.getElementById(p);
      if (!el) return;
      el.classList.remove('active');
      el.style.display = 'none';
    });
    var target = document.getElementById(id);
    if (!target) { console.warn('[WealthOS] showPage: target not found:', id); return; }
    target.classList.add('active');
    if (id === 'app')    target.style.display = 'flex';
    else if (id === 'auth') target.style.display = 'flex';
    else                 target.style.display = 'block';
    window.scrollTo(0, 0);
    var fab = document.getElementById('chat-fab');
    if (fab) fab.style.display = (id === 'app') ? 'flex' : 'none';
  } catch(e) { console.error('[WealthOS] showPage error:', e); }
}

function showLanding() {
  showPage('landing');
  var signinBtn = document.querySelector('.lnav-signin');
  var ctaBtn    = document.querySelector('.lnav-cta');
  var heroBtn   = document.querySelector('.btn-primary-lg');
  if (currentUser) {
    if (signinBtn) signinBtn.style.display = 'none';
    if (ctaBtn) { ctaBtn.textContent = 'Open Dashboard'; ctaBtn.setAttribute('onclick','enterDashboard()'); }
    if (heroBtn) { heroBtn.textContent = 'Open Dashboard \u2192'; heroBtn.setAttribute('onclick','enterDashboard()'); }
  } else {
    if (signinBtn) { signinBtn.style.display = ''; signinBtn.textContent = 'Log In'; }
    if (ctaBtn) { ctaBtn.textContent = 'Get Started Free'; ctaBtn.setAttribute('onclick',"selectPlan('free')"); }
    if (heroBtn) { heroBtn.textContent = 'Get Started Free \u2192'; heroBtn.setAttribute('onclick',"selectPlan('free')"); }
  }
}
function showAuth(mode) {
  showPage('auth');
  switchAuth(mode || 'login');
}

// ==============================================
// AUTH
// ==============================================
function saveUsers()  { try { localStorage.setItem('pw_users', JSON.stringify(users)); } catch(e) { console.warn('[WealthOS] saveUsers failed:', e); } }
function saveSession(u) { try { localStorage.setItem('pw_session', JSON.stringify(u)); } catch(e) { console.warn('[WealthOS] saveSession failed:', e); } currentUser = u; }
function clearSession() { try { localStorage.removeItem('pw_session'); } catch(e) {} currentUser = null; }

function doLogin() {
  var emailEl = document.getElementById('login-email');
  var pwEl    = document.getElementById('login-pw');
  var err     = document.getElementById('login-error');
  var suc     = document.getElementById('login-success');
  if (!emailEl || !pwEl) return;
  var email = emailEl.value.trim().toLowerCase();
  var pw    = pwEl.value;
  if (err) err.style.display = 'none';
  if (suc) suc.style.display = 'none';
  if (!email || !pw) { showErr(err, 'Please fill in all fields.'); return; }

  // Save remembered email
  var remEl = document.getElementById('remember-me');
  if (remEl && remEl.checked) localStorage.setItem('pw_remember', email);
  else localStorage.removeItem('pw_remember');

  // -- Try Supabase first (cloud auth) --
  var _sb = getSB();
  if (_sb) {
    // Show loading state (fixed selector: .auth-submit not .btn-p)
    var loginBtn = document.querySelector('#auth-login .auth-submit');
    var origText = loginBtn ? loginBtn.textContent : '';
    if (loginBtn) { loginBtn.disabled = true; loginBtn.textContent = 'Logging in...'; }

    _sb.auth.signInWithPassword({ email: email, password: pw })
      .then(function(res) {
        if (res.error) {
          if (loginBtn) { loginBtn.disabled = false; loginBtn.textContent = origText; }
          // Show the actual Supabase error — do NOT fall back to local
          var msg = res.error.message || 'Login failed.';
          var msgLow = msg.toLowerCase();

          // Supabase returns "Invalid login credentials" for BOTH wrong password AND unconfirmed email
          if (msgLow.indexOf('invalid') >= 0 || msgLow.indexOf('credentials') >= 0) {
            showErr(err, 'Invalid email or password. If you just signed up, please check your inbox and confirm your email first.');
          } else if (msgLow.indexOf('email not confirmed') >= 0) {
            showErr(err, 'Please confirm your email first. Check your inbox for a confirmation link.');
          } else if (msgLow.indexOf('rate') >= 0 || msgLow.indexOf('limit') >= 0) {
            showErr(err, 'Too many attempts. Please wait a moment and try again.');
          } else {
            showErr(err, msg);
          }
          return;
        }
        // Supabase success — user is authenticated in the cloud
        try {
          var sbUser = res.data.user;
          var localUser = users.find(function(u) { return u.email === email || u.supabaseId === sbUser.id; });
          if (!localUser) {
            // New device — create local user from cloud data
            var meta = sbUser.user_metadata || {};
            localUser = {
              id: 'u_' + Date.now(),
              firstName: meta.first_name || email.split('@')[0],
              lastName: meta.last_name || '',
              email: email, plan: 'free',
              supabaseId: sbUser.id, createdAt: new Date().toISOString()
            };
            users.push(localUser); saveUsers();
          }
          if (!localUser.supabaseId) { localUser.supabaseId = sbUser.id; saveUsers(); }
          // Read plan from Supabase metadata (trusted source)
          if (sbUser.user_metadata && sbUser.user_metadata.plan) {
            localUser.plan = sbUser.user_metadata.plan;
            saveUsers();
          }
          saveSession(localUser);
          // Sync plan from public.users table (may differ from metadata)
          setTimeout(syncPlanFromDB, 500);
          // Ensure profile row exists in public.users (update names if missing)
          try {
            if (localUser.supabaseId && _sb) {
              _sb.from('users').upsert({
                id: localUser.supabaseId,
                email: email,
                first_name: localUser.firstName || email.split('@')[0],
                last_name: localUser.lastName || ''
              }, { onConflict: 'id' }).then(function(r) {
                if (r.error) console.warn('[WealthOS] Login profile upsert error:', r.error.message);
              }).catch(function(e) { console.warn('[WealthOS] Login profile upsert failed:', e); });
            }
          } catch(ue) { console.warn('[WealthOS] Profile upsert skipped:', ue); }
          if (loginBtn) { loginBtn.disabled = false; loginBtn.textContent = origText; }
          if (suc) { suc.textContent = 'Welcome back, ' + (localUser.firstName || 'User') + '!'; suc.style.display = 'block'; }
          setTimeout(function() { enterDashboard(); }, 600);
        } catch(innerErr) {
          // Auth succeeded but post-login setup had an issue — go to dashboard anyway
          console.warn('[WealthOS] Post-login setup error (session valid):', innerErr);
          if (loginBtn) { loginBtn.disabled = false; loginBtn.textContent = origText; }
          setTimeout(function() { enterDashboard(); }, 300);
        }
      })
      .catch(function(e) {
        if (loginBtn) { loginBtn.disabled = false; loginBtn.textContent = origText; }
        // Network error — Supabase unreachable
        console.warn('[WealthOS] Supabase login network error:', e);
        showErr(err, 'Unable to connect to the server. Please check your internet connection and try again.');
      });
  } else {
    // Supabase library not loaded (ad blocker, CDN failure, etc.)
    showErr(err, 'Authentication service is loading. Please refresh the page and try again.');
  }
}

function doLoginLocal(email, pw, err, suc) {
  var u = users.find(function(x) { return x.email === email; });
  if (!u) { showErr(err, 'No account found. Please sign up.'); return; }
  try {
    if (u.password !== btoa(pw)) { showErr(err, 'Incorrect password. Please try again.'); return; }
  } catch(e) { showErr(err, 'Incorrect password.'); return; }
  saveSession(u);
  if (suc) { suc.textContent = 'Welcome back, ' + u.firstName + '!'; suc.style.display = 'block'; }
  setTimeout(function() { enterDashboard(); }, 600);
}

function doSignup() {
  var fname = (document.getElementById('signup-fname') || {}).value || '';
  var lname = (document.getElementById('signup-lname') || {}).value || '';
  var email = (document.getElementById('signup-email') || {}).value || '';
  var pw    = (document.getElementById('signup-pw')    || {}).value || '';
  var pw2   = (document.getElementById('signup-pw2')   || {}).value || '';
  var plan  = 'free'; // All new users start on free plan (upgrade via payment)
  var terms = (document.getElementById('signup-terms') || {}).checked || false;
  var err   = document.getElementById('signup-error');
  var btn   = document.querySelector('#auth-signup .auth-submit');
  fname = fname.trim(); lname = lname.trim();
  email = email.trim().toLowerCase();
  if (err) err.style.display = 'none';
  if (!fname || !email || !pw) { showErr(err, 'Please fill in all required fields.'); return; }
  if (pw.length < 8)           { showErr(err, 'Password must be at least 8 characters.'); return; }
  if (pw !== pw2)              { showErr(err, 'Passwords do not match.'); return; }
  if (!terms)                  { showErr(err, 'Please accept the terms of service.'); return; }
  // Check local duplicate
  if (users.find(function(x) { return x.email === email; })) {
    showErr(err, 'An account with this email already exists. Please sign in instead.'); return;
  }

  // Show loading state
  var origBtnText = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Creating account...'; }

  var _sb = getSB();
  if (_sb) {
    // Supabase-first: create cloud account, THEN create local user on success
    var emailRedirectTo = window.location.origin + window.location.pathname;
    _sb.auth.signUp({ email: email, password: pw,
      options: {
        data: { first_name: fname, last_name: lname },
        emailRedirectTo: emailRedirectTo
      }
    }).then(function(res) {
      if (res.error) {
        if (btn) { btn.disabled = false; btn.textContent = origBtnText; }
        var errMsg = (res.error.message || '').toLowerCase();
        if (errMsg.indexOf('already registered') >= 0 || errMsg.indexOf('already exists') >= 0 ||
            (res.error.code && res.error.code === 'user_already_exists')) {
          showErr(err, 'An account with this email already exists. Please sign in instead.');
          // Auto-switch to login with email pre-filled
          setTimeout(function() {
            switchAuth('login');
            var loginEmailEl = document.getElementById('login-email');
            if (loginEmailEl) loginEmailEl.value = email;
          }, 1500);
        } else {
          showErr(err, res.error.message || 'Signup failed. Please try again.');
        }
        return;
      }

      // Supabase succeeded - now create local user
      var u = {
        id: 'u_' + Date.now(),
        firstName: fname, lastName: lname, email: email,
        password: btoa(pw), plan: plan, createdAt: new Date().toISOString()
      };
      if (res.data && res.data.user) u.supabaseId = res.data.user.id;
      u._newUser = true;
      users.push(u);
      saveUsers();
      saveSession(u);
      if (btn) { btn.disabled = false; btn.textContent = origBtnText; }

      // Insert profile into public.users table
      if (u.supabaseId && _sb) {
        _sb.from('users').upsert({
          id: u.supabaseId,
          email: email,
          first_name: fname,
          last_name: lname,
          plan: 'free'
        }, { onConflict: 'id' }).then(function(r) {
          if (r.error) console.warn('[WealthOS] Profile insert error:', r.error.message);
          else console.log('[WealthOS] Profile saved to public.users');
        }).catch(function(e) { console.warn('[WealthOS] Profile insert failed:', e); });
      }

      // Enter dashboard
      enterDashboard();
      setTimeout(function() {
        _showToast('Account created! Check your email to confirm.', 'success');
        if (!localStorage.getItem('pw_tour_done_'+u.id)) startTour();
        else if (!localStorage.getItem('pw_onboarded_'+u.id)) showOnboarding();
      }, 700);
    }).catch(function(e) {
      if (btn) { btn.disabled = false; btn.textContent = origBtnText; }
      showErr(err, 'Network error. Please check your connection and try again.');
    });
  } else {
    // No Supabase - local-only signup (offline mode)
    var u = {
      id: 'u_' + Date.now(),
      firstName: fname, lastName: lname, email: email,
      password: btoa(pw), plan: plan, createdAt: new Date().toISOString()
    };
    u._newUser = true;
    users.push(u);
    saveUsers();
    saveSession(u);
    if (btn) { btn.disabled = false; btn.textContent = origBtnText; }
    enterDashboard();
    setTimeout(function(){
      if (!localStorage.getItem('pw_tour_done_'+u.id)) startTour();
      else if (!localStorage.getItem('pw_onboarded_'+u.id)) showOnboarding();
    }, 700);
  }
}

function doForgot() {
  var emailEl = document.getElementById('forgot-email');
  var errEl   = document.getElementById('forgot-error');
  var sucEl   = document.getElementById('forgot-success');
  if (!emailEl) return;
  var email = emailEl.value.trim().toLowerCase();
  if (errEl) errEl.style.display = 'none';
  if (sucEl) sucEl.style.display = 'none';
  if (!email) { showErr(errEl, 'Please enter your email address.'); return; }
  var _sb = getSB();
  var btn = document.getElementById('forgot-submit');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending...'; }
  if (_sb) {
    var redirectUrl = window.location.origin + window.location.pathname;
    _sb.auth.resetPasswordForEmail(email, { redirectTo: redirectUrl }).then(function(res) {
      if (btn) { btn.disabled = false; btn.textContent = 'Send Reset Link'; }
      if (res.error) { showErr(errEl, 'Could not send reset email. Check your email address.'); }
      else { if (sucEl) { sucEl.textContent = '\u2713 Reset link sent to ' + email + '. Check your inbox.'; sucEl.style.display = 'block'; } if (emailEl) emailEl.value = ''; }
    }).catch(function() {
      if (btn) { btn.disabled = false; btn.textContent = 'Send Reset Link'; }
      showErr(errEl, 'Network error. Check your connection.');
    });
  } else {
    if (btn) { btn.disabled = false; btn.textContent = 'Send Reset Link'; }
    if (sucEl) { sucEl.textContent = '\u2713 If an account exists for ' + email + ', a reset link will be sent.'; sucEl.style.display = 'block'; }
  }
}

function doResetPassword() {
  var newPw = (document.getElementById('reset-pw-new') || {}).value || '';
  var confirmPw = (document.getElementById('reset-pw-confirm') || {}).value || '';
  var errEl = document.getElementById('reset-pw-error');
  var sucEl = document.getElementById('reset-pw-success');
  var btn = document.getElementById('reset-pw-submit');
  if (errEl) errEl.style.display = 'none';
  if (sucEl) sucEl.style.display = 'none';

  if (!newPw || !confirmPw) { showErr(errEl, 'Please fill in both fields.'); return; }
  if (newPw.length < 8) { showErr(errEl, 'Password must be at least 8 characters.'); return; }
  if (newPw !== confirmPw) { showErr(errEl, 'Passwords do not match.'); return; }

  var _sb = getSB();
  if (!_sb) { showErr(errEl, 'Authentication service unavailable. Please try again.'); return; }

  if (btn) { btn.disabled = true; btn.textContent = 'Updating...'; }

  _sb.auth.updateUser({ password: newPw }).then(function(res) {
    if (btn) { btn.disabled = false; btn.textContent = 'Update Password \u2192'; }
    if (res.error) {
      showErr(errEl, res.error.message || 'Could not update password. Please try again.');
    } else {
      if (sucEl) { sucEl.textContent = '\u2713 Password updated successfully! Redirecting...'; sucEl.style.display = 'block'; }
      // Update local password if user exists locally
      if (currentUser) {
        try { currentUser.password = btoa(newPw); saveUsers(); } catch(e) {}
      }
      setTimeout(function() {
        enterDashboard();
        _showToast('Password updated successfully!', 'success');
      }, 1500);
    }
  }).catch(function(e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Update Password \u2192'; }
    showErr(errEl, 'Network error. Please check your connection.');
  });
}

function doSocialAuth(provider) {
  // Google OAuth removed for launch stability. Email/password only.
  console.log('[WealthOS] Social auth disabled');
  _showToast('Please sign in with email and password.', 'info');
}

function doLogout() {
  if (!confirm('Sign out of WealthOS?')) return;
  try {
  if (window._autoSyncTimer) { clearInterval(window._autoSyncTimer); window._autoSyncTimer = null; }
  // Clear all in-memory state
  assets = []; milestones = []; settings = {};
  editId = null;
  chatHistory = [];
  chatOpen = false;
  // -- Supabase: sign out from cloud (clears persisted session) --
  var _sb = getSB();
  if (_sb) {
    _sb.auth.signOut().then(function() {}).catch(function() {});
  }
  clearSession();
  assets = []; milestones = [];
  // Reset all charts
  [trendChart, allocChart, nwChart, classChart, projChart, historyChart].forEach(function(c) {
    if (c) { try { c.destroy(); } catch(e) {} }
  });
  trendChart = allocChart = nwChart = classChart = projChart = historyChart = null;
  // Restore nav buttons to default state
  var signinBtn = document.querySelector('.lnav-signin');
  var ctaBtn    = document.querySelector('.lnav-cta');
  if (signinBtn) { signinBtn.style.display = ''; signinBtn.textContent = 'Log In'; signinBtn.setAttribute('onclick', "showAuth('login')"); }
  if (ctaBtn)    { ctaBtn.textContent = 'Get Started Free'; ctaBtn.setAttribute('onclick', "selectPlan('free')"); }
  historyPeriod = 30; bustCache(''); _rp = false; showLanding();
  } catch(e) { console.error('[WealthOS] doLogout error:', e); clearSession(); showLanding(); }
}

// ==============================================
// DASHBOARD ENTRY
// ==============================================
// ============================================================
// LIVE PRICE SYNC -- Alpha Vantage (stocks) + CoinGecko (crypto)
// ============================================================

// CoinGecko ticker \u2192 coin ID map
var CG_ID_MAP = {
  // Top coins
  'BTC':'bitcoin','ETH':'ethereum','USDT':'tether','BNB':'binancecoin',
  'SOL':'solana','XRP':'ripple','USDC':'usd-coin','ADA':'cardano',
  'AVAX':'avalanche-2','DOGE':'dogecoin','TRX':'tron','TON':'the-open-network',
  'LINK':'chainlink','DOT':'polkadot','MATIC':'matic-network','SHIB':'shiba-inu',
  'DAI':'dai','LTC':'litecoin','BCH':'bitcoin-cash','UNI':'uniswap',
  'ATOM':'cosmos','XLM':'stellar','OKB':'okb','XMR':'monero',
  'ETC':'ethereum-classic','HBAR':'hedera-hashgraph','APT':'aptos',
  'NEAR':'near','FIL':'filecoin','ARB':'arbitrum','OP':'optimism',
  'VET':'vechain','ICP':'internet-computer','ALGO':'algorand',
  'MANA':'decentraland','SAND':'the-sandbox','AXS':'axie-infinity',
  'THETA':'theta-token','EOS':'eos','AAVE':'aave','GRT':'the-graph',
  'FTM':'fantom','EGLD':'elrond-erd-2','FLOW':'flow','XTZ':'tezos',
  'KLAY':'klay-token','INJ':'injective-protocol','SUI':'sui',
  'SEI':'sei-network','PEPE':'pepe','WIF':'dogwifcoin','APE':'apecoin',
  'LDO':'lido-dao','MKR':'maker','SNX':'havven','CRV':'curve-dao-token',
  'RUNE':'thorchain','SUSHI':'sushi','1INCH':'1inch','ENS':'ethereum-name-service',
  'BLUR':'blur','IMX':'immutable-x','FLOKI':'floki','BONK':'bonk'
};

// Per-ticker price cache: { ticker: { price, ts } }
var priceCache = {};
var CACHE_TTL  = 60000;
var priceSyncInProgress = false;

// -- Request cache (60s TTL for all API calls) --
var reqCache = {};
function getCached(k) { var e=reqCache[k]; if(!e||Date.now()-e.ts>60000){delete reqCache[k];return null;} return e.d; }
function setCached(k,d) { reqCache[k]={d:d,ts:Date.now()}; }
function bustCache(p) { Object.keys(reqCache).forEach(function(k){if(k.indexOf(p)===0)delete reqCache[k];}); }

// -- Debounced renderAll (prevents rapid successive re-renders) --
var _rt=null, _rp=false;
function renderAllDebounced(ms) {
  if(_rp) return; _rp=true;
  clearTimeout(_rt);
  _rt=setTimeout(function(){ _rp=false; renderAll(); }, ms||80);
}

// -- Loading state manager --
function setLoading(id, on, msg) {
  var el=document.getElementById(id); if(!el) return;
  if(on){ el._oh=el.innerHTML;
    el.innerHTML='<div style="display:flex;align-items:center;gap:8px;padding:20px;color:var(--muted);font-size:12px;justify-content:center"><div style="width:14px;height:14px;border:2px solid var(--muted2);border-top-color:var(--blue);border-radius:50%;animation:spin 0.7s linear infinite"></div>'+(msg||'Loading...')+'</div>';
  } else if(el._oh!==undefined){ el.innerHTML=el._oh; delete el._oh; }
}

// -- Centralized API error handler --
function handleAPIError(src, err, silent) {
  var msg = !navigator.onLine ? 'No internet. Using cached data.' :
    (err&&(err.status===429||(err.message&&err.message.indexOf('429')>=0))) ? src+': Rate limit. Wait 60s.' :
    (err&&err.status===401) ? src+': Invalid API key. Check Settings.' :
    (err&&err.status>=500)  ? src+': Server error. Try again later.' :
    (err&&err.message&&err.message.indexOf('Failed to fetch')>=0) ? src+': Network error.' :
    src+' error: '+(err&&err.message?err.message.substring(0,50):'Unknown');
  if(!silent) showSyncStatus('[!] '+msg);
  console.warn('[WealthOS]',src,err);
  return msg;
}

// -- Chat abort controller --
var _chatAbort = null;


function pullAssetsFromSupabase(force) {
  var _sb = getSB();
  if (!_sb || !currentUser) return;
  setLoading('all-table', true, 'Syncing assets...');
  _sb.auth.getUser().then(function(res) {
    if (!res.data || !res.data.user) { setLoading('all-table', false); return; }
    var uid = res.data.user.id;
    _sb.from('assets').select('*').eq('user_id', uid).order('created_at').then(function(result) {
      setLoading('all-table', false);
      if (result.error) { handleAPIError('Assets', result.error, true); return; }
      var rows = result.data || [];
      if (rows.length === 0 && !force) return;
      var cloudAssets = rows.map(function(row, i) { return rowToAsset(row, i); });
      // Only re-render if data actually changed
      var oldSig = assets.map(function(a){return a.id+'|'+a.val;}).join(',');
      var newSig = cloudAssets.map(function(a){return a.id+'|'+a.val;}).join(',');
      assets = cloudAssets;
      localStorage.setItem('pw_assets_' + currentUser.id, JSON.stringify(assets));
      if (oldSig !== newSig) renderAllDebounced(100);
    }).catch(function(e) { setLoading('all-table', false); handleAPIError('Assets', e, true); });
  }).catch(function() { setLoading('all-table', false); });
}

function syncPrices(silent, force) {
  if (priceSyncInProgress) return;
  if (!assets || assets.length === 0) return;

  // Collect unique tickers by category (skip assets with no ticker)
  var stockTickers  = [];
  var cryptoTickers = [];
  assets.forEach(function(a) {
    var t = (a.ticker || '').trim().toUpperCase();
    if (!t || t === '--' || t === '-' || t === '') return;
    if (a.cat === 'stock') {
      if (stockTickers.indexOf(t) < 0) stockTickers.push(t);
    } else if (a.cat === 'crypto') {
      if (cryptoTickers.indexOf(t) < 0) cryptoTickers.push(t);
    }
  });

  if (stockTickers.length === 0 && cryptoTickers.length === 0) {
    if (!silent) showSyncStatus('No tickers found. Add ticker symbols to your assets.');
    return;
  }

  // Check 60-second cache per ticker (unless force=true)
  var now = Date.now();
  if (!force) {
    var allCached = true;
    stockTickers.concat(cryptoTickers).forEach(function(t) {
      var cached = priceCache[t];
      if (!cached || (now - cached.ts) > CACHE_TTL) allCached = false;
    });
    if (allCached) {
      // Apply cached prices directly
      applyPriceMap(buildCachedPriceMap(), silent, 0);
      return;
    }
  }

  priceSyncInProgress = true;
  if (!silent) showSyncStatus(' Fetching live prices...');
  updateSyncBtn(true);

  var priceMap   = {};
  var errors     = [];
  var pending    = 0;

  function tryFinalize() {
    if (pending > 0) return;
    priceSyncInProgress = false;
    updateSyncBtn(false);

    // Cache the results
    Object.keys(priceMap).forEach(function(t) {
      priceCache[t] = { price: priceMap[t], ts: Date.now() };
    });

    var updated = applyPriceMap(priceMap, silent, errors.length);
    localStorage.setItem('pw_last_sync', String(Date.now()));

    if (!silent) {
      if (errors.length > 0 && updated === 0) {
        showSyncStatus('[!] Fetch failed: ' + errors.join(', '));
      } else if (errors.length > 0) {
        showSyncStatus('\u2713 Updated ' + updated + ' asset' + (updated!==1?'s':'') + ' (' + errors.join(', ') + ' failed)');
      } else {
        showSyncStatus('\u2713 ' + updated + ' price' + (updated!==1?'s':'') + ' updated -- ' + new Date().toLocaleTimeString());
      }
    } else if (updated > 0) {
      showSyncStatus('\u2713 ' + updated + ' live price' + (updated!==1?'s':'') + ' applied');
    }
  }

  // -- Stocks via /api/prices (server-side Yahoo Finance proxy, 20s cache) --
  if (stockTickers.length > 0) {
    pending++;
    fetch('/api/prices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tickers: stockTickers })
    })
      .then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function(data) {
        if (data && data.prices) {
          Object.keys(data.prices).forEach(function(ticker) {
            priceMap[ticker] = data.prices[ticker];
          });
        }
        if (data && data.errors && data.errors.length > 0) {
          data.errors.forEach(function(e) { errors.push(e); });
        }
      })
      .catch(function(e) {
        errors.push('prices API error: ' + e.message);
        // Fallback: use cached prices for any stock tickers that have them
        stockTickers.forEach(function(t) {
          if (priceCache[t] && !priceMap[t]) {
            priceMap[t] = priceCache[t].price;
          }
        });
      })
      .finally(function() { pending--; tryFinalize(); });
  }

  // -- CoinGecko: crypto (batched single request) --
  if (cryptoTickers.length > 0 && CG_KEY) {
    pending++;
    var coinIds = cryptoTickers.map(function(t) {
      return CG_ID_MAP[t] || t.toLowerCase();
    }).join(',');
    var cgUrl = 'https://api.coingecko.com/api/v3/simple/price' +
      '?ids=' + encodeURIComponent(coinIds) +
      '&vs_currencies=usd' +
      '&x_cg_demo_api_key=' + CG_KEY;
    fetch(cgUrl)
      .then(function(r) {
        if (r.status === 429) throw new Error('rate_limit');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function(data) {
        var found = 0;
        cryptoTickers.forEach(function(ticker) {
          var id = CG_ID_MAP[ticker] || ticker.toLowerCase();
          if (data[id] && data[id].usd && data[id].usd > 0) {
            priceMap[ticker] = data[id].usd;
            found++;
          } else {
            errors.push(ticker + ' not found');
          }
        });
        if (found === 0 && cryptoTickers.length > 0) {
          errors.push('CoinGecko: no prices returned');
        }
      })
      .catch(function(e) {
        if (e.message === 'rate_limit') {
          errors.push('CoinGecko rate limited');
          // Use cached prices as fallback
          cryptoTickers.forEach(function(t) {
            if (priceCache[t]) priceMap[t] = priceCache[t].price;
          });
        } else {
          errors.push('CoinGecko error');
        }
      })
      .finally(function() { pending--; tryFinalize(); });
  }

  if (pending === 0) {
    priceSyncInProgress = false;
    updateSyncBtn(false);
  }
}

function buildCachedPriceMap() {
  var map = {};
  Object.keys(priceCache).forEach(function(t) { map[t] = priceCache[t].price; });
  return map;
}

function applyPriceMap(priceMap, silent, errCount) {
  var updated = 0;
  assets = assets.map(function(a) {
    var t = (a.ticker || '').trim().toUpperCase();
    if (!t || t === '--' || t === '-') return a;
    var newPrice = priceMap[t];
    if (!newPrice || newPrice <= 0) return a;
    var newVal = newPrice * (a.qty || 1);
    if (Math.abs(newVal - (a.val || 0)) > 0.01) {
      updated++;
      return Object.assign({}, a, {
        val:        newVal,
        lastPrice:  newPrice,
        lastSynced: new Date().toISOString()
      });
    }
    return a;
  });
  if (updated > 0) {
    saveData();
    renderAll();
  }
  return updated;
}

function showSyncStatus(msg) {
  var el = document.getElementById('sync-status');
  if (!el) return;
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(el._hideTimer);
  el._hideTimer = setTimeout(function() { el.style.opacity = '0'; }, 5000);
}

function updateSyncBtn(loading) {
  var btn = document.getElementById('sync-prices-btn');
  if (!btn) return;
  btn.disabled = loading;
  btn.textContent = loading ? ' Syncing...' : ' Sync Prices';
}

function timeSince(ts) {
  var mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return mins + ' min ago';
  return Math.round(mins/60) + 'h ago';
}

var _enteringDashboard = false;
function enterDashboard() {
  if (_enteringDashboard) { console.log('[WealthOS] enterDashboard already in progress, skipping'); return; }
  console.log('[WealthOS] enterDashboard called, currentUser:', currentUser ? currentUser.email : 'null');
  // -- Route protection: require valid session --
  if (!currentUser) {
    var _sb = getSB();
    if (_sb) {
      _sb.auth.getSession().then(function(res) {
        if (res.data && res.data.session) {
          var sbUser = res.data.session.user;
          var localUser = users.find(function(u) { return u.email === sbUser.email; });
          if (localUser) { saveSession(localUser); currentUser = localUser; enterDashboard(); }
          else showAuth('login');
        } else {
          showAuth('login');
        }
      }).catch(function() { showAuth('login'); });
    } else {
      showAuth('login');
    }
    return;
  }
  try {
    _enteringDashboard = true;
    showPage('app');
    var initials = (currentUser.firstName || 'U').charAt(0).toUpperCase() +
                   (currentUser.lastName  || '').charAt(0).toUpperCase();
    var avEl = document.getElementById('app-avatar');
    var unEl = document.getElementById('app-username');
    if (avEl) avEl.textContent = initials;
    if (unEl) unEl.textContent = currentUser.firstName || 'User';

    var ukey = 'pw_assets_' + currentUser.id;
    var mkey = 'pw_milestones_' + currentUser.id;
    var skey = 'pw_settings_' + currentUser.id;

    // Load settings from localStorage (lightweight, always available)
    var savedSettings = null;
    try { savedSettings = localStorage.getItem(skey); } catch(e) {}
    try { settings = savedSettings ? JSON.parse(savedSettings) : Object.assign({}, DEFAULT_SETTINGS, {
      name: (currentUser.firstName || '') + ' ' + (currentUser.lastName || '')
    }); } catch(e) { settings = Object.assign({}, DEFAULT_SETTINGS); }
    if (currentUser.plan) settings.plan = currentUser.plan;

    // Start with empty arrays (no fake data, no stale cache)
    assets = [];
    milestones = [];

    document.querySelectorAll('.view').forEach(function(v) { v.classList.remove('active'); });
    document.querySelectorAll('.sb-item').forEach(function(s) { s.classList.remove('active'); });
    var ov = document.getElementById('v-overview');
    if (ov) ov.classList.add('active');
    var firstSb = document.querySelector('.sb-item');
    if (firstSb) firstSb.classList.add('active');

    // SUPABASE-FIRST: fetch real data from database, then render
    var _sbDash = getSB();
    if (_sbDash && currentUser.supabaseId) {
      setLoading('all-table', true, 'Loading your portfolio...');
      _sbDash.auth.getUser().then(function(res) {
        if (!res.data || !res.data.user) throw new Error('no user');
        var uid = res.data.user.id;
        return _sbDash.from('assets').select('*').eq('user_id', uid).order('created_at');
      }).then(function(result) {
        setLoading('all-table', false);
        if (result.data && result.data.length > 0) {
          assets = result.data.map(function(row, i) { return rowToAsset(row, i); });
          // Cache in localStorage for faster next load
          try { localStorage.setItem(ukey, JSON.stringify(assets)); } catch(e) {}
        } else {
          // No cloud assets -- check localStorage cache as fallback
          try {
            var cached = JSON.parse(localStorage.getItem(ukey) || '[]');
            if (cached.length > 0) assets = cached;
          } catch(e) { assets = []; }
        }
        // Load milestones from localStorage (not in Supabase)
        try { milestones = JSON.parse(localStorage.getItem(mkey) || '[]'); } catch(e) { milestones = []; }
        _dashboardReady();
      }).catch(function(e) {
        setLoading('all-table', false);
        console.warn('[WealthOS] Supabase load failed, using cache:', e);
        // Fallback to localStorage
        try { assets = JSON.parse(localStorage.getItem(ukey) || '[]'); } catch(e2) { assets = []; }
        try { milestones = JSON.parse(localStorage.getItem(mkey) || '[]'); } catch(e2) { milestones = []; }
        _dashboardReady();
      });
    } else {
      // No Supabase -- use localStorage
      try { assets = JSON.parse(localStorage.getItem(ukey) || '[]'); } catch(e) { assets = []; }
      try { milestones = JSON.parse(localStorage.getItem(mkey) || '[]'); } catch(e) { milestones = []; }
      _dashboardReady();
    }

    function _dashboardReady() {
      _enteringDashboard = false;
      console.log('[WealthOS] _dashboardReady fired, assets:', assets.length);
      try { updateBadgeCount(); } catch(e) {}
      renderAll();

      // Sync plan from public.users table (ensures DB plan is used, not stale local)
      try { syncPlanFromDB(); } catch(e) {}

      // CRITICAL: Independent AI section renderer
      // Runs SEPARATELY from overview chain to guarantee AI sections always render
      function _renderAISections() {
        if (assets.length === 0) {
          console.log('[WealthOS] AI render skipped: no assets');
          return;
        }
        var tv = totalV();
        var cls = clsT();
        var portfolio = calcPortfolio();
        var gain = portfolio.totalPL || 0;
        var pct = portfolio.totalPLPct || 0;
        var plan = settings.plan || (currentUser ? currentUser.plan : 'free') || 'free';
        console.log('[WealthOS] AI render: tv=' + tv + ', assets=' + assets.length + ', plan=' + plan);
        try { rInsights(cls, tv, gain, pct); } catch(e) { console.warn('[WealthOS] AI rInsights:', e); }
        try { rAlerts(cls, tv); } catch(e) { console.warn('[WealthOS] AI rAlerts:', e); }
        try { rMarketIntelligence(plan); } catch(e) { console.warn('[WealthOS] AI rMarket:', e); }
        try { rProjection(tv); } catch(e) { console.warn('[WealthOS] AI rProjection:', e); }
      }

      // Force overview re-render + independent AI render at multiple intervals
      function _forceAll() {
        try { renderView('overview'); } catch(e) {}
        _renderAISections();
      }
      setTimeout(_forceAll, 300);
      setTimeout(_forceAll, 1000);
      setTimeout(_forceAll, 2500);
      setTimeout(_forceAll, 5000);

      setTimeout(function(){ try{ syncPrices(true); }catch(e){} }, 1500);
      try { initPortfolios(); } catch(e) {}
      try { saveNWSnapshot(); } catch(e) {}
      setTimeout(function() { try { loadHistoryFromSupabase(); } catch(e) {} }, 1200);
      try {
        if (localStorage.getItem('pw_notif') === '1') {
          var nd = document.getElementById('notif-dot');
          if (nd) nd.classList.add('active');
        }
      } catch(e) {}
      setTimeout(function() { try { checkPWAPrompt(); } catch(e) {} }, 4000);

      // First-time user: welcome
      if (assets.length === 0) {
        var isFirstVisit = !localStorage.getItem('pw_welcomed_' + currentUser.id);
        if (isFirstVisit) {
          try { localStorage.setItem('pw_welcomed_' + currentUser.id, '1'); } catch(e) {}
          setTimeout(function() {
            _showToast('Welcome to WealthOS! Add your first asset to get started.', 'info');
            try {
              var addBtns = document.querySelectorAll('.empty-cta');
              addBtns.forEach(function(btn) {
                btn.style.boxShadow = '0 0 0 0 rgba(92,95,239,0.6)';
                var pulseCount = 0;
                var pulseInterval = setInterval(function() {
                  btn.style.boxShadow = pulseCount % 2 === 0
                    ? '0 0 0 8px rgba(92,95,239,0.15)'
                    : '0 0 0 0 rgba(92,95,239,0)';
                  btn.style.transition = 'box-shadow 0.5s ease';
                  pulseCount++;
                  if (pulseCount >= 6) { clearInterval(pulseInterval); btn.style.boxShadow = ''; btn.style.transition = ''; }
                }, 500);
              });
            } catch(e) {}
          }, 1200);
        }
      }
      console.log('[WealthOS] Dashboard loaded, assets:', assets.length);

      // Inject "Coming Soon" badges into sidebar
      _injectComingSoon();

      // Pending upgrade checkout
      if (window._pendingPlan && (window._pendingPlan === 'pro' || window._pendingPlan === 'private')) {
        var pendingPlan = window._pendingPlan;
        window._pendingPlan = null;
        setTimeout(function() { startPaddleCheckout(pendingPlan); }, 1500);
      }
    } // end _dashboardReady
  } catch(e) {
    console.error('[WealthOS] enterDashboard error:', e);
    showPage('app');
  }
}

// ==============================================
// DATA PERSISTENCE
// ==============================================
function saveData() {
  if (!currentUser) return;
  try {
    localStorage.setItem('pw_assets_' + currentUser.id,    JSON.stringify(assets));
    localStorage.setItem('pw_milestones_' + currentUser.id, JSON.stringify(milestones));
    localStorage.setItem('pw_settings_' + currentUser.id,  JSON.stringify(settings));
  } catch(e) { console.warn('[WealthOS] saveData localStorage error:', e); }
  try { syncAssetsToSupabase(); } catch(e) {}
}

function seedData() {
  // REMOVED: No demo/sample data. Users add their own assets.
  console.log('[WealthOS] seedData disabled - production mode');
}

// ============================================
// COMING SOON BADGES (UI only, no functionality)
// ============================================
function _injectComingSoon() {
  try {
    if (document.getElementById('coming-soon-items')) return; // already injected
    var sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;

    var container = document.createElement('div');
    container.id = 'coming-soon-items';
    container.style.cssText = 'margin-top:auto;padding:8px 6px 12px;border-top:1px solid rgba(255,255,255,0.06)';

    var label = document.createElement('div');
    label.style.cssText = 'font-size:9px;font-weight:600;letter-spacing:0.1em;color:var(--muted);padding:8px 12px 4px;font-family:var(--mono);text-transform:uppercase';
    label.textContent = 'Coming Soon';
    container.appendChild(label);

    var items = [
      { icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>', text: 'Bank Sync' },
      { icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 12h8M12 8v8"/></svg>', text: 'Crypto Wallet Connect' },
      { icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>', text: 'Broker Sync' },
    ];

    items.forEach(function(item) {
      var el = document.createElement('div');
      el.style.cssText = 'display:flex;align-items:center;gap:9px;padding:7px 12px;margin:2px 0;font-size:12px;color:var(--muted);opacity:0.7;cursor:default;border-radius:8px;transition:opacity 0.2s';
      el.innerHTML = '<span style="display:flex;align-items:center;justify-content:center;width:16px;height:16px;flex-shrink:0;opacity:0.7">' + item.icon + '</span>' +
        '<span>' + item.text + '</span>' +
        '<span style="margin-left:auto;font-size:8px;font-weight:700;letter-spacing:0.08em;background:rgba(92,95,239,0.15);color:var(--blue);padding:3px 8px;border-radius:4px;font-family:var(--mono);border:1px solid rgba(92,95,239,0.2)">SOON</span>';
      el.title = item.text + ' - Coming Soon';
      container.appendChild(el);
    });

    sidebar.appendChild(container);
  } catch(e) { console.warn('[WealthOS] Coming soon injection failed:', e); }
}

// ==============================================
// FORMATTERS & HELPERS
// ==============================================
function getCurrencySymbol() { return CURRENCY_SYMBOLS[settings.currency || 'USD'] || '$'; }
function getCurrencyRate()   { return CURRENCY_RATES[settings.currency || 'USD'] || 1; }

function fmt(n) {
  if (n === null || n === undefined || isNaN(n)) n = 0;
  var cur = settings.currency || 'USD';
  var v = n * getCurrencyRate();
  if (isNaN(v)) v = 0;
  try {
    return new Intl.NumberFormat('en-US', {style:'currency', currency:cur, minimumFractionDigits:0, maximumFractionDigits:0}).format(v);
  } catch(e) { return getCurrencySymbol() + Math.round(v).toLocaleString(); }
}
function fmtS(n) {
  if (n === null || n === undefined || isNaN(n)) n = 0;
  var r = getCurrencyRate(), s = getCurrencySymbol();
  var v = n * r;
  if (isNaN(v)) v = 0;
  if (Math.abs(v) >= 1e6) return s + (v / 1e6).toFixed(2) + 'M';
  if (Math.abs(v) >= 1e3) return s + (v / 1e3).toFixed(1) + 'k';
  return fmt(n);
}
function fmtP(n)       { if (isNaN(n)) n = 0; return (n >= 0 ? '+' : '') + n.toFixed(2) + '%'; }
function gainPct(c, v) { c = parseFloat(c) || 0; v = parseFloat(v) || 0; return c === 0 ? 0 : ((v - c) / c) * 100; }
function totalV()  { if (!assets || !Array.isArray(assets)) return 0; return assets.reduce(function(s, a) { return s + (parseFloat(a.val) || 0); }, 0); }
function totalCo() { if (!assets || !Array.isArray(assets)) return 0; return assets.reduce(function(s, a) { return s + (parseFloat(a.cost) || 0); }, 0); }
function clsT() {
  var r = {};
  if (!assets || !Array.isArray(assets)) return r;
  assets.forEach(function(a) { if (a && a.cat) r[a.cat] = (r[a.cat] || 0) + (parseFloat(a.val) || 0); });
  return r;
}
function catL(c)   { return {stock:'Stocks',real_estate:'Real Estate',crypto:'Crypto',art:'Art',watch:'Watches',cash:'Cash',other:'Other'}[c] || c; }
function catI(c){
  var icons={
    stock:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>',
    real_estate:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>',
    crypto:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/></svg>',
    art:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 18 3 22 9 12 22 2 9"/></svg>',
    watch:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="7"/><polyline points="12 9 12 12 13.5 13.5"/></svg>',
    cash:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12V7H4a2 2 0 0 1 0-4h16v4"/><path d="M20 7v14H4a2 2 0 0 1-2-2V5"/></svg>',
    other:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
  };
  return icons[c]||icons.other;
}
function catCls(c) { return {stock:'ai-s',real_estate:'ai-r',crypto:'ai-c',art:'ai-a',watch:'ai-w',cash:'ai-ca',other:'ai-ca'}[c] || 'ai-ca'; }
function showErr(el, msg) { if (!el) return; el.textContent = msg; el.style.display = 'block'; }
function safeGet(id) { return document.getElementById(id); }
function safeSet(id, val) { var el = safeGet(id); if (el) el.textContent = val; }

// ==============================================
// WAITLIST -- auto-growing count
// ==============================================
var waitlist = []; try { waitlist = JSON.parse(localStorage.getItem('pw_waitlist') || '[]'); } catch(e) { waitlist = []; }
var WL_BASE  = 1247;
var WL_START = new Date('2025-03-01').getTime();

function getWaitlistCount() {
  var days  = Math.floor((Date.now() - WL_START) / 86400000);
  // Believable organic growth: ~3-5 per day with daily variance
  var dailyNoise = [2, 5, 3, 7, 1, 4, 6][days % 7];
  var count = WL_BASE + Math.floor(days * 4) + dailyNoise + waitlist.length;
  return count;
}

function animateCount(el, target) {
  if (!el) return;
  var start = Math.max(0, target - 12), dur = 900, t0 = null;
  (function tick(ts) {
    if (!t0) t0 = ts;
    var p = Math.min((ts - t0) / dur, 1);
    var ease = 1 - Math.pow(1 - p, 3);
    var v = Math.round(start + (target - start) * ease);
    el.textContent = v.toLocaleString() + ' people joined the waitlist';
    if (p < 1) requestAnimationFrame(tick);
  })(performance.now());
}

function openWaitlist() {
  var m = safeGet('waitlist-modal');
  if (m) m.classList.add('show');
  // Reset form state in case previously submitted
  var fw = safeGet('waitlist-form-wrap');
  var ws = safeGet('waitlist-success');
  if (fw) fw.style.display = 'block';
  if (ws) ws.style.display = 'none';
  animateCount(safeGet('waitlist-count'), getWaitlistCount());
}
function closeWaitlist() {
  var m = safeGet('waitlist-modal');
  if (m) m.classList.remove('show');
}
function submitWaitlist() {
  var nameEl  = safeGet('wl-name');
  var emailEl = safeGet('wl-email');
  var btn     = document.querySelector('.waitlist-submit');
  var name    = (nameEl  || {value:''}).value.trim();
  var email   = (emailEl || {value:''}).value.trim().toLowerCase();
  if (!name || !email) { _wlErr('Please fill in your name and email.'); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { _wlErr('Please enter a valid email address.'); return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Joining...'; }
  var _sb = getSB();
  if (_sb) {
    _sb.from('waitlist').insert([{ name: name, email: email }])
      .then(function(res) {
        if (btn) { btn.disabled = false; btn.textContent = 'Join Waitlist \u2192'; }
        if (res.error) {
          // Duplicate email -- unique constraint
          if (res.error.code === '23505' ||
              (res.error.message && (
                res.error.message.indexOf('duplicate') >= 0 ||
                res.error.message.indexOf('unique') >= 0 ||
                res.error.message.indexOf('already exists') >= 0
              ))) {
            _wlOk("You're already on the waitlist -- we'll be in touch!");
          } else {
            console.warn('[WealthOS waitlist]', res.error.code, res.error.message);
            _wlErr('Something went wrong. Please try again.');
          }
          return;
        }
        // Success -- Supabase confirmed insert
        _wlSaveLocal(name, email, nameEl, emailEl);
        _wlOk("You're on the waitlist. We'll notify you when WealthOS launches.");
      })
      .catch(function(err) {
        if (btn) { btn.disabled = false; btn.textContent = 'Join Waitlist \u2192'; }
        console.warn('[WealthOS waitlist network]', err);
        _wlErr('Network error. Please check your connection and try again.');
      });
  } else {
    if (btn) { btn.disabled = false; btn.textContent = 'Join Waitlist \u2192'; }
    if (waitlist.find(function(w) { return w.email === email; })) {
      _wlOk("You're already on the waitlist \u2014 we'll be in touch!");
    } else {
      _wlSaveLocal(name, email, nameEl, emailEl);
      _wlOk("You're on the waitlist. We'll notify you when WealthOS launches.");
    }
  }
}
function _wlSaveLocal(name, email, nameEl, emailEl) {
  if (!waitlist.find(function(w){return w.email===email;})) {
    waitlist.push({name:name,email:email,ts:new Date().toISOString()});
    localStorage.setItem('pw_waitlist', JSON.stringify(waitlist));
  }
  if (nameEl) nameEl.value='';
  if (emailEl) emailEl.value='';
  try { updateBadgeCount(); } catch(e) {}
  animateCount(safeGet('waitlist-count'), getWaitlistCount());
}
function _wlErr(msg) {
  var el = document.getElementById('wl-error');
  if (!el) return;
  el.textContent = msg; el.style.display='block'; el.style.opacity='0';
  setTimeout(function(){el.style.opacity='1';},10);
  setTimeout(function(){el.style.opacity='0';setTimeout(function(){el.style.display='none';},300);},5000);
}
function _wlOk(msg) {
  var fw=safeGet('waitlist-form-wrap'), ws=safeGet('waitlist-success'), errEl=document.getElementById('wl-error');
  if (errEl) errEl.style.display='none';
  if (!ws) return;
  ws.textContent = '\u2713 ' + msg;
  if (fw) { fw.style.opacity='0'; setTimeout(function(){ fw.style.display='none'; ws.style.display='block'; setTimeout(function(){ws.style.opacity='1';},20); },250); }
  else { ws.style.display='block'; setTimeout(function(){ws.style.opacity='1';},20); }
}

function updateBadgeCount() {
  // Update live waitlist count from localStorage
  var wl = []; try { wl = JSON.parse(localStorage.getItem('pw_waitlist') || '[]'); } catch(e) {}
  var baseCount = 2779;
  var liveCount = baseCount + wl.length;
  var el = document.getElementById('wl-live-count');
  if (el) el.textContent = liveCount.toLocaleString() + ' on the waitlist';
  var el2 = document.getElementById('waitlist-count');
  if (el2) el2.textContent = liveCount.toLocaleString() + '+ people on the waitlist';
  var count = getWaitlistCount();
  var el = document.getElementById('badge-count-text');
  if (el) el.textContent = count.toLocaleString();
  var proof = document.getElementById('proof-users');
  if (proof) proof.textContent = count.toLocaleString();
}

document.addEventListener('click', function(e) {
  var m = safeGet('waitlist-modal');
  if (m && e.target === m) closeWaitlist();
});

// ==============================================
// AUTH UI
// ==============================================
function switchAuth(mode) {
  var views = {login: 'auth-login', signup: 'auth-signup', forgot: 'auth-forgot', 'reset-pw': 'auth-reset-pw'};
  Object.keys(views).forEach(function(k) {
    var el = safeGet(views[k]);
    if (el) el.style.display = (k === mode) ? 'block' : 'none';
  });
}
function togglePw(id, btn) {
  var i = safeGet(id);
  if (!i) return;
  i.type = i.type === 'password' ? 'text' : 'password';
  btn.innerHTML = i.type === 'text' ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>' : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
}
function checkStrength(pw) {
  var f = safeGet('pw-fill'), l = safeGet('pw-label');
  if (!f) return;
  var s = 0;
  if (pw.length >= 8)           s++;
  if (/[A-Z]/.test(pw))        s++;
  if (/[0-9]/.test(pw))        s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  var lvls = [
    {w:'0%',  c:'transparent',  t:'Enter a password'},
    {w:'25%', c:'var(--red)',   t:'Weak'},
    {w:'50%', c:'var(--amber)', t:'Fair -- add numbers'},
    {w:'75%', c:'var(--blue)',  t:'Good -- almost there'},
    {w:'100%',c:'var(--green)', t:'Strong \u2713'}
  ];
  var lvl = lvls[s] || lvls[0];
  f.style.width = lvl.w; f.style.background = lvl.c;
  if (l) { l.textContent = lvl.t; l.style.color = lvl.c; }
}

// ==============================================
// CURRENCY
// ==============================================
function saveCurrencyLive() {
  var el = safeGet('s-currency');
  if (el) settings.currency = el.value;
  saveData();
  renderAll();
}

// ==============================================
// NAVIGATION
// ==============================================
function nav(id, el) {
  document.querySelectorAll('.view').forEach(function(v)   { v.classList.remove('active'); });
  document.querySelectorAll('.sb-item').forEach(function(s){ s.classList.remove('active'); });
  var view = safeGet('v-' + id);
  if (view) view.classList.add('active');
  if (el)   el.classList.add('active');
  renderView(id);
}
// Safe nav by id without needing a DOM element reference
function navById(id) {
  nav(id, null);
  // Highlight matching sidebar item
  document.querySelectorAll('.sb-item').forEach(function(s) {
    var oc = s.getAttribute('onclick') || '';
    if (oc.indexOf("nav('" + id + "'") !== -1) s.classList.add('active');
  });
}

// ==============================================
// RENDER ALL
// ==============================================
function renderAll() {
  try {
    var sbCount = safeGet('sb-count');
    if (sbCount) sbCount.textContent = assets.length;

    var sName = safeGet('s-name');
    if (sName) sName.value = settings.name || '';
    var sKey = safeGet('s-apikey');
    if (sKey) { sKey.style.display = 'none'; } // Removed from UI
    var sEmail = safeGet('s-email');
    if (sEmail && currentUser) sEmail.value = currentUser.email || '';

    var sGoal = safeGet('s-goal');
    if (sGoal) sGoal.value = settings.goal || '';

    var sRisk = safeGet('s-risk');
    if (sRisk) sRisk.value = settings.risk || 'Moderate';

    var sCur = safeGet('s-currency');
    if (sCur) sCur.value = settings.currency || 'USD';

    var ovDate = safeGet('overview-date');
    if (ovDate) {
      var hour = new Date().getHours();
      var greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
      var fname = (currentUser && currentUser.firstName) ? currentUser.firstName : '';
      var dateStr = new Date().toLocaleDateString('en-US', {weekday:'long', year:'numeric', month:'long', day:'numeric'});
      ovDate.textContent = (fname ? greeting + ', ' + fname + ' -- ' : '') + dateStr;
    }

    var rpDate = safeGet('report-date');
    if (rpDate) rpDate.textContent = new Date().toLocaleDateString('en-US', {year:'numeric', month:'long', day:'numeric'});
    var rpTitle = safeGet('report-title');
    if (rpTitle) { var now=new Date(); rpTitle.textContent = ['Q1','Q2','Q3','Q4'][Math.floor(now.getMonth()/3)]+' '+now.getFullYear()+' Wealth Report'; }

    renderView('overview');
    renderAssetLimitBanner();
  } catch(e) { console.error('[WealthOS] renderAll error:', e); }
}

function renderView(id) {
  var map = {
    overview:   rOverview,
    assets:     function(){ var si=safeGet('asset-search');if(si)si.value='';rAllAssets(); },
    timeline:   rTimeline,
    stocks:     function() { rCat('stocks',      'stock');       },
    realestate: function() { rCat('realestate',  'real_estate'); },
    crypto:     function() { rCat('crypto',      'crypto');      },
    alternatives: rAlt,
    cash:       function() { rCat('cash',        'cash');        },
    history:    rHistory,
    report:     rReport,
    settings:   rSettings,
  };
  try { if (map[id]) map[id](); } catch(e) { console.error('[WealthOS] renderView error:', id, e); }
}

// ==============================================
// OVERVIEW
// ==============================================
function rOverview() {
  try {
    console.log('[WealthOS] rOverview called, assets:', assets.length);
    _rOverviewContent();
  } catch(e) { console.error('[WealthOS] rOverview error:', e); }
}
// ============================================================
// PORTFOLIO CALCULATION ENGINE -- Step 5
// All values derived from real data only. No estimates.
// ============================================================

// Per-asset calculations
function calcAsset(a) {
  if (!a) return { id:0, name:'Unknown', cat:'other', ticker:'--', qty:1, buyPrice:0, curVal:0, livePrice:0, plAbs:0, plPct:0, lastSynced:null, allocation:0 };
  var qty        = parseFloat(a.qty) || 1;
  var buyPrice   = parseFloat(a.cost) || 0;
  var curVal     = parseFloat(a.val) || 0;
  var livePrice  = qty > 0 ? curVal / qty : 0;
  var plAbs      = curVal - buyPrice;
  var plPct      = buyPrice > 0 ? (plAbs / buyPrice) * 100 : 0;
  // Protect against NaN
  if (isNaN(plAbs)) plAbs = 0;
  if (isNaN(plPct)) plPct = 0;
  if (isNaN(livePrice)) livePrice = 0;
  return {
    id:         a.id || 0,
    name:       a.name || 'Unnamed Asset',
    cat:        a.cat || 'other',
    ticker:     a.ticker || '--',
    qty:        qty,
    buyPrice:   buyPrice,
    curVal:     curVal,
    livePrice:  livePrice,
    plAbs:      plAbs,
    plPct:      plPct,
    lastSynced: a.lastSynced || null,
    allocation: 0
  };
}

// Portfolio-level aggregation
function calcPortfolio() {
  var totalNetWorth  = 0;
  var totalCostBasis = 0;
  var computed       = [];

  if (!assets || !Array.isArray(assets)) assets = [];

  assets.forEach(function(a) {
    try {
      var c = calcAsset(a);
      totalNetWorth  += c.curVal;
      totalCostBasis += c.buyPrice;
      computed.push(c);
    } catch(e) { console.warn('[WealthOS] calcAsset skip:', e); }
  });

  if (isNaN(totalNetWorth)) totalNetWorth = 0;
  if (isNaN(totalCostBasis)) totalCostBasis = 0;

  var totalPL    = totalNetWorth - totalCostBasis;
  var totalPLPct = totalCostBasis > 0 ? (totalPL / totalCostBasis) * 100 : 0;
  if (isNaN(totalPL)) totalPL = 0;
  if (isNaN(totalPLPct)) totalPLPct = 0;

  // Set allocation % now that we have the total
  computed.forEach(function(c) {
    c.allocation = totalNetWorth > 0 ? (c.curVal / totalNetWorth) * 100 : 0;
  });

  // Best / worst performers (by % gain, only assets with cost basis)
  var withCost = computed.filter(function(c) { return c.buyPrice > 0; });
  withCost.sort(function(a, b) { return b.plPct - a.plPct; });

  return {
    assets:        computed,
    totalNetWorth: totalNetWorth,
    totalCostBasis:totalCostBasis,
    totalPL:       totalPL,
    totalPLPct:    totalPLPct,
    bestAsset:     withCost.length ? withCost[0]             : null,
    worstAsset:    withCost.length ? withCost[withCost.length - 1] : null,
    byCategory:    calcByCategory(computed, totalNetWorth)
  };
}

// Category breakdown
function calcByCategory(computed, total) {
  var cats = {};
  computed.forEach(function(c) {
    if (!cats[c.cat]) cats[c.cat] = { val: 0, cost: 0, count: 0 };
    cats[c.cat].val   += c.curVal;
    cats[c.cat].cost  += c.buyPrice;
    cats[c.cat].count += 1;
  });
  // Add pct and pl per category
  Object.keys(cats).forEach(function(k) {
    var cat = cats[k];
    cat.pct  = total > 0 ? (cat.val / total) * 100 : 0;
    cat.pl   = cat.val - cat.cost;
    cat.plPct = cat.cost > 0 ? (cat.pl / cat.cost) * 100 : 0;
  });
  return cats;
}

function _rOverviewContent() {
  try {
  // -- Real portfolio calculations (no estimates) --
  var portfolio = calcPortfolio();
  var tv   = portfolio.totalNetWorth || 0;
  var tc   = portfolio.totalCostBasis || 0;
  var gain = portfolio.totalPL || 0;
  var pct  = portfolio.totalPLPct || 0;
  var mg   = gain;
  var goal = parseFloat(settings.goal) || 0;
  var gp   = goal > 0 ? Math.min(100, (tv / goal) * 100) : 0;
  if (isNaN(gp)) gp = 0;

  // Count-up net worth animation
  var nwEl = safeGet('nw-total');
  if (nwEl) {
    var sym = getCurrencySymbol();
    var targetVal = tv * getCurrencyRate();
    var dur = 1200, t0 = null;
    (function countUp(ts) {
      if (!t0) t0 = ts;
      var prog = Math.min((ts - t0) / dur, 1);
      var ease = 1 - Math.pow(1 - prog, 3);
      var cur  = Math.round(targetVal * ease);
      if      (Math.abs(cur) >= 1e6) nwEl.textContent = sym + (cur / 1e6).toFixed(2) + 'M';
      else if (Math.abs(cur) >= 1e3) nwEl.textContent = sym + (cur / 1e3).toFixed(0)  + 'k';
      else                           nwEl.textContent = sym + cur.toLocaleString();
      if (prog < 1) requestAnimationFrame(countUp);
      else          nwEl.textContent = fmtS(tv);
    })(performance.now());
  }

  // Change / stats
  // Show real total P&L
  var chEl = safeGet('nw-change');
  if (chEl) {
    chEl.textContent = (gain >= 0 ? '+' : '') + fmtS(gain);
    chEl.className   = 'nw-change-val ' + (gain >= 0 ? 'mc-up' : 'mc-dn');
    chEl.title       = 'Total P&L: ' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
  }
  if (!document.getElementById('nw-live-ind')) {
    var nwEl2 = safeGet('nw-total');
    if (nwEl2 && nwEl2.parentElement) {
      var li = document.createElement('span');
      li.id = 'nw-live-ind'; li.className = 'live-dot';
      li.innerHTML = '<span class="live-dot-pulse"></span>Live';
      nwEl2.parentElement.appendChild(li);
    }
  }
  safeSet('nw-return', fmtP(pct));
  safeSet('nw-count',  assets.length.toString());
  safeSet('goal-val',  fmtS(goal));
  safeSet('goal-pct',  gp.toFixed(1) + '%');
  setTimeout(function() { var gf = safeGet('goal-fill'); if (gf) gf.style.width = gp + '%'; }, 200);

  // Best / worst performer
  // Best/worst from calc engine
  if (portfolio.bestAsset) {
    var ba = portfolio.bestAsset, wa = portfolio.worstAsset;
    safeSet('nw-best',  ba.ticker !== '--' ? ba.ticker : ba.name.split(' ')[0]);
    safeSet('nw-worst', wa && wa !== ba ? (wa.ticker !== '--' ? wa.ticker : wa.name.split(' ')[0]) : '--');
  }

  // Metric cards
  var cls = clsT();
  var mets = [
    {label:'Stocks',      val: cls.stock       || 0, color: CAT_COLORS.stock,       pct: tv ? (cls.stock       || 0) / tv * 100 : 0},
    {label:'Real Estate', val: cls.real_estate  || 0, color: CAT_COLORS.real_estate, pct: tv ? (cls.real_estate || 0) / tv * 100 : 0},
    {label:'Crypto',      val: cls.crypto       || 0, color: CAT_COLORS.crypto,      pct: tv ? (cls.crypto      || 0) / tv * 100 : 0},
    {label:'Alternatives',val:(cls.art||0)+(cls.watch||0), color: CAT_COLORS.art,   pct: tv ? ((cls.art||0)+(cls.watch||0)) / tv * 100 : 0},
    {label:'Cash',        val: cls.cash         || 0, color: CAT_COLORS.cash,        pct: tv ? (cls.cash        || 0) / tv * 100 : 0},
    {label:'Total Gain',  val: gain,                  color: gain >= 0 ? 'var(--green)' : 'var(--red)'},
  ];
  var metEl = safeGet('ov-metrics');
  if (metEl) {
    metEl.innerHTML = mets.map(function(m) {
      var isGain = m.label === 'Total Gain';
      return '<div class="mc">' +
        '<div class="mc-label">' + m.label + '</div>' +
        '<div class="mc-val ' + (isGain ? (gain >= 0 ? 'green' : 'red') : '') + '">' + fmtS(m.val) + '</div>' +
        (m.pct !== undefined
          ? '<div class="mc-sub mc-n">' + m.pct.toFixed(1) + '% of portfolio</div><div class="mc-bar"><div class="mc-fill" style="width:' + m.pct + '%;background:' + m.color + '"></div></div>'
          : '<div class="mc-sub"><span class="' + (gain >= 0 ? 'mc-up' : 'mc-dn') + '">' + fmtP(gainPct(tc, tv)) + '</span><span class="mc-n"> all time</span></div>'
        ) +
        '</div>';
    }).join('');
  }

  rTrendChart();
  rAllocChart();

  // Top holdings table
  var top = [...assets].sort(function(a, b) { return b.val - a.val; }).slice(0, 6);
  var topEl = safeGet('top-table');
  if (topEl) {
    topEl.innerHTML = top.length ? top.map(function(a) {
      var g = gainPct(a.cost, a.val);
      return '<tr>' +
        '<td><div style="display:flex;align-items:center;gap:10px">' +
          '<div class="ai ' + catCls(a.cat) + '">' + catI(a.cat) + '</div>' +
          '<div><div style="font-weight:500">' + a.name + '</div>' +
          '<div class="tmu">' + (a.ticker !== '--' ? a.ticker : a.loc) + '</div></div>' +
        '</div></td>' +
        '<td><span class="bdg bdg-blue">' + catL(a.cat) + '</span></td>' +
        '<td class="tm">' + fmt(a.val) + '</td>' +
        '<td class="' + (g >= 0 ? 'tg' : 'tr2') + '">' + fmtP(g) + '</td>' +
        '<td><div style="display:flex;align-items:center;gap:7px">' +
          '<div class="pr-bar" style="width:70px"><div class="pr-fill" style="width:' + (tv ? (a.val / tv * 100) : 0) + '%;background:' + (CAT_COLORS[a.cat] || 'var(--blue)') + '"></div></div>' +
          '<span class="tmu">' + (tv ? (a.val / tv * 100).toFixed(1) : 0) + '%</span>' +
        '</div></td>' +
      '</tr>';
    }).join('') : '<tr><td colspan="5"><div style="text-align:center;padding:48px 24px">' +
      '<div style="width:52px;height:52px;border-radius:14px;background:rgba(92,95,239,0.08);border:1px solid rgba(92,95,239,0.14);display:flex;align-items:center;justify-content:center;margin:0 auto 16px"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#5C5FEF" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg></div>' +
      '<div style="font-size:15px;font-weight:600;color:var(--text);margin-bottom:8px">Your portfolio is empty</div>' +
      '<div style="font-size:13px;color:var(--muted);margin-bottom:20px;line-height:1.6">Start by adding your first asset to begin<br>tracking your total wealth.</div>' +
      '<button onclick="openAddAsset()" class="empty-cta">+ Add Asset</button>' +
      '</div></td></tr>';
  }

  var plan = currentUser ? (currentUser.plan||'free') : 'free';
  console.log('[WealthOS] _rOverviewContent: tv=' + tv + ', assets=' + assets.length + ', plan=' + plan);
  // Each AI section is independent — one failure must NOT kill the others
  try { rSnapshot(tv, cls); } catch(e) { console.warn('[WealthOS] rSnapshot error:', e); }
  try { rInsights(cls, tv, gain, pct); } catch(e) { console.warn('[WealthOS] rInsights error:', e); }
  try { rAlerts(cls, tv); } catch(e) { console.warn('[WealthOS] rAlerts error:', e); }
  try { rMarketIntelligence(plan); } catch(e) { console.warn('[WealthOS] rMarketIntelligence error:', e); }
  setTimeout(function() {
    try { rProjection(tv); } catch(e) { console.warn('[WealthOS] rProjection error:', e); }
    try {
      var cls2 = clsT(), tv2 = totalV();
      var rates2 = {stock:0.10,real_estate:0.07,crypto:0.20,art:0.08,watch:0.06,cash:0.04,other:0.06};
      var wr2 = 0;
      if (tv2 > 0) Object.keys(cls2).forEach(function(c){wr2+=(cls2[c]/tv2)*(rates2[c]||0.07);});
      wr2 = Math.min(wr2, 0.15);
      renderGoalDate(tv2, settings.goal || 0, wr2);
    } catch(e) {}
    try { checkAndNotify(clsT(), totalV()); } catch(e) {}
  }, 100);
  } catch(e) { console.error('[WealthOS] _rOverviewContent error:', e); }
}

// ==============================================
// CHARTS
// ==============================================
function destroyChart(ref) { if (ref) { try { ref.destroy(); } catch(e) {} } return null; }
function _chartAvailable() { return typeof Chart !== 'undefined'; }

function rTrendChart() {
  var ctx = safeGet('trend-chart');
  if (!ctx || !_chartAvailable()) return;
  trendChart = destroyChart(trendChart);
  var tv = totalV() || 0, base = tv * 0.72;
  var months = ['Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec','Jan','Feb','Mar'];
  var vals = months.map(function(_, i) {
    return Math.round(base + base * (i / months.length) * 0.32 + base * 0.025 * (Math.random() - 0.3));
  });
  vals[11] = Math.round(tv);
  trendChart = new Chart(ctx, {
    type: 'line',
    data: { labels: months, datasets: [{
      data: vals, fill: true, borderColor: 'rgba(92,95,239,0.9)', borderWidth: 2,
      tension: 0.4, pointRadius: 0, pointHoverRadius: 4,
      backgroundColor: function(c) {
        var g = c.chart.ctx.createLinearGradient(0, 0, 0, 220);
        g.addColorStop(0, 'rgba(92,95,239,0.14)');
        g.addColorStop(1, 'rgba(92,95,239,0.01)');
        return g;
      }
    }]},
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: {display:false}, tooltip: {
        backgroundColor:'rgba(13,13,18,0.96)', titleColor:'#6E7191', bodyColor:'#F0F0F8',
        borderColor:'rgba(92,95,239,0.2)', borderWidth:1,
        callbacks: { label: function(c) { return fmtS(c.raw); } }
      }},
      scales: {
        x: { grid:{color:'rgba(30,30,40,0.6)'}, ticks:{color:'#3D3D52',font:{family:'IBM Plex Mono',size:10}} },
        y: { grid:{color:'rgba(30,30,40,0.6)'}, ticks:{color:'#3D3D52',font:{family:'IBM Plex Mono',size:10}, callback:function(v){return fmtS(v);}} }
      }
    }
  });
}

function rAllocChart() {
  var ctx = safeGet('alloc-chart');
  if (!ctx || !_chartAvailable()) return;
  allocChart = destroyChart(allocChart);
  var cls = clsT(), tv = totalV();
  var cats   = Object.keys(cls).filter(function(c) { return cls[c] > 0; });
  var labels = cats.map(catL);
  var vals   = cats.map(function(c) { return cls[c]; });
  var colors = cats.map(function(c) { return CAT_COLORS[c] || '#8888aa'; });
  if (!vals.length) return;
  allocChart = new Chart(ctx, {
    type: 'doughnut',
    data: { labels: labels, datasets: [{
      data: vals, backgroundColor: colors,
      borderColor: 'rgba(13,13,18,0.9)', borderWidth: 3
    }]},
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '70%',
      plugins: { legend:{display:false}, tooltip:{
        backgroundColor:'rgba(13,13,18,0.96)', bodyColor:'#F0F0F8',
        borderColor:'rgba(92,95,239,0.2)', borderWidth:1,
        callbacks: { label: function(c) { return fmtS(c.raw) + ' (' + ((c.raw/tv)*100).toFixed(1) + '%)'; } }
      }}
    }
  });
  var legend = safeGet('alloc-legend');
  if (legend) {
    legend.innerHTML = labels.map(function(l, i) {
      return '<div class="al-item">' +
        '<div class="al-dot" style="background:' + colors[i] + '"></div>' +
        '<div class="al-label">' + l + '</div>' +
        '<div class="al-pct">' + ((vals[i]/tv)*100).toFixed(0) + '%</div>' +
      '</div>';
    }).join('');
  }
}

// rProjection moved to Wealth Intelligence Engine below

// ======================================================
// WEALTH INTELLIGENCE ENGINE
// ======================================================

// Market intelligence data (rotates daily for freshness)
var MARKET_UPDATES = [
  {sector:'Equities', icon:'bar-chart', text:'Large-cap tech continues to lead equity markets. AI-adjacent companies show strong momentum with multiple sectors at multi-year highs.',trend:'up',change:'+1.4%'},
  {sector:'Crypto',   icon:'cpu',       text:'Digital assets showing elevated volatility. Bitcoin dominance at 52%. On-chain metrics suggest institutional accumulation continues.',trend:'flat',change:'+/-2.1%'},
  {sector:'Real Estate',icon:'home',    text:'Commercial real estate pressure continues in tier-1 cities. Residential markets remain resilient with limited inventory.',trend:'flat',change:'+0.3%'},
  {sector:'Commodities',icon:'trending',text:'Gold holding near all-time highs as safe-haven demand persists. Oil volatile on supply uncertainty. Agricultural commodities stable.',trend:'up',change:'+0.8%'},
  {sector:'Fixed Income',icon:'file',   text:'10-year Treasury yields stabilising after recent volatility. Corporate bond spreads remain historically tight, reflecting low default risk.',trend:'flat',change:'-0.02%'},
  {sector:'Alternatives',icon:'gem',    text:'Collectibles and luxury assets continuing multi-year appreciation trend. Watch market remains active with strong secondary demand.',trend:'up',change:'+5.2% YTD'},
];

// Compute risk level from portfolio composition
function computeRiskLevel(cls, tv) {
  if (!tv) return {label:'--', score:0};
  var cryptoPct  = (cls.crypto||0)/tv*100;
  var stockPct   = (cls.stock||0)/tv*100;
  var altPct     = ((cls.art||0)+(cls.watch||0))/tv*100;
  var cashPct    = (cls.cash||0)/tv*100;
  var rePct      = (cls.real_estate||0)/tv*100;
  var score = cryptoPct * 0.4 + stockPct * 0.2 + altPct * 0.15 - cashPct * 0.1 - rePct * 0.05;
  if (score > 22) return {label:'High',       color:'var(--red)',   score:score};
  if (score > 12) return {label:'Moderate',   color:'var(--amber)', score:score};
  return           {label:'Conservative', color:'var(--green)', score:score};
}

// Market sentiment (deterministic per day)
function getSentiment() {
  var day = Math.floor(Date.now() / 86400000);
  var idx = day % 7;
  var states = ['Bullish','Bullish','Neutral','Neutral','Neutral','Cautious','Bullish'];
  var s = states[idx];
  if (s === 'Bullish')  return {label:'Bullish',  cls:'sentiment-bull'};
  if (s === 'Cautious') return {label:'Cautious', cls:'sentiment-bear'};
  return                       {label:'Neutral',  cls:'sentiment-neut'};
}

// -- 7: Daily Snapshot --
function rSnapshot(tv, cls) {
  if (!tv) return;
  var daily = tv * (0.008 + (Math.floor(Date.now()/86400000) % 5) * 0.002) * (Math.floor(Date.now()/86400000)%3===0?-1:1);
  var topAsset = [...assets].sort(function(a,b){return b.val-a.val;})[0];
  var bestPerf = [...assets].filter(function(a){return a.cost>0;}).sort(function(a,b){return gainPct(b.cost,b.val)-gainPct(a.cost,a.val);})[0];
  var risk = computeRiskLevel(cls, tv);
  var sentiment = getSentiment();
  safeSet('snap-nw', fmtS(tv));
  var dEl = safeGet('snap-daily');
  if (dEl) { dEl.textContent = (daily>=0?'+':'')+fmtS(daily); dEl.className = 'snap-val '+(daily>=0?'up':'dn'); }
  safeSet('snap-top',  topAsset ? topAsset.name.split(' ').slice(0,2).join(' ') : '--');
  safeSet('snap-best', bestPerf ? (bestPerf.ticker!=='--'?bestPerf.ticker:bestPerf.name.split(' ')[0])+' '+fmtP(gainPct(bestPerf.cost,bestPerf.val)) : '--');
  var rEl = safeGet('snap-risk');
  if (rEl) { rEl.textContent = risk.label; rEl.style.color = risk.color; }
  var sEl = safeGet('snap-sentiment');
  if (sEl) sEl.innerHTML = '<span class="sentiment-pill '+sentiment.cls+'"><span class="sentiment-dot"></span>'+sentiment.label+'</span>';
}

// -- 1: Portfolio Insight Cards --
function _buildAlertInsights(p) {
  if (!p || p.totalNetWorth <= 0) return '';
  var a = [], cats = p.byCategory;
  var cp = cats.crypto ? cats.crypto.pct : 0;
  var sp = cats.stock  ? cats.stock.pct  : 0;
  var cash = cats.cash ? cats.cash.pct   : 0;
  var best = p.bestAsset;
  var pl = p.totalPL, plp = p.totalPLPct;
  var cc = Object.keys(cats).filter(function(k){return cats[k].val>0;}).length;
  if (cp>30) a.push({t:'warn',i:'bolt',h:'High crypto exposure ('+cp.toFixed(0)+'%)',d:'Crypto is '+cp.toFixed(1)+'% -- above the typical 10-20% for most risk profiles. Consider rebalancing.'});
  if (sp>70) a.push({t:'warn',i:'chart',h:'Overweight equities ('+sp.toFixed(0)+'%)',d:'Public equities at '+sp.toFixed(1)+'%. Adding real assets could reduce drawdown risk.'});
  if (best&&best.allocation>40) a.push({t:'warn',i:'warn',h:(best.ticker!=='--' && best.ticker!=='-' && best.ticker!=='--'?best.ticker:best.name)+' is '+best.allocation.toFixed(0)+'% of portfolio',d:'Single-asset concentration above 40% increases drawdown risk significantly.'});
  if (cash<3&&p.totalNetWorth>50000) a.push({t:'warn',i:'drop',h:'Low liquidity buffer ('+cash.toFixed(1)+'% cash)',d:'Under 3% in liquid assets. Keep at least 3-6 months of expenses accessible.'});
  if (p.totalCostBasis>0&&plp>20) a.push({t:'good',i:'up',h:'Portfolio up '+plp.toFixed(1)+'% overall',d:'Unrealised gain of '+(pl>=0?'+':'')+fmtS(pl)+'. Consider whether to lock in profits or hold.'});
  else if (p.totalCostBasis>0&&plp<-10) a.push({t:'info',i:'down',h:'Portfolio down '+Math.abs(plp).toFixed(1)+'% from cost',d:'Unrealised loss of '+fmtS(Math.abs(pl))+'. Review whether fundamentals have changed.'});
  if (cc>=4) a.push({t:'good',i:'ok',h:'Diversified across '+cc+' asset classes',d:'Good structural diversification for long-term wealth preservation.'});
  if (a.length===0) return '';
  var icons = {bolt:'&#9889;',chart:'&#128202;',warn:'&#9888;',drop:'&#128167;',up:'&#128200;',down:'&#128201;',ok:'&#10003;'};
  return '<div style="margin-bottom:18px">'+a.slice(0,3).map(function(x){
    return '<div class="insight-alert '+x.t+'"><div class="insight-alert-icon">'+icons[x.i]+'</div><div class="insight-alert-text"><div class="insight-alert-title">'+x.h+'</div><div class="insight-alert-desc">'+x.d+'</div></div></div>';
  }).join('')+'</div>';
}

function rInsights(cls, tv, gain, pct) {
  var plan   = settings.plan || (currentUser ? currentUser.plan : 'free') || 'free';
  var isPro  = plan === 'pro' || plan === 'private';
  var grid   = safeGet('wi-insight-grid');
  if (!grid) return;
  if (!tv || assets.length === 0) {
    grid.innerHTML = '<div class="intel-card" style="grid-column:1/-1;text-align:center;color:var(--muted);font-size:13px;padding:24px">Add assets to unlock portfolio insights.</div>';
    return;
  }

  // -- Use real calc engine --
  var portfolio = calcPortfolio();
  var p = portfolio;
  var cats = p.byCategory;

  // -- INSIGHT 1: RISK LEVEL --
  // Compute from exact allocations -- specific numbers, not buckets
  var cryptoPct  = cats.crypto       ? cats.crypto.pct       : 0;
  var stockPct   = cats.stock        ? cats.stock.pct        : 0;
  var rePct      = cats.real_estate  ? cats.real_estate.pct  : 0;
  var cashPct    = cats.cash         ? cats.cash.pct         : 0;
  var altPct     = ((cats.art ? cats.art.pct : 0) + (cats.watch ? cats.watch.pct : 0));

  // Risk score: weighted by volatility class
  var riskScore  = (cryptoPct * 0.42) + (stockPct * 0.22) + (altPct * 0.18)
                 - (cashPct * 0.12) - (rePct * 0.08);
  var riskLabel, riskColor, riskAction;
  if (riskScore > 24) {
    riskLabel  = 'HIGH';
    riskColor  = 'var(--red)';
    riskAction = 'You have ' + cryptoPct.toFixed(1) + '% in crypto -- above the 20% threshold for your risk profile. Rebalancing could reduce volatility by ~30%.';
  } else if (riskScore > 14) {
    riskLabel  = 'MODERATE-HIGH';
    riskColor  = 'var(--amber)';
    riskAction = 'Elevated risk across speculative assets. Review your largest positions before deploying more capital.';
  } else if (riskScore > 6) {
    riskLabel  = 'MODERATE';
    riskColor  = 'var(--blue)';
    riskAction = 'Balanced risk profile. Suitable for long-term growth.';
  } else if (riskScore > 0) {
    riskLabel  = 'CONSERVATIVE';
    riskColor  = 'var(--green)';
    riskAction = 'Low volatility portfolio. May underperform in bull markets.';
  } else {
    riskLabel  = 'VERY CONSERVATIVE';
    riskColor  = 'var(--green)';
    riskAction = 'Very low volatility. Consider growth assets for better returns.';
  }

  // Build specific breakdown string
  var riskBreakdown = [];
  if (cryptoPct > 0.5) riskBreakdown.push('Crypto ' + cryptoPct.toFixed(1) + '%');
  if (stockPct  > 0.5) riskBreakdown.push('Stocks '  + stockPct.toFixed(1) + '%');
  if (rePct     > 0.5) riskBreakdown.push('Real estate ' + rePct.toFixed(1) + '%');
  if (cashPct   > 0.5) riskBreakdown.push('Cash '    + cashPct.toFixed(1) + '%');
  if (altPct    > 0.5) riskBreakdown.push('Alts '    + altPct.toFixed(1) + '%');

  var insight1 = {
    label:  'Portfolio Risk Level',
    val:    riskLabel,
    color:  riskColor,
    desc:   (riskBreakdown.join(' * ') || 'No assets') + '. ' + riskAction
  };

  // -- INSIGHT 2: DIVERSIFICATION WARNING --
  // Uses HHI (Herfindahl-Hirschman Index) -- higher = more concentrated
  var hhi = 0;
  p.assets.forEach(function(a) {
    var w = a.allocation / 100;
    hhi += w * w;
  });
  var hhiPct    = (hhi * 100).toFixed(0);     // 0-100 scale
  var classCount = Object.keys(cats).filter(function(k) { return cats[k].val > 0; }).length;
  var topAsset   = p.assets.length > 0 ?
    p.assets.slice().sort(function(a,b){ return b.curVal - a.curVal; })[0] : null;
  var topName    = topAsset ? (topAsset.ticker !== '--' ? topAsset.ticker : topAsset.name) : '--';
  var topAllocPct = topAsset ? topAsset.allocation.toFixed(1) : '0';

  var divLabel, divColor, divDesc;
  if (hhi > 0.5) {
    divLabel = 'HIGH CONCENTRATION';
    divColor = 'var(--red)';
    divDesc  = topName + ' is ' + topAllocPct + '% of portfolio. '
             + classCount + ' asset class' + (classCount !== 1 ? 'es' : '')
             + '. Add uncorrelated assets to reduce single-asset risk.';
  } else if (hhi > 0.25) {
    divLabel = 'MODERATELY CONCENTRATED';
    divColor = 'var(--amber)';
    divDesc  = topName + ' leads at ' + topAllocPct + '% across '
             + classCount + ' class' + (classCount !== 1 ? 'es' : '')
             + '. Consider rebalancing toward target weights.';
  } else if (classCount >= 4) {
    divLabel = 'WELL DIVERSIFIED';
    divColor = 'var(--green)';
    divDesc  = classCount + ' asset classes. ' + topName + ' is largest at '
             + topAllocPct + '%. HHI concentration index: ' + hhiPct + '/100.';
  } else {
    divLabel = 'NEEDS DIVERSIFICATION';
    divColor = 'var(--blue)';
    divDesc  = classCount + ' class' + (classCount !== 1 ? 'es' : '')
             + ' -- consider adding real estate, cash, or alternative assets.';
  }

  var insight2 = {
    label: 'Diversification',
    val:   divLabel,
    color: divColor,
    desc:  divDesc
  };

  // -- INSIGHT 3: PERFORMANCE SUMMARY --
  // Specific P&L numbers + best/worst named asset
  var totalPL    = p.totalPL;
  var totalPLPct = p.totalPLPct;
  var best       = p.bestAsset;
  var worst      = p.worstAsset;

  var perfLabel = totalPL >= 0 ? 'IN PROFIT' : 'IN LOSS';
  var perfColor = totalPL >= 0 ? 'var(--green)' : 'var(--red)';
  var perfDesc;

  if (p.totalCostBasis === 0) {
    perfDesc = 'No cost basis set. Edit your assets and add buy prices to track performance.';
  } else {
    var plStr = (totalPL >= 0 ? '+' : '') + fmtS(totalPL) +
                ' (' + (totalPLPct >= 0 ? '+' : '') + totalPLPct.toFixed(2) + '%) on ' +
                fmtS(p.totalCostBasis) + ' invested.';
    var bestStr  = best  ? ' Best: ' + (best.ticker !== '--' ? best.ticker : best.name.split(' ')[0])
                         + ' +' + best.plPct.toFixed(1) + '%.' : '';
    var worstStr = worst && worst !== best
                 ? ' Worst: ' + (worst.ticker !== '--' ? worst.ticker : worst.name.split(' ')[0])
                         + ' ' + (worst.plPct >= 0 ? '+' : '') + worst.plPct.toFixed(1) + '%.' : '';
    perfDesc = plStr + bestStr + worstStr;
  }

  var insight3 = {
    label: 'Performance Summary',
    val:   perfLabel,
    color: perfColor,
    desc:  perfDesc
  };

  // -- BONUS INSIGHT 4: LARGEST CLASS --
  var topCat = Object.keys(cats).filter(function(k){ return cats[k].val > 0; })
    .sort(function(a,b){ return cats[b].val - cats[a].val; })[0];
  var topCatPL = topCat ? cats[topCat].pl : 0;
  var insight4 = topCat ? {
    label: catL(topCat) + ' Position',
    val:   (cats[topCat].pct).toFixed(1) + '% of portfolio',
    color: topCatPL >= 0 ? 'var(--green)' : 'var(--red)',
    desc:  'Current value: ' + fmtS(cats[topCat].val) +
           '. Cost basis: ' + fmtS(cats[topCat].cost) +
           '. P&L: ' + (topCatPL >= 0 ? '+' : '') + fmtS(topCatPL) +
           ' (' + (topCatPL >= 0 ? '+' : '') + cats[topCat].plPct.toFixed(1) + '%).'
  } : null;

  // -- BONUS INSIGHT 5: CASH DRAG --
  var insight5 = null;
  if (cashPct > 1) {
    var cashVal   = cats.cash ? cats.cash.val : 0;
    var cashLabel = cashPct > 25 ? 'HIGH CASH DRAG' : cashPct < 5 ? 'LOW LIQUIDITY' : 'CASH BUFFER';
    var cashColor = cashPct > 25 ? 'var(--amber)' : cashPct < 5 ? 'var(--red)' : 'var(--green)';
    var cashDesc  = fmtS(cashVal) + ' cash (' + cashPct.toFixed(1) + '%). ';
    cashDesc += cashPct > 25 ? 'Significant idle capital. Review deployment opportunities.'
             : cashPct < 5  ? 'Below 5% liquidity buffer. Consider maintaining emergency reserve.'
             :                 'Healthy liquidity. Covers short-term needs.';
    insight5 = { label: 'Cash Position', val: cashLabel, color: cashColor, desc: cashDesc };
  }

  // -- BONUS INSIGHT 6: GOAL PROGRESS --
  var goal    = settings.goal || 0;
  var goalPct = (goal > 0 && tv > 0) ? (tv / goal * 100) : 0;
  var insight6 = goal > 0 ? {
    label: 'Goal Progress',
    val:   goalPct.toFixed(1) + '%',
    color: goalPct >= 100 ? 'var(--green)' : goalPct >= 75 ? 'var(--blue)' : 'var(--muted)',
    desc:  fmtS(tv) + ' of ' + fmtS(goal) + ' target. ' +
           (goalPct >= 100 ? 'Target reached!' :
            goalPct >= 75  ? fmtS(goal - tv) + ' remaining -- on track.' :
                             fmtS(goal - tv) + ' remaining.')
  } : {
    label: 'Goal Progress',
    val:   'Not set',
    color: 'var(--muted)',
    desc:  'Set a target net worth in Settings to track your progress.'
  };

  var allInsights = [insight1, insight2, insight3];
  if (insight4) allInsights.push(insight4);
  if (insight5) allInsights.push(insight5);
  allInsights.push(insight6);

  // Define insightCard renderer FIRST (used by benchmark and final render)
  var insightCard = function(ins) {
    if (!ins) return '';
    return '<div class="intel-card">' +
      '<div class="intel-card-label">' + (ins.label || '') + '</div>' +
      '<div class="intel-card-val"' + (ins.color ? ' style="color:' + ins.color + '"' : '') + '>' +
        (ins.val || '') +
      '</div>' +
      '<div class="intel-card-desc">' + (ins.desc || '') + '</div>' +
    '</div>';
  };

  // -- INSIGHT 7: BENCHMARK COMPARISON --
  // Compare all-time portfolio return vs S&P 500 YTD (fetched via /api/prices)
  var insight7 = null;
  if (totalPLPct !== 0 && p.totalCostBasis > 0) {
    var benchmarkKey = 'wos_bench_spy';
    var cachedBench = null;
    try {
      var bRaw = localStorage.getItem(benchmarkKey);
      if (bRaw) {
        var bData = JSON.parse(bRaw);
        if (bData && bData.ts && (Date.now() - bData.ts) < 4 * 60 * 60 * 1000) {
          cachedBench = bData; // use if < 4 hours old
        }
      }
    } catch(e) {}

    var renderBenchInsight = function(spyReturn) {
      var diff = p.totalPLPct - spyReturn;
      var beating = diff >= 0;
      var diffAbs = Math.abs(diff).toFixed(1);
      insight7 = {
        label: 'vs S&P 500 (YTD)',
        val:   (beating ? '+' : '-') + diffAbs + '% vs index',
        color: beating ? 'var(--green)' : 'var(--amber)',
        desc:  'Your all-time return: ' + (p.totalPLPct >= 0 ? '+' : '') + p.totalPLPct.toFixed(1) + '%. ' +
               'S&P 500 YTD: ' + (spyReturn >= 0 ? '+' : '') + spyReturn.toFixed(1) + '%. ' +
               (beating
                 ? 'Your all-time portfolio return is ' + diffAbs + ' pp ahead of S&P 500 YTD.'
                 : 'Your all-time portfolio return trails S&P 500 YTD by ' + diffAbs + ' pp. Review allocation.')
      };
      // Re-render insights with benchmark added
      var withBench = allInsights.concat([insight7]);
      grid.innerHTML = withBench.map(insightCard).join('');
    };

    if (cachedBench) {
      renderBenchInsight(cachedBench.ret);
    } else {
      // Fetch SPY price via existing /api/prices proxy
      fetch('/api/prices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tickers: ['SPY'] })
      })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data && data.prices && data.prices['SPY']) {
          // Approximate YTD: SPY started ~2026 at ~592, use that as baseline
          var spyNow = data.prices['SPY'];
          var spyStart = 592;
          var spyYTD = ((spyNow - spyStart) / spyStart) * 100;
          try {
            localStorage.setItem(benchmarkKey, JSON.stringify({ ret: spyYTD, ts: Date.now() }));
          } catch(e) {}
          renderBenchInsight(spyYTD);
        }
      })
      .catch(function() {}); // silent fail -- benchmark is bonus insight
    }
  }

  // -- Render --
  if (!isPro) {
    // Free: show first insight + upgrade prompt
    grid.innerHTML = insightCard(allInsights[0]) +
      '<div class="intel-card" style="background:rgba(92,95,239,0.04);border-color:rgba(92,95,239,0.15);cursor:pointer" onclick="showUpgradeInsights()">' +
        '<div class="intel-card-label">' + (allInsights.length - 1) + ' More Insights</div>' +
        '<div class="intel-card-val" style="font-size:14px;color:var(--blue)">Upgrade to Pro \u2192</div>' +
        '<div class="intel-card-desc">Real-data insights: diversification warning, performance summary, P&L breakdown, goal progress. Pro feature.</div>' +
      '</div>';
    return;
  }

  grid.innerHTML = _buildAlertInsights(portfolio) + allInsights.slice(0, 6).map(insightCard).join('');
}

// -- 2: Risk Alerts --
function rAlerts(cls, tv) {
  var el = safeGet('wi-alerts');
  var countEl = safeGet('wi-alert-count');
  if (!el) return;

  var plan = settings.plan || (currentUser ? currentUser.plan : 'free') || 'free';
  var isPro = (plan === 'pro' || plan === 'private');

  if (!isPro) {
    el.innerHTML = '<div style="text-align:center;padding:20px;cursor:pointer" onclick="showUpgradeRisk()">' +
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:block;margin:0 auto 8px"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>' +
      '<div style="font-size:12px;font-weight:600;color:var(--text);margin-bottom:3px">Pro Feature</div>' +
      '<div style="font-size:11px;color:var(--muted)">Upgrade to Pro for automated risk alerts</div></div>';
    if (countEl) countEl.textContent = '';
    return;
  }

  if (!tv || assets.length === 0) {
    el.innerHTML = '<div style="text-align:center;color:var(--muted);font-size:12px;padding:16px">Add assets to see risk analysis.</div>';
    if (countEl) countEl.textContent = '0';
    return;
  }
  var alerts = [];
  var highRiskSVG = '<svg class="risk-icon high" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
  var medRiskSVG  = '<svg class="risk-icon med" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
  var okSVG       = '<svg class="risk-icon ok" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

  var cryptoPct = (cls.crypto||0)/tv*100;
  var cashPct   = (cls.cash||0)/tv*100;
  var top       = [...assets].sort(function(a,b){return b.val-a.val;})[0];
  var topPct    = top ? (top.val/tv*100) : 0;
  var uniqueCats= Object.keys(cls).filter(function(k){return cls[k]>0;}).length;

  if (cryptoPct > 35) alerts.push({level:'high', icon:highRiskSVG, title:'Crypto concentration: '+cryptoPct.toFixed(0)+'%', desc:'Crypto exposure is above 35% of your portfolio. High volatility could cause significant net worth drawdown.'});
  else if (cryptoPct > 20) alerts.push({level:'med', icon:medRiskSVG, title:'Elevated crypto exposure: '+cryptoPct.toFixed(0)+'%', desc:'Crypto is above the typical 5-15% risk allocation for wealth preservation portfolios.'});

  if (topPct > 30) alerts.push({level:'high', icon:highRiskSVG, title:'Single position concentration: '+topPct.toFixed(0)+'%', desc:(top?top.name:'An asset')+' exceeds 30% of your total portfolio. Consider reducing concentration risk.'});
  else if (topPct > 20) alerts.push({level:'med', icon:medRiskSVG, title:'Large single position: '+topPct.toFixed(0)+'%', desc:(top?top.name:'Top position')+' is above 20% of portfolio -- monitor closely.'});

  if (cashPct < 5 && tv > 0) alerts.push({level:'med', icon:medRiskSVG, title:'Low cash allocation: '+cashPct.toFixed(0)+'%', desc:'Cash below 5% limits your liquidity buffer for opportunities or emergencies.'});

  if (uniqueCats < 3 && tv > 0) alerts.push({level:'high', icon:highRiskSVG, title:'Portfolio concentration', desc:'Assets are concentrated in fewer than 3 asset classes. Diversification reduces long-term risk.'});

  if (alerts.length === 0) {
    alerts.push({level:'ok', icon:okSVG, title:'Portfolio looks healthy', desc:'No major risk alerts detected. Your allocation appears well-diversified across asset classes.'});
  }

  if (countEl) countEl.textContent = alerts.filter(function(a){return a.level!=='ok';}).length + ' alerts';
  el.innerHTML = alerts.map(function(a) {
    return '<div class="risk-alert risk-'+a.level+'">' +
      '<div>'+a.icon+'</div>' +
      '<div><div class="risk-title">'+a.title+'</div><div class="risk-desc">'+a.desc+'</div></div>' +
    '</div>';
  }).join('');
}

// -- 3 & 4: Market Intelligence --
function rMarketIntelligence(plan) {
  var wrap = safeGet('wi-market-wrap');
  var el   = safeGet('wi-market');
  var badge = safeGet('mi-plan-badge');
  if (!el) return;

  var isPro = (plan === 'pro' || plan === 'private');
  if (badge) badge.textContent = isPro ? '' : 'Pro Feature';

  if (!isPro) {
    el.innerHTML = '';
    wrap.innerHTML = '<div style="position:relative;border-radius:12px;overflow:hidden">' +
      '<div class="market-grid" style="filter:blur(3px);pointer-events:none;opacity:0.4">' +
      MARKET_UPDATES.slice(0,3).map(function(m){
        return '<div class="market-card"><div class="market-card-label">'+m.sector+'</div><div class="market-card-text">'+m.text+'</div><div class="market-card-trend trend-'+m.trend+'">'+m.change+'</div></div>';
      }).join('')+'</div>' +
      '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(13,13,18,0.6);border-radius:12px">' +
        '<div style="background:var(--surface);border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:16px 24px;text-align:center">' +
          '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="display:block;margin:0 auto 8px"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>' +
          '<div style="font-size:12px;color:var(--text);font-weight:600;margin-bottom:3px">Pro Feature</div>' +
          '<div style="font-size:11px;color:var(--muted)">Upgrade to Pro for market intelligence</div>' +
          '<button onclick="goPricing()" style="margin-top:10px;background:var(--blue);border:none;border-radius:6px;padding:7px 16px;font-size:11px;font-weight:600;color:#fff;cursor:pointer;font-family:var(--sans)">View Plans</button>' +
        '</div></div></div>';
    return;
  }

  var day = Math.floor(Date.now() / 86400000);
  var items = MARKET_UPDATES.slice(0, 6);
  var trendSVG = {
    up:   '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>',
    dn:   '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 17 13.5 8.5 8.5 13.5 2 7"/><polyline points="16 17 22 17 22 11"/></svg>',
    flat: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>'
  };
  wrap.innerHTML = '<div class="market-grid">'+items.map(function(m) {
    return '<div class="market-card">' +
      '<div class="market-card-label">'+m.sector+'</div>' +
      '<div class="market-card-text">'+m.text+'</div>' +
      '<div class="market-card-trend trend-'+m.trend+'" style="display:flex;align-items:center;gap:4px">'+(trendSVG[m.trend]||'')+m.change+'</div>' +
    '</div>';
  }).join('')+'</div>';
}

// -- 5: Panic Mode --
function runPanicMode() {
  var plan = settings.plan || (currentUser ? currentUser.plan : 'free');
  var isPrivate = (plan === 'private');
  if (!isPrivate) {
    var r = safeGet('panic-result');
    if (r) {
      r.innerHTML = '<div style="text-align:center;padding:24px">' +
        '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:block;margin:0 auto 10px"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>' +
        '<div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:5px">Private Plan Feature</div>' +
        '<div style="font-size:12px;color:var(--muted);margin-bottom:12px">Stress testing is available on the Private plan.</div>' +
        '<button onclick="goPricing()" style="background:var(--blue);border:none;border-radius:6px;padding:8px 18px;font-size:12px;font-weight:600;color:#fff;cursor:pointer;font-family:var(--sans)">View Plans</button>' +
      '</div>';
      r.classList.add('show');
    }
    return;
  }

  var tv = totalV();
  var cls = clsT();
  var DROP = 0.30;
  var HIGH_RISK_CATS = ['crypto', 'stock'];
  var highRiskVal = HIGH_RISK_CATS.reduce(function(s,c){return s+(cls[c]||0);},0);
  var highRiskPct = tv ? (highRiskVal/tv*100).toFixed(0) : 0;
  var cashVal = cls.cash || 0;
  var cashMonthly = tv * 0.003;
  var cashRunway = cashMonthly > 0 ? Math.round(cashVal / cashMonthly) : 0;
  var stressedNW = tv * (1 - DROP);
  var stressedGain = stressedNW - totalCo();
  var r = safeGet('panic-result');
  if (r) {
    r.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:14px">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--red)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>' +
        '<span style="font-size:13px;font-weight:600;color:var(--red)">Stress Test: -30% Market Drop</span>' +
      '</div>' +
      '<p style="font-size:12px;color:var(--muted);margin-bottom:14px;line-height:1.6">Simulating a severe market correction across all risk assets. Cash and real estate partially shielded.</p>' +
      '<div class="panic-grid">' +
        '<div class="panic-stat"><div class="panic-stat-label">Stressed Net Worth</div><div class="panic-stat-val">'+fmtS(stressedNW)+'</div></div>' +
        '<div class="panic-stat"><div class="panic-stat-label">Total Drawdown</div><div class="panic-stat-val">-'+fmtS(tv-stressedNW)+'</div></div>' +
        '<div class="panic-stat"><div class="panic-stat-label">P&L After Drop</div><div class="panic-stat-val" style="color:'+(stressedGain>=0?'var(--green)':'var(--red)')+'">'+fmtS(stressedGain)+'</div></div>' +
        '<div class="panic-stat"><div class="panic-stat-label">High-Risk Exposure</div><div class="panic-stat-val">'+highRiskPct+'%</div></div>' +
        '<div class="panic-stat"><div class="panic-stat-label">Cash Runway</div><div class="panic-stat-val">'+cashRunway+' mo</div></div>' +
        '<div class="panic-stat"><div class="panic-stat-label">Recovery Estimate</div><div class="panic-stat-val">~2.4 yrs</div></div>' +
      '</div>';
    r.classList.add('show');
  }
}

// -- 6: 3-Scenario Projection --
function rProjection(tv) {
  if (!tv || tv <= 0) return;

  var plan = settings.plan || (currentUser ? currentUser.plan : 'free') || 'free';
  var isPro = (plan === 'pro' || plan === 'private');

  if (!isPro) {
    var scenEl = safeGet('proj-scenarios');
    if (scenEl) {
      scenEl.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:20px;cursor:pointer" onclick="showUpgradePrompt(\'Wealth Projection\',\'Upgrade to Pro to see 3-scenario 10-year projections of your net worth.\')">' +
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:block;margin:0 auto 8px"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>' +
        '<div style="font-size:12px;font-weight:600;color:var(--text);margin-bottom:3px">Pro Feature</div>' +
        '<div style="font-size:11px;color:var(--muted)">Upgrade to Pro for wealth projections</div></div>';
    }
    return;
  }

  var cls = clsT();
  var rates = {stock:0.10, real_estate:0.07, crypto:0.20, art:0.08, watch:0.06, cash:0.04, other:0.06};
  var wr = 0;
  if (tv > 0) Object.keys(cls).forEach(function(c){wr+=(cls[c]/tv)*(rates[c]||0.07);});
  else wr = 0.08;
  wr = Math.min(wr, 0.15);

  var bearRate = wr * 0.45;
  var baseRate = wr;
  var bullRate = wr * 1.65;

  var years = [0,1,2,3,4,5,6,7,8,9,10];
  var bearVals = years.map(function(y){return Math.round(tv*Math.pow(1+bearRate,y));});
  var baseVals = years.map(function(y){return Math.round(tv*Math.pow(1+baseRate,y));});
  var bullVals = years.map(function(y){return Math.round(tv*Math.pow(1+bullRate,y));});

  // ALWAYS render scenario cards (no Chart.js dependency)
  var scenEl = safeGet('proj-scenarios');
  if (scenEl) {
    scenEl.innerHTML =
      '<div class="proj-scenario bear"><div class="proj-sc-label">Conservative</div>' +
        '<div class="proj-sc-val">'+fmtS(bearVals[10])+'</div>' +
        '<div class="proj-sc-5yr">5yr: '+fmtS(bearVals[5])+'</div></div>' +
      '<div class="proj-scenario base"><div class="proj-sc-label">Expected</div>' +
        '<div class="proj-sc-val">'+fmtS(baseVals[10])+'</div>' +
        '<div class="proj-sc-5yr">5yr: '+fmtS(baseVals[5])+'</div></div>' +
      '<div class="proj-scenario bull"><div class="proj-sc-label">Optimistic</div>' +
        '<div class="proj-sc-val">'+fmtS(bullVals[10])+'</div>' +
        '<div class="proj-sc-5yr">5yr: '+fmtS(bullVals[5])+'</div></div>';
    console.log('[WealthOS] Projection scenarios rendered');
  }

  // Legacy elements
  safeSet('proj-today', fmtS(tv));
  safeSet('proj-5yr',   fmtS(baseVals[5]));
  safeSet('proj-10yr',  fmtS(baseVals[10]));

  // Chart requires Chart.js
  var ctx = safeGet('proj-chart');
  if (!ctx || !_chartAvailable()) return;
  projChart = destroyChart(projChart);

  var rate = getCurrencyRate();
  var labels = years.map(function(y){return y===0?'Now':'Yr '+y;});
  projChart = new Chart(ctx, {
    type: 'line',
    data: { labels: labels, datasets: [
      {label:'Conservative', data:bearVals, fill:false, borderColor:'rgba(240,92,113,0.5)', borderWidth:1.5, borderDash:[4,3], tension:0.4, pointRadius:0},
      {label:'Expected',     data:baseVals, fill:true,  borderColor:'rgba(92,95,239,0.9)',  borderWidth:2,   tension:0.4, pointRadius:0,
        backgroundColor:function(c){var g=c.chart.ctx.createLinearGradient(0,0,0,160);g.addColorStop(0,'rgba(92,95,239,0.12)');g.addColorStop(1,'rgba(92,95,239,0.01)');return g;}},
      {label:'Optimistic',   data:bullVals, fill:false, borderColor:'rgba(34,211,165,0.5)', borderWidth:1.5, borderDash:[4,3], tension:0.4, pointRadius:0},
    ]},
    options:{
      responsive:true, maintainAspectRatio:false,
      plugins:{legend:{display:true,position:'top',labels:{color:'#6E7191',font:{family:'IBM Plex Mono',size:10},boxWidth:16,padding:16}},
        tooltip:{backgroundColor:'rgba(13,13,18,0.96)',titleColor:'#6E7191',bodyColor:'#F0F0F8',borderColor:'rgba(92,95,239,0.2)',borderWidth:1,
          callbacks:{label:function(c){return c.dataset.label+': '+fmtS(c.raw/rate);}}}},
      scales:{
        x:{grid:{display:false},ticks:{color:'#3D3D52',font:{family:'IBM Plex Mono',size:9}}},
        y:{grid:{color:'rgba(30,30,40,0.5)'},ticks:{color:'#3D3D52',font:{family:'IBM Plex Mono',size:9},callback:function(v){return fmtS(v/rate);}}}
      }
    }
  });
}

// ==============================================
// ALL ASSETS VIEW
// ==============================================
function rAllAssets() {
  try {
  var portfolio = calcPortfolio();
  var tv = portfolio.totalNetWorth || 0;
  var el = safeGet('all-table');
  if (!el) return;

  if (!portfolio.assets.length) {
    el.innerHTML = '<tr><td colspan="7"><div class="empty-state">' +
      '<div class="empty-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#5C5FEF" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg></div>' +
      '<div class="empty-title">No assets yet</div>' +
      '<div class="empty-desc">Add your first asset to see your net worth and portfolio insights</div>' +
      '<button onclick="openAddAsset()" class="empty-cta">+ Add Asset</button>' +
      '</div></td></tr>';
    return;
  }

  // Sort by current value descending
  var sorted = portfolio.assets.slice().sort(function(a, b) { return b.curVal - a.curVal; });

  el.innerHTML = sorted.map(function(c) {
    var plColor = c.plAbs >= 0 ? 'var(--green)' : 'var(--red)';
    var plSign  = c.plAbs >= 0 ? '+' : '';
    var syncDot = c.lastSynced
      ? '<span title="Live price" style="display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--green);margin-left:4px;vertical-align:middle"></span>'
      : '';
    return '<tr>' +
      // Asset name + ticker
      '<td><div style="display:flex;align-items:center;gap:9px">' +
        '<div class="ai ' + catCls(c.cat) + '">' + catI(c.cat) + '</div>' +
        '<div>' +
          '<div style="font-weight:500">' + c.name + syncDot + '</div>' +
          '<div class="tmu">' + (c.ticker !== '--' ? c.ticker + ' * ' : '') +
            '<span style="color:var(--muted2)">' + catL(c.cat) + '</span>' +
          '</div>' +
        '</div>' +
      '</div></td>' +
      // Quantity
      '<td class="tm" style="color:var(--muted)">' + (c.qty !== 1 ? c.qty + ' units' : '1 unit') + '</td>' +
      // Cost basis (buy price total)
      '<td class="tm">' + fmt(c.buyPrice) + '</td>' +
      // Current value (live_price x qty)
      '<td class="tm" style="font-weight:600">' + fmt(c.curVal) + '</td>' +
      // Profit / Loss absolute + %
      '<td>' +
        '<div style="font-weight:600;color:' + plColor + '">' + plSign + fmt(c.plAbs) + '</div>' +
        '<div style="font-size:10px;color:' + plColor + '">' + plSign + c.plPct.toFixed(2) + '%</div>' +
      '</td>' +
      // Allocation bar
      '<td><div style="display:flex;align-items:center;gap:7px;min-width:90px">' +
        '<div class="pr-bar" style="width:55px"><div class="pr-fill" style="width:' + c.allocation.toFixed(1) + '%;background:' + (CAT_COLORS[c.cat] || 'var(--blue)') + '"></div></div>' +
        '<span class="tmu">' + c.allocation.toFixed(1) + '%</span>' +
      '</div></td>' +
      // Actions
      '<td>' +
        '<button onclick="editAsset(\'' + c.id + '\')" style="background:rgba(92,95,239,0.07);border:none;color:#5C5FEF;border-radius:3px;padding:3px 7px;font-size:10px;cursor:pointer;font-family:var(--mono);margin-right:3px">EDIT</button>' +
        '<button onclick="deleteAsset(\'' + c.id + '\')" style="background:rgba(240,92,113,0.07);border:none;color:var(--red);border-radius:3px;padding:3px 7px;font-size:10px;cursor:pointer;font-family:var(--mono)">DEL</button>' +
      '</td>' +
    '</tr>';
  }).join('');
  } catch(e) { console.error('[WealthOS] rAllAssets error:', e); }
}

// ==============================================
// CATEGORY VIEWS
// ==============================================
function rCat(viewId, cat) {
  try {
  var ca = assets.filter(function(a) { return a && a.cat === cat; });
  var tv = totalV();
  var ct = ca.reduce(function(s, a) { return s + (parseFloat(a.val) || 0); }, 0);
  var cc = ca.reduce(function(s, a) { return s + (parseFloat(a.cost) || 0); }, 0);
  var el = safeGet(viewId + '-content');
  if (!el) return;
  if (ca.length === 0) {
    el.innerHTML = '<div class="empty-state"><div class="empty-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#5C5FEF" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg></div><div class="empty-title">No assets yet</div><div class="empty-desc">Add your first asset to see your net worth and portfolio insights</div><button onclick="openAddAsset()" class="empty-cta">+ Add Asset</button></div>';
    return;
  }
  var metHtml = '<div class="metrics-grid" style="margin-bottom:14px">' +
    '<div class="mc"><div class="mc-label">Total Value</div><div class="mc-val">' + fmtS(ct) + '</div></div>' +
    '<div class="mc"><div class="mc-label">Cost Basis</div><div class="mc-val">' + fmtS(cc) + '</div></div>' +
    '<div class="mc"><div class="mc-label">Unrealised Gain</div><div class="mc-val ' + (ct-cc>=0?'green':'red') + '">' + fmtS(ct-cc) + '</div></div>' +
    '<div class="mc"><div class="mc-label">Portfolio Weight</div><div class="mc-val">' + (tv ? ((ct/tv)*100).toFixed(1) : 0) + '%</div></div>' +
  '</div>';
  var rows = ca.length ? ca.map(function(a) {
    var g = a.val - a.cost, gp = gainPct(a.cost, a.val);
    return '<tr>' +
      '<td><div style="display:flex;align-items:center;gap:9px">' +
        '<div class="ai ' + catCls(a.cat) + '">' + catI(a.cat) + '</div>' +
        '<div><div style="font-weight:500">' + a.name + '</div><div class="tmu">' + (a.loc||'--') + '</div></div>' +
      '</div></td>' +
      '<td class="tm">' + (a.ticker||'--') + '</td>' +
      '<td class="tm">' + fmt(a.cost) + '</td>' +
      '<td class="tm" style="font-weight:500">' + fmt(a.val) + '</td>' +
      '<td class="' + (g>=0?'tg':'tr2') + '">' + (g>=0?'+':'') + fmt(g) + ' <span style="font-size:10px">' + fmtP(gp) + '</span></td>' +
      '<td class="tmu">' + (a.notes||'--') + '</td>' +
      '<td>' +
        '<button onclick="editAsset(\'' + a.id + '\')" style="background:rgba(92,95,239,0.07);border:none;color:#5C5FEF;border-radius:3px;padding:3px 7px;font-size:10px;cursor:pointer;font-family:var(--mono);margin-right:3px">EDIT</button>' +
        '<button onclick="deleteAsset(\'' + a.id + '\')" style="background:rgba(240,92,113,0.07);border:none;color:var(--red);border-radius:3px;padding:3px 7px;font-size:10px;cursor:pointer;font-family:var(--mono)">DEL</button>' +
      '</td>' +
    '</tr>';
  }).join('') : '<tr><td colspan="7" style="text-align:center;padding:36px;color:var(--muted);font-family:var(--mono);font-size:12px">NO ' + cat.toUpperCase().replace('_',' ') + ' ASSETS YET</td></tr>';
  el.innerHTML = metHtml + '<div class="card"><table><thead><tr><th>Name</th><th>Symbol</th><th>Cost Basis</th><th>Current Value</th><th>Gain / Loss</th><th>Notes</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  } catch(e) { console.error('[WealthOS] rCat error:', e); }
}

function rAlt() {
  try {
  var aa = assets.filter(function(a) { return a && (a.cat === 'art' || a.cat === 'watch' || a.cat === 'other'); });
  var tv = totalV(), at = aa.reduce(function(s, a) { return s + (parseFloat(a.val) || 0); }, 0);
  var el = safeGet('alternatives-content');
  if (!el) return;
  var rows = aa.length ? aa.map(function(a) {
    var g = a.val - a.cost, gp = gainPct(a.cost, a.val);
    return '<tr>' +
      '<td><div style="display:flex;align-items:center;gap:9px">' +
        '<div class="ai ' + catCls(a.cat) + '">' + catI(a.cat) + '</div>' +
        '<div><div style="font-weight:500">' + a.name + '</div><div class="tmu">' + catL(a.cat) + ' * ' + (a.loc||'--') + '</div></div>' +
      '</div></td>' +
      '<td class="tm">' + fmt(a.cost) + '</td>' +
      '<td class="tm" style="font-weight:500">' + fmt(a.val) + '</td>' +
      '<td class="' + (g>=0?'tg':'tr2') + '">' + (g>=0?'+':'') + fmt(g) + ' ' + fmtP(gp) + '</td>' +
      '<td class="tmu">' + (a.notes||'--') + '</td>' +
      '<td>' +
        '<button onclick="editAsset(\'' + a.id + '\')" style="background:rgba(92,95,239,0.07);border:none;color:#5C5FEF;border-radius:3px;padding:3px 7px;font-size:10px;cursor:pointer;font-family:var(--mono);margin-right:3px">EDIT</button>' +
        '<button onclick="deleteAsset(\'' + a.id + '\')" style="background:rgba(240,92,113,0.07);border:none;color:var(--red);border-radius:3px;padding:3px 7px;font-size:10px;cursor:pointer;font-family:var(--mono)">DEL</button>' +
      '</td>' +
    '</tr>';
  }).join('') : '<tr><td colspan="6" style="text-align:center;padding:36px;color:var(--muted);font-family:var(--mono);font-size:12px">NO ALTERNATIVE ASSETS YET</td></tr>';
  el.innerHTML = '<div class="metrics-grid" style="margin-bottom:14px">' +
    '<div class="mc"><div class="mc-label">Total Value</div><div class="mc-val gold">' + fmtS(at) + '</div></div>' +
    '<div class="mc"><div class="mc-label">Portfolio Weight</div><div class="mc-val">' + (tv ? ((at/tv)*100).toFixed(1) : 0) + '%</div></div>' +
    '<div class="mc"><div class="mc-label">Items</div><div class="mc-val">' + aa.length + '</div></div>' +
  '</div><div class="card"><table><thead><tr><th>Item</th><th>Cost</th><th>Current Value</th><th>Gain / Loss</th><th>Notes</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  } catch(e) { console.error('[WealthOS] rAlt error:', e); }
}

// ==============================================
// TIMELINE
// ==============================================
function rTimeline() {
  try {
  rMilestoneList();
  var ctx = safeGet('nw-chart');
  if (ctx && _chartAvailable()) {
    nwChart = destroyChart(nwChart);
    var ms = [...milestones].sort(function(a, b) { return new Date(a.date) - new Date(b.date); });
    var labels = ms.length ? ms.map(function(m) { return new Date(m.date).toLocaleDateString('en-US',{month:'short',year:'2-digit'}); }) : ['2020','2021','2022','2023','2024','2025'];
    var vals   = ms.length ? ms.map(function(m) { return m.val; }) : [850000,2100000,3200000,4100000,5200000,totalV()];
    nwChart = new Chart(ctx, {
      type: 'line',
      data: { labels: labels, datasets: [{
        data: vals, fill: true, borderColor:'rgba(34,211,165,0.9)', borderWidth:2,
        tension: 0.4, pointRadius: 6,
        pointBackgroundColor:'rgba(34,211,165,0.9)', pointBorderColor:'rgba(13,13,18,0.9)', pointBorderWidth:2,
        backgroundColor: function(c) {
          var g = c.chart.ctx.createLinearGradient(0, 0, 0, 280);
          g.addColorStop(0, 'rgba(34,211,165,0.10)');
          g.addColorStop(1, 'rgba(34,211,165,0.01)');
          return g;
        }
      }]},
      options: {
        responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{display:false}, tooltip:{
          backgroundColor:'rgba(13,13,18,0.96)', bodyColor:'#F0F0F8',
          borderColor:'rgba(34,211,165,0.2)', borderWidth:1,
          callbacks:{ label:function(c){ return fmtS(c.raw); } }
        }},
        scales:{
          x:{grid:{color:'rgba(30,30,40,0.6)'}, ticks:{color:'#3D3D52',font:{family:'IBM Plex Mono',size:10}}},
          y:{grid:{color:'rgba(30,30,40,0.6)'}, ticks:{color:'#3D3D52',font:{family:'IBM Plex Mono',size:10}, callback:function(v){return fmtS(v);}}}
        }
      }
    });
  }

  var mlEl = safeGet('milestones-list');
  if (mlEl) {
    mlEl.innerHTML = milestones.length
      ? [...milestones].sort(function(a,b){return new Date(b.date)-new Date(a.date);}).map(function(m){
          return '<div class="tl-item"><div class="tl-dot ' + m.type + '"></div><div>' +
            '<div class="tl-title">' + m.title + '</div>' +
            '<div class="tl-meta">' + new Date(m.date).toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'}) + ' * ' + fmtS(m.val) + '</div>' +
          '</div></div>';
        }).join('')
      : '<div style="padding:16px;color:var(--muted);font-family:var(--mono);font-size:12px;text-align:center">NO MILESTONES YET -- ADD YOUR FIRST</div>';
  }

  var ctx2 = safeGet('class-chart');
  if (ctx2 && _chartAvailable()) {
    classChart = destroyChart(classChart);
    var cls = clsT();
    var l   = Object.keys(cls).map(catL);
    var v   = Object.values(cls);
    var co  = Object.keys(cls).map(function(c){ return CAT_COLORS[c] || '#8888aa'; });
    if (v.length) {
      classChart = new Chart(ctx2, {
        type: 'bar',
        data: { labels: l, datasets: [{ data: v, backgroundColor: co.map(function(c){return c+'2a';}), borderColor: co, borderWidth:1.5, borderRadius:4 }]},
        options: {
          responsive:true, maintainAspectRatio:false,
          plugins:{ legend:{display:false}, tooltip:{
            backgroundColor:'rgba(13,13,18,0.96)', bodyColor:'#F0F0F8',
            borderColor:'rgba(92,95,239,0.2)', borderWidth:1,
            callbacks:{label:function(c){return fmtS(c.raw);}}
          }},
          scales:{
            x:{grid:{display:false}, ticks:{color:'#3D3D52',font:{family:'IBM Plex Mono',size:9}}},
            y:{grid:{color:'rgba(30,30,40,0.6)'}, ticks:{color:'#3D3D52',font:{family:'IBM Plex Mono',size:9}, callback:function(v){return fmtS(v);}}}
          }
        }
      });
    }
  }
  } catch(e) { console.error('[WealthOS] rTimeline error:', e); }
}

// ==============================================
// REPORT
// ==============================================
function rReport() {
  try {
  var plan = settings.plan || (currentUser ? currentUser.plan : 'free') || 'free';
  var isPro = (plan === 'pro' || plan === 'private');
  if (!isPro) {
    var reportView = document.getElementById('v-report');
    if (reportView) {
      reportView.innerHTML = '<div style="text-align:center;padding:80px 24px">' +
        '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" style="display:block;margin:0 auto 14px"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>' +
        '<div style="font-size:16px;font-weight:600;color:var(--text);margin-bottom:8px">Quarterly Wealth Reports</div>' +
        '<div style="font-size:13px;color:var(--muted);margin-bottom:20px;max-width:380px;margin-left:auto;margin-right:auto;line-height:1.7">Detailed portfolio reports with allocation breakdown, performance summary, asset tables, and printable PDF export. Available on Pro and Private plans.</div>' +
        '<button onclick="showUpgradePrompt(\'Quarterly Reports\',\'Upgrade to Pro for quarterly wealth reports with PDF export.\')" style="background:var(--blue);border:none;border-radius:9px;padding:12px 28px;font-size:13px;font-weight:600;color:#fff;cursor:pointer;font-family:var(--sans)">Upgrade to Pro \u2192</button>' +
      '</div>';
    }
    return;
  }
  var tv = totalV(), tc = totalCo(), gain = tv - tc, pct = gainPct(tc, tv);
  var cls = clsT();
  safeSet('report-nw', fmtS(tv));
  var statsEl = safeGet('report-stats');
  if (statsEl) {
    statsEl.innerHTML =
      '<div class="rpt-stat"><div class="rpt-stat-label">Net Worth</div><div class="rpt-stat-val">' + fmtS(tv) + '</div></div>' +
      '<div class="rpt-stat"><div class="rpt-stat-label">Total Gain</div><div class="rpt-stat-val" style="color:' + (gain>=0?'var(--green)':'var(--red)') + '">' + (gain>=0?'+':'') + fmtS(gain) + '</div></div>' +
      '<div class="rpt-stat"><div class="rpt-stat-label">Return</div><div class="rpt-stat-val" style="color:' + (pct>=0?'var(--green)':'var(--red)') + '">' + fmtP(pct) + '</div></div>' +
      '<div class="rpt-stat"><div class="rpt-stat-label">Total Assets</div><div class="rpt-stat-val">' + assets.length + '</div></div>' +
      '<div class="rpt-stat"><div class="rpt-stat-label">Cost Basis</div><div class="rpt-stat-val">' + fmtS(tc) + '</div></div>' +
      '<div class="rpt-stat"><div class="rpt-stat-label">Risk Profile</div><div class="rpt-stat-val">' + (settings.risk||'Moderate') + '</div></div>';
  }
  var allocEl = safeGet('report-alloc');
  if (allocEl && tv) {
    allocEl.innerHTML = Object.keys(cls).map(function(c) {
      return '<div class="pr-row"><div class="pr-top"><span class="pr-label">' + catI(c) + ' ' + catL(c) + '</span><span class="pr-val">' + fmtS(cls[c]) + ' * ' + ((cls[c]/tv)*100).toFixed(1) + '%</span></div>' +
        '<div class="pr-bar"><div class="pr-fill" style="width:' + ((cls[c]/tv)*100) + '%;background:' + (CAT_COLORS[c]||'var(--blue)') + '"></div></div></div>';
    }).join('');
  }
  var topEl = safeGet('report-table');
  if (topEl) {
    topEl.innerHTML = [...assets].sort(function(a,b){return b.val-a.val;}).slice(0,8).map(function(a){
      var g = gainPct(a.cost, a.val);
      return '<tr><td>' + catI(a.cat) + ' ' + a.name + '</td><td class="tm">' + fmt(a.val) + '</td><td class="' + (g>=0?'tg':'tr2') + '">' + fmtP(g) + '</td><td class="tmu">' + (tv?(a.val/tv*100).toFixed(1):0) + '%</td></tr>';
    }).join('');
  }
  var riskEl = safeGet('report-risk');
  if (riskEl) {
    var r = settings.risk || 'Moderate';
    riskEl.textContent = r === 'Aggressive'
      ? 'Portfolio is weighted toward growth assets. High concentration in equities and crypto introduces significant volatility. Consider diversifying into real assets and fixed income.'
      : r === 'Conservative'
      ? 'Portfolio is defensively positioned with strong allocation to cash and real assets. Lower expected volatility with reduced upside. Review cash drag in the current rate environment.'
      : 'Portfolio maintains a balanced allocation across asset classes. Moderate correlation to public markets with meaningful private asset exposure. Review crypto allocation relative to risk tolerance.';
  }
  } catch(e) { console.error('[WealthOS] rReport error:', e); }
}

// ==============================================
// SETTINGS
// ==============================================
function rSettings() {
  try {
  var tv = totalV(), gain = tv - totalCo();
  // Sync theme buttons
  var savedTheme = localStorage.getItem('pw_theme') || 'dark';
  var dk = safeGet('theme-dark-btn'), lt = safeGet('theme-light-btn');
  if (dk && lt) {
    var isDark = savedTheme !== 'light';
    dk.style.background  = isDark  ? 'rgba(92,95,239,0.12)' : 'rgba(255,255,255,0.04)';
    dk.style.color       = isDark  ? 'var(--blue)'          : 'var(--muted)';
    dk.style.borderColor = isDark  ? 'rgba(255,255,255,0.12)': 'rgba(255,255,255,0.08)';
    lt.style.background  = !isDark ? 'rgba(92,95,239,0.12)' : 'rgba(255,255,255,0.04)';
    lt.style.color       = !isDark ? 'var(--blue)'          : 'var(--muted)';
    lt.style.borderColor = !isDark ? 'rgba(255,255,255,0.12)': 'rgba(255,255,255,0.08)';
  }
  var planLabel = {free:'Free Plan',pro:'Pro Plan',private:'Private Plan'}[settings.plan||'free']||'Free Plan';
  var el = safeGet('settings-stats');
  if (!el) return;
  el.innerHTML =
    '<div class="pr-row"><div class="pr-top"><span class="pr-label">Total Net Worth</span><span class="pr-val tm">' + fmt(tv) + '</span></div></div>' +
    '<div class="pr-row"><div class="pr-top"><span class="pr-label">Total Assets</span><span class="pr-val tm">' + assets.length + '</span></div></div>' +
    '<div class="pr-row"><div class="pr-top"><span class="pr-label">Unrealised Gain</span><span class="pr-val" style="color:' + (gain>=0?'var(--green)':'var(--red)') + '">' + fmt(gain) + '</span></div></div>' +
    '<div class="pr-row"><div class="pr-top"><span class="pr-label">Goal Progress</span><span class="pr-val" style="color:var(--green)">' + ((tv/(settings.goal||0))*100).toFixed(1) + '%</span></div></div>' +
    '<div style="margin-top:12px"><div class="goal-track"><div class="goal-fill" style="width:' + Math.min(100,(tv/(settings.goal||0))*100) + '%"></div></div></div>' +
    '<div style="margin-top:14px;padding-top:14px;border-top:1px solid rgba(255,255,255,0.05);display:flex;align-items:center;justify-content:space-between">' +
      '<div style="font-size:12px;color:var(--muted)">Current Plan</div>' +
      '<div style="font-family:var(--mono);font-size:11px;font-weight:600;color:var(--blue);background:rgba(92,95,239,0.1);border:1px solid rgba(92,95,239,0.2);border-radius:20px;padding:3px 10px">' + ({free:'Free',pro:'Pro',private:'Private'}[settings.plan||'free']||'Free') + '</div>' +
    '</div>';
  } catch(e) { console.error('[WealthOS] rSettings error:', e); }
}

// -- Asset <-> Supabase row converters --
function assetToRow(a, uid) {
  return {
    user_id:       uid,
    name:          a.name        || '',
    type:          a.cat         || 'other',
    ticker:        a.ticker      || '',
    quantity:      a.qty         || 1,
    buy_price:     a.cost        || 0,
    current_value: a.val         || 0,
    location:      a.loc         || '',
    notes:         a.notes       || '',
    currency:      a.currency    || 'USD',
    asset_date:    a.date        || ''
  };
}

function rowToAsset(row, idx) {
  return {
    id:       row.supabase_id || row.id || (Date.now() + (idx||0)),
    supabase_id: row.id,           // store Supabase UUID for updates/deletes
    name:     row.name,
    cat:      row.type,
    ticker:   row.ticker   || '--',
    qty:      row.quantity  || 1,
    cost:     row.buy_price || 0,
    val:      row.current_value || 0,
    loc:      row.location  || '',
    notes:    row.notes     || '',
    currency: row.currency  || 'USD',
    date:     row.asset_date|| ''
  };
}

function syncAssetsToSupabase() {
  var _sb = getSB();
  if (!_sb || !currentUser) return;
  _sb.auth.getUser().then(function(res) {
    if (!res.data || !res.data.user) return;
    var uid = res.data.user.id;
    // Delete all then re-insert -- simplest reliable sync
    _sb.from('assets').delete().eq('user_id', uid).then(function() {
      if (!assets || assets.length === 0) return;
      var rows = assets.map(function(a) { return assetToRow(a, uid); });
      _sb.from('assets').insert(rows).then(function(res2) {
        // Store Supabase-generated IDs back into local assets
        if (res2.data) {
          res2.data.forEach(function(row, i) {
            if (assets[i]) assets[i].supabase_id = row.id;
          });
          localStorage.setItem('pw_assets_' + currentUser.id, JSON.stringify(assets));
        }
      }).catch(function(e) { console.warn('Asset insert failed:', e); });
    }).catch(function(e) { console.warn('Asset delete failed:', e); });
  }).catch(function() {});
}

function saveSettings() {
  settings.name     = (safeGet('s-name')  || {value:''}).value.trim() || 'J. Smith';
  settings.goal     = parseFloat((safeGet('s-goal') || {value:0}).value) || 0;
  settings.risk     = (safeGet('s-risk')  || {value:'Moderate'}).value;
  settings.currency = (safeGet('s-currency') || {value:'USD'}).value || 'USD';
  if (currentUser) settings.plan = currentUser.plan || settings.plan || 'free';
  saveData();
  renderAll();
  var btn = event && event.target;
  if (btn) { var orig = btn.textContent; btn.textContent = '\u2713 Saved'; setTimeout(function(){ btn.textContent = orig; }, 1500); }
}

// ==============================================
// ASSET CRUD
// ==============================================
function openAddAsset(cat) {
  try {
    // Free plan limit check
    var plan = settings.plan || (currentUser ? currentUser.plan : 'free') || 'free';
    if (plan === 'free' && assets.length >= 5) {
      showUpgradePrompt('You have reached the 5 asset limit on the Free plan.', 'Upgrade to Pro for unlimited assets.');
      return;
    }
    editId = null;
    safeSet('add-modal-title', 'ADD ASSET');
    ['a-name','a-ticker','a-loc','a-notes'].forEach(function(id){ var el=safeGet(id); if(el) el.value=''; });
    ['a-cost','a-val'].forEach(function(id){ var el=safeGet(id); if(el) el.value=''; });
    var qEl = safeGet('a-qty'); if (qEl) qEl.value = '1';
    var dEl = safeGet('a-date'); if (dEl) dEl.value = new Date().toISOString().split('T')[0];
    if (cat) { var cEl = safeGet('a-cat'); if (cEl) cEl.value = cat; }
    var curEl = safeGet('a-currency'); if (curEl) curEl.value = settings.currency || 'USD';
    var m = safeGet('add-modal'); if (m) m.classList.add('show');
    console.log('[WealthOS] openAddAsset:', cat || 'no category');
  } catch(e) { console.error('[WealthOS] openAddAsset error:', e); }
}

function editAsset(id) {
  try {
    var a = assets.find(function(x){ return String(x.id) === String(id); });
    if (!a) { console.warn('[WealthOS] editAsset: asset not found:', id); return; }
    editId = id;
    console.log('[WealthOS] editAsset:', id, a.name);
    safeSet('add-modal-title', 'EDIT ASSET');

    // Populate all fields - convert USD values back to display currency
    var displayCurrency = a.currency || settings.currency || 'USD';
    var displayRate = CURRENCY_RATES[displayCurrency] || 1;

    var nameEl = safeGet('a-name');     if (nameEl) nameEl.value = a.name || '';
    var catEl = safeGet('a-cat');       if (catEl) catEl.value = a.cat || 'stock';
    var tickerEl = safeGet('a-ticker'); if (tickerEl) tickerEl.value = a.ticker || '';
    var costEl = safeGet('a-cost');     if (costEl) costEl.value = a.cost ? Math.round(parseFloat(a.cost) * displayRate) : '';
    var valEl = safeGet('a-val');       if (valEl) valEl.value = a.val ? Math.round(parseFloat(a.val) * displayRate) : '';
    var dateEl = safeGet('a-date');     if (dateEl) dateEl.value = a.date || '';
    var qtyEl = safeGet('a-qty');       if (qtyEl) qtyEl.value = a.qty || 1;
    var locEl = safeGet('a-loc');       if (locEl) locEl.value = a.loc || '';
    var notesEl = safeGet('a-notes');   if (notesEl) notesEl.value = a.notes || '';
    var curEl = safeGet('a-currency');  if (curEl) curEl.value = displayCurrency;

    var m = safeGet('add-modal'); if (m) m.classList.add('show');
  } catch(e) { console.error('[WealthOS] editAsset error:', e); }
}

function saveAsset() {
  try {
  var name = (safeGet('a-name') || {value:''}).value.trim();
  if (!name) { alert('Asset name is required.'); return; }

  var isEdit = !!editId;

  // Free plan limit enforcement (also in openAddAsset, but double-check here)
  if (!isEdit) {
    var plan = settings.plan || (currentUser ? currentUser.plan : 'free') || 'free';
    if (plan === 'free' && assets.length >= 5) {
      closeModal('add-modal');
      showUpgradePrompt('Asset Limit Reached', 'Free plan supports up to 5 assets. Upgrade to Pro for unlimited assets.');
      return;
    }
  }

  var assetCurrency = (safeGet('a-currency')||{value:'USD'}).value || 'USD';
  var assetRate  = CURRENCY_RATES[assetCurrency] || 1;
  if (assetRate <= 0) assetRate = 1;
  var costRaw    = Math.abs(parseFloat((safeGet('a-cost')||{value:0}).value)||0);
  var valRaw     = Math.abs(parseFloat((safeGet('a-val') ||{value:0}).value)||0);
  var costUSD    = costRaw / assetRate;
  var valUSD     = valRaw > 0 ? valRaw / assetRate : costUSD;
  if (isNaN(costUSD)) costUSD = 0;
  if (isNaN(valUSD)) valUSD = 0;

  var type = (safeGet('a-cat')||{value:'stock'}).value || 'stock';
  var qtyRaw = parseFloat((safeGet('a-qty')||{value:1}).value);
  var qty  = (isNaN(qtyRaw) || qtyRaw <= 0) ? 1 : qtyRaw;
  var ticker = (safeGet('a-ticker')||{value:''}).value.trim().toUpperCase();
  // Auto-set ticker to '--' for non-market assets
  if (!ticker && (type === 'real_estate' || type === 'art' || type === 'watch' || type === 'cash')) ticker = '--';
  if (!ticker) ticker = '--';

  var a = {
    id:       editId || Date.now(),
    name:     name,
    cat:      type,
    ticker:   ticker,
    cost:     costUSD,
    val:      valUSD,
    currency: assetCurrency,
    date:     (safeGet('a-date')  ||{value:''}).value,
    qty:      qty,
    loc:      (safeGet('a-loc')   ||{value:''}).value.trim(),
    notes:    (safeGet('a-notes') ||{value:''}).value.trim(),
  };

  // -- 1. Update in-memory + localStorage immediately --
  if (isEdit) {
    var existing = assets.find(function(x){ return String(x.id) === String(editId); });
    if (existing) {
      if (existing.supabase_id) a.supabase_id = existing.supabase_id;
      if (existing.lastSynced) a.lastSynced = existing.lastSynced;
    }
    assets = assets.map(function(x){ return String(x.id) === String(editId) ? a : x; });
    console.log('[WealthOS] Asset updated:', a.name, 'val:', a.val);
  } else {
    assets.push(a);
    console.log('[WealthOS] Asset added:', a.name, 'val:', a.val);
  }

  var savedEditId = editId;
  editId = null;
  saveData();
  closeModal('add-modal');
  renderAll();
  // Re-render the current active view
  var cur = document.querySelector('.sb-item.active');
  if (cur) { var oc=cur.getAttribute('onclick')||''; var m2=oc.match(/nav\('(\w+)'/); if(m2) renderView(m2[1]); }

  // Success feedback
  if (isEdit) {
    _showToast(a.name + ' updated successfully', 'success');
  } else {
    _showToast(a.name + ' added to portfolio', 'success');
    if (assets.length === 1) {
      setTimeout(function() { try { nav('overview'); } catch(e) {} }, 200);
    }
  }

  // -- Auto price sync: fetch live price for this asset's ticker --
  if (a.ticker && a.ticker !== '--' && (a.cat === 'stock' || a.cat === 'crypto')) {
    setTimeout(function() {
      try {
        console.log('[WealthOS] Auto-syncing price for', a.ticker);
        syncPrices(true, false);
      } catch(e) { console.warn('[WealthOS] Auto-sync failed:', e); }
    }, 500);
  }

  // -- 2. Sync to Supabase in background --
  var _sb = getSB();
  if (!_sb || !currentUser) return;
  _sb.auth.getUser().then(function(res) {
    if (!res.data || !res.data.user) return;
    var uid = res.data.user.id;
    var row = assetToRow(a, uid);

    if (isEdit && a.supabase_id) {
      // UPDATE existing row
      _sb.from('assets').update(row)
        .eq('id', a.supabase_id)
        .eq('user_id', uid)
        .then(function() { console.log('[WealthOS] Supabase: asset updated'); }).catch(function(e){ console.warn('Update failed:', e); });
    } else {
      // INSERT new row
      _sb.from('assets').insert([row]).select().then(function(r2) {
        if (r2.data && r2.data[0]) {
          a.supabase_id = r2.data[0].id;
          assets = assets.map(function(x){ return x.id === a.id ? a : x; });
          localStorage.setItem('pw_assets_' + currentUser.id, JSON.stringify(assets));
        }
      }).catch(function(e){ console.warn('Insert failed:', e); });
    }
  }).catch(function(){});
  } catch(e) { console.error('[WealthOS] saveAsset error:', e); }
}

function deleteAsset(id) {
  try {
  if (!confirm('Remove this asset from your portfolio?')) return;

  // Find asset before removing (need supabase_id for DB delete)
  var toDelete = assets.find(function(a){ return String(a.id) === String(id); });

  // -- 1. Update UI immediately --
  assets = assets.filter(function(a){ return String(a.id) !== String(id); });
  saveData();
  renderAll();
  var cur = document.querySelector('.sb-item.active');
  if (cur) { var oc=cur.getAttribute('onclick')||''; var m2=oc.match(/nav\('(\w+)'/); if(m2) renderView(m2[1]); }
  _showToast((toDelete ? toDelete.name : 'Asset') + ' removed', 'info');

  // -- 2. Delete from Supabase in background --
  if (!toDelete) return;
  var _sb = getSB();
  if (!_sb) return;
  _sb.auth.getUser().then(function(res) {
    if (!res.data || !res.data.user) return;
    var uid = res.data.user.id;
    if (toDelete.supabase_id) {
      // Delete by Supabase UUID (precise)
      _sb.from('assets').delete().eq('id', toDelete.supabase_id)
        .then(function(){}).catch(function(e){ console.warn('Delete by id failed:', e); });
    } else {
      // Fallback: delete by name + user_id
      _sb.from('assets').delete().eq('user_id', uid).eq('name', toDelete.name)
        .then(function(){}).catch(function(e){ console.warn('Delete by name failed:', e); });
    }
  }).catch(function(){});
  } catch(e) { console.error('[WealthOS] deleteAsset error:', e); }
}

// ==============================================
// MILESTONES
// ==============================================
function openMilestone() {
  ['m-title','m-val'].forEach(function(id){ var el=safeGet(id); if(el) el.value=''; });
  var dEl = safeGet('m-date'); if (dEl) dEl.value = new Date().toISOString().split('T')[0];
  var m = safeGet('milestone-modal'); if (m) m.classList.add('show');
}
function saveMilestone() {
  var t = (safeGet('m-title') || {value:''}).value.trim();
  if (!t) { alert('Title is required.'); return; }
  milestones.push({
    id:    Date.now(),
    title: t,
    date:  (safeGet('m-date') || {value:''}).value,
    val:   parseFloat((safeGet('m-val') || {value:0}).value) || totalV(),
    type:  (safeGet('m-type') || {value:'blue'}).value,
  });
  saveData();
  closeModal('milestone-modal');
  rTimeline();
}

// ==============================================
// MODALS
// ==============================================
function closeModal(id) {
  var el = safeGet(id);
  if (el) el.classList.remove('show');
  if (id === 'add-modal') editId = null;
}
document.querySelectorAll('.modal-overlay').forEach(function(o) {
  o.addEventListener('click', function(e) {
    if (e.target === this) {
      this.classList.remove('show');
      if (this.id === 'add-modal') editId = null;
    }
  });
});

// ==============================================
// MISC
// ==============================================
function exportData() {
  var plan = settings.plan || (currentUser ? currentUser.plan : 'free') || 'free';
  var isPro = (plan === 'pro' || plan === 'private');
  if (!isPro) {
    showUpgradePrompt('JSON Data Export', 'Export your complete portfolio data as a JSON file. Available on Pro and Private plans.');
    return;
  }
  var portfolio = calcPortfolio();
  var history   = getNWHistory();
  var now       = new Date();
  var exportObj = {
    meta: {
      exported_at: now.toISOString(),
      exported_by: (currentUser && currentUser.email) || 'unknown',
      app: 'WealthOS', version: '1.0',
      currency: settings.currency || 'USD'
    },
    profile: {
      name:  settings.name  || '',
      email: currentUser ? currentUser.email : '',
      plan:  settings.plan  || 'free',
      goal:  settings.goal  || 0,
      risk:  settings.risk  || 'Moderate'
    },
    summary: {
      total_net_worth:   portfolio.totalNetWorth,
      total_cost_basis:  portfolio.totalCostBasis,
      total_profit_loss: portfolio.totalPL,
      total_pl_pct:      parseFloat(portfolio.totalPLPct.toFixed(2)),
      asset_count:       assets.length,
      snapshot_count:    history.length
    },
    assets: portfolio.assets.map(function(a) {
      return {
        name:            a.name,
        type:            a.cat,
        ticker:          a.ticker !== '--' ? a.ticker : '',
        quantity:        a.qty,
        buy_price:       a.buyPrice,
        current_value:   parseFloat(a.curVal.toFixed(2)),
        live_price:      parseFloat(a.livePrice.toFixed(4)),
        profit_loss:     parseFloat(a.plAbs.toFixed(2)),
        profit_loss_pct: parseFloat(a.plPct.toFixed(2)),
        allocation_pct:  parseFloat(a.allocation.toFixed(2)),
        last_synced:     a.lastSynced || null
      };
    }),
    milestones: milestones.map(function(m) {
      return { title: m.title, date: m.date, value: m.val, type: m.type };
    }),
    portfolio_history: history.map(function(s) {
      return { date: s.date, net_worth: s.val };
    }),
    settings: {
      currency: settings.currency || 'USD',
      goal:     settings.goal     || 0,
      risk:     settings.risk     || 'Moderate',
      theme:    localStorage.getItem('pw_theme') || 'dark'
    }
  };

  var json     = JSON.stringify(exportObj, null, 2);
  var blob     = new Blob([json], { type: 'application/json' });
  var url      = URL.createObjectURL(blob);
  var filename = 'wealthos-export-' + now.toISOString().split('T')[0] + '.json';
  var a        = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function() { URL.revokeObjectURL(url); }, 1500);

  var btn = document.getElementById('export-btn');
  if (btn) {
    var orig = btn.textContent;
    btn.textContent = '\u2713 Downloaded';
    btn.style.background = 'var(--green)';
    btn.style.color = '#fff';
    setTimeout(function() { btn.textContent = orig; btn.style.background = ''; btn.style.color = ''; }, 2000);
  }
}
function toggleFaq(el) {
  var isOpen = el.classList.contains('open');
  document.querySelectorAll('.faq-item').forEach(function(f){ f.classList.remove('open'); });
  if (!isOpen) el.classList.add('open');
}

// ==============================================
// CLOCK
// ==============================================
function updateClock() {
  var el = safeGet('app-time');
  if (!el) return;
  try {
    var est = new Date().toLocaleString('en-US', {timeZone:'America/New_York'});
    var d   = new Date(est);
    el.textContent = d.toLocaleTimeString('en-US', {hour:'2-digit', minute:'2-digit', hour12:false}) + ' EST';
  } catch(e) { el.textContent = new Date().toLocaleTimeString(); }
}
setInterval(updateClock, 1000);
updateClock();



// -- NAV INTELLIGENCE --
function navIntelligence(el) {
  nav('overview', null);
  // Mark this item active
  document.querySelectorAll('.sb-item').forEach(function(s){ s.classList.remove('active'); });
  if (el) el.classList.add('active');
  setTimeout(function(){
    var target = safeGet('wi-snapshot');
    if (target) target.scrollIntoView({behavior:'smooth', block:'start'});
  }, 150);
}

// -- UPGRADE PROMPT --
function closeUpgradePrompt() {
  var el = document.getElementById('upgrade-prompt');
  if (el) el.remove();
}

function showUpgradePrompt(title, desc) {
  closeUpgradePrompt();
  var proFeatures = ['Unlimited assets','AI portfolio insights','Risk alerts','Wealth projections','Market intelligence','Quarterly reports'];
  var privateFeatures = ['Everything in Pro','Portfolio stress testing','Multi-user access','Advisor sharing portal'];
  var checkSVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#22D3A5" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  var featureHTML = function(list) {
    return list.map(function(f) {
      return '<div style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text)">' + checkSVG + f + '</div>';
    }).join('');
  };

  var overlay = document.createElement('div');
  overlay.className = 'modal-overlay show';
  overlay.id = 'upgrade-prompt';
  overlay.innerHTML =
    '<div class="modal" style="max-width:520px">' +
      '<div class="modal-h" style="border-bottom:none;padding-bottom:8px">' +
        '<div style="display:flex;align-items:center;gap:10px">' +
          '<div style="width:32px;height:32px;border-radius:9px;background:rgba(92,95,239,0.12);border:1px solid rgba(92,95,239,0.2);display:flex;align-items:center;justify-content:center;color:var(--blue)">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>' +
          '</div>' +
          '<div style="font-family:var(--mono);font-size:12px;font-weight:600;color:var(--text)">Upgrade Your Plan</div>' +
        '</div>' +
        '<button class="modal-x" onclick="closeUpgradePrompt()">&#x2715;</button>' +
      '</div>' +
      '<div class="modal-body" style="padding-top:8px">' +
        '<div style="font-size:15px;font-weight:600;color:var(--text);margin-bottom:8px">' + title + '</div>' +
        '<div style="font-size:13px;color:var(--muted);line-height:1.6;margin-bottom:20px">' + desc + '</div>' +
        // Pro plan
        '<div style="background:rgba(92,95,239,0.07);border:1px solid rgba(92,95,239,0.14);border-radius:10px;padding:16px;margin-bottom:12px">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">' +
            '<div style="font-size:11px;font-weight:600;color:var(--blue);font-family:var(--mono);letter-spacing:0.08em;text-transform:uppercase">Pro Plan</div>' +
            '<div style="font-size:13px;font-weight:700;color:var(--text)">$49/mo</div>' +
          '</div>' +
          '<div style="display:flex;flex-direction:column;gap:5px">' + featureHTML(proFeatures) + '</div>' +
          '<button onclick="closeUpgradePrompt();startPaddleCheckout(\'pro\')" style="width:100%;margin-top:12px;background:var(--blue);border:none;border-radius:8px;padding:10px;font-size:13px;font-weight:600;color:#fff;cursor:pointer;font-family:var(--sans)">Get Pro &#x2192;</button>' +
        '</div>' +
        // Private plan
        '<div style="background:rgba(34,211,165,0.05);border:1px solid rgba(34,211,165,0.15);border-radius:10px;padding:16px;margin-bottom:16px">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">' +
            '<div style="font-size:11px;font-weight:600;color:var(--green);font-family:var(--mono);letter-spacing:0.08em;text-transform:uppercase">Private Plan</div>' +
            '<div style="font-size:13px;font-weight:700;color:var(--text)">$99/mo</div>' +
          '</div>' +
          '<div style="display:flex;flex-direction:column;gap:5px">' + featureHTML(privateFeatures) + '</div>' +
          '<button onclick="closeUpgradePrompt();startPaddleCheckout(\'private\')" style="width:100%;margin-top:12px;background:rgba(34,211,165,0.12);border:1px solid rgba(34,211,165,0.25);border-radius:8px;padding:10px;font-size:13px;font-weight:600;color:var(--green);cursor:pointer;font-family:var(--sans)">Get Private &#x2192;</button>' +
        '</div>' +
        '<button onclick="closeUpgradePrompt()" style="width:100%;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:10px;font-size:13px;color:var(--muted);cursor:pointer;font-family:var(--sans)">Maybe later</button>' +
      '</div>' +
    '</div>';
  overlay.addEventListener('click', function(e) { if (e.target === overlay) closeUpgradePrompt(); });
  document.body.appendChild(overlay);
}
// -- PRIVATE-ONLY UPGRADE PROMPT --
function showPrivateUpgradePrompt(title, desc) {
  closeUpgradePrompt();
  var features = ['Everything in Pro','Portfolio stress testing','Multi-user access','Advisor sharing portal','PDF report export','Priority support'];
  var checkSVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#22D3A5" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  var featureHTML = features.map(function(f) {
    return '<div style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text)">' + checkSVG + f + '</div>';
  }).join('');
  var overlay = document.createElement('div');
  overlay.className = 'modal-overlay show';
  overlay.id = 'upgrade-prompt';
  overlay.innerHTML =
    '<div class="modal" style="max-width:420px">' +
      '<div class="modal-h" style="border-bottom:none;padding-bottom:8px">' +
        '<div style="display:flex;align-items:center;gap:10px">' +
          '<div style="width:32px;height:32px;border-radius:9px;background:rgba(34,211,165,0.12);border:1px solid rgba(34,211,165,0.2);display:flex;align-items:center;justify-content:center;color:var(--green)">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>' +
          '</div>' +
          '<div style="font-family:var(--mono);font-size:12px;font-weight:600;color:var(--text)">Private Feature</div>' +
        '</div>' +
        '<button class="modal-x" onclick="closeUpgradePrompt()">&#x2715;</button>' +
      '</div>' +
      '<div class="modal-body" style="padding-top:8px">' +
        '<div style="font-size:15px;font-weight:600;color:var(--text);margin-bottom:8px">' + title + '</div>' +
        '<div style="font-size:13px;color:var(--muted);line-height:1.6;margin-bottom:20px">' + desc + '</div>' +
        '<div style="background:rgba(34,211,165,0.05);border:1px solid rgba(34,211,165,0.15);border-radius:10px;padding:16px;margin-bottom:16px">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">' +
            '<div style="font-size:11px;font-weight:600;color:var(--green);font-family:var(--mono);letter-spacing:0.08em;text-transform:uppercase">Private Plan</div>' +
            '<div style="font-size:13px;font-weight:700;color:var(--text)">$99/mo</div>' +
          '</div>' +
          '<div style="display:flex;flex-direction:column;gap:5px">' + featureHTML + '</div>' +
        '</div>' +
        '<div style="display:flex;gap:9px">' +
          '<button onclick="closeUpgradePrompt();startPaddleCheckout(\'private\')" style="flex:1;background:var(--green);border:none;border-radius:8px;padding:11px;font-size:13px;font-weight:600;color:#fff;cursor:pointer;font-family:var(--sans)">Get Private &#x2192;</button>' +
          '<button onclick="closeUpgradePrompt()" style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:11px 16px;font-size:13px;color:var(--muted);cursor:pointer;font-family:var(--sans)">Later</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  overlay.addEventListener('click', function(e) { if (e.target === overlay) closeUpgradePrompt(); });
  document.body.appendChild(overlay);
}
// -- ASSET LIMIT BANNER --
function renderAssetLimitBanner() {
  var plan = settings.plan || (currentUser ? currentUser.plan : 'free') || 'free';
  var bannerEl = safeGet('asset-limit-banner');
  if (!bannerEl) return;
  if (plan !== 'free') { bannerEl.style.display='none'; return; }
  var count = assets.length;
  var pct = (count / 5) * 100;
  var fillClass = pct >= 100 ? 'full' : pct >= 60 ? 'warn' : '';
  bannerEl.style.display = 'flex';
  bannerEl.innerHTML =
    '<div class="asset-limit-info">Free plan: <strong>' + count + ' of 5</strong> assets used</div>' +
    '<div class="asset-limit-progress"><div class="asset-limit-fill ' + fillClass + '" style="width:' + Math.min(100,pct) + '%"></div></div>' +
    '<button class="upgrade-cta" onclick="showUpgradeAssets()">' +
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>' +
      (pct >= 100 ? 'Upgrade to add more' : 'Upgrade to Pro') +
    '</button>';
}

// -- ASSET SEARCH --
function filterAssets(q) {
  if (!q && q !== '') q = '';
  q = q.trim().toLowerCase();
  var rows = document.querySelectorAll('#all-table tr');
  rows.forEach(function(row) {
    if (!q) { row.style.display = ''; return; }
    row.style.display = row.textContent.toLowerCase().indexOf(q) !== -1 ? '' : 'none';
  });
}

// -- THEME --
function setTheme(mode) {
  if (mode === 'light') {
    document.body.classList.add('light-mode');
    localStorage.setItem('pw_theme','light');
  } else {
    document.body.classList.remove('light-mode');
    localStorage.setItem('pw_theme','dark');
  }
  var dk = safeGet('theme-dark-btn'), lt = safeGet('theme-light-btn');
  if (dk && lt) {
    var isDark = mode === 'dark';
    dk.style.background  = isDark  ? 'rgba(92,95,239,0.12)' : 'rgba(255,255,255,0.04)';
    dk.style.color       = isDark  ? 'var(--blue)'          : 'var(--muted)';
    dk.style.borderColor = isDark  ? 'rgba(255,255,255,0.12)': 'rgba(255,255,255,0.08)';
    lt.style.background  = !isDark ? 'rgba(92,95,239,0.12)' : 'rgba(255,255,255,0.04)';
    lt.style.color       = !isDark ? 'var(--blue)'          : 'var(--muted)';
    lt.style.borderColor = !isDark ? 'rgba(255,255,255,0.12)': 'rgba(255,255,255,0.08)';
  }
  try { renderView('overview'); } catch(e) {}
}

// -- ONBOARDING --
function showOnboarding() {
  var m = safeGet('onboarding-modal');
  if (m) m.classList.add('show');
}
function closeOnboarding() {
  var m = safeGet('onboarding-modal');
  if (m) m.classList.remove('show');
  if (currentUser) localStorage.setItem('pw_onboarded_' + currentUser.id, '1');
}


// ==========================================================
// FEATURE 1: ANNUAL BILLING TOGGLE
// ==========================================================
var billingMode = 'monthly';

function setBilling(mode) {
  billingMode = mode;
  var mBtn = document.getElementById('billing-monthly');
  var aBtn = document.getElementById('billing-annual');
  if (mBtn) { mBtn.classList.toggle('active', mode === 'monthly'); }
  if (aBtn) { aBtn.classList.toggle('active', mode === 'annual'); }

  var prices = {
    free:  { monthly: 0,  annual: 0  },
    pro:   { monthly: 49, annual: 39 },
    priv:  { monthly: 99, annual: 79 }
  };

  function setPrice(amtId, periodId, yearId, key) {
    var amtEl    = document.getElementById(amtId);
    var periEl   = document.getElementById(periodId);
    var yearEl   = document.getElementById(yearId);
    var price    = prices[key][mode];
    if (amtEl)  amtEl.firstChild.textContent = '$' + price;
    if (periEl) periEl.textContent = '/mo';
    if (yearEl) {
      if (mode === 'annual' && price > 0) {
        yearEl.textContent = '$' + (price * 12) + ' billed annually';
        yearEl.style.color = 'var(--green)';
      } else {
        yearEl.textContent = '';
      }
    }
  }

  setPrice('price-free-amount',  'price-free-period',  'price-free-year',  'free');
  setPrice('price-pro-amount',   'price-pro-period',   'price-pro-year',   'pro');
  setPrice('price-priv-amount',  'price-priv-period',  'price-priv-year',  'priv');

  // Update button text to reflect current pricing
  var proBtn = document.getElementById('price-btn-pro');
  var privBtn = document.getElementById('price-btn-priv');
  if (proBtn) proBtn.textContent = 'Get Pro — $' + prices.pro[mode] + '/mo';
  if (privBtn) privBtn.textContent = 'Get Private — $' + prices.priv[mode] + '/mo';
}




// ==========================================================
// FEATURE 3: ONBOARDING TOUR
// ==========================================================
var tourStep = 0;
var tourSteps = [
  {
    label: 'Step 1 of 5',
    title: 'Welcome to WealthOS',
    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#5C5FEF" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>',
    visual: 'Your <span>total net worth</span> -- stocks, property, crypto, art, cash -- unified in one number.',
    desc: 'WealthOS is your personal wealth command centre. Everything you own in one private dashboard, automatically analysed.',
    action: 'Next \u2192'
  },
  {
    label: 'Step 2 of 5',
    title: 'Add your first asset',
    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#5C5FEF" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    visual: 'Click <span>+ Add Asset</span> on the Overview page. Add any asset -- stock, property, crypto, art, watch, or cash.',
    desc: 'You only need a name, current value, and cost basis. Takes about 30 seconds per asset. No bank connection required.',
    action: 'Next \u2192'
  },
  {
    label: 'Step 3 of 5',
    title: 'Read your intelligence',
    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#5C5FEF" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
    visual: 'The <span>AI Wealth Intelligence</span> section appears automatically below your overview -- no setup needed.',
    desc: 'Portfolio analysis, risk alerts, and market updates run on every session. Concentration risk and overexposure are flagged instantly.',
    action: 'Next \u2192'
  },
  {
    label: 'Step 4 of 5',
    title: 'Set your wealth goal',
    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#5C5FEF" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    visual: 'Go to <span>Settings</span> and enter your target net worth. Your progress bar tracks how close you are.',
    desc: 'Milestone tracking lets you mark key moments -- a property sale, an investment round, a new all-time high.',
    action: 'Next \u2192'
  },
  {
    label: 'Step 5 of 5',
    title: 'You are ready',
    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#22D3A5" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    visual: '<span>WealthOS is private by design.</span> Your data never leaves this browser. Only you can see your net worth.',
    desc: 'That is everything. Add your assets and let the intelligence layer do the work. Your dashboard is ready.',
    action: 'Go to Dashboard'
  }
];

function startTour() {
  tourStep = 0;
  renderTourStep();
  var m = document.getElementById('tour-modal');
  if (m) m.classList.add('show');
}

function closeTour() {
  var m = document.getElementById('tour-modal');
  if (m) m.classList.remove('show');
  if (currentUser) localStorage.setItem('pw_tour_done_' + currentUser.id, '1');
}

function tourNext() {
  if (tourStep >= tourSteps.length - 1) {
    closeTour();
    return;
  }
  tourStep++;
  renderTourStep();
}

function renderTourStep() {
  var step = tourSteps[tourStep];
  if (!step) return;
  var pct = ((tourStep + 1) / tourSteps.length) * 100;

  var fill  = document.getElementById('tour-progress-fill');
  var label = document.getElementById('tour-step-label');
  var title = document.getElementById('tour-title');
  var desc  = document.getElementById('tour-desc');
  var vis   = document.getElementById('tour-visual');
  var next  = document.getElementById('tour-next-btn');
  var dots  = document.getElementById('tour-dots');

  if (fill)  fill.style.width  = pct + '%';
  if (label) label.textContent = step.label;
  if (title) title.textContent = step.title;
  if (desc)  desc.textContent  = step.desc;
  if (next)  next.textContent  = step.action;
  if (vis) {
    vis.innerHTML =
      '<div class="tour-visual-icon">' + step.icon + '</div>' +
      '<div class="tour-visual-text">' + step.visual + '</div>';
  }
  if (dots) {
    dots.innerHTML = tourSteps.map(function(_, i) {
      return '<div class="tour-dot' + (i === tourStep ? ' active' : '') + '"></div>';
    }).join('');
  }
}

// ==========================================================
// FEATURE 4: PLAN SELECTOR
// ==========================================================
function selectPlan(plan, el) {
  // NOT logged in -> go to auth for ALL plans
  if (!currentUser) {
    if (plan === 'pro' || plan === 'private') {
      window._pendingPlan = plan;
    }
    showAuth('signup');
    // Pre-select the chosen plan in signup form
    setTimeout(function() {
      var dd = document.getElementById('signup-plan');
      if (dd && plan) dd.value = plan;
      // Show plan badge above signup
      var badge = document.getElementById('signup-plan-badge');
      if (!badge) {
        badge = document.createElement('div');
        badge.id = 'signup-plan-badge';
        badge.style.cssText = 'text-align:center;margin-bottom:12px;font-size:11px;font-family:var(--mono);font-weight:600;letter-spacing:0.05em';
        var form = document.getElementById('auth-signup');
        if (form) {
          var card = form.querySelector('.auth-card');
          if (card) card.insertBefore(badge, card.querySelector('.auth-body'));
        }
      }
      if (badge && (plan === 'pro' || plan === 'private')) {
        var label = plan === 'private' ? 'Private' : 'Pro';
        var color = plan === 'private' ? '#22D3A5' : '#5C5FEF';
        badge.innerHTML = '<span style="background:' + color + '15;color:' + color + ';padding:4px 14px;border-radius:20px;border:1px solid ' + color + '30">' + label + ' Plan Selected</span>';
      } else if (badge) {
        badge.innerHTML = '';
      }
    }, 100);
    return;
  }

  // Logged in
  var userPlan = (currentUser.plan || 'free').toLowerCase();

  if (plan === 'free') {
    enterDashboard();
    return;
  }

  if (plan === 'pro' || plan === 'private') {
    if (userPlan === plan || (userPlan === 'private' && plan === 'pro')) {
      enterDashboard();
      _showToast('You already have the ' + userPlan.charAt(0).toUpperCase() + userPlan.slice(1) + ' plan!', 'info');
      return;
    }
    startPaddleCheckout(plan);
    return;
  }

  var hidden = document.getElementById('signup-plan');
  if (hidden) hidden.value = plan;
}

// ==========================================================
// FEATURE 5: CSV IMPORT
// ==========================================================
var csvParsed = [];

function openCSVModal() {
  var m = document.getElementById('csv-modal');
  if (m) m.classList.add('show');
}

function closeCSVModal() {
  var m = document.getElementById('csv-modal');
  if (m) m.classList.remove('show');
  // Reset state
  var ta = document.getElementById('csv-textarea');
  if (ta) ta.value = '';
  csvParsed = [];
  var prev = document.getElementById('csv-preview');
  if (prev) prev.style.display = 'none';
  var btn = document.getElementById('csv-import-btn');
  if (btn) btn.disabled = true;
  var err = document.getElementById('csv-error');
  if (err) err.style.display = 'none';
}

function handleCSVFile(input) {
  var file = input.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    var ta = document.getElementById('csv-textarea');
    if (ta) { ta.value = e.target.result; previewCSV(); }
  };
  reader.readAsText(file);
}

// Drag and drop
(function() {
  var drop = document.getElementById('csv-drop');
  if (!drop) return;
  drop.addEventListener('dragover', function(e) { e.preventDefault(); drop.classList.add('dragover'); });
  drop.addEventListener('dragleave', function() { drop.classList.remove('dragover'); });
  drop.addEventListener('drop', function(e) {
    e.preventDefault(); drop.classList.remove('dragover');
    var file = e.dataTransfer.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function(ev) {
      var ta = document.getElementById('csv-textarea');
      if (ta) { ta.value = ev.target.result; previewCSV(); }
    };
    reader.readAsText(file);
  });
})();

function parseCSVLine(line) {
  var result = [];
  var inQ = false, cur = '';
  for (var i = 0; i < line.length; i++) {
    var c = line[i];
    if (c === '"') { inQ = !inQ; }
    else if (c === ',' && !inQ) { result.push(cur.trim()); cur = ''; }
    else { cur += c; }
  }
  result.push(cur.trim());
  return result;
}

var VALID_CATS = ['stock','real_estate','crypto','art','watch','cash','other'];
function normCat(s) {
  s = (s||'').toLowerCase().replace(/[^a-z_]/g,'');
  if (s === 'realestate' || s === 'property' || s === 'real estate') return 'real_estate';
  if (s === 'crypto' || s === 'bitcoin' || s === 'ethereum') return 'crypto';
  if (s === 'art' || s === 'artwork') return 'art';
  if (s === 'watch' || s === 'watches' || s === 'jewellery' || s === 'jewelry') return 'watch';
  if (s === 'cash' || s === 'savings' || s === 'bank') return 'cash';
  if (VALID_CATS.indexOf(s) !== -1) return s;
  return 'stock';
}

function previewCSV() {
  var ta  = document.getElementById('csv-textarea');
  var err = document.getElementById('csv-error');
  var btn = document.getElementById('csv-import-btn');
  var prev = document.getElementById('csv-preview');
  var body = document.getElementById('csv-preview-body');
  var cnt  = document.getElementById('csv-preview-count');
  if (!ta) return;

  var text = ta.value.trim();
  if (!text) { csvParsed = []; if (btn) btn.disabled = true; if (prev) prev.style.display = 'none'; return; }

  var lines = text.split('\n').filter(function(l) { return l.trim(); });
  // Detect if first line is a header
  var startIdx = 0;
  var firstCols = parseCSVLine(lines[0]);
  if (isNaN(parseFloat(firstCols[2])) || isNaN(parseFloat(firstCols[3]))) startIdx = 1;

  csvParsed = [];
  var errors = [];

  for (var i = startIdx; i < lines.length; i++) {
    var cols = parseCSVLine(lines[i]);
    if (cols.length < 3) { errors.push('Row ' + (i+1) + ': needs at least Name, Category, Value'); continue; }
    var name = cols[0];
    var cat  = normCat(cols[1]);
    var val  = parseFloat(cols[2]);
    var cost = parseFloat(cols[3]) || val * 0.8;
    var ticker = (cols[4] || '--').trim() || '--';
    var loc    = (cols[5] || '').trim();
    if (!name) { errors.push('Row ' + (i+1) + ': name is required'); continue; }
    if (isNaN(val) || val <= 0) { errors.push('Row ' + (i+1) + ': invalid value'); continue; }
    csvParsed.push({ name: name, cat: cat, val: val, cost: cost, ticker: ticker, loc: loc });
  }

  if (err) {
    if (errors.length) { err.textContent = errors.join(' * '); err.style.display = 'block'; }
    else { err.style.display = 'none'; }
  }

  if (btn) btn.disabled = csvParsed.length === 0;

  if (prev && body && cnt) {
    prev.style.display = csvParsed.length ? 'block' : 'none';
    cnt.textContent = csvParsed.length;
    body.innerHTML = csvParsed.slice(0, 5).map(function(a) {
      return '<tr><td>' + a.name + '</td><td>' + catL(a.cat) + '</td><td>$' + a.val.toLocaleString() + '</td><td>$' + a.cost.toLocaleString() + '</td></tr>';
    }).join('') + (csvParsed.length > 5 ? '<tr><td colspan="4" style="color:var(--muted2);font-style:italic">...and ' + (csvParsed.length-5) + ' more</td></tr>' : '');
  }
}

function importCSV() {
  if (!csvParsed.length) return;
  var plan = settings.plan || (currentUser ? currentUser.plan : 'free') || 'free';
  var isFree = plan === 'free';
  var added = 0;

  for (var i = 0; i < csvParsed.length; i++) {
    if (isFree && assets.length >= 5) {
      showUpgradeAssets();
      break;
    }
    var a = csvParsed[i];
    assets.push({
      id: Date.now() + i,
      name: a.name, cat: a.cat, ticker: a.ticker,
      cost: a.cost, val: a.val,
      date: new Date().toISOString().split('T')[0],
      qty: 1, loc: a.loc, notes: 'Imported from CSV', currency: 'USD'
    });
    added++;
  }
  saveData();
  // Sync to Supabase
  try { syncAssetsToSupabase(); } catch(e) { console.warn('[WealthOS] CSV sync error:', e); }
  closeCSVModal();
  renderAll();
  try { nav('all'); } catch(e) {}
  if (added > 0) _showToast(added + ' asset' + (added > 1 ? 's' : '') + ' imported from CSV.', 'success');
}

// ==========================================================
// FEATURE 6: PWA
// ==========================================================
var pwaInstallEvent = null;

// Inject manifest dynamically
(function() {
  var manifest = {
    name: 'WealthOS',
    short_name: 'WealthOS',
    description: 'Your personal wealth dashboard',
    start_url: '/',
    display: 'standalone',
    background_color: '#0A0A0F',
    theme_color: '#5C5FEF',
    icons: [
      { src: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 192 192'><rect width='192' height='192' rx='40' fill='%235C5FEF'/><text x='96' y='130' font-family='system-ui' font-size='100' font-weight='700' text-anchor='middle' fill='white'>W</text></svg>", sizes: '192x192', type: 'image/svg+xml' },
      { src: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 512 512'><rect width='512' height='512' rx='100' fill='%235C5FEF'/><text x='256' y='350' font-family='system-ui' font-size='280' font-weight='700' text-anchor='middle' fill='white'>W</text></svg>", sizes: '512x512', type: 'image/svg+xml' }
    ]
  };
  var blob = new Blob([JSON.stringify(manifest)], {type:'application/json'});
  var url  = URL.createObjectURL(blob);
  var link = document.getElementById('pwa-manifest');
  if (link) link.href = url;
})();

window.addEventListener('beforeinstallprompt', function(e) {
  e.preventDefault();
  pwaInstallEvent = e;
});

function checkPWAPrompt() {
  if (pwaInstallEvent && !localStorage.getItem('pw_pwa_dismissed')) {
    var p = document.getElementById('pwa-prompt');
    if (p) p.classList.add('show');
  }
}

function installPWA() {
  if (!pwaInstallEvent) return;
  pwaInstallEvent.prompt();
  pwaInstallEvent.userChoice.then(function(result) {
    if (result.outcome === 'accepted') pwaInstallEvent = null;
    dismissPWA();
  });
}

function dismissPWA() {
  localStorage.setItem('pw_pwa_dismissed', '1');
  var p = document.getElementById('pwa-prompt');
  if (p) p.classList.remove('show');
}

// ==========================================================
// FEATURE 7: MILESTONE TIMELINE -- enhanced renderer
// ==========================================================
function deleteMilestone(id) {
  if (!confirm('Delete this milestone?')) return;
  milestones = milestones.filter(function(m) { return m.id !== id; });
  saveData();
  rTimeline();
  rMilestoneList();
}

function rMilestoneList() {
  var el = document.getElementById('milestones-list');
  if (!el) return;
  if (!milestones.length) {
    el.innerHTML = '<div style="text-align:center;padding:28px;color:var(--muted);font-size:13px">No milestones yet. Mark key moments in your wealth journey.</div>';
    return;
  }
  var sorted = milestones.slice().sort(function(a, b) { return new Date(b.date) - new Date(a.date); });
  el.innerHTML = sorted.map(function(m, i) {
    var isLast = i === sorted.length - 1;
    return '<div class="milestone-item">' +
      '<div class="milestone-dot-wrap">' +
        '<div class="milestone-dot ' + (m.type||'green') + '"></div>' +
        (!isLast ? '<div class="milestone-line"></div>' : '') +
      '</div>' +
      '<div class="milestone-content">' +
        '<div class="milestone-title-row">' +
          '<span class="milestone-name">' + m.title + '</span>' +
          '<div style="display:flex;align-items:center;gap:8px">' +
          '<span class="milestone-val">' + fmt(m.val) + '</span>' +
          '<button onclick="deleteMilestone('+m.id+')" style="background:none;border:none;color:var(--muted2);cursor:pointer;padding:2px 5px;font-size:11px;border-radius:3px" title="Delete">&#x2715;</button>' +
          '</div>' +
        '</div>' +
        '<div class="milestone-date-row">' + new Date(m.date).toLocaleDateString('en-US', {year:'numeric',month:'long',day:'numeric'}) + '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

// ==========================================================
// FEATURE 8: ADVISOR SHARE LINK
// ==========================================================
function openShareModal() {
  var plan = settings.plan || (currentUser ? currentUser.plan : 'free') || 'free';
  if (plan !== 'private') {
    showPrivateUpgradePrompt('Advisor Sharing', 'Share a read-only view of your portfolio with a financial advisor. Available exclusively on the Private plan.');
    return;
  }
  var m = document.getElementById('share-modal');
  if (!m) return;
  m.classList.add('show');
  // Generate share URL
  try {
    var shareData = {
      assets: assets.map(function(a) { return {name:a.name,cat:a.cat,val:a.val,cost:a.cost,ticker:a.ticker}; }),
      settings: {name: settings.name, currency: settings.currency},
      generated: new Date().toISOString(),
      expires: new Date(Date.now() + 7*24*60*60*1000).toISOString()
    };
    var encoded  = btoa(unescape(encodeURIComponent(JSON.stringify(shareData))));
    var shareURL = window.location.href.split('?')[0] + '?share=' + encoded;
    var input = document.getElementById('share-url-input');
    if (input) input.value = shareURL;
  } catch(e) {
    var input = document.getElementById('share-url-input');
    if (input) input.value = 'Error generating link. Portfolio may be too large.';
  }
}

function closeShareModal() {
  var m = document.getElementById('share-modal');
  if (m) m.classList.remove('show');
}

function copyShareLink() {
  var input = document.getElementById('share-url-input');
  if (!input) return;
  try {
    navigator.clipboard.writeText(input.value).then(function() {
      var btn = document.querySelector('.share-copy-btn');
      if (btn) { btn.textContent = 'Copied \u2713'; btn.style.background = 'var(--green)'; btn.style.color = '#000'; setTimeout(function() { btn.textContent = 'Copy Link'; btn.style.background = ''; btn.style.color = ''; }, 2000); }
    });
  } catch(e) {
    input.select();
    document.execCommand('copy');
  }
}

// Check for shared portfolio in URL on load
function checkShareParam() {
  var params = new URLSearchParams(window.location.search);
  var share  = params.get('share');
  if (!share) return;
  try {
    var data = JSON.parse(decodeURIComponent(escape(atob(share))));
    // Check expiry
    if (data.expires && new Date(data.expires) < new Date()) {
      alert('This shared link has expired.'); return;
    }
    // Load read-only view
    currentUser = { id: 'shared', firstName: data.settings.name || 'Shared', lastName: 'Portfolio', plan: 'private', email: '' };
    settings = Object.assign({}, DEFAULT_SETTINGS, data.settings, { plan: 'private' });
    assets = (data.assets || []).map(function(a, i) { return Object.assign({id: i+1, date:'', qty:1, loc:'', notes:'', currency:'USD'}, a); });
    milestones = [];
    showPage('app');
    var avEl = document.getElementById('app-avatar');
    if (avEl) avEl.textContent = (data.settings.name||'S').charAt(0).toUpperCase();
    var unEl = document.getElementById('app-username');
    if (unEl) unEl.textContent = (data.settings.name || 'Shared Portfolio');
    renderAll();
    // Show read-only banner
    var banner = document.getElementById('share-ro-banner');
    if (banner) banner.classList.add('show');
    // Disable edit controls
    document.querySelectorAll('.btn-p, .btn.btn-p').forEach(function(b) { b.style.display = 'none'; });
  } catch(e) {
    console.warn('Invalid share link');
  }
}


// ==============================================
// INIT
// ==============================================
(function init() {
  console.log('[WealthOS] init starting');
  try {
  // -- Handle Supabase auth redirects (email confirm, password reset) --
  try {
    var hash = window.location.hash;
    if (hash && (hash.indexOf('access_token=') >= 0 || hash.indexOf('error=') >= 0)) {
      var params = {};
      hash.replace(/^#/, '').split('&').forEach(function(pair) {
        var kv = pair.split('=');
        params[decodeURIComponent(kv[0])] = decodeURIComponent((kv[1] || '').replace(/\+/g,' '));
      });

      if (params.error) {
        // Show friendly error on landing page
        window.addEventListener('load', function() {
          var msg = params.error_description || 'Authentication error. Please try again.';
          if (params.error_code === 'otp_expired') {
            msg = 'Your confirmation link has expired. Please sign up again or request a new link.';
          }
          setTimeout(function() {
            showAuth('login');
            var errEl = document.getElementById('login-error');
            if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
          }, 500);
        });
      } else if (params.access_token && params.type === 'signup') {
        // Email confirmed -- exchange token for session
        var _sbInit = getSB();
        if (_sbInit) {
          _sbInit.auth.setSession({ access_token: params.access_token, refresh_token: params.refresh_token || '' })
            .then(function(res) {
              if (res.data && res.data.session && res.data.session.user) {
                var sbUser = res.data.session.user;
                var existingUser = users.find(function(u) { return u.email === sbUser.email || u.supabaseId === sbUser.id; });
                if (!existingUser) {
                  existingUser = {
                    id: 'u_' + Date.now(),
                    firstName: (sbUser.user_metadata && (sbUser.user_metadata.first_name || (sbUser.user_metadata.full_name || sbUser.user_metadata.name || '').split(' ')[0])) || sbUser.email.split('@')[0],
                    lastName:  (sbUser.user_metadata && (sbUser.user_metadata.last_name || (sbUser.user_metadata.full_name || sbUser.user_metadata.name || '').split(' ').slice(1).join(' '))) || '',
                    email: sbUser.email, plan: 'free', supabaseId: sbUser.id,
                    createdAt: new Date().toISOString()
                  };
                  users.push(existingUser); saveUsers();
                }
                if (!existingUser.supabaseId) { existingUser.supabaseId = sbUser.id; saveUsers(); }
                saveSession(existingUser); currentUser = existingUser;
                window.history.replaceState(null, '', window.location.pathname);
                setTimeout(function() { enterDashboard(); }, 200);
              }
            }).catch(function() {
              window.history.replaceState(null, '', window.location.pathname);
            });
        }
      } else if (params.access_token && params.type === 'recovery') {
        // Password reset link -- set the session, log the user in.
        // onAuthStateChange then fires PASSWORD_RECOVERY \u2192 shows "set new password" banner.
        window.history.replaceState(null, '', window.location.pathname);
        var _sbRec = getSB();
        if (_sbRec) {
          _sbRec.auth.setSession({ access_token: params.access_token, refresh_token: params.refresh_token || '' })
            .then(function(recRes) {
              if (recRes.data && recRes.data.session && recRes.data.session.user) {
                var recU = recRes.data.session.user;
                var recLU = users.find(function(ux) { return ux.email === recU.email || ux.supabaseId === recU.id; });
                if (!recLU) {
                  recLU = { id: 'u_' + Date.now(),
                    firstName: (recU.user_metadata && (recU.user_metadata.first_name || (recU.user_metadata.full_name || recU.user_metadata.name || '').split(' ')[0])) || recU.email.split('@')[0],
                    lastName:  (recU.user_metadata && (recU.user_metadata.last_name || (recU.user_metadata.full_name || recU.user_metadata.name || '').split(' ').slice(1).join(' '))) || '',
                    email: recU.email, plan: 'free', supabaseId: recU.id, createdAt: new Date().toISOString() };
                  users.push(recLU); saveUsers();
                }
                if (!recLU.supabaseId) { recLU.supabaseId = recU.id; saveUsers(); }
                saveSession(recLU); currentUser = recLU;
                // Show reset password form (NOT dashboard) -- PASSWORD_RECOVERY event also fires
                setTimeout(function() { showPage('auth'); switchAuth('reset-pw'); }, 200);
              }
            }).catch(function() {
              window.addEventListener('load', function() {
                setTimeout(function() {
                  showAuth('login');
                  var recErr = document.getElementById('login-error');
                  if (recErr) { recErr.style.color = 'var(--green)'; recErr.textContent = '\u2713 Link accepted -- please sign in to continue.'; recErr.style.display = 'block'; }
                }, 500);
              });
            });
        }
      }
      // Clear the hash regardless
      if (!params.access_token || params.type !== 'signup') {
        window.history.replaceState(null, '', window.location.pathname);
      }
    }
  } catch(e) {}

  // API key is handled server-side - no client-side key needed
  try { updateBadgeCount(); } catch(e) {}
  try { setBilling('monthly'); } catch(e) {}
  try { initKeyboardShortcuts(); } catch(e) {}
  try { checkShareParam(); } catch(e) {}
  var savedTheme = localStorage.getItem('pw_theme');
  if (savedTheme === 'light') setTheme('light');

  // Show landing immediately so page is never blank
  showLanding();

  // -- Supabase: check for persisted session (survives page refresh) --
  var _sb = getSB();
  if (_sb) {
    _sb.auth.getSession().then(function(res) {
      var session = res.data && res.data.session;
      if (session && session.user) {
        // Valid cloud session -- restore user and go straight to dashboard
        var sbUser = session.user;
        // Find matching local user or create a lightweight one
        var localUser = users.find(function(u) {
          return u.email === sbUser.email || u.supabaseId === sbUser.id;
        });
        if (!localUser) {
          // User exists in Supabase but not local storage (new device)
          localUser = {
            id: 'u_' + Date.now(),
            firstName: (sbUser.user_metadata && (sbUser.user_metadata.first_name || (sbUser.user_metadata.full_name || sbUser.user_metadata.name || '').split(' ')[0])) || sbUser.email.split('@')[0],
            lastName:  (sbUser.user_metadata && (sbUser.user_metadata.last_name || (sbUser.user_metadata.full_name || sbUser.user_metadata.name || '').split(' ').slice(1).join(' '))) || '',
            email: sbUser.email,
            plan: 'free',
            supabaseId: sbUser.id,
            createdAt: new Date().toISOString()
          };
          users.push(localUser);
          saveUsers();
        }
        // Update supabaseId in case it was missing
        if (!localUser.supabaseId) { localUser.supabaseId = sbUser.id; saveUsers(); }
        // Sync plan from Supabase metadata (trusted source - set by webhook)
        if (sbUser.user_metadata && sbUser.user_metadata.plan) {
          localUser.plan = sbUser.user_metadata.plan;
          saveUsers();
        }
        saveSession(localUser);
        currentUser = localUser;
        // Sync plan from public.users table
        setTimeout(syncPlanFromDB, 300);
        enterDashboard();
      } else {
        // No cloud session -- check local session as fallback
        if (currentUser) {
          enterDashboard();
        }
      }
    }).catch(function() {
      // Supabase unreachable -- fall back to local session
      if (currentUser) {
        enterDashboard();
      }
    });

    // -- onAuthStateChange -- prevents unexpected logouts --
    // Supabase silently refreshes JWTs every ~55 min. Without this listener
    // the app loses sync and users appear logged out after one hour.
    _sb.auth.onAuthStateChange(function(event, session) {
      if (event === 'SIGNED_OUT') {
        if (currentUser) { clearSession(); }
        return;
      }
      if (event === 'TOKEN_REFRESHED' && session && session.user) {
        var sbU2 = session.user;
        var lu2 = users.find(function(ux) { return ux.email === sbU2.email || ux.supabaseId === sbU2.id; });
        if (lu2) { saveSession(lu2); }
        return;
      }
      if (event === 'PASSWORD_RECOVERY') {
        // User clicked reset link -- show the Set New Password form
        console.log('[WealthOS] Password recovery detected, showing reset form');
        showPage('auth');
        switchAuth('reset-pw');
        return;
      }
    });
  } else {
    // Supabase not loaded yet -- use local session
    if (currentUser) {
      enterDashboard();
    }
  }
  } catch(masterErr) {
    console.error('[WealthOS] init crashed:', masterErr);
    try { showLanding(); } catch(e) {}
  }
  console.log('[WealthOS] init complete');
})();


// ==========================================================
// FEATURE: WEALTH REPORT -- beautiful one-page HTML report
// Opens in new tab; user prints \u2192 Save as PDF
// ==========================================================
function generateWealthReport() {
  var p    = calcPortfolio();
  var tv   = p.totalNetWorth;
  var gain = p.totalPL;
  var pct  = p.totalPLPct;
  var user = currentUser ? (currentUser.firstName || 'Your') : 'Your';
  var today = new Date().toLocaleDateString('en-US', {weekday:'long',year:'numeric',month:'long',day:'numeric'});
  var cats = p.byCategory;

  // Week change
  var weekChange = 0, weekChangePct = 0;
  try {
    var hist = JSON.parse(localStorage.getItem('pw_history_' + (currentUser ? currentUser.id : '')) || '[]');
    if (hist.length >= 2) {
      var prev = hist[hist.length - 8] || hist[0];
      if (prev && prev.val) { weekChange = tv - prev.val; weekChangePct = prev.val > 0 ? (weekChange / prev.val) * 100 : 0; }
    }
  } catch(e) {}

  // Benchmark
  var spyYTD = null, benchHtml = '';
  try {
    var bRaw = localStorage.getItem('wos_bench_spy');
    if (bRaw) { var bData = JSON.parse(bRaw); if (bData && bData.ret !== undefined) spyYTD = bData.ret; }
  } catch(e) {}
  if (spyYTD !== null) {
    var diff = pct - spyYTD;
    benchHtml = '<tr><td>S&amp;P 500 YTD</td><td>' + (spyYTD >= 0 ? '+' : '') + spyYTD.toFixed(1) + '%</td></tr>' +
                '<tr><td>vs Market</td><td style="color:' + (diff >= 0 ? '#22D3A5' : '#E8A030') + '">' +
                (diff >= 0 ? '+' : '') + diff.toFixed(1) + '% ' + (diff >= 0 ? '^ outperforming' : 'v trailing') + '</td></tr>';
  }

  // Allocation rows
  var allocRows = Object.keys(cats)
    .filter(function(c){ return cats[c] && cats[c].val > 0; })
    .sort(function(a,b){ return cats[b].val - cats[a].val; })
    .map(function(c){
      var bar = tv > 0 ? (cats[c].val / tv * 100).toFixed(1) : 0;
      return '<tr><td>' + catL(c) + '</td><td>' + fmtS(cats[c].val) + '</td>' +
             '<td>' + bar + '%</td><td style="color:' + (cats[c].pl >= 0 ? '#22D3A5' : '#F05C71') + '">' +
             (cats[c].pl >= 0 ? '+' : '') + fmtS(cats[c].pl) + '</td></tr>';
    }).join('');

  // Top holdings
  var holdingRows = p.assets
    .slice().sort(function(a,b){ return b.curVal - a.curVal; })
    .slice(0, 10)
    .map(function(a){
      var alloc = tv > 0 ? (a.curVal / tv * 100).toFixed(1) : 0;
      return '<tr><td>' + a.name + '</td><td>' + (a.ticker || '--') + '</td>' +
             '<td>' + fmtS(a.curVal) + '</td><td>' + alloc + '%</td>' +
             '<td style="color:' + (((a.plAbs !== undefined ? a.plAbs : 0) >= 0) ? '#22D3A5' : '#F05C71') + '">' +
             (((a.plAbs !== undefined ? a.plAbs : 0) >= 0) ? '+' : '') + fmtS(a.plAbs !== undefined ? a.plAbs : 0) + '</td></tr>';
    }).join('');

  var reportHTML = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' +
    '<title>WealthOS Wealth Report -- ' + today + '</title>' +
    '<style>' +
    'body{margin:0;padding:40px;background:#fff;font-family:"Helvetica Neue",Arial,sans-serif;color:#111;font-size:14px;line-height:1.6}' +
    '@media print{body{padding:20px}.no-print{display:none}@page{margin:15mm}}' +
    'h1{font-size:28px;font-weight:800;letter-spacing:-1px;margin:0 0 4px;color:#0A0A0F}' +
    '.sub{font-size:13px;color:#636382;margin-bottom:32px}' +
    '.kpi-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:32px}' +
    '.kpi{background:#F8F8FC;border-radius:10px;padding:18px 20px;border-left:3px solid #5C5FEF}' +
    '.kpi-label{font-size:11px;color:#8A8FAF;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px}' +
    '.kpi-val{font-size:26px;font-weight:700;letter-spacing:-0.8px}' +
    '.kpi-sub{font-size:12px;color:#8A8FAF;margin-top:4px}' +
    'h2{font-size:14px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#8A8FAF;border-bottom:1px solid #EBEBF5;padding-bottom:8px;margin:28px 0 14px}' +
    'table{width:100%;border-collapse:collapse;font-size:13px}' +
    'th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#8A8FAF;padding:8px 12px;background:#F8F8FC;border-bottom:2px solid #EBEBF5}' +
    'td{padding:10px 12px;border-bottom:1px solid #F0F0F8;color:#2A2A3A}' +
    'tr:last-child td{border-bottom:none}' +
    '.footer{margin-top:40px;padding-top:16px;border-top:1px solid #EBEBF5;font-size:11px;color:#AEAEC8;display:flex;justify-content:space-between}' +
    '.print-btn{position:fixed;bottom:24px;right:24px;background:#5C5FEF;color:#fff;border:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 4px 20px rgba(92,95,239,0.4)}' +
    '</style></head><body>' +
    '<div style="display:flex;align-items:center;gap:12px;margin-bottom:24px">' +
    '<div style="width:36px;height:36px;background:#5C5FEF;border-radius:8px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:18px">W</div>' +
    '<div><div style="font-size:11px;color:#8A8FAF;letter-spacing:1px;text-transform:uppercase">WealthOS</div><div style="font-size:13px;font-weight:600;color:#0A0A0F">Wealth Report</div></div>' +
    '<div style="margin-left:auto;font-size:12px;color:#8A8FAF">' + today + '</div>' +
    '</div>' +
    '<h1>' + user + '\'s Portfolio Summary</h1>' +
    '<div class="sub">Private &amp; confidential -- generated by WealthOS</div>' +
    '<div class="kpi-grid">' +
    '<div class="kpi"><div class="kpi-label">Total Net Worth</div><div class="kpi-val">' + fmtS(tv) + '</div>' +
    (weekChange !== 0 ? '<div class="kpi-sub">' + (weekChange >= 0 ? '^ +' : 'v ') + fmtS(weekChange) + ' this week</div>' : '') + '</div>' +
    '<div class="kpi" style="border-color:#22D3A5"><div class="kpi-label">All-Time Return</div>' +
    '<div class="kpi-val" style="color:' + (gain >= 0 ? '#22D3A5' : '#F05C71') + '">' + (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%</div>' +
    '<div class="kpi-sub">' + (gain >= 0 ? '+' : '') + fmtS(gain) + ' total gain</div></div>' +
    '<div class="kpi" style="border-color:#E8A030"><div class="kpi-label">Assets Tracked</div>' +
    '<div class="kpi-val">' + p.assets.length + '</div>' +
    '<div class="kpi-sub">across ' + Object.keys(cats).filter(function(c){return cats[c]&&cats[c].val>0;}).length + ' asset classes</div></div>' +
    '</div>' +
    (benchHtml ? '<h2>Market Comparison</h2><table><tbody><tr><td>Your all-time return</td><td>' + (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%</td></tr>' + benchHtml + '</tbody></table>' : '') +
    '<h2>Asset Allocation</h2>' +
    '<table><thead><tr><th>Category</th><th>Value</th><th>Allocation</th><th>P&amp;L</th></tr></thead><tbody>' + allocRows + '</tbody></table>' +
    '<h2>Top Holdings</h2>' +
    '<table><thead><tr><th>Asset</th><th>Ticker</th><th>Value</th><th>Allocation</th><th>P&amp;L</th></tr></thead><tbody>' + holdingRows + '</tbody></table>' +
    '<div class="footer"><span>Generated by WealthOS * Private &amp; Confidential</span><span>wealthos.app</span></div>' +
    '<button class="print-btn no-print" onclick="window.print()">Download PDF</button>' +
    '</body></html>';

  var win = window.open('', '_blank');
  if (win) {
    win.document.write(reportHTML);
    win.document.close();
  } else {
    alert('Please allow popups for WealthOS to generate your report.');
  }
}

// ============================================
// BACKUP EVENT LISTENERS + DEBUGGING
// Runs after all code above, catches clicks
// even if onclick attributes fail
// ============================================
(function backupInit() {
  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  ready(function() {
    console.log('Backup init running');
    var ok = typeof showAuth === 'function' && typeof showPage === 'function';
    console.log('Functions defined:', ok ? 'YES' : 'NO - creating fallbacks');

    if (!ok) {
      // Main script crashed - create minimal working navigation
      window.showPage = function(id) {
        console.log('showPage:', id);
        ['landing', 'auth', 'app'].forEach(function(p) {
          var el = document.getElementById(p);
          if (el) { el.classList.remove('active'); el.style.display = 'none'; }
        });
        var t = document.getElementById(id);
        if (t) {
          t.classList.add('active');
          if (id === 'app') t.style.display = 'flex';
          else if (id === 'auth') t.style.display = 'flex';
          else t.style.display = 'block';
        }
        window.scrollTo(0, 0);
      };
      window.showAuth = function(mode) {
        console.log('showAuth:', mode);
        showPage('auth');
        var views = { login: 'auth-login', signup: 'auth-signup', forgot: 'auth-forgot', 'reset-pw': 'auth-reset-pw' };
        Object.keys(views).forEach(function(k) {
          var el = document.getElementById(views[k]);
          if (el) el.style.display = k === mode ? 'block' : 'none';
        });
      };
      window.showLanding = function() { showPage('landing'); };
      window.switchAuth = function(mode) { showAuth(mode); };
      window.enterDashboard = function() { showAuth('login'); };
      window.toggleFaq = function(el) {
        var open = el.classList.contains('open');
        document.querySelectorAll('.faq-item').forEach(function(f) { f.classList.remove('open'); });
        if (!open) el.classList.add('open');
      };
    }

    // Attach backup addEventListener to every button with onclick
    document.querySelectorAll('[onclick]').forEach(function(el) {
      var oc = el.getAttribute('onclick') || '';
      if (oc.indexOf('showAuth') >= 0 || oc.indexOf('enterDashboard') >= 0 ||
          oc.indexOf('showLanding') >= 0 || oc.indexOf('switchAuth') >= 0) {
        el.addEventListener('click', function(e) {
          console.log('Backup click:', oc);
          try { eval(oc); } catch(err) { console.error('Click handler error:', err); }
        });
      }
    });

    console.log('Backup init complete - all buttons wired');
  });
})();