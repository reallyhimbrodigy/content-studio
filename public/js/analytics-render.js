let currentPostSort = { key: 'views', direction: 'desc' };
let cachedPosts = [];
let lastSortedPosts = [];
let currentPlatformFilter = 'all';

const numberFmt = (n, opts = {}) => {
  if (n == null || isNaN(n)) return '—';
  const formatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, ...opts });
  return formatter.format(n);
};

export function renderOverview(overview = {}) {
  const fg = document.getElementById('kpi-follower-growth');
  const eng = document.getElementById('kpi-engagement');
  const views = document.getElementById('kpi-views');
  const ret = document.getElementById('kpi-retention');

  const loading = overview.__loading === true;

  const fgVal = overview.follower_growth ?? overview.followerGrowth ?? null;
  const engVal = overview.engagement_rate ?? overview.engagementRate ?? null;
  const viewsVal = overview.avg_views ?? overview.avgViewsPerPost ?? null;
  const retVal = overview.retention ?? overview.retentionPct ?? null;

  if (fg) fg.textContent = loading ? '—' : fgVal != null ? `${numberFmt(fgVal)}${fgVal > 0 ? '+' : ''}` : '—';
  if (eng) eng.textContent = loading ? '—' : engVal != null ? `${numberFmt(engVal, { maximumFractionDigits: 2 })}%` : '—';
  if (views) views.textContent = loading ? '—' : viewsVal != null ? numberFmt(viewsVal) : '—';
  if (ret) ret.textContent = loading ? '—' : retVal != null ? `${numberFmt(retVal, { maximumFractionDigits: 1 })}%` : '—';
}

export function renderPosts(posts = []) {
  const table = document.getElementById('content-performance-table');
  if (!table) return;
  const tbody = table.querySelector('tbody');
  if (!tbody) return;

  if (posts === '__loading') {
    tbody.innerHTML = `
      <tr><td colspan="7" class="analytics-skeleton">&nbsp;</td></tr>
      <tr><td colspan="7" class="analytics-skeleton">&nbsp;</td></tr>
    `;
    return;
  }

  if (!Array.isArray(posts) || !posts.length) {
    tbody.innerHTML = '<tr><td class="analytics-empty" colspan="7">No post data yet.</td></tr>';
    cachedPosts = [];
    return;
  }

  cachedPosts = [...posts];

  const filtered = cachedPosts.filter((p) => {
    if (currentPlatformFilter === 'all') return true;
    return (p.platform || '').toLowerCase() === currentPlatformFilter;
  });

  const sorted = sortPosts(filtered, currentPostSort.key, currentPostSort.direction);
  lastSortedPosts = sorted;

  const fmtPct = (v) => (v == null ? '—' : `${numberFmt(v * 100, { maximumFractionDigits: 1 })}%`);
  tbody.innerHTML = '';
  sorted.forEach((p) => {
    const tr = document.createElement('tr');
    tr.dataset.url = p.url || '';
    tr.classList.add('content-row');

    tr.innerHTML = `
      <td>${p.title || 'Untitled'}</td>
      <td>${p.platform || '—'}</td>
      <td>${numberFmt(p.views)}</td>
      <td>${numberFmt(p.likes)}</td>
      <td>${fmtPct(p.retention_pct || p.retentionPct)}</td>
      <td>${numberFmt(p.shares)}</td>
      <td>${numberFmt(p.saves)}</td>
    `;

    if (p.url) {
      tr.style.cursor = 'pointer';
      tr.addEventListener('click', () => {
        window.open(p.url, '_blank', 'noopener,noreferrer');
      });
    }

    tbody.appendChild(tr);
  });
}

function sortPosts(posts, key, direction) {
  const dir = direction === 'asc' ? 1 : -1;
  return [...posts].sort((a, b) => {
    const va = a[key] ?? 0;
    const vb = b[key] ?? 0;
    if (typeof va === 'string' || typeof vb === 'string') {
      return va.toString().localeCompare(vb.toString()) * dir;
    }
    return (va - vb) * dir;
  });
}

