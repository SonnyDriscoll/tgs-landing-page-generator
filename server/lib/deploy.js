require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const axios = require('axios');

const GH_API = 'https://api.github.com';

async function deployToGitHub(html, filename) {
  const { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, BASE_URL } = process.env;

  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
    throw new Error('Missing GitHub env vars: GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO');
  }

  const path = filename;
  const content = Buffer.from(html).toString('base64');
  const headers = {
    Authorization: `token ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'tgs-page-generator',
  };

  // Check if file already exists (need SHA to update)
  let sha;
  try {
    const { data } = await axios.get(
      `${GH_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`,
      { headers }
    );
    sha = data.sha;
  } catch (err) {
    if (err.response?.status !== 404) throw err;
    // 404 means file doesn't exist yet — that's fine
  }

  const body = {
    message: `feat: generate landing page for ${filename}`,
    content,
    ...(sha ? { sha } : {}),
  };

  await axios.put(
    `${GH_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`,
    body,
    { headers }
  );

  const base = (BASE_URL || `https://${GITHUB_REPO}.vercel.app`).replace(/\/$/, '');
  const url = `${base}/${filename}`;
  return url;
}

module.exports = { deployToGitHub };
