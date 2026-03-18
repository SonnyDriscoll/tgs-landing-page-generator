#!/usr/bin/env node
/**
 * Appends landing_page_url to coo-v2-prospects.csv by matching
 * first_name + last_name + company_table_data to generated filenames.
 *
 * Usage:
 *   node append-urls.js \
 *     --csv ../../../clients/global-series/imports/coo-v2-prospects.csv \
 *     --pages ../tgs-landing-pages/coo-v2 \
 *     --out ../../../clients/global-series/imports/coo-v2-prospects-with-urls.csv
 */

const fs = require('fs');
const path = require('path');

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

// Full CSV parser that handles quoted multi-line fields
function parseCsvFull(raw) {
  const rows = [];
  let i = 0;
  const len = raw.length;

  while (i < len) {
    const row = [];
    // Parse one row
    while (i < len) {
      let field = '';
      if (raw[i] === '"') {
        // Quoted field
        i++; // skip opening quote
        while (i < len) {
          if (raw[i] === '"') {
            if (raw[i + 1] === '"') {
              field += '"';
              i += 2;
            } else {
              i++; // skip closing quote
              break;
            }
          } else {
            field += raw[i++];
          }
        }
      } else {
        // Unquoted field — read until comma or newline
        while (i < len && raw[i] !== ',' && raw[i] !== '\n' && raw[i] !== '\r') {
          field += raw[i++];
        }
      }
      row.push(field.trim());
      if (i < len && raw[i] === ',') {
        i++; // skip comma, continue to next field
      } else {
        // End of row — skip newline chars
        while (i < len && (raw[i] === '\r' || raw[i] === '\n')) i++;
        break;
      }
    }
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  return rows;
}

// Match generate.js filename construction exactly:
// first_name: toLowerCase only
// last_name:  toLowerCase + spaces→hyphens
// company:    toLowerCase + non-alphanumeric→hyphens (no trailing strip)
function slugFirst(str) {
  return (str || '').toLowerCase();
}
function slugLast(str) {
  return (str || '').toLowerCase().replace(/\s+/g, '-');
}
function slugCompany(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function normalizeKey(h) {
  return h.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const csvPath = path.resolve(args.csv || '../../../clients/global-series/imports/coo-v2-prospects.csv');
  const pagesDir = path.resolve(args.pages || '../tgs-landing-pages/coo-v2');
  const outPath = path.resolve(args.out || '../../../clients/global-series/imports/coo-v2-prospects-with-urls.csv');
  const baseUrl = (args.base || 'https://www.theglobalseriespage.com').replace(/\/$/, '');

  // Build a set of existing filenames (without .html)
  const existingFiles = new Set(
    fs.readdirSync(pagesDir)
      .filter(f => f.endsWith('.html'))
      .map(f => f.replace(/\.html$/, ''))
  );

  console.log(`Pages directory: ${pagesDir} (${existingFiles.size} files)`);
  console.log(`CSV: ${csvPath}`);

  const raw = fs.readFileSync(csvPath, 'utf8');
  const allRows = parseCsvFull(raw);
  const headers = allRows[0];
  const normHeaders = headers.map(normalizeKey);

  let matched = 0;
  let unmatched = 0;
  const unmatchedNames = [];

  const outputLines = [headers.join(',') + ',landing_page_url'];

  for (const values of allRows.slice(1)) {
    const row = {};
    headers.forEach((h, i) => {
      row[h] = values[i] ?? '';
      row[normalizeKey(h)] = values[i] ?? '';
    });

    const firstName = row['first_name'] || '';
    const lastName = row['last_name'] || '';
    const company = row['company_table_data'] || row['company'] || '';

    const expectedSlug = `${slugFirst(firstName)}-${slugLast(lastName)}-${slugCompany(company)}`;

    // Fuzzy fallbacks: normalize spaces in first name, strip trailing hyphens, strip periods
    const fallbacks = [
      `${slugFirst(firstName).replace(/\s+/g, '-')}-${slugLast(lastName)}-${slugCompany(company)}`,
      `${slugFirst(firstName)}-${slugLast(lastName).replace(/\./g, '')}-${slugCompany(company)}`,
      `${slugFirst(firstName).replace(/\s+/g, '-')}-${slugLast(lastName).replace(/\./g, '')}-${slugCompany(company)}`,
    ];

    let url = '';
    const matchedSlug = [expectedSlug, ...fallbacks].find(s => existingFiles.has(s));

    if (matchedSlug) {
      url = `${baseUrl}/${matchedSlug}`;
      matched++;
    } else {
      unmatched++;
      unmatchedNames.push(`${firstName} ${lastName} (${company}) → tried: ${expectedSlug}`);
    }

    // Rebuild CSV row with url appended
    const rowValues = headers.map(h => {
      const v = row[h] || '';
      return v.includes(',') || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v;
    });
    outputLines.push(rowValues.join(',') + ',' + url);
  }

  fs.writeFileSync(outPath, outputLines.join('\n'), 'utf8');

  console.log(`\nDone.`);
  console.log(`Matched:   ${matched}`);
  console.log(`Unmatched: ${unmatched}`);
  console.log(`Output:    ${outPath}`);

  if (unmatchedNames.length) {
    console.log(`\nUnmatched rows:`);
    unmatchedNames.forEach(n => console.log(`  - ${n}`));
  }
}

main();
