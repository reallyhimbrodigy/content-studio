import {
  renderOverview,
  renderPosts,
  renderDemographics,
  renderInsights,
  renderLastSync,
  renderConnectedAccounts,
  renderGrowthReport,
  renderAlerts,
  initPostTableSorting,
  renderDemoBadge,
  exportPostsToCSV,
  initPlatformFilter,
  renderPlatformBreakdown,
  applyAnalyticsAccess,
} from './analytics-render.js';

const DEMO_ANALYTICS = {
  overview: {
    followerGrowth: '+1,250 this month',
    engagementRate: 5.8,
    avgViewsPerPost: 7200,
    retentionPct: 68,
  },
  posts: [
    {
      title: 'Study Hack Short',
      platform: 'TikTok',
      views: 15000,
      likes: 1200,
      comments: 95,
      shares: 40,
      saves: 80,
      retention_pct: 72,
    },
    {
      title: 'Morning Routine Reel',
      platform: 'Instagram',
      views: 9800,
      likes: 640,
      comments: 30,
      shares: 18,
      saves: 50,
      retention_pct: 65,
    },
    {
      title: 'Deep Work Tips',
      platform: 'YouTube',
      views: 21000,
      likes: 1300,
      comments: 110,
      shares: 55,
      saves: 120,
      retention_pct: 70,
    },
  ],
  demographics: {
    age: { '18-24': 54, '25-34': 32, '35-44': 10 },
    gender: { male: 48, female: 50, other: 2 },
    location: { US: 60, UK: 15, CA: 10, DE: 5 },
    language: { en: 80, es: 10, fr: 5 },
  },
  insights: [
    { title: 'Best Posting Time', detail: 'Your audience is most active at 7 PM PST on weekdays.' },
    { title: 'Content Theme', detail: 'Study hacks and productivity tips have 72% average retention.' },
  ],
  report: {
    weekStart: 'This Week',
    overview: {
      followerGrowth: '+1,250',
      engagementRate: 5.8,
      avgViewsPerPost: 7200,
      retentionPct: 68,
    },
    highlights: {
      fastestGrowingPlatform: 'TikTok',
      bestPostingTime: '7 PM PST (Weekdays)',
    },
  },
};

async function fetchAnalyticsJson(url, options) {
  const res = await fetch(url, options || {});

  if (res.status === 401) {
    console.warn('[Analytics] unauthorized for', url);
    return { unauthorized: true, data: null };
  }

  if (!res.ok) {
    console.warn('[Analytics] fetch failed', url, res.status);
    return { error: true, data: null };
  }

  try {
    const json = await res.json();
    return { data: json };
  } catch (e) {
    console.warn('[Analytics] invalid JSON for', url, e);
    return { error: true, data: null };
  }
}

