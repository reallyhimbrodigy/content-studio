async function getPhylloPosts(accountId) {
  const base = process.env.PHYLLO_API_BASE_URL || 'https://api.sandbox.getphyllo.com';
  const url = `${base}/v1/posts?account_id=${accountId}`;
  const resp = await fetch(url, {
    headers: {
      'Client-Id': process.env.PHYLLO_CLIENT_ID,
      'Client-Secret': process.env.PHYLLO_CLIENT_SECRET,
      'Content-Type': 'application/json',
    },
  });
  return resp.json();
}

async function getPhylloPostMetrics(postId) {
  const base = process.env.PHYLLO_API_BASE_URL || 'https://api.sandbox.getphyllo.com';
  const url = `${base}/v1/posts/${postId}/metrics`;
  const resp = await fetch(url, {
    headers: {
      'Client-Id': process.env.PHYLLO_CLIENT_ID,
      'Client-Secret': process.env.PHYLLO_CLIENT_SECRET,
      'Content-Type': 'application/json',
    },
  });
  return resp.json();
}

async function getUserPostMetrics(accounts = []) {
  const posts = [];
  let totalViews = 0;
  let totalEngInteractions = 0;
  let totalRetention = 0;
  let retentionCount = 0;

  for (const acc of accounts) {
    if (!acc || !acc.account_id) continue;
    try {
      const postsResp = await getPhylloPosts(acc.account_id);
      const list = postsResp?.data || [];
      for (const p of list) {
        const postId = p.id;
        const base = {
          account_id: acc.account_id,
          platform: acc.platform || p.platform || acc.work_platform_id || 'unknown',
          post_id: postId,
          title: p.title || p.caption || 'Untitled',
          caption: p.caption || null,
          url: p.url || null,
          published_at: p.published_at || null,
        };

        let metrics = {};
        try {
          const metricsResp = await getPhylloPostMetrics(postId);
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

async function getAudienceDemographics(accounts = []) {
  // Overloaded helper:
  // - If an array is provided, use legacy creator_id flow (sandbox)
  // - If a string is provided, treat it as phylloUserId and call production audience-demographics endpoint
  if (!accounts) return null;

  // string: new single-user helper
  if (typeof accounts === 'string') {
    try {
      const base = process.env.PHY_PRODUCTION_BASE_URL;
      const clientId = process.env.PHY_PRODUCTION_CLIENT_ID;
      const clientSecret = process.env.PHY_PRODUCTION_CLIENT_SECRET;
      if (!base || !clientId || !clientSecret) {
        console.error('[Phyllo] Missing production audience env vars');
        return null;
      }
      const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      const resp = await fetch(`${base}/v1/users/${accounts}/audience-demographics`, {
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
        },
      });
      if (!resp.ok) {
        console.error('[Phyllo] audience demographics fetch failed', resp.status);
        return null;
      }
      return await resp.json();
    } catch (err) {
      console.error('[Phyllo] audience demographics error', err);
      return null;
    }
  }

  // array: legacy multi-account helper
  const base = process.env.PHYLLO_API_BASE_URL || 'https://api.sandbox.getphyllo.com';
  const results = [];

  for (const acc of accounts) {
    if (!acc || !acc.creator_id) continue;
    try {
      const url = `${base}/v1/creators/${acc.creator_id}/audience`;
      const resp = await fetch(url, {
        headers: {
          'Content-Type': 'application/json',
          'phyllo-client-id': process.env.PHYLLO_CLIENT_ID,
          'phyllo-client-secret': process.env.PHYLLO_CLIENT_SECRET,
        },
      });
      if (!resp.ok) continue;
      const json = await resp.json();
      results.push({ platform: acc.platform || acc.work_platform_id || 'unknown', audience: json });
    } catch (err) {
      // ignore per-account errors for now
    }
  }

  return results;
}

async function buildWeeklyReport({ posts = [], overview = {}, insights = [], alerts = [] }) {
  return {
    weekStart: new Date().toISOString().slice(0, 10),
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
  const base = process.env.PHYLLO_API_BASE_URL || 'https://api.sandbox.getphyllo.com';
  let total = 0;
  const followerSeries = [];

  try {
    // Load connected accounts for this user
    const { supabaseAdmin } = require('./supabase-admin');
    const { data: accounts, error } = await supabaseAdmin
      .from('phyllo_accounts')
      .select('account_id, platform')
      .eq('user_id', userId)
      .eq('status', 'connected');

    if (error || !accounts || !accounts.length) {
      if (error) {
        console.error('[Phyllo] syncFollowerMetrics accounts error', error);
      }
      return { total, followerSeries };
    }

    for (const acc of accounts) {
      if (!acc || !acc.account_id) continue;
      try {
        const url = `${base}/v1/accounts/${acc.account_id}/followers`;
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
            platform: acc.platform || 'unknown',
            account_id: acc.account_id,
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
  const base = process.env.PHYLLO_API_BASE_URL || 'https://api.sandbox.getphyllo.com';
  const demographics = {};

  try {
    const { supabaseAdmin } = require('./supabase-admin');
    const { data: accounts, error } = await supabaseAdmin
      .from('phyllo_accounts')
      .select('account_id, platform, work_platform_id')
      .eq('user_id', userId)
      .eq('status', 'connected');

    if (error || !accounts || !accounts.length) {
      if (error) {
        console.error('[Phyllo] syncDemographics accounts error', error);
      }
      return demographics;
    }

    for (const acc of accounts) {
      if (!acc || !acc.account_id) continue;
      try {
        const url = `${base}/v1/accounts/${acc.account_id}/audience`;
        const resp = await fetch(url, {
          headers: {
            'Client-Id': process.env.PHYLLO_CLIENT_ID,
            'Client-Secret': process.env.PHYLLO_CLIENT_SECRET,
            'Content-Type': 'application/json',
          },
        });
        if (!resp.ok) {
          console.warn('[Phyllo] demographics fetch failed', acc.account_id, resp.status);
          continue;
        }
        const json = await resp.json();
        demographics[acc.platform || acc.work_platform_id || 'unknown'] = json?.data || json || [];
      } catch (err) {
        console.error('[Phyllo] demographics fetch error', acc.account_id, err.message);
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
  getAudienceDemographics,
};

async function getAudienceDemographics(phylloUserId) {
  try {
    const base = process.env.PHY_PRODUCTION_BASE_URL;
    const clientId = process.env.PHY_PRODUCTION_CLIENT_ID;
    const clientSecret = process.env.PHY_PRODUCTION_CLIENT_SECRET;

    if (!base || !clientId || !clientSecret) {
      console.error('[Phyllo] Missing production audience env vars');
      return null;
    }

    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const resp = await fetch(`${base}/v1/users/${phylloUserId}/audience-demographics`, {
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
    });

    if (!resp.ok) {
      console.error('[Phyllo] audience demographics fetch failed', resp.status);
      return null;
    }

    return await resp.json();
  } catch (err) {
    console.error('[Phyllo] audience demographics error', err);
    return null;
  }
}
