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

      // Persist connection server-side (fire-and-forget)
      fetch('/api/phyllo/account-connected', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phylloUserId: userId,
          accountId,
          workPlatformId,
          platform: 'unknown',
          handle: null,
          displayName: null,
          avatarUrl: null,
        }),
      }).catch((err) => console.error('[Phyllo] failed to persist accountConnected', err));
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
    try {
      const res = await fetch('/api/analytics/alerts');
      const json = await res.json();
      if (!json.ok) throw new Error('alerts_fetch_failed');
      renderAlerts(json.alerts || []);
    } catch (err) {
      console.error('[Analytics] loadAlerts error', err);
      const el = document.getElementById('alerts-list');
      if (el) el.textContent = 'No alerts available.';
    }
  }

  loadAccounts();
  loadOverview();
  // legacy individual loaders removed in favor of loadAnalytics()

  function loadFullAnalytics() {
    fetch('/api/analytics/data')
      .then((r) => r.json())
      .then((res) => {
        if (!res || res.ok === false) return;
        console.log('[Analytics] full dataset', res.data);
      })
      .catch((err) => console.error('[Analytics] loadFullAnalytics error', err));
  }

  loadFullAnalytics();
  function loadConnectedAccounts() {
    fetch('/api/phyllo/accounts')
      .then((r) => r.json())
      .then((res) => {
        if (!res || res.ok === false) return;
        const list = document.getElementById('connected-accounts');
        if (!list) return;
        list.innerHTML = '';
        (res.data || []).forEach((acc) => {
          const li = document.createElement('div');
          li.className = 'connected-account';
          li.textContent = `${acc.platform || 'Platform'} — ${acc.handle || acc.username || 'Unknown handle'}`;
          list.appendChild(li);
        });
      })
      .catch((err) => console.error('[Phyllo] loadConnectedAccounts error', err));
  }

  loadConnectedAccounts();

  async function fetchAnalyticsData() {
    const res = await fetch('/api/analytics/data');
    if (!res.ok) throw new Error('analytics/data failed ' + res.status);
    const json = await res.json();
    if (!json.ok) throw new Error('analytics/data error');
    return json.data;
  }

  async function fetchInsights() {
    const res = await fetch('/api/analytics/insights');
    if (!res.ok) throw new Error('insights failed ' + res.status);
    const json = await res.json();
    if (!json.ok) throw new Error('insights error');
    return json.insights || [];
  }

  async function fetchAlerts() {
    const res = await fetch('/api/analytics/alerts');
    if (!res.ok) throw new Error('alerts failed ' + res.status);
    const json = await res.json();
    if (!json.ok) throw new Error('alerts error');
    return json.alerts || json.data || [];
  }

  function renderOverview(overview = {}) {
    const fg = document.getElementById('kpi-follower-growth');
    const eng = document.getElementById('kpi-engagement');
    const views = document.getElementById('kpi-views');
    const ret = document.getElementById('kpi-retention');
    if (fg) fg.textContent = overview.followerGrowth != null ? `${numberFmt(overview.followerGrowth)}${overview.followerGrowth > 0 ? '+' : ''}` : '—';
    if (eng) eng.textContent = overview.engagementRate != null ? `${numberFmt(overview.engagementRate * 100, { maximumFractionDigits: 2 })}%` : '—';
    if (views) views.textContent = overview.avgViewsPerPost != null ? numberFmt(overview.avgViewsPerPost) : '—';
    if (ret) ret.textContent = overview.retentionPct != null ? `${numberFmt(overview.retentionPct * 100, { maximumFractionDigits: 1 })}%` : '—';
  }

  function renderPosts(posts = []) {
    const tbody = document.getElementById('analytics-table-body');
    if (!tbody) return;
    if (!posts.length) {
      tbody.innerHTML = '<tr><td colspan="7">No data yet – connect an account.</td></tr>';
      return;
    }
    const fmtPct = (v) => (v == null ? '—' : `${numberFmt(v * 100, { maximumFractionDigits: 1 })}%`);
    tbody.innerHTML = posts
      .map((p) => `
        <tr>
          <td>${p.url ? `<a href="${p.url}" target="_blank" rel="noreferrer">${p.title || 'Untitled'}</a>` : (p.title || 'Untitled')}</td>
          <td>${p.platform || '—'}</td>
          <td>${numberFmt(p.views)}</td>
          <td>${numberFmt(p.likes)}</td>
          <td>${fmtPct(p.retention_pct || p.retentionPct)}</td>
          <td>${numberFmt(p.shares)}</td>
          <td>${numberFmt(p.saves)}</td>
        </tr>
      `)
      .join('');
  }

  function renderHeatmapFromPosts(posts = []) {
    const grid = document.querySelector('.analytics-heatmap-grid');
    if (!grid) return;
    const buckets = [
      { label: 'Midnight-4a', hours: [0, 1, 2, 3] },
      { label: '4a-8a', hours: [4, 5, 6, 7] },
      { label: '8a-Noon', hours: [8, 9, 10, 11] },
      { label: 'Noon-4p', hours: [12, 13, 14, 15] },
      { label: '4p-8p', hours: [16, 17, 18, 19] },
      { label: '8p-Mid', hours: [20, 21, 22, 23] },
    ];
    const agg = {};
    posts.forEach((p) => {
      if (!p.published_at && !p.publishedAt) return;
      const dt = new Date(p.published_at || p.publishedAt);
      const day = dt.getUTCDay();
      const hour = dt.getUTCHours();
      const bucketIdx = buckets.findIndex((b) => b.hours.includes(hour));
      if (bucketIdx === -1) return;
      const key = `${day}-${bucketIdx}`;
      const engagement =
        Number(p.likes || 0) + Number(p.comments || 0) + Number(p.shares || 0) + Number(p.saves || 0);
      agg[key] = (agg[key] || 0) + engagement;
    });
    const maxEng = Object.values(agg).length ? Math.max(...Object.values(agg)) : 0;
    grid.innerHTML = '';
    buckets.forEach((bucket, bIdx) => {
      for (let day = 0; day < 7; day++) {
        const key = `${day}-${bIdx}`;
        const engagement = agg[key] || 0;
        const intensity = maxEng ? Math.min(1, engagement / maxEng) : 0;
        const cell = document.createElement('span');
        cell.className = 'heatmap-cell';
        cell.style.opacity = `${0.2 + intensity * 0.8}`;
        cell.title = `Day ${day}, ${bucket.label}: ${Math.round(engagement)} engagement`;
        grid.appendChild(cell);
      }
    });
  }

  async function loadHeatmap() {
    try {
      const res = await fetch('/api/analytics/heatmap');
      const json = await res.json();
      if (!json.ok) throw new Error('heatmap_fetch_failed');
      renderHeatmap(json.heatmap || []);
    } catch (err) {
      console.error('[Analytics] loadHeatmap error', err);
      const grid = document.getElementById('heatmap-grid');
      if (grid) grid.textContent = 'No heatmap data yet.';
    }
  }

  function renderHeatmap(matrix = []) {
    const grid = document.getElementById('heatmap-grid');
    if (!grid) return;
    grid.innerHTML = '';
    if (!matrix.length) {
      grid.textContent = 'No heatmap data yet.';
      return;
    }
    const flat = matrix.flat();
    const max = flat.length ? Math.max(...flat) : 0;
    matrix.forEach((row, day) => {
      row.forEach((score, hour) => {
        const cell = document.createElement('div');
        cell.className = 'heatmap-cell';
        cell.dataset.score = `${score} engagement`;
        const intensity = max > 0 ? score / max : 0;
        cell.style.background = `rgba(127, 90, 240, ${intensity})`;
        cell.title = `Day ${day}, Hour ${hour}: ${score}`;
        grid.appendChild(cell);
      });
    });
  }

  function renderInsights(insights = []) {
    const container = document.getElementById('insights-list');
    if (!container) return;
    container.innerHTML = '';
    if (!insights.length) {
      container.textContent = 'No insights yet. Click "Generate Insights" to create them.';
      return;
    }
    insights.forEach((ins, idx) => {
      const card = document.createElement('div');
      card.className = 'insight-card';
      card.innerHTML = `
        <div class="insight-title">${ins.title || 'Insight ' + (idx + 1)}</div>
        <div class="insight-detail">${ins.detail || ins.description || ''}</div>
        <button
          class="secondary-btn experiment-btn"
          type="button"
          data-title="${(ins.title || 'Experiment').replace(/"/g, '&quot;')}"
          data-description="${(ins.detail || ins.description || '').replace(/"/g, '&quot;')}"
        >
          Try This Experiment
        </button>
      `;
      container.appendChild(card);
    });
  }

  function renderAlerts(alerts = []) {
    const container = document.getElementById('alerts-list');
    if (!container) return;
    if (!alerts.length) {
      container.textContent = 'No alerts available.';
      return;
    }
    container.innerHTML = '';
    alerts.forEach((a) => {
      const div = document.createElement('div');
      div.className = `alert-card ${a.severity || ''}`;
      div.innerHTML = `
        <div>${a.message || a.detail || a.type}</div>
        <div class="alert-timestamp">${a.created_at ? new Date(a.created_at).toLocaleString() : ''}</div>
      `;
      container.appendChild(div);
    });
  }

  function renderExperiments(experiments = []) {
    const container = document.getElementById('experiments-list');
    if (!container) return;
    if (!experiments.length) {
      container.textContent = 'No experiments yet.';
      return;
    }
    container.innerHTML = '';
    experiments.forEach((exp) => {
      const div = document.createElement('div');
      div.className = 'experiment-card';
      div.innerHTML = `
        <div class="experiment-header">
          <span class="experiment-title">${exp.title || 'Experiment'}</span>
          <span class="experiment-status">${exp.status || 'active'}</span>
        </div>
        <div class="experiment-body">
          <p>${exp.description || ''}</p>
          <small>${exp.start_date || ''} → ${exp.end_date || ''}</small>
        </div>
      `;
      container.appendChild(div);
    });
  }

  async function loadExperiments() {
    try {
      const res = await fetch('/api/analytics/experiments');
      const json = await res.json();
      if (!json.ok) throw new Error('experiments fetch failed');
      renderExperiments(json.experiments || []);
    } catch (err) {
      console.error('[Analytics] loadExperiments error', err);
      const container = document.getElementById('experiments-list');
      if (container) container.textContent = 'No experiments yet.';
    }
  }

  async function loadAnalytics() {
    try {
      const data = await fetchAnalyticsData();
      renderOverview(data.overview || {});
      renderPosts(data.posts || []);
      renderHeatmapFromPosts(data.posts || []);

      const insights = await fetchInsights();
      renderInsights(insights);

      const alerts = await fetchAlerts();
      renderAlerts(alerts);
    } catch (err) {
      console.error('[Analytics] loadAnalytics error', err);
    }
  }

  async function loadTopPosts() {
    try {
      const res = await fetch('/api/analytics/top-posts');
      const json = await res.json();
      if (!json.ok) throw new Error('top posts failed');
      renderTopPosts(json.posts || []);
    } catch (err) {
      console.error('[Analytics] loadTopPosts error', err);
      const container = document.getElementById('top-posts-list');
      if (container) container.textContent = 'No post data yet.';
    }
  }

  function renderTopPosts(posts = []) {
    const container = document.getElementById('top-posts-list');
    if (!container) return;
    container.innerHTML = '';
    if (!posts.length) {
      container.textContent = 'No post data yet.';
      return;
    }
    posts.forEach((p) => {
      const div = document.createElement('div');
      div.className = 'top-post-card';
      div.innerHTML = `
        <div class="top-post-title">${p.title || '(Untitled Post)'}</div>
        <div class="top-post-metrics">
          <span>Views: ${p.views || 0}</span>
          <span>Likes: ${p.likes || 0}</span>
          <span>Comments: ${p.comments || 0}</span>
          <span>Shares: ${p.shares || 0}</span>
        </div>
      `;
      container.appendChild(div);
    });
  }

  async function loadDemographics() {
    try {
      const res = await fetch('/api/analytics/demographics');
      const json = await res.json();
      if (!json.ok) throw new Error('demographics fetch failed');
      renderDemographics(json.demographics || {});
    } catch (err) {
      console.error('[Analytics] loadDemographics error', err);
      ['demographics-age', 'demographics-gender', 'demographics-location', 'demographics-language'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.textContent = 'No demographic data yet.';
      });
    }
  }

  function renderDemographics(demo = {}) {
    renderKeyValueBlock('demographics-age', 'Age', demo.age);
    renderKeyValueBlock('demographics-gender', 'Gender', demo.gender);
    renderKeyValueBlock('demographics-location', 'Location', demo.location);
    renderKeyValueBlock('demographics-language', 'Language', demo.language);
  }

  function renderKeyValueBlock(containerId, title, data) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = '';

    const entries = data && Object.entries(data);
    if (!entries || !entries.length) {
      el.textContent = `No ${title.toLowerCase()} data yet.`;
      return;
    }

    const header = document.createElement('h3');
    header.textContent = title;
    el.appendChild(header);

    const list = document.createElement('ul');
    entries.forEach(([key, value]) => {
      const li = document.createElement('li');
      li.textContent = `${key}: ${value}`;
      list.appendChild(li);
    });
    el.appendChild(list);
  }

  async function loadEngagement() {
    try {
      const res = await fetch('/api/analytics/engagement');
      const json = await res.json();
      if (!json.ok) throw new Error('engagement_fetch_failed');
      const el = document.getElementById('kpi-engagement');
      if (el) el.textContent = `${json.engagement}%`;
    } catch (err) {
      console.error('[Analytics] loadEngagement error', err);
      const el = document.getElementById('kpi-engagement');
      if (el) el.textContent = '--%';
    }
  }

  async function loadFollowerGrowth() {
    try {
      const res = await fetch('/api/analytics/followers');
      const json = await res.json();
      if (!json.ok) throw new Error('followers_fetch_failed');
      renderFollowerGrowth(json.trends || []);
    } catch (err) {
      console.error('[Analytics] loadFollowerGrowth error', err);
      const el = document.getElementById('followers-chart');
      if (el) el.textContent = 'No follower data yet.';
    }
  }

  async function loadFollowerGrowthChart() {
    try {
      const res = await fetch('/api/analytics/overview');
      const json = await res.json();
      if (!json.ok) throw new Error('followers_fetch_failed');
      const followers = json.followers || [];
      const el = document.getElementById('follower-growth-chart');
      if (!el) return;
      el.innerHTML = followers.length
        ? `Latest follower count: ${followers[followers.length - 1].followers}`
        : 'No follower data yet.';
    } catch (err) {
      console.error('[Analytics] follower chart error', err);
      const el = document.getElementById('follower-growth-chart');
      if (el) el.textContent = 'No follower data yet.';
    }
  }

  function renderFollowerGrowth(trends = []) {
    const container = document.getElementById('followers-chart');
    if (!container) return;
    container.innerHTML = '';
    if (!trends.length) {
      container.textContent = 'No follower data yet.';
      return;
    }
    const max = Math.max(...trends.map((t) => t.count || 0)) || 1;
    trends.forEach((t) => {
      const bar = document.createElement('div');
      bar.className = 'followers-bar';
      const heightPct = ((t.count || 0) / max) * 100;
      bar.style.height = `${heightPct}%`;
      bar.dataset.label = t.date;
      container.appendChild(bar);
    });
  }

  async function loadSyncStatus() {
    try {
      const res = await fetch('/api/analytics/sync-status');
      const json = await res.json();
      const el = document.getElementById('sync-status');
      if (!el) return;
      const s = json.status;
      if (s && s.status === 'never') {
        el.textContent = 'No sync has occurred yet.';
      } else if (s && s.last_sync) {
        el.textContent = `Last Sync: ${new Date(s.last_sync).toLocaleString()} (${s.status})`;
      } else {
        el.textContent = 'No sync has occurred yet.';
      }
    } catch (err) {
      console.error('[Analytics] sync-status error', err);
      const el = document.getElementById('sync-status');
      if (el) el.textContent = 'No sync has occurred yet.';
    }
  }

  loadAnalytics();
  loadExperiments();
  loadTopPosts();
  loadDemographics();
  loadEngagement();
  loadHeatmap();
  loadAlerts();
  loadFollowerGrowth();
  loadSyncStatus();
  loadFollowerGrowthChart();
  const genBtn = document.getElementById('generate-insights-btn');
  if (genBtn) {
    genBtn.addEventListener('click', generateInsights);
  }

  const syncNowBtn = document.getElementById('sync-now-btn');
  if (syncNowBtn) {
    syncNowBtn.addEventListener('click', handleSyncNow);
  }
  const audienceBtn = document.getElementById('sync-audience-btn');
  if (audienceBtn) {
    audienceBtn.addEventListener('click', handleAudienceSync);
  }

  document.addEventListener('click', async (e) => {
    if (!e.target.classList.contains('experiment-btn')) return;
    const title = e.target.dataset.title || 'Experiment';
    const description = e.target.dataset.description || '';
    try {
      const res = await fetch('/api/analytics/experiments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, description }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error('experiment_create_failed');
      console.log('[Analytics] Experiment created', json.experiment);
      alert('Experiment started for the next 7 days.');
    } catch (err) {
      console.error('[Analytics] experiment create error', err);
      alert('Could not start experiment.');
    }
  });

  async function handleSyncNow() {
    const btn = document.getElementById('sync-now-btn');
    const statusEl = document.getElementById('sync-status');
    if (btn) btn.disabled = true;
    if (statusEl) statusEl.textContent = 'Sync in progress...';

    try {
      const syncRes = await fetch('/api/phyllo/sync-posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const syncJson = await syncRes.json();
      const success = syncRes.ok && syncJson.ok;

      await fetch('/api/analytics/sync-status/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: success ? 'success' : 'failed',
          message: success ? `Synced ${syncJson.syncedPosts || 0} posts` : 'Sync failed',
        }),
      });

      await loadSyncStatus();
      await loadAnalytics();
    } catch (err) {
      console.error('[Analytics] handleSyncNow error', err);
      if (statusEl) statusEl.textContent = 'Sync failed. Try again later.';
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function handleAudienceSync() {
    try {
      const res = await fetch('/api/phyllo/sync-audience', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: window.USER_ID }),
      });
      const json = await res.json();
      console.log('[Analytics] audience sync result:', json);
    } catch (err) {
      console.error('[Analytics] audience sync error', err);
    }
  }

  async function generateInsights() {
    const btn = document.getElementById('generate-insights-btn');
    const list = document.getElementById('insights-list');
    try {
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Generating...';
      }
      if (list) {
        list.textContent = 'Analyzing your posts...';
      }

      const res = await fetch('/api/analytics/insights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ posts: [] }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error('insights_generate_failed');

      const latest = await fetch('/api/analytics/insights');
      const latestJson = await latest.json();
      if (latestJson.ok) {
        renderInsights(latestJson.insights || []);
      }
    } catch (err) {
      console.error('[Analytics] generateInsights error', err);
      if (list) list.textContent = 'Could not generate insights. Try again later.';
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Generate Insights';
      }
    }
  }
});
