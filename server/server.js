/**
 * TGS Page Generator — Express webhook server
 *
 * Clay sends a POST to /generate with prospect fields.
 * This server calls Claude to build the HTML, commits it to GitHub
 * (triggering Vercel auto-deploy), and returns the live URL.
 *
 * Start:  node server.js
 * Port:   process.env.PORT || 3000
 */

require('dotenv').config();
const express = require('express');
const { buildHtml } = require('./lib/buildHtml');
const { deployToGitHub } = require('./lib/deploy');

const app = express();
app.use(express.json());

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'tgs-page-generator' });
});

// ── Generate endpoint ─────────────────────────────────────────────────────────
/**
 * Expected Clay payload:
 * {
 *   "first_name": "Jake",
 *   "last_name": "Vande Hey",
 *   "title": "VP Sales",
 *   "company": "Calix",
 *   "company_domain": "calix.com",       ← Clay field name
 *   "solution_focus": "...",
 *   "solution_focus_reworded": "...",
 *   "event_theme": "...",
 *   "competitor": "..."
 * }
 */
app.post('/generate', async (req, res) => {
  const body = req.body;

  // Normalise domain field (Clay exports as company_domain)
  const prospect = {
    first_name:              body.first_name,
    last_name:               body.last_name,
    title:                   body.title || '',
    company:                 body.company,
    domain:                  body.company_domain || body.domain || '',
    solution_focus:          body.solution_focus || '',
    solution_focus_reworded: body.solution_focus_reworded || '',
    event_theme:             body.event_theme || '',
    competitor:              body.competitor || '',
  };

  // Validate required fields
  const missing = ['first_name', 'last_name', 'company', 'domain'].filter(k => !prospect[k]);
  if (missing.length) {
    return res.status(400).json({
      error: 'Missing required fields',
      missing,
    });
  }

  console.log(`[generate] ${prospect.first_name} ${prospect.last_name} — ${prospect.company}`);

  try {
    const { html, filename } = await buildHtml(prospect);
    console.log(`[generate] HTML built (${html.length} chars) → ${filename}`);

    const url = await deployToGitHub(html, filename);
    console.log(`[generate] Deployed → ${url}`);

    res.json({ ok: true, url, filename });
  } catch (err) {
    console.error(`[generate] Error: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`TGS page-generator listening on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/`);
  console.log(`Webhook:      POST http://localhost:${PORT}/generate`);
});