export function renderDemographics(demo = {}) {
  if (demo === '__loading') {
    ['demographics-age', 'demographics-gender', 'demographics-location', 'demographics-language'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) {
        el.innerHTML =
          '<div class="analytics-skeleton" style="height:16px;margin:4px 0;"></div><div class="analytics-skeleton" style="height:16px;margin:4px 0;"></div>';
      }
    });
    return;
  }
  renderKeyValueBlock('demographics-age', 'Age', demo.age_groups || demo.age);
  renderKeyValueBlock('demographics-gender', 'Gender', demo.genders || demo.gender);
  renderKeyValueBlock('demographics-location', 'Location', demo.countries || demo.location);
  renderKeyValueBlock('demographics-language', 'Language', demo.languages || demo.language);
}

function renderKeyValueBlock(containerId, title, data) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = '';

  const entries = data && Object.entries(data);
  if (!entries || !entries.length) {
    el.textContent = `No ${title.toLowerCase()} data yet.`;
    el.classList.add('analytics-empty');
    return;
  }
  el.classList.remove('analytics-empty');

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

export function renderInsights(insights = []) {
  const container = document.getElementById('insights-list');
  if (!container) return;
  container.innerHTML = '';

  if (insights === '__loading') {
    container.innerHTML =
      '<div class="insight-card analytics-skeleton" style="height:80px;"></div><div class="insight-card analytics-skeleton" style="height:80px;"></div>';
    return;
  }

  if (!insights.length) {
    container.textContent = 'No insights yet. Click "Generate Insights" to create them.';
    container.classList.add('analytics-empty');
    return;
  }
  container.classList.remove('analytics-empty');

  insights.forEach((insight, idx) => {
    const card = document.createElement('div');
    card.className = 'insight-card';
    card.innerHTML = `
      <div class="insight-title">${insight.title || 'Insight ' + (idx + 1)}</div>
      <div class="insight-detail">${insight.detail || insight.summaryText || ''}</div>
      <button
        class="experiment-btn"
        data-title="${insight.title || 'Experiment'}"
        data-description="${insight.detail || ''}"
      >
        Try This Experiment
      </button>
    `;
    container.appendChild(card);
  });
}

export function renderLastSync(ts) {
  const syncEl = document.getElementById('sync-status');
  if (!syncEl) return;
  if (!ts) {
    syncEl.textContent = 'No sync has occurred yet.';
    return;
  }
  syncEl.textContent = `Last Sync: ${new Date(ts).toLocaleString()}`;
}

export function renderConnectedAccounts(accounts = []) {
  const container = document.getElementById('connected-accounts-list');
  if (!container) return;

  container.innerHTML = '';

  if (!accounts || !accounts.length) {
    container.textContent = 'No accounts connected yet.';
    return;
  }

  accounts.forEach((acc) => {
    const div = document.createElement('div');
    div.className = 'connected-account-pill';
    const platform = (acc.platform || 'platform').toUpperCase();
    const handle = acc.handle || acc.username || 'Unknown handle';
    div.textContent = `${platform} · ${handle}`;
    container.appendChild(div);
  });
}

export function applyAnalyticsAccess(plan) {
  const isPro = plan === 'pro' || plan === 'teams';

  toggleSection('insights-section', isPro, 'Upgrade to Promptly Pro to unlock AI Insights.');
  toggleSection('experiments-section', isPro, 'Upgrade to run 7-day content experiments.');
  toggleSection('alerts-section', isPro, 'Upgrade to see real-time performance alerts.');
  toggleSection('growth-report-section', isPro, 'Upgrade to get weekly growth reports.');
}

function toggleSection(id, isVisible, upsellText) {
  const section = document.getElementById(id);
  if (!section) return;

  const upsellId = `${id}-upsell`;
  let upsell = document.getElementById(upsellId);

  if (isVisible) {
    section.style.display = '';
    if (upsell) upsell.remove();
    return;
  }

  section.style.display = 'none';

  if (!upsell && section.parentNode) {
    upsell = document.createElement('div');
    upsell.id = upsellId;
    upsell.className = 'analytics-upsell';
    upsell.textContent = upsellText;
    section.parentNode.insertBefore(upsell, section);
  }
}

