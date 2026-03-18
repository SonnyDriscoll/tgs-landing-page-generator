/**
 * enrich-ppe-leads.js
 *
 * Reads the raw PPE vendor CSV from Clay, batch-enriches company-level fields
 * (solution_focus, solution_focus_reworded, event_theme, competitor, tier)
 * via Claude, then outputs a full CSV ready for generate-hse.js.
 *
 * Usage:
 *   node enrich-ppe-leads.js --input <path-to-raw-csv> --output <path-to-enriched-csv>
 *
 * Output CSV format matches generate-hse.js expectations:
 *   first_name, last_name, title, company, company_domain, linkedin_url,
 *   work_email, solution_focus, solution_focus_reworded, event_theme,
 *   competitor, tier
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const args = process.argv.slice(2);
const inputFlag  = args.indexOf('--input');
const outputFlag = args.indexOf('--output');
const inputPath  = inputFlag  !== -1 ? args[inputFlag  + 1] : null;
const outputPath = outputFlag !== -1 ? args[outputFlag + 1] : null;

if (!inputPath || !outputPath) {
  console.error('Usage: node enrich-ppe-leads.js --input <raw.csv> --output <enriched.csv>');
  process.exit(1);
}

// ── CSV parser ──────────────────────────────────────────────────────────────
function parseRow(line) {
  const result = []; let inQuote = false, current = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && !inQuote) { inQuote = true; }
    else if (c === '"' && inQuote) { inQuote = false; }
    else if (c === ',' && !inQuote) { result.push(current.trim()); current = ''; }
    else { current += c; }
  }
  result.push(current.trim()); return result;
}

function csvEscape(v) {
  if (!v) return '';
  if (v.includes(',') || v.includes('"') || v.includes('\n')) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

// ── Load raw CSV ─────────────────────────────────────────────────────────────
const raw = fs.readFileSync(inputPath, 'utf8').trim().split('\n');
// Header: Find people(0), Company(1), First(2), Last(3), Full(4), Title(5), Location(6), Domain(7), LinkedIn(8), Offers PPE(9)
const rows = raw.slice(1).map(parseRow).filter(r => r[7] && r[7].trim()); // only rows with domain

// ── Extract unique companies ──────────────────────────────────────────────────
const companyMap = new Map(); // domain -> { company, domain }
rows.forEach(r => {
  const domain = r[7].trim();
  if (!companyMap.has(domain)) companyMap.set(domain, { company: r[1].trim(), domain });
});
const companies = [...companyMap.values()];
console.log(`Unique companies to enrich: ${companies.length}`);

// ── Batch enrich via Claude ───────────────────────────────────────────────────
const BATCH_SIZE = 15;
const enriched = new Map(); // domain -> { solution_focus, solution_focus_reworded, event_theme, competitor, tier }

const CONFIRMED_SPONSORS = 'Intenseye, ecoPortal, BIS Safety, Ideagen, Solera, ISN, Astutis, Hunter, PEAK4, Strika';
const EVENT_THEMES = [
  'data-driven zero harm',
  'human factors and system design',
  'storytelling for board influence',
  'ESG-HSE alignment',
  'AI and automation in safety operations',
  'safety culture as business differentiator',
  'digital transformation of safety mindset',
];

async function enrichBatch(batch) {
  const companyList = batch.map((c, i) => `${i + 1}. Company: "${c.company}" | Domain: ${c.domain}`).join('\n');

  const prompt = `You are enriching a list of PPE and workplace safety companies for an event sponsorship outreach campaign.

The event is the HSE Learning Summit UK (Birmingham, 7-8 July 2026) — a closed-door gathering of 50+ senior HSE leaders from companies like BBC, Netflix, BP, Sainsbury's, Arup, Mercedes-AMG F1, and Hitachi Rail.

Confirmed sponsors already attending: ${CONFIRMED_SPONSORS}

Event agenda themes:
${EVENT_THEMES.map(t => `- ${t}`).join('\n')}

For each company below, return a JSON array. Each object must have these exact fields:
- "domain": the company domain (exact as given)
- "solution_focus": 1 sentence, what the company sells/does (lowercase, specific — e.g. "cut-resistant gloves and hand protection for industrial workers", "head protection and face shields for construction and manufacturing")
- "solution_reworded": 1 sentence, same thing phrased as a buyer benefit (e.g. "reducing hand injuries in high-risk industrial environments through premium cut-resistant protection")
- "event_theme": the single most relevant agenda theme from the list above (exact string match)
- "competitor": the single most relevant confirmed sponsor that sells in the same space (from: ${CONFIRMED_SPONSORS}) — or "Strika" if none are closely related
- "tier": 1 if well-known named PPE brand with UK GTM presence, 2 if distributor or reseller with enterprise reach, 3 if smaller niche or regional vendor

Companies:
${companyList}

Return ONLY a valid JSON array, no markdown, no explanation.`;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  });

  let text = message.content[0].text.trim();
  // Strip markdown fences if present
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  const parsed = JSON.parse(text);
  parsed.forEach(item => {
    enriched.set(item.domain, {
      solution_focus: item.solution_focus || '',
      solution_focus_reworded: item.solution_reworded || '',
      event_theme: item.event_theme || 'data-driven zero harm',
      competitor: item.competitor || 'Strika',
      tier: String(item.tier || '3'),
    });
  });
}

async function runEnrichment() {
  for (let i = 0; i < companies.length; i += BATCH_SIZE) {
    const batch = companies.slice(i, i + BATCH_SIZE);
    const end = Math.min(i + BATCH_SIZE, companies.length);
    process.stdout.write(`  Enriching companies ${i + 1}–${end} of ${companies.length}… `);
    try {
      await enrichBatch(batch);
      console.log('✓');
    } catch (err) {
      console.error(`FAILED: ${err.message}`);
      // Fill with defaults so we don't lose rows
      batch.forEach(c => {
        if (!enriched.has(c.domain)) {
          enriched.set(c.domain, {
            solution_focus: 'PPE and workplace safety products',
            solution_focus_reworded: 'keeping workers safe with high-quality protective equipment',
            event_theme: 'data-driven zero harm',
            competitor: 'Strika',
            tier: '3',
          });
        }
      });
    }
    // Small pause between batches
    if (i + BATCH_SIZE < companies.length) await new Promise(r => setTimeout(r, 500));
  }
}

// ── Build enriched CSV ────────────────────────────────────────────────────────
function buildOutput() {
  const outHeader = 'first_name,last_name,title,company,company_domain,linkedin_url,work_email,solution_focus,solution_focus_reworded,event_theme,competitor,tier';
  const outRows = rows.map(r => {
    const domain = r[7].trim();
    const e = enriched.get(domain) || {
      solution_focus: 'PPE and workplace safety products',
      solution_focus_reworded: 'keeping workers safe with high-quality protective equipment',
      event_theme: 'data-driven zero harm',
      competitor: 'Strika',
      tier: '3',
    };
    return [
      csvEscape(r[2]),   // first_name
      csvEscape(r[3]),   // last_name
      csvEscape(r[5]),   // title
      csvEscape(r[1]),   // company
      csvEscape(domain), // company_domain
      csvEscape(r[8]),   // linkedin_url
      '',                // work_email (not in source)
      csvEscape(e.solution_focus),
      csvEscape(e.solution_focus_reworded),
      csvEscape(e.event_theme),
      csvEscape(e.competitor),
      csvEscape(e.tier),
    ].join(',');
  });

  fs.writeFileSync(outputPath, [outHeader, ...outRows].join('\n'));
  console.log(`\nWrote ${outRows.length} enriched contacts to: ${outputPath}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\nEnriching ${rows.length} contacts across ${companies.length} companies…\n`);
  await runEnrichment();
  buildOutput();
})();
