/**
 * Load the demo in a real browser and check that it works.
 *
 * Serves the project and opens the saved copy, so the check never depends on
 * the SEC API being reachable - and it could not be reached from a browser
 * anyway, because the SEC does not send the cross-origin header a `fetch`
 * needs. It does depend on jsDelivr, because that is where the page gets the
 * grid from: this edition has no local copy of the library at all, and a check
 * that loaded one would not be checking the page.
 *
 * Beyond "it drew something", it asserts the things this demo exists to show:
 *
 *   - the library arrived by classic script tag: there is no `type="module"`
 *     script on the page, every library tag points at the pinned release on
 *     the CDN, and each one left the global it documents;
 *   - the results grid holds rows, the four charts drew marks, and there is no
 *     watermark on localhost;
 *   - the headline stat tiles and the KPI figures agree with the saved data,
 *     recomputed here rather than read back off the page;
 *   - the derived grids hold the rows they should (annual revenue per company,
 *     revenue by year with the grid's own period-over-period shadow, a profile
 *     and a series summary);
 *   - narrowing the results table moves the tiles, the charts and the derived
 *     grids;
 *   - a revised reading lands on the row it belongs to and lights up the "vs
 *     first reading" shadow column.
 *
 * It then blocks the API in the browser and opens the live page, to prove a
 * visitor gets the saved copy, and is told so, when the SEC cannot be reached.
 *
 * `--all` also opens the live page without blocking, which records the SEC's
 * missing cross-origin header rather than asserting live data arrived.
 *
 * Exits non-zero when any of that fails, so it can gate a deployment.
 *
 * Usage: node tools/verify.mjs [--all] [--shots <dir>]
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const args = process.argv.slice(2);
const shotIndex = args.indexOf('--shots');
const shotDir = shotIndex >= 0 ? resolve(args[shotIndex + 1]) : null;
const all = args.includes('--all');

/** The release every library tag must name, and the globals each file leaves. */
const GRID_VERSION = '1.65.0';
const CDN_BASE = `https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@${GRID_VERSION}/`;
const LIBRARY_TAGS = [
  { file: 'lattice-grid.min.js', global: 'LatticeGrid', member: 'createGrid' },
  { file: 'modules/charts.min.js', global: 'LatticeGrid', member: 'createChart' },
  { file: 'modules/data-router.min.js', global: 'LatticeGridDataRouter', member: 'createDataRouter' },
  { file: 'modules/kpi.min.js', global: 'LatticeGridKPI', member: 'createKPI' },
  { file: 'modules/tabs.min.js', global: 'LatticeGridTabs', member: 'createTabs' },
];

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
].filter(Boolean);

/** The first browser on this machine that actually exists. */
async function findChrome() {
  for (const path of CHROME_CANDIDATES) {
    try {
      await access(path);
      return path;
    } catch {}
  }
  throw new Error(`No browser found. Tried:\n  ${CHROME_CANDIDATES.join('\n  ')}\nSet CHROME_PATH to point at one.`);
}

/** This check needs Node's built-in WebSocket, which arrived in Node 22. */
function requireModernNode() {
  if (typeof WebSocket === 'undefined') {
    throw new Error(
      `This check needs Node 22 or newer. You are running ${process.version}, which has no built in WebSocket.`,
    );
  }
}

/** A free TCP port, asked of the operating system. */
function freePort() {
  return new Promise((ok, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => ok(port));
    });
  });
}

const failures = [];
const notes = [];

/** Record a check and its outcome. */
function check(ok, description, detail) {
  if (ok) {
    notes.push(`  ok   ${description}${detail ? ` (${detail})` : ''}`);
  } else {
    failures.push(`${description}${detail ? ` (${detail})` : ''}`);
    notes.push(`  FAIL ${description}${detail ? ` (${detail})` : ''}`);
  }
}

let browser;
let browserPid = null;
let profile;
let server;

