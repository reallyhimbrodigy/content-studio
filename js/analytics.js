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

function lockAnalyticsSection(sectionKey) {
  const el = document.querySelector(`[data-analytics-section="${sectionKey}"]`);
  if (!el) return;
  el.classList.add('analytics-section-locked');
  if (!el.dataset.lockHandlerAttached) {
    el.dataset.lockHandlerAttached = 'true';
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openUpgradeCTA();
    });
  }
}

function setAnalyticsUnauthenticatedState() {
  const el = document.querySelector('[data-analytics-section="auth"]');
  if (el) {
    el.classList.add('analytics-section-unauthenticated');
  }
}

let analyticsIsPro = false;

const supabaseUrlMeta = document.querySelector('meta[name="supabase-url"]');
const supabaseAnonKeyMeta = document.querySelector('meta[name="supabase-anon-key"]');
const SUPABASE_META_URL = supabaseUrlMeta?.getAttribute('content')?.trim() || '';
const SUPABASE_META_ANON_KEY = supabaseAnonKeyMeta?.getAttribute('content')?.trim() || '';
let supabaseClientInstance = null;
let supabaseMissingLogged = false;

function ensureSupabaseClient() {
  if (supabaseClientInstance) return supabaseClientInstance;
  if (!SUPABASE_META_URL || !SUPABASE_META_ANON_KEY) {
    if (!supabaseMissingLogged) {
      supabaseMissingLogged = true;
      console.error('[Analytics] Supabase credentials are missing; add meta tags for supabase-url and supabase-anon-key.');
    }
    return null;
  }
  if (typeof window === 'undefined' || !window.supabase) {
    if (!supabaseMissingLogged) {
      supabaseMissingLogged = true;
      console.error('[Analytics] Supabase SDK not loaded; include https://cdn.jsdelivr.net/npm/@supabase/supabase-js before analytics.js.');
    }
    return null;
  }
  try {
    supabaseClientInstance = window.supabase.createClient(SUPABASE_META_URL, SUPABASE_META_ANON_KEY);
    return supabaseClientInstance;
  } catch (err) {
    if (!supabaseMissingLogged) {
      supabaseMissingLogged = true;
      console.error('[Analytics] Failed to initialize Supabase client', err);
    }
    return null;
  }
}

async function getAnalyticsAccessToken() {
  const supabaseClient = ensureSupabaseClient();
  if (!supabaseClient) return null;
  try {
    const { data } = await supabaseClient.auth.getSession();
    return data?.session?.access_token || null;
  } catch (err) {
    console.warn('[Analytics] Unable to read Supabase session', err);
    return null;
  }
}