export function renderGrowthReport(report) {
  const card = document.getElementById('growth-report-card');
  if (!card) return;

  if (report === '__loading') {
    card.innerHTML =
      '<div class="analytics-skeleton" style="height:16px;margin-bottom:10px;"></div><div class="analytics-skeleton" style="height:14px;margin-bottom:6px;"></div><div class="analytics-skeleton" style="height:14px;width:60%;"></div>';
    return;
  }

  if (!report) {
    card.textContent = 'No weekly report generated yet.';
    card.classList.add('analytics-empty');
    return;
  }
  card.classList.remove('analytics-empty');

  const weekLabel = report.weekStart || 'This week';
  const overview = report.overview || {};
  const highlights = report.highlights || {};

  card.innerHTML = `
    <h3>${weekLabel}</h3>
    <div class="growth-report-metrics">
      <div class="growth-report-metric">Follower Growth: ${overview.followerGrowth ?? '—'}</div>
      <div class="growth-report-metric">Engagement Rate: ${overview.engagementRate ?? '—'}%</div>
      <div class="growth-report-metric">Avg Views/Post: ${overview.avgViewsPerPost ?? '—'}</div>
      <div class="growth-report-metric">Retention: ${overview.retentionPct ?? '—'}%</div>
    </div>
    <div class="growth-report-highlights">
      <div>Fastest Growing Platform: ${highlights.fastestGrowingPlatform ?? '—'}</div>
      <div>Best Posting Time: ${highlights.bestPostingTime ?? '—'}</div>
    </div>
  `;
}

export function exportPostsToCSV() {
  const rows = (lastSortedPosts && lastSortedPosts.length ? lastSortedPosts : cachedPosts) || [];
  if (!rows.length) {
    alert('No post data to export.');
    return;
  }

  const headers = ['Title', 'Platform', 'Views', 'Likes', 'Comments', 'Shares', 'Saves', 'RetentionPct', 'URL'];
  const lines = [headers.join(',')];

  rows.forEach((p) => {
    const line = [
      escapeCSV(p.title || ''),
      escapeCSV(p.platform || ''),
      p.views ?? 0,
      p.likes ?? 0,
      p.comments ?? 0,
      p.shares ?? 0,
      p.saves ?? 0,
      p.retention_pct ?? p.retentionPct ?? '',
      escapeCSV(p.url || ''),
    ].join(',');
    lines.push(line);
  });

  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'content-performance.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function escapeCSV(value) {
  const str = String(value).replace(/"/g, '""');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str}"`;
  }
  return str;
}

export function renderDemoBadge(isDemo) {
  const titleEl = document.getElementById('analytics-title');
  if (!titleEl) return;

  let badge = document.getElementById('analytics-demo-badge');
  if (!isDemo) {
    if (badge) badge.remove();
    return;
  }

  if (!badge) {
    badge = document.createElement('span');
    badge.id = 'analytics-demo-badge';
    badge.className = 'analytics-demo-badge';
    badge.textContent = 'Demo Data';
    titleEl.appendChild(badge);
  }
}

export function initPostTableSorting() {
  const table = document.getElementById('content-performance-table');
  if (!table) return;
  const headers = table.querySelectorAll('thead th[data-sort-key]');
  headers.forEach((th) => {
    th.style.cursor = 'pointer';
    th.addEventListener('click', () => {
      const key = th.getAttribute('data-sort-key');
      if (!key) return;
      if (currentPostSort.key === key) {
        currentPostSort.direction = currentPostSort.direction === 'asc' ? 'desc' : 'asc';
      } else {
        currentPostSort.key = key;
        currentPostSort.direction = 'desc';
      }
      if (cachedPosts.length) {
        renderPosts(cachedPosts);
      }
    });
  });
}

export function initPlatformFilter() {
  const select = document.getElementById('platform-filter');
  if (!select) return;
  select.addEventListener('change', () => {
    currentPlatformFilter = select.value;
    if (cachedPosts.length) {
      renderPosts(cachedPosts);
    }
  });
}

export function renderAlerts(alerts) {
  const container = document.getElementById('alerts-list');
  if (!container) return;

  if (alerts === '__loading') {
    container.innerHTML = '<div class="alert-card analytics-skeleton" style="height:20px;"></div>';
    return;
  }

  if (!alerts || alerts.length === 0) {
    container.innerHTML = '<div class="alert-empty">No alerts available.</div>';
    return;
  }

  container.innerHTML = '';
  alerts.forEach((a) => {
    const div = document.createElement('div');
    div.className = 'alert-card';
    div.textContent = a.message || a.detail || a.type || 'Alert';
    container.appendChild(div);
  });
}
