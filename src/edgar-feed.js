/**
 * The SEC EDGAR company-facts feed: the XBRL "company facts" endpoint, read for
 * a small, curated set of companies and concepts and turned into flat rows.
 *
 * Nothing here knows about the grid. It produces plain objects and hands them
 * to whoever asked, so the same code feeds the live page and the saved copy.
 *
 * The SEC publishes every registrant's facts as XBRL under
 *
 *   /api/xbrl/companyfacts/CIK##########.json   (CIK zero-padded to 10 digits)
 *
 * one JSON document per company, holding every us-gaap concept with its annual
 * and quarterly time series. The service is public and needs no key, but it
 * requires a descriptive `User-Agent` header identifying the caller. A browser
 * cannot set one - it always sends its own - and the SEC also answers a plain
 * browser request without the cross-origin header a `fetch` would need to read
 * the response, so the live path cannot work from a web page. The snapshot
 * tool runs this same file under Node, where it sets the User-Agent the SEC
 * asks for.
 *
 * Companies and their tags are curated by hand. Revenue is the classic XBRL
 * gotcha: five of the six companies restated it onto the ASC 606 tag
 * `RevenueFromContractWithCustomerExcludingAssessedTax`, while Netflix kept the
 * older `Revenues` name; Amazon never reported a single "total liabilities"
 * figure under that name, so those rows are simply absent for Amazon. The
 * mapping below records each choice rather than burying it in the parsing.
 *
 * This is a classic script, not a module: there is no `import` or `export`
 * anywhere on this page. What this file offers is put on `EdgarDemo`, a plain
 * object on the global, and the next script reads it from there. The snapshot
 * tool runs this same file under Node, which is why it looks for `globalThis`
 * rather than `window`.
 */
