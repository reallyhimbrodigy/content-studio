const PHYLLO_API_BASE_URL = process.env.PHYLLO_API_BASE_URL || 'https://api.insightiq.ai';
const PHYLLO_CLIENT_ID = process.env.PHYLLO_CLIENT_ID;
const PHYLLO_CLIENT_SECRET = process.env.PHYLLO_CLIENT_SECRET;

if (!PHYLLO_CLIENT_ID || !PHYLLO_CLIENT_SECRET) {
  console.warn('[Phyllo] PHYLLO_CLIENT_ID/PHYLLO_CLIENT_SECRET are not set');
}

const PHYLLO_AUTH_TOKEN = PHYLLO_CLIENT_ID && PHYLLO_CLIENT_SECRET
  ? Buffer.from(`${PHYLLO_CLIENT_ID}:${PHYLLO_CLIENT_SECRET}`).toString('base64')
  : '';

async function phylloFetch(path, options = {}) {
  const url = path.startsWith('http') ? path : `${PHYLLO_API_BASE_URL}${path}`;
  const headers = {
    Authorization: PHYLLO_AUTH_TOKEN ? `Basic ${PHYLLO_AUTH_TOKEN}` : undefined,
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  const requestId = options.requestId || null;
  const userId = options.userId || null;
  const attempt = options.attempt || 1;
  const timeoutMs = options.timeoutMs || 12000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(url, {
      method: options.method || 'GET',
      headers,
      signal: controller.signal,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch (err) {
    console.error('[Phyllo] API request failed', {
      url,
      requestId,
      userId,
      error: err?.message || err,
    });
    clearTimeout(timeout);
    if (attempt === 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return phylloFetch(path, { ...options, attempt: 2 });
    }
    throw err;
  }
  clearTimeout(timeout);
  if (!resp.ok) {
    const status = resp.status;
    const statusText = resp.statusText;
    const bodyText = await resp.text().catch(() => '');
    console.error('[Phyllo] API request failed', {
      url,
      status,
      statusText,
      requestId,
      userId,
      body: bodyText.slice(0, 300),
    });
    if (status >= 500 && attempt === 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return phylloFetch(path, { ...options, attempt: 2 });
    }
    throw new Error(`phyllo_${status}`);
  }
  return resp.json();
}

async function getPhylloPosts(accountId, options = {}) {
  return phylloFetch(`/v1/posts?account_id=${accountId}`, options);
}

async function getPhylloPostMetrics(postId, options = {}) {
  return phylloFetch(`/v1/posts/${postId}/metrics`, options);
}

async function getUserPostMetrics(accounts = [], options = {}) {
  const posts = [];
  let totalViews = 0;
  let totalEngInteractions = 0;
  let totalRetention = 0;
  let retentionCount = 0;

  for (const acc of accounts) {
    const accountId = acc && (acc.account_id || acc.phyllo_account_id);
    if (!acc || !accountId) continue;
    try {
      const postsResp = await getPhylloPosts(accountId, options);
      const list = postsResp?.data || [];
      for (const p of list) {
        const postId = p.id;
        const base = {
          account_id: accountId,
          platform: acc.platform || p.platform || acc.work_platform_id || 'unknown',
          post_id: postId,
          title: p.title || p.caption || 'Untitled',
          caption: p.caption || null,
          url: p.url || null,
          published_at: p.published_at || null,
        };

        let metrics = {};
        try {
          const metricsResp = await getPhylloPostMetrics(postId, options);
          metrics = metricsResp?.data || {};
        } catch (err) {
          // ignore per-post metric errors
        }

        const views = Number(metrics.views || metrics.impressions || 0);
        const likes = Number(metrics.likes || 0);
        const comments = Number(metrics.comments || 0);
        const shares = Number(metrics.shares || metrics.reposts || 0);
        const saves = Number(metrics.saves || 0);
        const retention = metrics.retention_pct != null ? Number(metrics.retention_pct) : null;

        totalViews += views;
        totalEngInteractions += likes + comments + shares + saves;
        if (retention != null && !Number.isNaN(retention)) {
          totalRetention += retention;
          retentionCount += 1;
        }

        posts.push({
          ...base,
          views,
          likes,
          comments,
          shares,
          saves,
          retention_pct: retention,
        });
      }
    } catch (err) {
      // skip this account on failure
    }
  }

  const postCount = posts.length || 1;
  const avgViews = totalViews / postCount;
  const engagementRate = totalViews > 0 ? totalEngInteractions / totalViews : 0;
  const retentionAvg = retentionCount > 0 ? totalRetention / retentionCount : 0;

  return {
    posts,
    summary: {
      followerGrowth: 0,
      engagementRate,
      avgViews,
      retention: retentionAvg,
    },
  };
}

async function getAudienceDemographics(accounts = [], options = {}) {
  // Overloaded helper:
  // - If a string is provided, treat it as phylloUserId and call production audience-demographics endpoint.
  // - If an array is provided, prefer phyllo_user_id; fall back to legacy creator_id flow (sandbox).
  if (!accounts) return null;

  if (typeof accounts === 'string') {
    try {
      return phylloFetch(`/v1/users/${accounts}/audience-demographics`, options);
    } catch (err) {
      console.error('[Phyllo] audience demographics error', err);
      return null;
    }
  }

  if (!Array.isArray(accounts)) return null;

  const withUserId = accounts.find((acc) => acc && acc.phyllo_user_id);
  if (withUserId && withUserId.phyllo_user_id) {
    try {
      return phylloFetch(`/v1/users/${withUserId.phyllo_user_id}/audience-demographics`, options);
    } catch (err) {
      console.error('[Phyllo] audience demographics error', err);
      return null;
    }
  }

  const results = [];
  for (const acc of accounts) {
    if (!acc || !acc.creator_id) continue;
    try {
      const resp = await phylloFetch(`/v1/creators/${acc.creator_id}/audience`, options);
      if (!resp) continue;
      results.push({ platform: acc.platform || acc.work_platform_id || 'unknown', audience: resp });
    } catch (err) {
      // ignore per-account errors for now
    }
  }
  return results;
}

async function buildWeeklyReport({ posts = [], overview = {}, insights = [], alerts = [], isPro = true }) {
  const weekStart = new Date().toISOString().slice(0, 10);

  if (!isPro) {
    // Free tier teaser: last-30-day basics + limited insights
    const limitedOverview = {
      followerGrowth:
        overview.followerGrowth ?? overview.follower_growth ?? overview.followers_growth ?? null,
      engagementRate:
        overview.engagementRate ?? overview.engagement_rate ?? null,
      avgViewsPerPost:
        overview.avgViewsPerPost ?? overview.avg_views_per_post ?? overview.avg_views ?? null,
    };

    return {
      weekStart,
      tier: 'free',
      overview: limitedOverview,
      topPosts: [],
      insights: (insights || []).slice(0, 2),
      alerts: [],
      highlights: {
        fastestGrowingPlatform: null,
        bestPostingTime: null,
      },
    };
  }

  return {
    weekStart,
    tier: 'pro',
    overview,
    topPosts: posts.slice(0, 5),
    insights,
    alerts,
    highlights: {
      fastestGrowingPlatform: overview.fastestGrowingPlatform || null,
      bestPostingTime: overview.bestPostingTime || null,
    },
  };
}

async function syncAudience(userId) {
  // Placeholder audience sync; expand with real Phyllo calls and Supabase writes as needed.
  console.warn('[Phyllo] syncAudience placeholder for user', userId);
  return { updated: 0 };
}

async function syncFollowerMetrics(userId) {
  const base = PHYLLO_API_BASE_URL;
  let total = 0;
  const followerSeries = [];

  try {
    // Load connected accounts for this user
    const { supabaseAdmin } = require('./supabase-admin');
    const { data: accounts, error } = await supabaseAdmin
      .from('phyllo_accounts')
      .select('phyllo_account_id, work_platform_id, username')
      .eq('promptly_user_id', userId)
      .eq('status', 'connected');

    if (error || !accounts || !accounts.length) {
      if (error) {
        console.error('[Phyllo] syncFollowerMetrics accounts error', error);
      }
      return { total, followerSeries };
    }

    for (const acc of accounts) {
      const accountId = acc.phyllo_account_id || acc.account_id;
      if (!acc || !accountId) continue;
      try {
        const url = `${base}/v1/accounts/${accountId}/followers`;
        const resp = await fetch(url, {
          headers: {
            'Client-Id': process.env.PHYLLO_CLIENT_ID,
            'Client-Secret': process.env.PHYLLO_CLIENT_SECRET,
            'Content-Type': 'application/json',
          },
        });

        if (!resp.ok) {
          console.warn('[Phyllo] followers fetch failed', acc.account_id, resp.status);
          continue;
        }

        const json = await resp.json();
        const list = json?.data || json || [];

        list.forEach((item) => {
          followerSeries.push({
            platform: acc.work_platform_id || 'unknown',
            account_id: accountId,
            followers: item.followers || item.follower_count || item.count || 0,
            captured_at: item.captured_at || item.timestamp || item.date || null,
          });
          total += 1;
        });
      } catch (err) {
        console.error('[Phyllo] followers fetch error', acc.account_id, err.message);
      }
    }
  } catch (err) {
    console.error('[Phyllo] syncFollowerMetrics unexpected error', err);
  }

  return { total, followerSeries };
}

async function syncDemographics(userId) {
  const base = PHYLLO_API_BASE_URL;
  const demographics = {};

  try {
    const { supabaseAdmin } = require('./supabase-admin');
    const { data: accounts, error } = await supabaseAdmin
      .from('phyllo_accounts')
      .select('phyllo_account_id, work_platform_id')
      .eq('promptly_user_id', userId)
      .eq('status', 'connected');

    if (error || !accounts || !accounts.length) {
      if (error) {
        console.error('[Phyllo] syncDemographics accounts error', error);
      }
      return demographics;
    }

    for (const acc of accounts) {
      const accountId = acc.phyllo_account_id || acc.account_id;
      if (!acc || !accountId) continue;
      try {
        const url = `${base}/v1/accounts/${accountId}/audience`;
        const resp = await fetch(url, {
          headers: {
            'Client-Id': process.env.PHYLLO_CLIENT_ID,
            'Client-Secret': process.env.PHYLLO_CLIENT_SECRET,
            'Content-Type': 'application/json',
          },
        });
        if (!resp.ok) {
          console.warn('[Phyllo] demographics fetch failed', accountId, resp.status);
          continue;
        }
        const json = await resp.json();
        demographics[acc.work_platform_id || 'unknown'] = json?.data || json || [];
      } catch (err) {
        console.error('[Phyllo] demographics fetch error', accountId, err.message);
      }
    }
  } catch (err) {
    console.error('[Phyllo] syncDemographics unexpected error', err);
  }

  return demographics;
}

module.exports = {
  getPhylloPosts,
  getPhylloPostMetrics,
  getUserPostMetrics,
  getAudienceDemographics,
  buildWeeklyReport,
  syncAudience,
  syncFollowerMetrics,
  syncDemographics,
};
