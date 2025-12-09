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

module.exports = { getPhylloPosts, getPhylloPostMetrics, getUserPostMetrics, getAudienceDemographics };