(function (root) {
  'use strict';

  const BASE = 'https://data.sec.gov/api/xbrl';

  /** The companies the demo reads, with their zero-padded CIKs. */
  const COMPANIES = [
    { cik: '0000320193', company: 'Apple', ticker: 'AAPL' },
    { cik: '0000789019', company: 'Microsoft', ticker: 'MSFT' },
    { cik: '0001652044', company: 'Alphabet', ticker: 'GOOGL' },
    { cik: '0001018724', company: 'Amazon', ticker: 'AMZN' },
    { cik: '0001326801', company: 'Meta', ticker: 'META' },
    { cik: '0001065280', company: 'Netflix', ticker: 'NFLX' },
  ];

  /**
   * The concepts the demo extracts, each with the us-gaap tag that holds it.
   * A `tags` map overrides the default `tag` for a ticker; the entries are
   * the ones actually used on that company's filings.
   */
  const CONCEPTS = [
    {
      key: 'Revenue',
      tag: 'RevenueFromContractWithCustomerExcludingAssessedTax',
      tags: { GOOGL: 'Revenues', NFLX: 'Revenues' },
    },
    { key: 'Net income', tag: 'NetIncomeLoss' },
    { key: 'Total assets', tag: 'Assets' },
    { key: 'Total liabilities', tag: 'Liabilities' },
    { key: 'Total equity', tag: 'StockholdersEquity' },
  ];

  /** The User-Agent the SEC requires. Only the Node snapshot tool can send it. */
  const USER_AGENT = 'TOCLOCO lattice-grid demo contact@latticegrid.dev';

  /** How often the live page would ask the SEC for new filings. The data only
      moves when a company files, so this is deliberately slow. */
  const POLL_MS = 30 * 60 * 1000;

  /** The order the snapshot stores a row's fields in, so a compact array can be
      decoded back into a row. Shared by the browser and the snapshot tool. */
  const COLUMNS = [
    'id',
    'company',
    'ticker',
    'concept',
    'tag',
    'freq',
    'period',
    'fy',
    'end',
    'value',
    'sign',
    'change',
    'changePct',
    'direction',
  ];

  const isNode = typeof process !== 'undefined' && process.versions && process.versions.node;

  /**
   * Fetch JSON from the SEC, retrying a moment later when it asks us to slow
   * down. The SEC rate-limits (ten requests a second), so a quick pause and
   * retry is enough rather than giving up.
   *
   * @param {string} url the endpoint
   * @param {string} describe what is being read, for the error message
   * @param {{signal?: AbortSignal}} [opts]
   * @returns {Promise<object>} the parsed body
   */
  async function requestJson(url, describe, opts = {}) {
    const headers = { Accept: 'application/json' };
    /* A browser cannot set User-Agent and must not try; Node must, or the SEC
       answers 403. */
    if (isNode) headers['User-Agent'] = USER_AGENT;
    const maxAttempts = 4;
    for (let attempt = 1; ; attempt += 1) {
      const response = await fetch(url, { headers, signal: opts.signal, cache: 'no-store' });
      if (response.ok) return response.json();
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
        continue;
      }
      throw new Error(`The SEC answered ${response.status} for ${describe}.`);
    }
  }

  /** A value from the SEC to a finite number, or null when there is none. */
  function toNumber(value) {
    if (value == null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  /** The number of days a period spans, or null when it has no usable span. */
  function durationDays(start, end) {
    const a = Date.parse(start);
    const b = Date.parse(end);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return (b - a) / 86400000;
  }

  /**
   * Classify one XBRL fact as an annual or quarterly reading, or null when it
   * is neither. Income-statement concepts are *duration* facts (a start and an
   * end); a year-long span is annual, a single quarter is quarterly, and the
   * six- and nine-month cumulative spans the filings also repeat are dropped.
   * A year-long span only counts as annual when the filing says `FY`: some
   * companies also report trailing-twelve-month figures that span a year but
   * carry a quarter `fp`, and those are dropped too. Balance-sheet concepts
   * are *instant* facts (no start); there the filing's `fp` - `FY` versus
   * `Q1`..`Q4` - says annual versus quarterly.
   *
   * @param {object} entry one fact from a `units.USD` array
   * @returns {'annual'|'quarter'|null}
   */
  function classifyFreq(entry) {
    const hasStart = entry.start != null && entry.start !== entry.end;
    if (hasStart) {
      const dur = durationDays(entry.start, entry.end);
      if (dur == null) return null;
      if (dur >= 300) return entry.fp === 'FY' ? 'annual' : null;
      if (dur >= 60 && dur < 160) return 'quarter';
      return null;
    }
    if (entry.fp === 'FY') return 'annual';
    if (/^Q[1-4]$/.test(String(entry.fp))) return 'quarter';
    return null;
  }

  /** The concept's tag on one company, honouring the per-ticker override. */
  function tagFor(concept, ticker) {
    return (concept.tags && concept.tags[ticker]) || concept.tag;
  }

  /**
   * Turn one company's facts document into raw rows - one per (concept, period,
   * end date, value) - without the period-on-period change fields, which need
   * the whole series assembled first.
   *
   * @param {{ticker: string, company: string}} company
   * @param {object} facts the parsed companyfacts JSON
   * @returns {object[]} rows, unshaped beyond the values themselves
   */
  function extractRows(company, facts) {
    const rows = [];
    const usgaap = (facts && facts.facts && facts.facts['us-gaap']) || {};
    for (const concept of CONCEPTS) {
      const tag = tagFor(concept, company.ticker);
      const node = usgaap[tag];
      if (!node || !node.units || !node.units.USD) continue;
      /* Keep the latest-filed value for each period: amendments restate the
         same quarter or year, and the newest filing is the one to keep. */
      const byKey = new Map();
      for (const entry of node.units.USD) {
        const freq = classifyFreq(entry);
        if (!freq) continue;
        const key = `${freq}|${entry.end}`;
        const existing = byKey.get(key);
        if (!existing || String(entry.filed || '') > String(existing.filed || '')) {
          byKey.set(key, entry);
        }
      }
      for (const [key, entry] of byKey) {
        const value = toNumber(entry.val);
        if (value == null) continue;
        const freq = key.split('|')[0];
        const period = freq === 'annual' ? 'FY' : 'Q';
        const fy = entry.end ? toNumber(String(entry.end).slice(0, 4)) : null;
        rows.push({
          id: `${company.ticker}|${concept.key}|${freq}|${period}|${entry.end}`,
          company: company.company,
          ticker: company.ticker,
          concept: concept.key,
          tag,
          freq,
          period,
          fy,
          end: entry.end,
          value,
          sign: value > 0 ? 'gain' : value < 0 ? 'loss' : 'flat',
          change: null,
          changePct: null,
          direction: 'flat',
        });
      }
    }
    return rows;
  }

  /**
   * Order each (company, concept, frequency) series by its period and compute
   * the change against the period before: year-over-year for annual rows,
   * quarter-over-quarter for quarterly ones.
   *
   * @param {object[]} rows the raw rows
   * @returns {object[]} the same rows, with `change`, `changePct` and
   *   `direction` filled in
   */
  function finaliseRows(rows) {
    const bySeries = new Map();
    for (const row of rows) {
      const seriesKey = `${row.ticker}|${row.concept}|${row.freq}`;
      if (!bySeries.has(seriesKey)) bySeries.set(seriesKey, []);
      bySeries.get(seriesKey).push(row);
    }
    for (const series of bySeries.values()) {
      series.sort((a, b) => (a.end > b.end ? 1 : a.end < b.end ? -1 : 1));
      for (let i = 0; i < series.length; i += 1) {
        const row = series[i];
        const previous = series[i - 1];
        if (previous && previous.value != null && previous.value !== 0) {
          row.change = row.value - previous.value;
          row.changePct = (row.change / Math.abs(previous.value)) * 100;
          row.direction = row.change > 0 ? 'up' : row.change < 0 ? 'down' : 'flat';
        } else {
          row.change = null;
          row.changePct = null;
          row.direction = 'flat';
        }
      }
    }
    /* A stable whole-dataset order: company, concept, then newest period first. */
    rows.sort((a, b) => {
      if (a.ticker !== b.ticker) return a.ticker < b.ticker ? -1 : 1;
      if (a.concept !== b.concept) return a.concept < b.concept ? -1 : 1;
      if (a.freq !== b.freq) return a.freq < b.freq ? -1 : 1;
      return a.end > b.end ? -1 : a.end < b.end ? 1 : 0;
    });
    return rows;
  }

  /** Read one company's facts document from the SEC. */
  async function fetchCompany(company, opts = {}) {
    const url = `${BASE}/companyfacts/CIK${company.cik}.json`;
    const body = await requestJson(url, `${company.company} company facts`, opts);
    return body;
  }

  /** Read every company, parse and finalise, returning the flat row set. */
  async function fetchInitial(opts = {}) {
    const report = opts.onProgress || (() => {});
    const rows = [];
    for (let i = 0; i < COMPANIES.length; i += 1) {
      const company = COMPANIES[i];
      report(`Reading ${company.company}...`, (i + 0.5) / COMPANIES.length);
      const facts = await fetchCompany(company, opts);
      rows.push(...extractRows(company, facts));
      /* The SEC allows ten requests a second; a beat between companies keeps
         this comfortably inside it. */
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    report('Building the dashboard...', 1);
    return finaliseRows(rows);
  }

  /**
   * Poll the SEC for new filings and report each result. A fresh reading that
   * adds or revises a period lands on the row it belongs to rather than adding
   * a second one; the grid keys on the row id.
   *
   * @param {object} opts
   * @param {(result: object) => void} opts.onPoll called with each successful poll
   * @param {(error: Error) => void} [opts.onError] called when a poll fails
   * @param {number} [opts.intervalMs] how often to poll
   * @returns {{stop: Function, pollNow: Function}} a handle that stops the polling
   */
  function startPolling({ onPoll, onError, intervalMs = POLL_MS }) {
    let stopped = false;
    let timer = null;
    let polls = 0;
    const controller = new AbortController();

    const runOnce = async () => {
      if (stopped) return;
      polls += 1;
      try {
        const rows = await fetchInitial({ signal: controller.signal });
        if (!stopped) onPoll({ rows, fetchedAt: Date.now(), poll: polls });
      } catch (error) {
        if (!stopped && onError) onError(error);
      }
    };

    timer = setInterval(runOnce, intervalMs);

    return {
      stop() {
        stopped = true;
        clearInterval(timer);
        controller.abort();
      },
      pollNow: runOnce,
    };
  }

  /** Pack a row into the compact array form the snapshot stores. */
  function encodeRow(row) {
    return COLUMNS.map((col) => row[col]);
  }

  /** Unpack a compact snapshot array back into a row. */
  function decodeRow(values) {
    const row = {};
    COLUMNS.forEach((col, index) => {
      row[col] = values[index];
    });
    return row;
  }

  /** Read the saved copy that ships with the demo. */
  async function readSnapshot() {
    const [rowValues, meta] = await Promise.all(
      ['rows', 'meta'].map(async (name) => {
        const response = await fetch(`./data/snapshot/${name}.json`);
        if (!response.ok) throw new Error(`The saved copy is missing ${name}.json.`);
        return response.json();
      }),
    );
    return {
      rows: rowValues.map(decodeRow),
      meta: { ...meta, live: false },
    };
  }

  root.EdgarDemo = Object.assign(root.EdgarDemo || {}, {
    BASE,
    COMPANIES,
    CONCEPTS,
    USER_AGENT,
    POLL_MS,
    COLUMNS,
    requestJson,
    toNumber,
    durationDays,
    classifyFreq,
    tagFor,
    extractRows,
    finaliseRows,
    fetchCompany,
    fetchInitial,
    startPolling,
    encodeRow,
    decodeRow,
    readSnapshot,
  });
})(typeof globalThis !== 'undefined' ? globalThis : window);
