#!/usr/bin/env node
/**
 * TGS Page Generator — CLI
 *
 * Usage (single prospect):
 *   node generate.js \
 *     --first_name Jake \
 *     --last_name "Vande Hey" \
 *     --title "VP Sales" \
 *     --company Calix \
 *     --domain calix.com \
 *     --solution_focus "fibre broadband enablement" \
 *     --solution_focus_reworded "helping broadband providers modernise their networks" \
 *     --event_theme "operational transformation at the edge" \
 *     --competitor "Nokia"
 *
 * Usage (from CSV — generates all rows):
 *   node generate.js --csv ../coo-summit-prospects.csv
 *
 * Flags:
 *   --deploy        Push to GitHub (triggers Vercel auto-deploy). Default: local only.
 *   --out <dir>     Output directory. Default: ../tgs-landing-pages
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { buildHtml } = require('./lib/buildHtml');
const { deployToGitHub } = require('./lib/deploy');

// ── Minimal arg parser ───────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      args[key] = val;
    }
  }
  return args;
}

// ── CSV parser (no deps) ─────────────────────────────────────────────────────
function parseFields(line) {
  const values = [];
  let cur = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { values.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  values.push(cur.trim());
  return values;
}

// Normalize a header to lowercase_underscore for flexible column matching
function normalizeKey(h) {
  return h.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function parseCsv(filepath) {
  const raw = fs.readFileSync(filepath, 'utf8');
  const lines = raw.trim().split(/\r?\n/);
  const rawHeaders = parseFields(lines[0]);
  // Store both original and normalized keys so row[normalizedKey] works
  const headers = rawHeaders.map(h => h.replace(/^"|"$/g, '').trim());
  const normHeaders = headers.map(normalizeKey);
  return lines.slice(1).map(line => {
    const values = parseFields(line);
    const row = {};
    headers.forEach((h, i) => {
      row[h] = values[i] ?? '';           // original key
      row[normHeaders[i]] = values[i] ?? ''; // normalized key
    });
    return row;
  });
}

// ── Map CSV row → prospect object expected by buildHtml ──────────────────────
// Supports both old format (first_name, title, company) and
// new Clay export format (First Name, Job Title, Company Table Data etc.)
function rowToProspect(row) {
  return {
    first_name:              row.first_name || '',
    last_name:               row.last_name || '',
    title:                   row.job_title || row.title || '',
    company:                 row.company_table_data || row.company || '',
    domain:                  row.company_domain || row.domain || '',
    email:                   row.email || row.work_email || '',
    // Enrichment fields — used in Claude prompt when present
    solution_focus:          row.solution_focus || '',
    solution_focus_reworded: row.solution_focus_reworded || '',
    event_theme:             row.event_theme || '',
    competitor:              row.na_competitor_competitor_company_name || row.competitor || '',
    short_description:       row.short_description || '',
    keywords:                row.keywords || '',
    reason_1:                row.reason_1 || '',
    reason_2:                row.reason_2 || '',
    tier:                    row.tier || '',
    status:                  row.status || '',
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(args.out || path.join(__dirname, '../tgs-landing-pages'));
  const deploy = args.deploy === true || args.deploy === 'true';

  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  let prospects = [];

  if (args.csv) {
    const csvPath = path.resolve(args.csv);
    console.log(`Reading prospects from ${csvPath}…`);
    const rows = parseCsv(csvPath);
    const all = rows.map(rowToProspect);
    // If the CSV has a status column, only include rows with valid emails
    const hasStatusCol = all.some(p => p.status);
    prospects = all.filter(p => {
      if (!p.first_name || !p.company || !p.domain) return false;
      if (hasStatusCol && p.status && p.status !== 'valid') return false;
      return true;
    });
    console.log(`Found ${prospects.length} valid prospects (from ${all.length} rows).\n`);
  } else {
    // Single prospect from flags
    const required = ['first_name', 'last_name', 'company', 'domain'];
    const missing = required.filter(k => !args[k]);
    if (missing.length) {
      console.error(`Missing required flags: ${missing.map(k => `--${k}`).join(', ')}`);
      console.error('Use --csv <path> or provide individual flags. Run with --help for usage.');
      process.exit(1);
    }
    prospects = [rowToProspect(args)];
  }

  const results = [];
  const CONCURRENCY = args.concurrency ? parseInt(args.concurrency) : 1;
  let completed = 0;

  async function processProspect(prospect) {
    const label = `${prospect.first_name} ${prospect.last_name} (${prospect.company})`;
    // Skip if already generated (allows resuming interrupted runs)
    const expectedFilename = `${prospect.first_name.toLowerCase()}-${prospect.last_name.toLowerCase().replace(/\s+/g, '-')}-${prospect.company.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.html`;
    const localPath = path.join(outDir, expectedFilename);
    if (fs.existsSync(localPath) && !args.force) {
      completed++;
      console.log(`Skipping ${label} (already exists) [${completed}/${prospects.length}]`);
      results.push({ filename: expectedFilename, ok: true, skipped: true });
      return;
    }

    try {
      const { html, filename } = await buildHtml(prospect);
      fs.writeFileSync(path.join(outDir, filename), html, 'utf8');

      let url = null;
      if (deploy) {
        url = await deployToGitHub(html, filename);
      }

      completed++;
      console.log(`✓ ${label} → ${filename}${url ? ' → ' + url : ''} [${completed}/${prospects.length}]`);
      results.push({ filename, url, ok: true });
    } catch (err) {
      completed++;
      console.log(`✗ ${label}: ${err.message} [${completed}/${prospects.length}]`);
      results.push({ label, ok: false, error: err.message });
    }
  }

  // Run with concurrency pool
  for (let i = 0; i < prospects.length; i += CONCURRENCY) {
    const batch = prospects.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(processProspect));
  }

  console.log(`\nDone. ${results.filter(r => r.ok).length}/${prospects.length} succeeded (${results.filter(r => r.skipped).length} skipped).`);

  if (!deploy) {
    console.log(`\nFiles saved to: ${outDir}`);
    console.log('To deploy to Vercel manually, run:');
    console.log(`  npx vercel "${outDir}" --prod`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
