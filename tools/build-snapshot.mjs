/**
 * Save a real run of the SEC EDGAR company-facts API to `data/snapshot/`, so
 * the dashboard can also be opened with no network at all - which is how a
 * browser must open it, because the SEC does not send the cross-origin header
 * a `fetch` needs.
 *
 * Run it with `node tools/build-snapshot.mjs`. It is a development tool:
 * nothing the page loads imports it.
 *
 * The feed code the page uses is a classic script, not a module, so it cannot
 * be imported. It is run here instead, in this process, exactly as the browser
 * runs it: the file leaves its functions on `globalThis.EdgarDemo` and they are
 * read from there. One copy of the feed code, used by both. Running under Node
 * is what lets the feed set the descriptive User-Agent the SEC requires.
 */

import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { readFile } from 'node:fs/promises';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'data', 'snapshot');

const feedFile = join(here, '..', 'src', 'edgar-feed.js');
runInThisContext(await readFile(feedFile, 'utf8'), { filename: feedFile });
const { fetchInitial, encodeRow, COLUMNS, COMPANIES, CONCEPTS } = globalThis.EdgarDemo;

const started = Date.now();
console.log('Reading the SEC EDGAR company-facts API...');
const rows = await fetchInitial();
console.log(`  ${rows.length} rows across ${COMPANIES.length} companies and ${CONCEPTS.length} concepts.`);

/* Stored in the feed's stable order, so the files are diffable between runs. */
const rowValues = rows.map(encodeRow);

const seconds = Number(((Date.now() - started) / 1000).toFixed(1));

const byCompany = {};
for (const row of rows) byCompany[row.ticker] = (byCompany[row.ticker] || 0) + 1;

const meta = {
  fetchedAt: new Date().toISOString(),
  fetchedAtMs: Date.now(),
  seconds,
  rows: rows.length,
  source: 'SEC EDGAR',
  sourceUrl: 'https://www.sec.gov/edgar/sec-api-documentation',
  apiUrl: 'https://data.sec.gov/api/xbrl',
  licence: 'SEC EDGAR data is in the public domain',
  columns: COLUMNS,
  companies: COMPANIES.map((c) => ({ ...c, rows: byCompany[c.ticker] || 0 })),
  concepts: CONCEPTS.map((c) => c.key),
  annual: rows.filter((r) => r.freq === 'annual').length,
  quarter: rows.filter((r) => r.freq === 'quarter').length,
};

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'rows.json'), JSON.stringify(rowValues));
await writeFile(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));

const rowsBytes = (await stat(join(outDir, 'rows.json'))).size;
console.log(`\nSaved ${rows.length} rows in ${seconds}s.`);
console.log(`rows.json is ${(rowsBytes / 1024).toFixed(1)} KB.`);