function shouldUseDemo(data) {
  if (!data || !data.overview) return true;
  const hasPosts = Array.isArray(data.posts) && data.posts.length > 0;
  const hasViews = data.overview.avgViewsPerPost && data.overview.avgViewsPerPost > 0;
  return !hasPosts && !hasViews;
}

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

  async function loadInsights() {
    try {
      const res = await fetch('/api/analytics/insights');
      const json = await res.json();
      if (!json.ok) throw new Error('insights fetch failed');
      renderInsights(json.insights || []);
    } catch (err) {
      console.error('[Analytics] loadInsights error', err);
      renderInsights([]);
    }
  }

  initPostTableSorting();
  initPlatformFilter();
  loadSubscriptionAndAnalytics();
  loadConnectedAccounts();
  function loadConnectedAccounts() {
    fetchAnalyticsJson('/api/phyllo/accounts')
      .then(({ data, unauthorized, error }) => {
        if (unauthorized) return;
        if (error || !data || data.ok === false) {
          renderConnectedAccounts([]);
          return;
        }
        renderConnectedAccounts(data.data || []);
      })
      .catch((err) => {
        console.error('[Phyllo] loadConnectedAccounts error', err);
        renderConnectedAccounts([]);
      });
  }

  async function fetchInsights() {
    const { data, unauthorized, error } = await fetchAnalyticsJson('/api/analytics/insights');
    if (unauthorized) return [];
    if (error || !data || data.ok === false) throw new Error('insights error');
    return data.insights || [];
  }

  async function fetchAlerts() {
    const { data, unauthorized, error } = await fetchAnalyticsJson('/api/analytics/alerts');
    if (unauthorized) return [];
    if (error || !data || data.ok === false) throw new Error('alerts error');
    return data.alerts || data.data || [];
  }

  async function loadFullAnalytics() {
    try {
      renderOverview({ __loading: true });
      renderPosts('__loading');
      renderDemographics('__loading');
      renderInsights('__loading');
      renderGrowthReport('__loading');
      renderPlatformBreakdown('__loading');
      renderDemoBadge(false);

      const { data, unauthorized, error } = await fetchAnalyticsJson('/api/analytics/full');
      let analyticsData = data;
      const useDemo = unauthorized || error || !analyticsData || analyticsData.ok === false || shouldUseDemo(analyticsData);
      if (useDemo) {
        analyticsData = DEMO_ANALYTICS;
        renderDemoBadge(true);
      } else {
        renderDemoBadge(false);
      }

      renderOverview(analyticsData.overview || {});
      renderPosts(analyticsData.posts || []);
      renderDemographics(analyticsData.demographics || {});
      renderInsights(analyticsData.insights || []);
      renderLastSync(analyticsData.last_sync);
      renderGrowthReport(analyticsData.report || analyticsData.growth_report || null);
      renderPlatformBreakdown(analyticsData.posts || []);
    } catch (err) {
      console.error('[Analytics] loadFullAnalytics error', err);
      renderOverview({});
      renderPosts([]);
      renderDemographics({});
      renderInsights([]);
      renderGrowthReport(null);
      renderDemoBadge(false);
      renderPlatformBreakdown([]);
    }
  }

  async function loadSubscriptionAndAnalytics() {
    try {
      const res = await fetch('/api/user/subscription');
      const json = await res.json();
      const plan = json.plan || 'free';
      applyAnalyticsAccess(plan);
      await loadFullAnalytics();
    } catch (err) {
      console.error('[Analytics] subscription load error', err);
      applyAnalyticsAccess('free');
      await loadFullAnalytics();
    }
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
          <div>
            <button class="complete-experiment-btn secondary-btn" data-id="${exp.id}">Mark as Complete</button>
            <button class="delete-experiment-btn secondary-btn" data-id="${exp.id}">Delete</button>
          </div>
        </div>
      `;
      container.appendChild(div);
    });
  }

  async function loadExperiments() {
    try {
      const { data, unauthorized, error } = await fetchAnalyticsJson('/api/analytics/experiments');
      if (unauthorized) {
        renderExperiments([]);
        return;
      }
      if (error || !data || data.ok === false) throw new Error('experiments fetch failed');
      renderExperiments(data.experiments || []);
    } catch (err) {
      console.error('[Analytics] loadExperiments error', err);
      renderExperiments([]);
    }
  }

  async function loadAlerts() {
    try {
      renderAlerts('__loading');
      const { data, unauthorized, error } = await fetchAnalyticsJson('/api/analytics/alerts');
      if (unauthorized) {
        renderAlerts([]);
        return;
      }
      if (error || !data || data.ok === false) throw new Error('alerts_fetch_failed');
      renderAlerts(data.alerts || data.data || []);
    } catch (err) {
      console.error('[Analytics] loadAlerts error', err);
      renderAlerts([]);
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
      renderTopPosts([]);
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
      const { data, unauthorized, error } = await fetchAnalyticsJson('/api/analytics/demographics');
      if (unauthorized) return;
      if (error || !data || data.ok === false) throw new Error('demographics fetch failed');
      renderDemographics(data.demographics || {});
    } catch (err) {
      console.error('[Analytics] loadDemographics error', err);
      renderDemographics({});
    }
  }

  async function loadGrowthReport() {
    try {
      const { data, unauthorized, error } = await fetchAnalyticsJson('/api/analytics/reports/latest');
      if (unauthorized) return;
      if (error || !data || data.ok === false) throw new Error('report_fetch_failed');
      renderGrowthReport(data.report || null);
    } catch (err) {
      console.error('[Analytics] loadGrowthReport error', err);
      renderGrowthReport(null);
    }
  }

  function renderDemographics(demo = {}) {
    renderKeyValueBlock('demographics-age', 'Age', demo.age);
    renderKeyValueBlock('demographics-gender', 'Gender', demo.gender);
    renderKeyValueBlock('demographics-location', 'Location', demo.location);
    renderKeyValueBlock('demographics-language', 'Language', demo.language);
    renderDemographicsPanel(demo);
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

  function renderDemographicsPanel(demo = {}) {
    const panel = document.getElementById('demographics-panel');
    if (!panel) return;
    panel.innerHTML = '';

    const platforms = Object.keys(demo);
    if (!platforms.length) {
      panel.textContent = 'No demographic data yet.';
      return;
    }

    platforms.forEach((platform) => {
      const block = document.createElement('div');
      block.className = 'demo-block';
      const items = demo[platform] || [];
      if (!Array.isArray(items) || !items.length) {
        block.innerHTML = `<h3>${platform}</h3>No data`;
        panel.appendChild(block);
        return;
      }
      const content = items
        .map((d) => {
          const label = d.age_group || d.location || d.segment || 'Segment';
          const val = d.percentage != null ? `${d.percentage}%` : d.count || '';
          return `${label}: ${val}`;
        })
        .join('<br>');
      block.innerHTML = `<h3>${platform}</h3>${content || 'No data'}`;
      panel.appendChild(block);
    });
  }

  async function loadEngagement() {
    try {
      const { data, unauthorized, error } = await fetchAnalyticsJson('/api/analytics/engagement');
      if (unauthorized) return;
      if (error || !data || data.ok === false) throw new Error('engagement_fetch_failed');
      const el = document.getElementById('kpi-engagement');
      if (el) el.textContent = `${data.engagement}%`;
    } catch (err) {
      console.error('[Analytics] loadEngagement error', err);
      const el = document.getElementById('kpi-engagement');
      if (el) el.textContent = '--%';
    }
  }

  async function loadFollowerGrowth() {
    try {
      const { data, unauthorized, error } = await fetchAnalyticsJson('/api/analytics/followers');
      if (unauthorized) return;
      if (error || !data || data.ok === false) throw new Error('followers_fetch_failed');
      renderFollowerGrowth(data.trends || []);
    } catch (err) {
      console.error('[Analytics] loadFollowerGrowth error', err);
      const el = document.getElementById('followers-chart');
      if (el) el.textContent = 'No follower data yet.';
    }
  }

  async function loadFollowerGrowthChart() {
    try {
      const { data, unauthorized, error } = await fetchAnalyticsJson('/api/analytics/overview');
      if (unauthorized) return;
      if (error || !data || data.ok === false) throw new Error('followers_fetch_failed');
      const followers = data.followers || [];
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
      const { data, unauthorized, error } = await fetchAnalyticsJson('/api/analytics/sync-status');
      if (unauthorized) return;
      const el = document.getElementById('sync-status');
      if (!el) return;
      if (error || !data) {
        el.textContent = 'No sync has occurred yet.';
        return;
      }
      const s = data.status;
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

  loadHeatmap();
  loadAlerts();
  loadFollowerGrowth();
  loadSyncStatus();
  loadFollowerGrowthChart();
  loadExperiments();
  loadDemographics();
  loadGrowthReport();
  const exportBtn = document.getElementById('export-posts-csv');
  if (exportBtn) {
    exportBtn.addEventListener('click', exportPostsToCSV);
  }
  const refreshBtn = document.getElementById('refresh-all-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', refreshAllData);
  }
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
    const btn = e.target.closest('.experiment-btn');
    if (!btn) return;

    const title = btn.getAttribute('data-title') || 'New Experiment';
    const description = btn.getAttribute('data-description') || '';

    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Creating...';

    try {
      const res = await fetch('/api/analytics/experiments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, description }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error('experiment_create_failed');

      if (typeof loadExperiments === 'function') {
        await loadExperiments();
      }

      btn.textContent = 'Experiment Created';
    } catch (err) {
      console.error('[Analytics] experiment create error', err);
      btn.textContent = originalText;
      btn.disabled = false;
    }
  });

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.delete-experiment-btn');
    if (!btn) return;

    const id = btn.dataset.id;
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Removing…';

    try {
      const res = await fetch(`/api/analytics/experiments/${id}`, { method: 'DELETE' });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error('delete_failed');
      if (typeof loadExperiments === 'function') await loadExperiments();
    } catch (err) {
      console.error('[Analytics] delete experiment error', err);
      btn.disabled = false;
      btn.textContent = original;
    }
  });

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.complete-experiment-btn');
    if (!btn) return;
    const id = btn.dataset.id;
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Updating...';
    try {
      const res = await fetch(`/api/analytics/experiments/${id}/complete`, { method: 'PATCH' });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error('complete_failed');
      if (typeof loadExperiments === 'function') await loadExperiments();
    } catch (err) {
      console.error('[Analytics] complete experiment error', err);
      btn.disabled = false;
      btn.textContent = original;
    }
  });

  async function handleSyncNow() {
    const btn = document.getElementById('sync-now-btn');
    const statusEl = document.getElementById('sync-status');
    if (btn) btn.disabled = true;
    if (statusEl) statusEl.textContent = 'Sync in progress...';

    try {
      const syncRes = await fetch('/api/analytics/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const syncJson = await syncRes.json();
      const success = syncRes.ok && syncJson.ok;

      if (!success) {
        throw new Error('sync_failed');
      }

      await loadSyncStatus();
      await loadFullAnalytics();
      await loadConnectedAccounts();
    } catch (err) {
      console.error('[Analytics] handleSyncNow error', err);
      if (statusEl) statusEl.textContent = 'Sync failed. Try again later.';
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function refreshAllData() {
    const btn = document.getElementById('refresh-all-btn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Refreshing...';
    }
    try {
      await fetch('/api/phyllo/sync-posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      await fetch('/api/phyllo/sync-followers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      await fetch('/api/phyllo/sync-demographics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      await loadSyncStatus();
      await loadFullAnalytics();
      await loadFollowerGrowthChart();
      await loadDemographics();
      await loadInsights();
    } catch (err) {
      console.error('[Analytics] refreshAllData error', err);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Refresh All Data';
      }
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
