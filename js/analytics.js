document.addEventListener('DOMContentLoaded', () => {
  const connectBtn = document.getElementById('connect-account');

  let phylloConnectInstance = null;

  async function getPhylloInstance() {
    if (phylloConnectInstance) return phylloConnectInstance;

    const res = await fetch('/api/phyllo/sdk-config');
    if (!res.ok) {
      console.error('[Phyllo] sdk-config failed', res.status);
      return null;
    }

    const cfg = await res.json();
    if (!cfg || cfg.ok === false) {
      console.error('[Phyllo] sdk-config error', cfg);
      return null;
    }

    if (!window.PhylloConnect) {
      console.error('[Phyllo] PhylloConnect not available');
      return null;
    }

    const instance = window.PhylloConnect.initialize({
      clientDisplayName: cfg.clientDisplayName,
      environment: cfg.environment,
      userId: cfg.userId,
      token: cfg.token,
      // no callbacks here
    });

    instance.on('accountConnected', function (accountId, workPlatformId, userId) {
      console.log('[Phyllo] accountConnected', { accountId, workPlatformId, userId });
    });

    instance.on('accountDisconnected', function (accountId, workPlatformId, userId) {
      console.log('[Phyllo] accountDisconnected', { accountId, workPlatformId, userId });
    });

    instance.on('tokenExpired', function (userId) {
      console.log('[Phyllo] tokenExpired for user', userId);
      // later: refresh token via /api/phyllo/sdk-config
    });

    instance.on('exit', function (reason, userId) {
      console.log('[Phyllo] exit', { reason, userId });
    });

    instance.on('connectionFailure', function (reason, workPlatformId, userId) {
      console.log('[Phyllo] connectionFailure', { reason, workPlatformId, userId });
    });

    phylloConnectInstance = instance;
    return instance;
  }

  async function openPhyllo() {
    try {
      const instance = await getPhylloInstance();
      if (!instance) return;
      instance.open();
    } catch (err) {
      console.error('[Phyllo] connect error', err);
    }
  }

  if (connectBtn) {
    connectBtn.addEventListener('click', openPhyllo);
  }

  const numberFmt = (n, opts = {}) => {
    if (n == null || isNaN(n)) return '—';
    const formatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, ...opts });
    return formatter.format(n);
  };

  async function safeFetch(url) {
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) return null;
      const data = await res.json();
      return data;
    } catch (err) {
      console.error('[Analytics] fetch failed', url, err);
      return null;
    }
  }

  async function loadAccounts() {
    const strip = document.getElementById('connected-accounts');
    const data = await safeFetch('/api/analytics/accounts');
    if (!strip || !data) return;
    const list = Array.isArray(data) ? data : data.data || [];
    const statusByPlatform = {};
    list.forEach((acct) => {
      const platform = (acct.platform || '').toLowerCase();
      statusByPlatform[platform] = acct;
    });
    strip.querySelectorAll('.analytics-connected-card').forEach((card) => {
      const platform = (card.dataset.platform || '').toLowerCase();
      const info = statusByPlatform[platform];
      const statusEl = card.querySelector('.analytics-connected-status');
      if (info) {
        statusEl.textContent = info.username ? `@${info.username}` : 'Connected';
      } else {
        statusEl.textContent = 'Not connected';
      }
    });
  }

  async function loadOverview() {
    const data = await safeFetch('/api/analytics/overview');
    const payload = data && (data.data || data);
    if (!payload) return;
    const fg = document.getElementById('kpi-follower-growth');
    const eng = document.getElementById('kpi-engagement');
    const views = document.getElementById('kpi-views');
    const ret = document.getElementById('kpi-retention');
    const fgVal = payload.followerGrowth ?? payload.follower_growth;
    const engVal = payload.engagementRate ?? payload.engagement_rate;
    const viewsVal = payload.avgViewsPerPost ?? payload.avg_views_per_post;
    const retVal = payload.retentionPct ?? payload.retention_pct;
    if (fg) fg.textContent = `${numberFmt(fgVal)}${fgVal > 0 ? '+' : ''}`;
    if (eng) eng.textContent = engVal != null ? `${numberFmt(engVal * 100, { maximumFractionDigits: 2 })}%` : '—';
    if (views) views.textContent = numberFmt(viewsVal);
    if (ret) ret.textContent = retVal != null ? `${numberFmt(retVal * 100, { maximumFractionDigits: 1 })}%` : '—';
  }

  function renderHeatmapGrid(data) {
    const grid = document.querySelector('.analytics-heatmap-grid');
    if (!grid) return;
    grid.innerHTML = '';
    const buckets = [
      { label: 'Midnight-4a', hours: [0, 1, 2, 3] },
      { label: '4a-8a', hours: [4, 5, 6, 7] },
      { label: '8a-Noon', hours: [8, 9, 10, 11] },
      { label: 'Noon-4p', hours: [12, 13, 14, 15] },
      { label: '4p-8p', hours: [16, 17, 18, 19] },
      { label: '8p-Mid', hours: [20, 21, 22, 23] },
    ];
    const maxEng = data.length ? Math.max(...data.map((d) => Number(d.engagement || 0))) : 0;
    buckets.forEach((bucket, bucketIdx) => {
      for (let day = 0; day < 7; day++) {
        const cell = document.createElement('span');
        cell.className = 'heatmap-cell';
        cell.dataset.day = String(day);
        cell.dataset.bucket = String(bucketIdx);
        const matches = data.filter((d) => d.day === day && bucket.hours.includes(d.hour));
        const engagement = matches.reduce((sum, c) => sum + Number(c.engagement || 0), 0);
        const intensity = maxEng ? Math.min(1, engagement / maxEng) : 0;
        cell.style.opacity = `${0.2 + intensity * 0.8}`;
        cell.title = `Day ${day}, ${bucket.label}: ${Math.round(engagement)} engagement`;
        grid.appendChild(cell);
      }
    });
  }

  async function loadHeatmap() {
    const data = await safeFetch('/api/analytics/heatmap');
    const rows = data && (data.data || data);
    if (!rows || !Array.isArray(rows) || !rows.length) return;
    renderHeatmapGrid(rows);
  }

  async function loadPosts() {
    const tbody = document.getElementById('analytics-table-body');
    if (!tbody) return;
    const data = await safeFetch('/api/analytics/posts');
    const rows = data && (data.data || data);
    if (!rows || !rows.length) {
      tbody.innerHTML = '<tr><td colspan="7">No data yet – connect an account.</td></tr>';
      return;
    }
    const fmtPct = (v) => (v == null ? '—' : `${numberFmt(v * 100, { maximumFractionDigits: 1 })}%`);
    const html = rows
      .map((r) => `
        <tr>
          <td>${r.post_url ? `<a href="${r.post_url}" target="_blank" rel="noreferrer">${r.title || 'Untitled'}</a>` : (r.title || 'Untitled')}</td>
          <td>${r.platform || '—'}</td>
          <td>${numberFmt(r.views)}</td>
          <td>${numberFmt(r.likes)}</td>
          <td>${fmtPct(r.retention)}</td>
          <td>${numberFmt(r.shares)}</td>
          <td>${numberFmt(r.saves)}</td>
        </tr>
      `)
      .join('');
    tbody.innerHTML = html;
  }

  async function loadInsights() {
    const container = document.getElementById('analytics-insights');
    if (!container) return;
    const data = await safeFetch('/api/analytics/insights');
    const items = data && (data.data || data);
    if (!items || (Array.isArray(items) && !items.length)) {
      container.innerHTML = '<p class="muted">No insights yet – generate after syncing data.</p>';
      return;
    }
    const insight = Array.isArray(items) ? items[0] : items;
    const recs = Array.isArray(insight.experiments) ? insight.experiments : [];
    const recHtml = recs.map((rec) => `<li>${rec}</li>`).join('');
    container.innerHTML = `
      <div class="analytics-card insight-card">
        <h3>${insight.summaryText || insight.summary || 'Insight'}</h3>
        ${recHtml ? `<ul>${recHtml}</ul>` : '<p class="muted">No experiments yet.</p>'}
        <button class="secondary-btn" type="button">Try This Experiment</button>
      </div>
    `;
  }

  async function loadAlerts() {
    const container = document.getElementById('analytics-alerts');
    if (!container) return;
    const data = await safeFetch('/api/analytics/alerts');
    const rows = data && (data.data || data);
    if (!rows || !rows.length) {
      container.innerHTML = '<p class="muted">No alerts yet.</p>';
      return;
    }
    container.innerHTML = rows
      .map((a) => `<div class="alert-card"><span class="alert-icon">${a.type === 'warning' ? '⚠' : 'ℹ'}</span><span class="alert-text">${a.message || (a.payload && a.payload.message) || a.type}</span></div>`)
      .join('');
  }

  loadAccounts();
  loadOverview();
  loadHeatmap();
  loadPosts();
  loadInsights();
  loadAlerts();
});