try {
  requireModernNode();
  const chromePath = await findChrome();
  const started = await startServer(0);
  server = started.server;
  const origin = `http://127.0.0.1:${started.port}`;
  console.log(`Browser: ${chromePath}`);
  console.log(`Serving: ${origin}`);

  profile = await mkdtemp(join(tmpdir(), 'sec-edgar-umd-demo-verify-'));
  const port = await freePort();
  browser = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--window-size=1440,900',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  browserPid = browser.pid;
  browser.stderr.on('data', () => {});

  let wsUrl;
  for (let i = 0; i < 150 && !wsUrl; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) wsUrl = (await response.json()).webSocketDebuggerUrl;
    } catch {}
    if (!wsUrl) await sleep(200);
  }
  if (!wsUrl) throw new Error('the browser never opened its debugging port');

  const socket = new WebSocket(wsUrl);
  await new Promise((done, fail) => {
    socket.onopen = done;
    socket.onerror = () => fail(new Error('could not attach to the browser'));
  });

  let nextId = 0;
  const pending = new Map();
  let consoleErrors = [];
  let pageErrors = [];

  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id != null && pending.has(message.id)) {
      const { resolve: ok, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else ok(message.result);
      return;
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      consoleErrors.push(message.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails;
      pageErrors.push(details.exception?.description || details.text);
    }
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      consoleErrors.push(message.params.entry.text);
    }
  };

  const send = (method, params = {}, sessionId) =>
    new Promise((ok, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve: ok, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const call = (method, params) => send(method, params, sessionId);

  await call('Page.enable');
  await call('Runtime.enable');
  await call('Log.enable');
  await call('Network.enable');
  await call('Network.setUserAgentOverride', {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
  });
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text + ' ' + (result.exceptionDetails.exception?.description || ''));
    }
    return result.result.value;
  };

  const waitFor = async (expression, timeout, what) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      let value;
      try {
        value = await evaluate(expression);
      } catch {}
      if (value) return value;
      await sleep(250);
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  /** Open a URL with a clean error log and wait for the dashboard to report in. */
  const open = async (url, label) => {
    consoleErrors = [];
    pageErrors = [];
    console.log(`\n--- ${label} ---\n${url}`);
    await call('Page.navigate', { url });
    await waitFor('!!(window.__edgarDemo)', 120000, `${label} to load`);
    const state = await evaluate('({ ready: window.__edgarDemo.ready, error: window.__edgarDemo.error || null })');
    if (!state.ready) throw new Error(`${label} reported a failure: ${state.error}`);
    await waitFor('window.__edgarDemo.resultsGrid && window.__edgarDemo.resultsGrid.rows.count() > 0', 60000, `${label} results rows`);
  };

  /** Save a screenshot, when a directory was asked for. */
  const shoot = async (name) => {
    if (!shotDir) return;
    await mkdir(shotDir, { recursive: true });
    const { data } = await call('Page.captureScreenshot', { format: 'png' });
    const file = join(shotDir, `${name}.png`);
    await writeFile(file, Buffer.from(data, 'base64'));
    console.log(`  shot ${file}`);
  };

  /** Complain about anything the page logged. */
  const noErrors = (label) => {
    check(consoleErrors.length === 0, `${label}: no console errors`, consoleErrors.slice(0, 3).join(' | '));
    check(pageErrors.length === 0, `${label}: no page errors`, pageErrors.slice(0, 3).join(' | '));
  };

  /* =================================================================== */
  /* 1. The saved copy: the deterministic run, where the figures are      */
  /*    cross-checked against the saved data.                             */
  /* =================================================================== */

  await open(`${origin}/index.html?source=snapshot`, 'saved copy');

  /* ---- how the library arrived ---- */

  const delivery = await evaluate(`(() => {
    const scripts = [...document.querySelectorAll('script')];
    const globals = {};
    for (const name of ['LatticeGrid', 'LatticeGridDataRouter', 'LatticeGridKPI', 'LatticeGridTabs']) {
      const value = window[name];
      globals[name] = value ? Object.keys(value).filter((k) => typeof value[k] === 'function').length : 0;
    }
    return {
      moduleScripts: scripts.filter((s) => s.type === 'module').length,
      importmaps: scripts.filter((s) => s.type === 'importmap').length,
      librarySrcs: scripts.map((s) => s.getAttribute('src') || '').filter((src) => /cdn\\.jsdelivr\\.net/.test(src)),
      withIntegrity: scripts.filter((s) => /cdn\\.jsdelivr\\.net/.test(s.src) && s.integrity).length,
      stylesheetSrc: (document.querySelector('link[rel=stylesheet][href*="cdn.jsdelivr.net"]') || {}).href || null,
      stylesheetIntegrity: (document.querySelector('link[rel=stylesheet][href*="cdn.jsdelivr.net"]') || {}).integrity || null,
      globals,
      members: {
        createGrid: typeof (window.LatticeGrid || {}).createGrid,
        setLicence: typeof (window.LatticeGrid || {}).setLicence,
        createChart: typeof (window.LatticeGrid || {}).createChart,
        createDataRouter: typeof (window.LatticeGridDataRouter || {}).createDataRouter,
        createKPI: typeof (window.LatticeGridKPI || {}).createKPI,
        createTabs: typeof (window.LatticeGridTabs || {}).createTabs,
      },
    };
  })()`);
  console.log(`  library tags: ${delivery.librarySrcs.length} from the CDN, ${delivery.withIntegrity} with an integrity hash; module scripts on the page: ${delivery.moduleScripts}`);
  check(delivery.moduleScripts === 0, 'delivery: no type="module" script on the page', `${delivery.moduleScripts}`);
  check(delivery.importmaps === 0, 'delivery: no import map on the page', `${delivery.importmaps}`);
  check(
    delivery.librarySrcs.length === LIBRARY_TAGS.length,
    `delivery: ${LIBRARY_TAGS.length} library script tags point at the CDN`,
    `${delivery.librarySrcs.length}`,
  );
  for (const tag of LIBRARY_TAGS) {
    const wanted = `${CDN_BASE}${tag.file}`;
    check(delivery.librarySrcs.includes(wanted), `delivery: ${tag.file} is loaded from the pinned ${GRID_VERSION} release`, wanted);
    check(delivery.members[tag.member] === 'function', `delivery: ${tag.file} left ${tag.global}.${tag.member} behind`, delivery.members[tag.member]);
  }
  check(delivery.withIntegrity === LIBRARY_TAGS.length, 'delivery: every library tag carries an integrity hash', `${delivery.withIntegrity} of ${LIBRARY_TAGS.length}`);
  check(
    delivery.stylesheetSrc === `${CDN_BASE}lattice-grid.min.css`,
    `delivery: the stylesheet is loaded from the pinned ${GRID_VERSION} release`,
    delivery.stylesheetSrc,
  );
  check(!!delivery.stylesheetIntegrity, 'delivery: the stylesheet carries an integrity hash');
  check(delivery.members.setLicence === 'function', 'delivery: setLicence is on the core global');

  const snap = await evaluate(`(() => {
    const d = window.__edgarDemo;
    return {
      rows: d.resultsGrid.rows.count(),
      columns: d.resultsGrid.columns.visible().length,
      painted: document.querySelectorAll('.lattice [role="row"]').length,
      charts: d.charts.length,
      stats: d.stats.length,
      watermark: d.resultsGrid.licence.watermark(),
      licenceState: d.resultsGrid.licence.state(),
      tiles: Object.fromEntries(d.kpi.tiles().map((t) => [t.id, t.value])),
      statValues: d.stats.map((s) => s.value()),
    };
  })()`);
  console.log(`  ${snap.rows} rows, ${snap.columns} columns, ${snap.painted} painted, ${snap.charts} charts, ${snap.stats} stat tiles`);
  console.log(`  tiles: ${JSON.stringify(snap.tiles)}`);

  check(snap.rows > 1000, 'saved copy: the results grid holds rows', `${snap.rows}`);
  check(snap.painted > 0, 'saved copy: the grid painted rows', `${snap.painted}`);
  check(snap.charts === 4, 'saved copy: all four charts were built', `${snap.charts}`);
  check(snap.stats === 3, 'saved copy: the three headline stat tiles were built', `${snap.stats}`);

  /* Each chart is asked what it actually plotted, so an empty pair of axes is
     not mistaken for a chart. */
  const drawn = await evaluate(`(() => window.__edgarDemo.charts.map((c, i) => {
    const data = c.data();
    const series = (data && data.series) || [];
    const points = series.reduce((n, s) => n + ((s.points || []).length), 0);
    const withValue = series.reduce((n, s) => n + (s.points || []).filter((p) => p.y != null && p.y !== 0).length, 0);
    const svg = c.element;
    const marks = svg ? svg.querySelectorAll('rect, circle, path').length : 0;
    return { i, points, withValue, marks };
  }))()`);
  for (const c of drawn) {
    console.log(`  chart ${c.i}: ${c.points} points, ${c.withValue} with a value, ${c.marks} marks`);
    check(c.withValue > 0, `saved copy: chart ${c.i} plotted values rather than empty axes`, `${c.withValue} of ${c.points} points carry a measure`);
    check(c.marks > 2, `saved copy: chart ${c.i} drew marks`, `${c.marks} marks`);
  }
  check(snap.watermark === false, 'saved copy: no watermark on localhost', `state ${snap.licenceState}`);
  /* ------------------------------------------------------------------ */
  /* The main grid, specifically.                                        */
  /* ------------------------------------------------------------------ */

  /*
   * `snap.painted` counts `[role="row"]` across every `.lattice` on the page,
   * so any one grid with rows satisfies it. That is a different question from
   * "did the grid this page is built around draw anything", which is the one
   * a reader actually cares about, and which the summary grids beside it can
   * answer for it. So this asks about that one grid, and counts only *data*
   * rows -- the sticky totals row and the header row are `.lat-row` too, and
   * carry no `data-index`.
   */
  const mainGrid = await evaluate(`(() => {
    const host = document.querySelector('.primary-host') || document.querySelector('.tabs-host');
    const root = host && host.querySelector('.lattice');
    const viewport = root && root.querySelector('.lat-body-viewport');
    if (!root) return { found: false };
    return {
      found: true,
      dataRows: viewport ? viewport.querySelectorAll('.lat-row[data-index]').length : 0,
      anyRows: viewport ? viewport.querySelectorAll('.lat-row').length : 0,
      bodyCells: viewport ? viewport.querySelectorAll('[role="gridcell"]').length : 0,
      columnHeaders: root.querySelectorAll('[role="columnheader"]').length,
      viewportHeight: viewport ? Math.round(viewport.getBoundingClientRect().height) : 0,
    };
  })()`);
  console.log(`  main grid: ${mainGrid.dataRows} data rows, ${mainGrid.bodyCells} body cells, `
    + `${mainGrid.columnHeaders} column headers, body ${mainGrid.viewportHeight}px tall`);

  check(mainGrid.found, 'saved copy: the main grid exists');
  check(mainGrid.dataRows > 0, 'saved copy: the main grid painted at least one data row',
    `${mainGrid.dataRows} data rows in a body ${mainGrid.viewportHeight}px tall`);
  check(mainGrid.bodyCells > 0, 'saved copy: the main grid painted cells', `${mainGrid.bodyCells}`);
  check(mainGrid.columnHeaders > 0, 'saved copy: the main grid drew a column header row',
    `${mainGrid.columnHeaders}`);

  noErrors('saved copy');
  await shoot('01-grid-saved');

  /* The independent recomputation: the saved rows, reduced here in Node. */
  const meta = JSON.parse(await readFile(join(root, 'data', 'snapshot', 'meta.json'), 'utf8'));
  const rowValues = JSON.parse(await readFile(join(root, 'data', 'snapshot', 'rows.json'), 'utf8'));
  const cols = meta.columns;
  const rows = rowValues.map((v) => Object.fromEntries(cols.map((c, i) => [c, v[i]])));

  const annualSeries = (list, concept) =>
    list.filter((r) => r.period === 'FY' && r.concept === concept).sort((a, b) => (a.fy > b.fy ? 1 : a.fy < b.fy ? -1 : 1));
  const latestPerCompany = (list, concept) => {
    const byCompany = new Map();
    for (const r of list) {
      if (r.period !== 'FY' || r.concept !== concept) continue;
      const current = byCompany.get(r.company);
      if (!current || r.fy > current.fy || (r.fy === current.fy && r.end > current.end)) byCompany.set(r.company, r);
    }
    return [...byCompany.values()];
  };
  const combinedLatest = (list, concept) => latestPerCompany(list, concept).reduce((s, r) => s + r.value, 0);
  const combinedPrior = (list, concept) => {
    let total = 0;
    const companies = new Set(list.filter((r) => r.period === 'FY' && r.concept === concept).map((r) => r.company));
    for (const company of companies) {
      const series = annualSeries(list.filter((r) => r.company === company && r.concept === concept), concept);
      if (series.length > 1) total += series[series.length - 2].value;
    }
    return total;
  };
  const meanAnnual = (list, concept) => {
    const series = annualSeries(list, concept);
    return series.length ? series.reduce((s, r) => s + r.value, 0) / series.length : null;
  };

  const expectedRevenue = combinedLatest(rows, 'Revenue');
  const expectedIncome = combinedLatest(rows, 'Net income');
  const expectedMean = meanAnnual(rows, 'Revenue');
  const expectedRevenueYoY = combinedLatest(rows, 'Revenue') - combinedPrior(rows, 'Revenue');

  const nearRel = (a, b, eps) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));

  console.log(`  expected: revenue ${expectedRevenue}, net income ${expectedIncome}, mean revenue ${expectedMean}`);
  check(nearRel(snap.statValues[0], expectedRevenue, 1e-12), 'saved copy: the combined-revenue tile matches the saved data', `tile ${snap.statValues[0]}, expected ${expectedRevenue}`);
  check(nearRel(snap.statValues[1], expectedIncome, 1e-12), 'saved copy: the combined-net-income tile matches the saved data', `tile ${snap.statValues[1]}, expected ${expectedIncome}`);
  check(nearRel(snap.statValues[2], expectedMean, 1e-12), 'saved copy: the mean-annual-revenue tile matches the saved data', `tile ${snap.statValues[2]}, expected ${expectedMean}`);
  check(nearRel(snap.tiles.revenue, expectedRevenue, 1e-12), 'saved copy: the KPI revenue tile matches the saved data', `${snap.tiles.revenue}`);
  check(nearRel(snap.tiles.income, expectedIncome, 1e-12), 'saved copy: the KPI income tile matches the saved data', `${snap.tiles.income}`);
  check(nearRel(snap.tiles.revenueYoY, expectedRevenueYoY, 1e-9), 'saved copy: the KPI year-on-year tile matches the saved data', `tile ${snap.tiles.revenueYoY}, expected ${expectedRevenueYoY}`);
  check(snap.tiles.companies === 6, 'saved copy: the KPI companies tile counts six companies', `${snap.tiles.companies}`);

  /* ---- the derived grids hold the rows they should ---- */

  const derived = await evaluate(`(() => {
    const d = window.__edgarDemo;
    const count = (g) => { let n = 0; g.rows.forEach((r) => { if (r && r.data) n += 1; }); return n; };
    const seriesMetrics = [];
    d.seriesGrid.rows.forEach((r) => { if (r && r.data) seriesMetrics.push(r.data.metric); });
    return {
      annual: count(d.annualRevenueGrid),
      byYear: count(d.byYearGrid),
      byCompany: count(d.byCompanyGrid),
      profile: count(d.profileGrid),
      series: count(d.seriesGrid),
      seriesMetrics,
    };
  })()`);
  console.log(`  derived: ${derived.annual} annual rows, ${derived.byYear} years, ${derived.byCompany} companies, ${derived.profile} profile rows, ${derived.series} series metrics`);
  check(derived.annual > 20, 'saved copy: the annual revenue grid holds rows', `${derived.annual}`);
  check(derived.byYear > 10, 'saved copy: the revenue-by-year grid buckets the annual revenue', `${derived.byYear} years`);
  check(derived.byCompany === 6, 'saved copy: the revenue-by-company grid has one row per company', `${derived.byCompany}`);
  check(derived.profile === 3, 'saved copy: the profile derived grid has one row per profiled column', `${derived.profile}`);
  check(derived.series >= 10 && derived.seriesMetrics.includes('growth') && derived.seriesMetrics.includes('volatility'), 'saved copy: the series derived grid reports growth and volatility', derived.seriesMetrics.join(', '));

  /* The grid's own period-over-period shadow on the revenue-by-year grid. */
  const byYearRow = await evaluate(`(() => {
    const d = window.__edgarDemo;
    let out = null;
    d.byYearGrid.rows.forEach((r) => { if (r && r.data && !out) out = r.data; });
    return out;
  })()`);
  check(!!byYearRow, 'saved copy: the revenue-by-year grid exposes a row', byYearRow && byYearRow.fy);
  check(
    byYearRow && typeof byYearRow.revenue === 'number',
    'saved copy: the revenue-by-year row carries a summed revenue',
    byYearRow && byYearRow.revenue,
  );

  /* ---- a revised reading lights up the "vs first reading" shadow ---- */

  const revision = await evaluate(`(async () => {
    const d = window.__edgarDemo;
    const data = d.resultsGrid.rows.data();
    let target = null;
    for (const row of data) { if (row.freq === 'annual' && row.concept === 'Revenue' && (!target || row.end > target.end)) target = row; }
    const before = { count: d.resultsGrid.rows.count(), id: target.id, value: target.value, delta: d.resultsGrid.rows.value(target.id, 'delta') };
    d.ingest([{ ...target, value: target.value + 1000000000 }]);
    await new Promise((r) => setTimeout(r, 400));
    return {
      before,
      after: {
        count: d.resultsGrid.rows.count(),
        value: d.resultsGrid.rows.value(target.id, 'value'),
        delta: d.resultsGrid.rows.value(target.id, 'delta'),
        deltaPct: d.resultsGrid.rows.value(target.id, 'deltaPct'),
      },
    };
  })()`);
  console.log(`  revision: ${revision.before.id} ${revision.before.value} -> ${revision.after.value}, rows ${revision.before.count} -> ${revision.after.count}, delta ${revision.before.delta} -> ${revision.after.delta}`);
  check(revision.after.count === revision.before.count, 'a revised reading updates the row rather than adding one', `${revision.before.count} -> ${revision.after.count}`);
  check(nearRel(revision.after.delta, 1e9, 1e-6), 'the revision lights up the "vs first reading" shadow', `delta ${revision.after.delta}`);
  check(revision.after.deltaPct !== 0 && revision.after.deltaPct != null, 'the revision lights up the percentage shadow', `deltaPct ${revision.after.deltaPct}`);

  /* ---- narrowing the table moves the tiles, the charts and the derived ---- */

  const beforeNarrow = await evaluate(`(() => {
    const d = window.__edgarDemo;
    const count = (g) => { let n = 0; g.rows.forEach((r) => { if (r && r.data) n += 1; }); return n; };
    return {
      rows: d.resultsGrid.rows.count(),
      revenue: d.stats[0].value(),
      byYear: count(d.byYearGrid),
      chartSizes: d.charts.map((c) => { const data = c.data(); return data ? JSON.stringify(data).length : 0; }),
    };
  })()`);

  await evaluate("window.__edgarDemo.resultsGrid.filters.where('verify', (row) => row.ticker === 'AAPL')");
  await sleep(900);

  const afterNarrow = await evaluate(`(() => {
    const d = window.__edgarDemo;
    const count = (g) => { let n = 0; g.rows.forEach((r) => { if (r && r.data) n += 1; }); return n; };
    return {
      rows: d.resultsGrid.rows.count(),
      revenue: d.stats[0].value(),
      byYear: count(d.byYearGrid),
      chartSizes: d.charts.map((c) => { const data = c.data(); return data ? JSON.stringify(data).length : 0; }),
    };
  })()`);

  const appleRows = rows.filter((r) => r.ticker === 'AAPL');
  const appleRevenue = combinedLatest(appleRows, 'Revenue');

  console.log(`  narrowed: ${beforeNarrow.rows} rows -> ${afterNarrow.rows} rows, revenue tile ${beforeNarrow.revenue} -> ${afterNarrow.revenue}, byYear ${beforeNarrow.byYear} -> ${afterNarrow.byYear}`);
  check(afterNarrow.rows < beforeNarrow.rows, 'the filter narrows the results table', `${beforeNarrow.rows} -> ${afterNarrow.rows}`);
  check(afterNarrow.byYear < beforeNarrow.byYear, 'the revenue-by-year derived grid follows the filter', `${beforeNarrow.byYear} -> ${afterNarrow.byYear}`);
  check(nearRel(afterNarrow.revenue, appleRevenue, 1e-12), 'the headline tile moved to the filtered company', `tile ${afterNarrow.revenue}, expected ${appleRevenue}`);
  const chartsMoved = afterNarrow.chartSizes.filter((size, i) => size !== beforeNarrow.chartSizes[i]).length;
  check(chartsMoved > 0, 'the charts rebound to the narrowed data', `${chartsMoved} of ${afterNarrow.chartSizes.length} changed`);
  await shoot('02-charts-filtered');

  await evaluate("window.__edgarDemo.resultsGrid.filters.where('verify', null)");
  await sleep(600);
  const restored = await evaluate('window.__edgarDemo.resultsGrid.rows.count()');
  check(restored === beforeNarrow.rows, 'removing the filter restores the table', `${restored} of ${beforeNarrow.rows}`);

  /* The demo's own control also narrows the table. */
  await evaluate('window.__edgarDemo.recentButton.click()');
  await sleep(700);
  const recent = await evaluate(`(() => {
    const d = window.__edgarDemo;
    return { rows: d.resultsGrid.rows.count(), pressed: d.recentButton.getAttribute('aria-pressed') };
  })()`);
  check(recent.pressed === 'true', 'the recent control reports itself pressed');
  check(recent.rows < beforeNarrow.rows, 'the recent control narrows the table', `${beforeNarrow.rows} -> ${recent.rows}`);
  await evaluate('window.__edgarDemo.recentButton.click()');
  await sleep(600);

  /* ------------------------------------------------------------------ */
  /* On a phone.                                                         */
  /* ------------------------------------------------------------------ */

  /*
   * A dashboard laid out across can leave one element wider than the screen,
   * and the whole page then scrolls sideways -- which on a phone is the first
   * thing a reader meets. Loaded narrow, nothing may stick out, and the grid
   * this page is built around must still draw rows.
   */
  await call('Emulation.setDeviceMetricsOverride', { width: 400, height: 900, deviceScaleFactor: 1, mobile: true });
  await open(`${origin}/index.html?source=snapshot`, 'saved copy, 400px wide');

  const narrow = await evaluate(`(() => {
    const de = document.documentElement;
    const host = document.querySelector('.primary-host') || document.querySelector('.tabs-host');
    const root = host && host.querySelector('.lattice');
    const viewport = root && root.querySelector('.lat-body-viewport');
    const widest = [];
    const clipped = (e) => getComputedStyle(e).overflowX !== 'visible';
    const walk = (e) => {
      for (const child of e.children) {
        const box = child.getBoundingClientRect();
        if (box.width === 0 && box.height === 0) continue;
        if (box.right > de.clientWidth + 1) {
          widest.push(String(child.className || child.tagName).slice(0, 40) + ' @' + Math.round(box.right));
        }
        if (!clipped(child)) walk(child);
      }
    };
    walk(document.body);
    return {
      clientWidth: de.clientWidth,
      scrollWidth: de.scrollWidth,
      dataRows: viewport ? viewport.querySelectorAll('.lat-row[data-index]').length : 0,
      sticking: widest.slice(0, 5),
    };
  })()`);
  console.log(`  at 400px: scrollWidth ${narrow.scrollWidth} vs clientWidth ${narrow.clientWidth}, `
    + `${narrow.dataRows} data rows in the main grid`);
  if (narrow.sticking.length) console.log(`  sticking out: ${narrow.sticking.join(', ')}`);

  check(narrow.scrollWidth <= narrow.clientWidth, 'at 400px: the page does not scroll sideways',
    `scrollWidth ${narrow.scrollWidth} > clientWidth ${narrow.clientWidth}; ${narrow.sticking.join(', ')}`);
  check(narrow.dataRows > 0, 'at 400px: the main grid still paints data rows', `${narrow.dataRows}`);

  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  noErrors('saved copy, after the checks');

  /* =================================================================== */
  /* 2. What a visitor gets when the SEC API cannot be reached.          */
  /* =================================================================== */

  await call('Network.setBlockedURLs', { urls: ['*data.sec.gov*'] });
  await open(`${origin}/index.html`, 'live page, with the API unreachable');
  const fallback = await evaluate(`(() => {
    const d = window.__edgarDemo;
    const notice = document.querySelector('.notice');
    const pill = document.querySelector('.head-note .pill');
    const freshness = document.querySelector('.freshness');
    return {
      rows: d.resultsGrid.rows.count(),
      painted: document.querySelectorAll('.lattice [role="row"]').length,
      fellBack: !!(d.timings && d.timings.fellBack),
      mode: d.timings && d.timings.mode,
      badge: pill ? pill.textContent.trim() : null,
      notice: notice ? notice.textContent.trim() : null,
      savedOnShown: freshness ? /saved copy/i.test(freshness.textContent) : false,
      polling: !!d.poller,
    };
  })()`);
  console.log(`  rows ${fallback.rows}, badge "${fallback.badge}", fell back: ${fallback.fellBack}`);
  console.log(`  notice: ${fallback.notice}`);
  check(fallback.rows > 0, 'fallback: the saved copy is on screen', `${fallback.rows} rows`);
  check(fallback.painted > 0, 'fallback: the grid painted rows', `${fallback.painted}`);
  check(fallback.fellBack, 'fallback: the page recorded that it fell back to the saved copy');
  check(fallback.mode === 'live', 'fallback: the page ran in the live default, not snapshot mode', `mode ${fallback.mode}`);
  check(fallback.badge === 'Saved copy', 'fallback: the badge reads "Saved copy"', `"${fallback.badge}"`);
  check(!!fallback.notice && /does not allow browser requests/i.test(fallback.notice),
    'fallback: the page says the API cannot be read by a browser', fallback.notice);
  check(!!fallback.notice && /saved copy/i.test(fallback.notice),
    'fallback: the page says what is on screen instead', fallback.notice);
  check(!!fallback.notice && !/will try again/i.test(fallback.notice),
    'fallback: the page does not invite a reload that cannot succeed', fallback.notice);
  check(fallback.savedOnShown, "fallback: the saved copy's provenance is shown");
  check(!fallback.polling, 'fallback: no poll is started against an API that could not be reached');
  check(pageErrors.length === 0, 'fallback: no page errors', pageErrors.slice(0, 3).join(' | '));
  await shoot('05-fallback');
  await call('Network.setBlockedURLs', { urls: [] });

  if (all) {
    /* ================================================================= */
    /* 3. Live, unblocked: recorded, not asserted, because the SEC does  */
    /*    not send the cross-origin header a browser needs.              */
    /* ================================================================= */

    await open(`${origin}/index.html`, 'live, unblocked');
    const live = await evaluate(`(() => {
      const d = window.__edgarDemo;
      return {
        rows: d.resultsGrid.rows.count(),
        fellBack: !!(d.timings && d.timings.fellBack),
        notice: (document.querySelector('.notice') || {}).textContent || null,
        freshness: document.querySelector('.freshness').textContent,
      };
    })()`);
    console.log(`  ${live.rows} rows; fell back: ${live.fellBack}; ${live.freshness}`);
    console.log(`  This is expected when the SEC is read from a browser: it does not send Access-Control-Allow-Origin.${live.notice ? ' ' + live.notice : ''}`);
    check(live.rows > 0, 'live: the dashboard is on screen either way', `${live.rows} rows`);
    check(live.fellBack, 'live: the page fell back to the saved copy when the SEC was unreachable from the browser');
    const corsBlocked = consoleErrors.some((e) => /CORS policy|Access-Control-Allow-Origin/i.test(e));
    check(corsBlocked, 'live: the failure is the SEC\u2019s missing cross-origin header, not a broken page', consoleErrors.slice(0, 2).join(' | '));
    check(pageErrors.length === 0, 'live: no page errors', pageErrors.slice(0, 3).join(' | '));
    await shoot('06-live');
  }

  socket.close();
} catch (error) {
  failures.push(String((error && error.stack) || error));
} finally {
  if (browserPid) {
    try { process.kill(-browserPid, 'SIGKILL'); } catch {}
    try { process.kill(browserPid, 'SIGKILL'); } catch {}
  }
  if (server) server.close();
  await sleep(400);
  if (profile) await rm(profile, { recursive: true, force: true });
}

console.log('\nChecks:');
for (const note of notes) console.log(note);

if (failures.length) {
  console.error(`\nFAILED (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`\nAll ${notes.length} checks passed.`);
process.exit(0);
