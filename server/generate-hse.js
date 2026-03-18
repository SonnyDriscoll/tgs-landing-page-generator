#!/usr/bin/env node
/**
 * TGS HSE Page Generator — CLI
 *
 * Usage (single prospect):
 *   node generate-hse.js \
 *     --first_name Barney \
 *     --last_name Goffer \
 *     --title "Director Customer Success" \
 *     --company "Teletrac Navman" \
 *     --domain teletracnavman.com \
 *     --solution_focus "fleet telematics and safety" \
 *     --solution_focus_reworded "helping fleet operators reduce incidents and improve driver safety" \
 *     --event_theme "data-driven zero harm" \
 *     --competitor "Samsara"
 *
 * Usage (from CSV — generates all rows):
 *   node generate-hse.js --csv ../../../clients/global-series/imports/hse/[file].csv
 *
 * Flags:
 *   --deploy        Push to GitHub (triggers Vercel auto-deploy). Default: local only.
 *   --out <dir>     Output directory. Default: ../tgs-landing-pages
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { buildHtml } = require('./lib/buildHtml-hse');
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
function parseCsv(filepath) {
  const raw = fs.readFileSync(filepath, 'utf8');
  const lines = raw.trim().split(/\r?\n/);
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  return lines.slice(1).map(line => {
    const values = [];
    let cur = '';
    let inQuotes = false;
    for (const ch of line) {
      if (ch === '"') { inQuotes = !inQuotes; continue; }
      if (ch === ',' && !inQuotes) { values.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    values.push(cur.trim());
    return Object.fromEntries(headers.map((h, i) => [h, values[i] ?? '']));
  });
}

// ── Map CSV row → prospect object expected by buildHtml ──────────────────────
function rowToProspect(row) {
  return {
    first_name:              row.first_name,
    last_name:               row.last_name,
    title:                   row.title,
    company:                 row.company,
    domain:                  row.company_domain || row.domain || '',
    solution_focus:          row.solution_focus || '',
    solution_focus_reworded: row.solution_focus_reworded || '',
    event_theme:             row.event_theme || '',
    competitor:              row.competitor || '',
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
    prospects = rows.map(rowToProspect).filter(p => p.first_name && p.company);
    console.log(`Found ${prospects.length} prospects.\n`);
  } else {
    const required = ['first_name', 'last_name', 'company', 'domain'];
    const missing = required.filter(k => !args[k]);
    if (missing.length) {
      console.error(`Missing required flags: ${missing.map(k => `--${k}`).join(', ')}`);
      console.error('Use --csv <path> or provide individual flags.');
      process.exit(1);
    }
    prospects = [rowToProspect(args)];
  }

  const results = [];

  for (const prospect of prospects) {
    const label = `${prospect.first_name} ${prospect.last_name} (${prospect.company})`;
    process.stdout.write(`Generating HSE page for ${label}… `);

    try {
      const { html, filename } = await buildHtml(prospect);

      const localPath = path.join(outDir, filename);
      fs.writeFileSync(localPath, html, 'utf8');
      process.stdout.write(`saved → ${filename}`);

      let url = null;
      if (deploy) {
        process.stdout.write(' | deploying…');
        url = await deployToGitHub(html, filename);
        process.stdout.write(` → ${url}`);
      }

      console.log('  ✓');
      results.push({ filename, url, ok: true });
    } catch (err) {
      console.log(`  ✗  ${err.message}`);
      results.push({ label, ok: false, error: err.message });
    }
  }

  console.log(`\nDone. ${results.filter(r => r.ok).length}/${prospects.length} succeeded.`);

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