async function fetchAuthenticated(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (!headers.has('Content-Type') && options.body && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  const token = await getAnalyticsAccessToken();
  if (!token) {
    return new Response(JSON.stringify({ ok: false, unauthorized: true }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  headers.set('Authorization', `Bearer ${token}`);
  const finalOptions = {
    credentials: 'same-origin',
    ...options,
    headers,
  };
  return fetch(url, finalOptions);
}

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
  const headers = new Headers(options?.headers || {});
  const token = await getAnalyticsAccessToken();
  if (!token) {
    return { unauthorized: true, data: null };
  }
  headers.set('Authorization', `Bearer ${token}`);
  const finalOptions = { ...(options || {}), headers };
  if (!finalOptions.credentials) {
    finalOptions.credentials = 'same-origin';
  }
  const res = await fetch(url, finalOptions);

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

function applyProButtonStyles() {
  const proBtns = document.querySelectorAll('#generate-insights-btn, .experiment-btn');
  proBtns.forEach((btn) => {
    if (!btn) return;
    if (analyticsIsPro) {
      btn.classList.remove('analytics-btn-locked');
      btn.disabled = false;
    } else {
      btn.classList.add('analytics-btn-locked');
    }
  });
}

function applyShareReportGating() {
  const shareBtn = document.getElementById('analytics-share-report-btn');
  if (!shareBtn) return;

  // If Pro, remove any upgrade handler and locked styling.
  if (analyticsIsPro) {
    shareBtn.classList.remove('analytics-btn-locked');
    if (shareBtn.__upgradeHandler) {
      shareBtn.removeEventListener('click', shareBtn.__upgradeHandler);
      shareBtn.__upgradeHandler = null;
    }
    return;
  }

  // Free users: lock the button and route clicks to upgrade modal.
  shareBtn.classList.add('analytics-btn-locked');
  if (!shareBtn.__upgradeHandler) {
    const handler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openUpgradeCTA();
    };
    shareBtn.__upgradeHandler = handler;
    shareBtn.addEventListener('click', handler);
  }
}

function openUpgradeCTA() {
  const fn = window.openUpgradeModal || window.showUpgradeModal;
  if (typeof fn === 'function') {
    fn();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const connectBtn = document.getElementById('connect-account');

  const ANALYTICS_WORK_PLATFORM_IDS = [
    'de55aeec-0dc8-4119-bf90-16b3d1f0c987', // TikTok
    '9bb8913b-ddd9-430b-a66a-d74d846e6c66', // Instagram
  ];
  const ANALYTICS_PLATFORM_LABELS = ['TikTok', 'Instagram'];

  let phylloConnectInstance = null;
  let tokenExpiredTimeout = null;

  function showTokenExpiredNotice() {
    const statusEl = document.getElementById('sync-status');
    if (!statusEl) return;
    statusEl.textContent = 'Phyllo session expired; reconnect to refresh analytics.';
    if (tokenExpiredTimeout) {
      clearTimeout(tokenExpiredTimeout);
    }
    tokenExpiredTimeout = setTimeout(() => {
      loadSyncStatus();
      tokenExpiredTimeout = null;
    }, 12000);
  }

  async function persistPhylloConnection(action, payload) {
    try {
      const res = await fetchAuthenticated(`/api/phyllo/accounts/${action}`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        console.error(`[Phyllo] ${action} failed`, res.status, detail);
        return false;
      }
      return true;
    } catch (err) {
      console.error(`[Phyllo] ${action} error`, err);
      return false;
    }
  }

  function attachPhylloEvents(instance) {
    instance.on('accountConnected', async (accountId, workPlatformId, userId) => {
      console.log('[Phyllo] accountConnected', { accountId, workPlatformId, userId });
      const saved = await persistPhylloConnection('connect', {
        userId,
        accountId,
        workPlatformId,
      });
      if (saved) {
        loadConnectedAccounts();
        loadSyncStatus();
      }
    });

    instance.on('accountDisconnected', async (accountId, workPlatformId, userId) => {
      console.log('[Phyllo] accountDisconnected', { accountId, workPlatformId, userId });
      const saved = await persistPhylloConnection('disconnect', {
        userId,
        accountId,
        workPlatformId,
      });
      if (saved) {
        loadConnectedAccounts();
      }
    });

    instance.on('tokenExpired', (userId) => {
      console.log('[Phyllo] tokenExpired for user', userId);
      showTokenExpiredNotice();
    });

    instance.on('exit', (reason, userId) => {
      console.log('[Phyllo] exit', { reason, userId });
    });

    instance.on('connectionFailure', (reason, workPlatformId, userId) => {
      console.log('[Phyllo] connectionFailure', { reason, workPlatformId, userId });
    });
  }

  async function fetchPhylloConfig() {
    try {
      const res = await fetchAuthenticated('/api/phyllo/connect-config');
      if (!res.ok) {
        console.error('[Phyllo] connect-config failed', res.status);
        return null;
      }
      const parsed = await res.json();
      if (!parsed || parsed.ok === false) {
        console.error('[Phyllo] connect-config error', parsed);
        return null;
      }
      return parsed.config;
    } catch (err) {
      console.error('[Phyllo] connect-config request failed', err);
      return null;
    }
  }

  let phylloConfigCache = null;

  async function openPhyllo() {
    try {
      if (!window.PhylloConnect) {
        console.error('[Phyllo] PhylloConnect SDK is not loaded');
        return;
      }
      if (phylloConnectInstance) {
        phylloConnectInstance.open();
        return;
      }
      const config = phylloConfigCache || (await fetchPhylloConfig());
      if (!config) return;
      phylloConfigCache = config;
      config.workPlatformIds = ANALYTICS_WORK_PLATFORM_IDS.slice();
      if (config.token) {
        console.log('[Phyllo] connect config ready', {
          environment: config.environment,
          userId: config.userId,
          workPlatformCount: config.workPlatformIds.length,
          platforms: ANALYTICS_PLATFORM_LABELS,
          tokenLength: config.token.length,
        });
      }
      const instance = window.PhylloConnect.initialize(config);
      attachPhylloEvents(instance);
      phylloConnectInstance = instance;
      instance.open();
    } catch (err) {
      console.error('[Phyllo] connect error', err);
    }
  }

  if (connectBtn) {
    connectBtn.addEventListener('click', openPhyllo);
  }

  async function loadInsights() {
    try {
      const { data, unauthorized, error } = await fetchAnalyticsJson('/api/analytics/insights');
      if (unauthorized) {
        setAnalyticsUnauthenticatedState();
        renderInsights([], analyticsIsPro);
        applyProButtonStyles();
        return;
      }
      if (error) throw new Error('insights fetch failed');
      renderInsights(data.insights || [], analyticsIsPro);
      applyProButtonStyles();
    } catch (err) {
      console.error('[Analytics] loadInsights error', err);
      renderInsights([], analyticsIsPro);
      applyProButtonStyles();
    }
  }

  initPostTableSorting();
  initPlatformFilter();
  loadSubscriptionAndAnalytics();
  loadConnectedAccounts();
  document.addEventListener('click', (e) => {
    const lockedBtn = e.target.closest('.analytics-btn-locked');
    if (!lockedBtn) return;
    e.preventDefault();
    e.stopPropagation();
    openUpgradeCTA();
  });
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
      renderInsights('__loading', analyticsIsPro);
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

      setOverviewRangeLabel(analyticsData);
      renderOverview(analyticsData.overview || {});
      renderPosts(analyticsData.posts || []);
      renderDemographics(analyticsData.demographics || {});
      renderInsights(analyticsData.insights || [], analyticsIsPro);
      applyProButtonStyles();
      renderLastSync(analyticsData.last_sync);
      renderGrowthReport(analyticsData.report || analyticsData.growth_report || null);
      renderPlatformBreakdown(analyticsData.posts || []);
    } catch (err) {
      console.error('[Analytics] loadFullAnalytics error', err);
      renderOverview({});
      renderPosts([]);
      renderDemographics({});
      renderInsights([], analyticsIsPro);
      applyProButtonStyles();
      renderGrowthReport(null);
      renderDemoBadge(false);
      renderPlatformBreakdown([]);
      setOverviewRangeLabel(null);
    }
  }

  async function loadSubscriptionAndAnalytics() {
    try {
      const res = await fetch('/api/user/subscription');
      const json = await res.json();
      const plan = json.plan || 'free';
      analyticsIsPro = plan === 'pro' || plan === 'teams';
      removeProRangeHelpers();
      applyAnalyticsAccess(plan);
      applyProButtonStyles();
      applyShareReportGating();
      await loadFullAnalytics();
    } catch (err) {
      console.error('[Analytics] subscription load error', err);
      analyticsIsPro = false;
      applyAnalyticsAccess('free');
      applyProButtonStyles();
      applyShareReportGating();
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
      const { data, unauthorized, error } = await fetchAnalyticsJson('/api/analytics/heatmap');
      if (unauthorized) {
        setAnalyticsUnauthenticatedState();
        return;
      }
      if (data?.disabled && data.reason === 'upgrade_required') {
        lockAnalyticsSection('heatmap');
        return;
      }
      if (error || !data || data.ok === false) throw new Error('heatmap_fetch_failed');
      renderHeatmap(data.heatmap || []);
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
    const safeExperiments = Array.isArray(experiments) ? experiments : [];
    const container = document.getElementById('experiments-list');
    if (!container) return;
    if (!safeExperiments.length) {
      container.textContent = 'No experiments yet.';
      return;
    }
    container.innerHTML = '';
    safeExperiments.forEach((exp) => {
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
        setAnalyticsUnauthenticatedState();
        renderExperiments([]);
        return;
      }
      if (data?.disabled && data.reason === 'upgrade_required') {
        lockAnalyticsSection('experiments');
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
      if (data && data.error === 'upgrade_required') {
        lockAnalyticsSection('alerts');
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
      if (data && data.error === 'upgrade_required') {
        lockAnalyticsSection('demographics');
        return;
      }
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
      if (unauthorized) {
        setAnalyticsUnauthenticatedState();
        return;
      }
      if (data?.disabled && data.reason === 'upgrade_required') {
        lockAnalyticsSection('report');
        return;
      }
      if (error || !data || data.ok === false) throw new Error('report_fetch_failed');
      renderGrowthReport(data.report || null);
    } catch (err) {
      console.error('[Analytics] loadGrowthReport error', err);
      renderGrowthReport(null);
    }
  }

  function renderDemographics(demo = {}) {
    const safeDemo = demo && typeof demo === 'object' ? demo : {};
    renderKeyValueBlock('demographics-age', 'Age', safeDemo.age);
    renderKeyValueBlock('demographics-gender', 'Gender', safeDemo.gender);
    renderKeyValueBlock('demographics-location', 'Location', safeDemo.location);
    renderKeyValueBlock('demographics-language', 'Language', safeDemo.language);
    renderDemographicsPanel(safeDemo);
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

    const safeDemo = demo && typeof demo === 'object' ? demo : {};
    const platforms = Object.keys(safeDemo);
    if (!platforms.length) {
      panel.textContent = 'No demographic data yet.';
      return;
    }

    platforms.forEach((platform) => {
      const block = document.createElement('div');
      block.className = 'demo-block';
      const items = safeDemo[platform] || [];
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

  function setOverviewRangeLabel(payload) {
    const el = document.getElementById('analytics-overview-range');
    if (!el) return;

    if (!analyticsIsPro) {
      el.textContent = ' · Last 30 days';
      return;
    }

    const label =
      (payload && payload.overview && payload.overview.rangeLabel) ||
      (payload && payload.rangeLabel);

    el.textContent = label ? ` · ${label}` : ' · Full history';
  }

  function removeProRangeHelpers() {
    if (!analyticsIsPro) return;
    document.querySelectorAll('.analytics-kpi-helper').forEach((el) => {
      const text = (el.textContent || '').toLowerCase();
      if (text.includes('last 30 days')) {
        el.remove();
      }
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
      if (data && data.error === 'upgrade_required') {
        lockAnalyticsSection('followers');
        return;
      }
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
    const safeTrends = Array.isArray(trends) ? trends : [];
    const container = document.getElementById('followers-chart');
    if (!container) return;
    container.innerHTML = '';
    if (!safeTrends.length) {
      container.textContent = 'No follower data yet.';
      return;
    }
    const max = Math.max(...safeTrends.map((t) => t.count || 0)) || 1;
    safeTrends.forEach((t) => {
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

    if (!analyticsIsPro) {
      e.preventDefault();
      e.stopPropagation();
      openUpgradeCTA();
      return;
    }

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
      if (json && json.error === 'upgrade_required') {
        lockAnalyticsSection('experiments');
        if (typeof window.showUpgradeModal === 'function') {
          window.showUpgradeModal();
        }
        btn.textContent = originalText;
        btn.disabled = false;
        return;
      }
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
      if (json && json.error === 'upgrade_required') {
        lockAnalyticsSection('experiments');
        if (typeof window.showUpgradeModal === 'function') {
          window.showUpgradeModal();
        }
        btn.disabled = false;
        btn.textContent = original;
        return;
      }
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
      if (json && json.error === 'upgrade_required') {
        lockAnalyticsSection('experiments');
        if (typeof window.showUpgradeModal === 'function') {
          window.showUpgradeModal();
        }
        btn.disabled = false;
        btn.textContent = original;
        return;
      }
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
      await fetchAuthenticated('/api/phyllo/sync-posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      await fetchAuthenticated('/api/phyllo/sync-followers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      await fetchAuthenticated('/api/phyllo/sync-demographics', {
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
    const res = await fetchAuthenticated('/api/phyllo/sync-audience', {
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
    // Allow Free users to generate insights; server will limit payload size for Free.
    try {
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Generating...';
      }
      if (list) {
        list.textContent = 'Analyzing your posts...';
      }

      const res = await fetchAuthenticated('/api/analytics/insights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ posts: [] }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error('insights_generate_failed');

      const latest = await fetchAuthenticated('/api/analytics/insights');
      const latestJson = await latest.json();
      if (latestJson.ok) {
        renderInsights(latestJson.insights || [], analyticsIsPro);
        applyProButtonStyles();
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
