const fetch = require('node-fetch');

async function getPhylloPosts(accountId) {
  const url = `https://api.sandbox.getphyllo.com/v1/posts?account_id=${accountId}`;
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
  const url = `https://api.sandbox.getphyllo.com/v1/posts/${postId}/metrics`;
  const resp = await fetch(url, {
    headers: {
      'Client-Id': process.env.PHYLLO_CLIENT_ID,
      'Client-Secret': process.env.PHYLLO_CLIENT_SECRET,
      'Content-Type': 'application/json',
    },
  });
  return resp.json();
}

module.exports = { getPhylloPosts, getPhylloPostMetrics };
