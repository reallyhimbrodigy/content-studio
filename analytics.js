document.addEventListener('DOMContentLoaded', () => {
  const tiktokBtn = document.getElementById('connect-tiktok');
  const instagramBtn = document.getElementById('connect-instagram');
  const youtubeBtn = document.getElementById('connect-youtube');

  async function openPhylloConnect() {
    try {
      const res = await fetch('/api/phyllo/sdk-config', { credentials: 'include' });
      if (!res.ok) throw new Error('sdk-config failed');
      const data = await res.json();

      const config = {
        clientDisplayName: data.clientDisplayName || 'Promptly',
        environment: data.environment || 'sandbox',
        userId: data.userId,
        token: data.token,
      };

      const phylloConnect = window.PhylloConnect.initialize(config);
      phylloConnect.open();
    } catch (err) {
      console.error('[Analytics] Failed to open Phyllo Connect', err);
    }
  }

  if (tiktokBtn) tiktokBtn.addEventListener('click', openPhylloConnect);
  if (instagramBtn) instagramBtn.addEventListener('click', openPhylloConnect);
  if (youtubeBtn) youtubeBtn.addEventListener('click', openPhylloConnect);

  async function fetchJSON(url) {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`Request failed ${res.status}`);
    return res.json();
  }

  function renderAccounts(accounts) {
    const strip = document.getElementById('connected-accounts');
    if (!strip) return;
    const cards = strip.querySelectorAll('.analytics-connected-card');
    cards.forEach((card) => {
      const platform = card.getAttribute('data-platform');
      const match = accounts.find((a) => a.platform === platform);
      const statusEl = card.querySelector('.analytics-connected-status');
      if (match) {
        statusEl.textContent = `@${match.username || match.profile_name || 'connected'}`;
      } else {
        statusEl.textContent = 'Not connected';
      }
    });
  }

  function formatNumber(val) {
    if (val === null || val === undefined) return '—';
    if (Math.abs(val) >= 1000) return `${(val / 1000).toFixed(1)}k`;
    return `${val}`;
  }

  function renderKPIs(data) {
    const fg = document.getElementById('kpi-follower-growth');
    const eng = document.getElementById('kpi-engagement');
    const views = document.getElementById('kpi-views');
    const ret = document.getElementById('kpi-retention');
    if (fg) fg.textContent = data.follower_growth != null ? `+${formatNumber(data.follower_growth)}` : '—';
    if (eng) eng.textContent = data.engagement_rate != null ? `${(data.engagement_rate * 100).toFixed(1)} %` : '—';
    if (views) views.textContent = data.avg_views_per_post != null ? formatNumber(data.avg_views_per_post) : '—';
    if (ret) ret.textContent = data.retention_pct != null ? `${(data.retention_pct * 100).toFixed(1)} %` : '—';
  }

  function renderPosts(rows) {
    const tbody = document.getElementById('analytics-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';
    rows.forEach((row) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><a href="${row.post_url || '#'}">${row.title || 'Untitled post'}</a></td>
        <td>${row.platform || '—'}</td>
        <td>${formatNumber(row.views)}</td>
        <td>${formatNumber(row.likes)}</td>
        <td>${row.retention != null ? `${(row.retention * 100).toFixed(1)}%` : '—'}</td>
        <td>${formatNumber(row.shares)}</td>
        <td>${formatNumber(row.saves)}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  function renderInsights(items) {
    const container = document.getElementById('analytics-insights');
    if (!container) return;
    container.innerHTML = '';
    items.forEach((insight) => {
      (insight.recommendations || []).forEach((rec) => {
        const card = document.createElement('div');
        card.className = 'analytics-card insight-card';
        card.innerHTML = `
          <h3>${rec.title || 'Experiment'}</h3>
          <p>${rec.description || insight.summary || ''}</p>
          <button class="primary">Try This Experiment</button>
        `;
        container.appendChild(card);
      });
    });
    if (!items.length) {
      container.innerHTML = '<p style="opacity:0.7;">Insights will appear once data is available.</p>';
    }
  }

  function renderAlerts(alerts) {
    const container = document.getElementById('analytics-alerts');
    if (!container) return;
    container.innerHTML = '';
    if (!alerts.length) {
      container.innerHTML = '<p style="opacity:0.7;">No alerts right now.</p>';
      return;
    }
    alerts.forEach((alert) => {
      const card = document.createElement('div');
      card.className = 'analytics-card alert-card';
      card.innerHTML = `
        <span class="alert-icon">${alert.type === 'warning' ? '⚠' : 'ℹ'}</span>
        <div class="alert-text">${alert.message}</div>
      `;
      container.appendChild(card);
    });
  }

  function wireTableSorting() {
    const headers = document.querySelectorAll('.analytics-table th[data-sort]');
    headers.forEach((th) => {
      th.style.cursor = 'pointer';
      th.addEventListener('click', () => {
        const sort = th.getAttribute('data-sort');
        loadPosts(sort);
      });
    });
  }

  async function loadAccounts() {
    try {
      const data = await fetchJSON('/api/analytics/accounts');
      renderAccounts(data || []);
    } catch (err) {
      console.error('[Analytics] accounts load failed', err);
    }
  }

  async function loadKPIs() {
    try {
      const data = await fetchJSON('/api/analytics/overview');
      renderKPIs(data || {});
    } catch (err) {
      console.error('[Analytics] overview load failed', err);
    }
  }

  async function loadPosts(sort = 'views') {
    try {
      const data = await fetchJSON(`/api/analytics/posts?sort=${encodeURIComponent(sort)}`);
      renderPosts(data || []);
    } catch (err) {
      console.error('[Analytics] posts load failed', err);
    }
  }

  async function loadInsights() {
    try {
      const data = await fetchJSON('/api/analytics/insights');
      renderInsights(data || []);
    } catch (err) {
      console.error('[Analytics] insights load failed', err);
    }
  }

  async function loadAlerts() {
    try {
      const data = await fetchJSON('/api/analytics/alerts');
      renderAlerts(data || []);
    } catch (err) {
      console.error('[Analytics] alerts load failed', err);
    }
  }

  wireTableSorting();
  loadAccounts();
  loadKPIs();
  loadPosts();
  loadInsights();
  loadAlerts();
});
