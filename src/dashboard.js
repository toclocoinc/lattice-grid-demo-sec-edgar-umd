/**
 * The dashboard: six companies' reported results, read from SEC EDGAR, and
 * every view built on top of them.
 *
 * Nothing here fetches anything and nothing here reaches for the grid's
 * globals: every factory is handed in, so this file is the same whether the
 * library arrived by script tag, as it does here, or by import.
 *
 * The results grid - every fact row, annual and quarterly, for every concept -
 * is the primary view. Its tiles, its KPI panel and its charts all read it, so
 * narrowing the table moves everything. Five further views are derived from it
 * - annual revenue per company, revenue aggregated by year, revenue by company,
 * a statistical profile and a series summary - each its own grid whose rows
 * come from the results grid rather than from a second load.
 *
 * A classic script: it reads the constants from `EdgarDemo`, put there by
 * `edgar-feed.js`, and adds `buildDashboard` alongside them.
 */
(function (root) {
  'use strict';

  const { CONCEPTS } = root.EdgarDemo;

  /** Make an element with a class and optional text, the long way round. */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /** A dollar figure, compact for a headline. */
  function moneyCompact(value) {
    if (value == null || !Number.isFinite(value)) return '-';
    return new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency: 'USD',
      notation: 'compact',
      maximumFractionDigits: 2,
    }).format(value);
  }

  /** A clock time, local to whoever is reading. */
  function clockText(ms) {
    return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  /** The plain data objects a grid is currently showing, in display order. */
  function plainRows(grid) {
    const out = [];
    if (grid && grid.rows && grid.rows.forEach) {
      grid.rows.forEach((row) => {
        if (row && !row.group && row.data) out.push(row.data);
      });
    }
    return out;
  }

  /** A currency column format. */
  function usd(decimals) {
    return { style: 'currency', currency: 'USD', decimals: decimals == null ? 0 : decimals };
  }

  /* ------------------------------------------------------------------ */
  /* Reductions shared by the tiles, the KPI panel and the checker      */
  /* ------------------------------------------------------------------ */

  /** The annual rows for one concept, ordered oldest first. */
  function annualSeries(rows, concept) {
    return rows
      .filter((row) => row.period === 'FY' && row.concept === concept)
      .sort((a, b) => (a.fy > b.fy ? 1 : a.fy < b.fy ? -1 : 1));
  }

  /** One row per company: that company's latest annual reading for a concept. */
  function latestPerCompany(rows, concept) {
    const byCompany = new Map();
    for (const row of rows) {
      if (row.period !== 'FY' || row.concept !== concept) continue;
      const current = byCompany.get(row.company);
      if (!current || row.fy > current.fy || (row.fy === current.fy && row.end > current.end)) {
        byCompany.set(row.company, row);
      }
    }
    return [...byCompany.values()];
  }

  /** The combined figure for a concept: each company's latest annual value, summed. */
  function combinedLatest(rows, concept) {
    let total = 0;
    for (const row of latestPerCompany(rows, concept)) total += row.value;
    return total;
  }

  /** The combined figure a year earlier: each company's second-latest annual value. */
  function combinedPrior(rows, concept) {
    let total = 0;
    const companies = new Set(rows.filter((r) => r.period === 'FY' && r.concept === concept).map((r) => r.company));
    for (const company of companies) {
      const series = annualSeries(rows.filter((r) => r.company === company && r.concept === concept), concept);
      if (series.length > 1) total += series[series.length - 2].value;
    }
    return total;
  }

  /* ------------------------------------------------------------------ */
  /* Columns                                                             */
  /* ------------------------------------------------------------------ */

  /** The primary results columns: every fact row, annual and quarterly. */
  function resultsColumns(pctMax) {
    return [
      {
        id: 'company',
        field: 'company',
        title: 'Company',
        cell: { render: 'twoline', props: { secondary: 'ticker' } },
        filter: { type: 'set' },
        layout: { width: 200, pin: 'start' },
      },
      {
        id: 'concept',
        field: 'concept',
        title: 'Concept',
        cell: { render: 'twoline', props: { secondary: (p) => p.data.tag } },
        filter: { type: 'set' },
        layout: { width: 210 },
      },
      {
        id: 'period',
        field: 'period',
        title: 'Period',
        cell: {
          decoration: 'pill',
          variant: { when: [{ op: 'eq', value: 'FY', use: 'accent' }], default: 'neutral' },
        },
        filter: { type: 'set' },
        layout: { width: 80 },
      },
      { id: 'fy', field: 'fy', title: 'Fiscal year', type: 'number', filter: { type: 'number' }, layout: { width: 100 } },
      {
        id: 'end',
        field: 'end',
        title: 'Period end',
        type: 'date',
        format: { type: 'date', pattern: 'd MMM yyyy' },
        filter: { type: 'date' },
        layout: { width: 120 },
      },
      { id: 'value', field: 'value', title: 'Value (USD)', type: 'number', format: usd(0), filter: { type: 'number' }, layout: { width: 180 } },
      {
        id: 'change',
        field: 'change',
        title: 'Period change',
        type: 'number',
        format: { ...usd(0), signed: true },
        layout: { width: 170 },
      },
      {
        id: 'changePct',
        field: 'changePct',
        title: 'Change %',
        type: 'number',
        format: { type: 'number', decimals: 2, suffix: '%', signed: true },
        cell: { decoration: { type: 'bar', min: -pctMax, max: pctMax, origin: 0 } },
        layout: { width: 130 },
      },
      {
        id: 'sign',
        field: 'sign',
        title: 'Result',
        cell: {
          decoration: 'pill',
          variant: {
            when: [
              { op: 'eq', value: 'gain', use: 'success' },
              { op: 'eq', value: 'loss', use: 'danger' },
            ],
            default: 'neutral',
          },
        },
        filter: { type: 'set' },
        layout: { width: 100 },
      },
      {
        id: 'delta',
        title: 'vs first reading',
        type: 'number',
        shadow: { kind: 'delta', of: 'value' },
        format: { ...usd(0), signed: true },
        layout: { hidden: true },
      },
      {
        id: 'deltaPct',
        title: 'vs first reading %',
        type: 'number',
        shadow: { kind: 'deltaPercent', of: 'value' },
        format: { type: 'number', decimals: 2, suffix: '%', signed: true },
        layout: { hidden: true },
      },
    ];
  }

  /** The annual revenue columns: one row per company per fiscal year. */
  function annualRevenueColumns(pctMax) {
    return [
      {
        id: 'company',
        field: 'company',
        title: 'Company',
        cell: { render: 'twoline', props: { secondary: 'ticker' } },
        filter: { type: 'set' },
        layout: { width: 220, pin: 'start' },
      },
      { id: 'fy', field: 'fy', title: 'Fiscal year', type: 'number', filter: { type: 'number' }, layout: { width: 100 } },
      {
        id: 'end',
        field: 'end',
        title: 'Year end',
        type: 'date',
        format: { type: 'date', pattern: 'd MMM yyyy' },
        layout: { width: 120 },
      },
      { id: 'value', field: 'value', title: 'Revenue', type: 'number', format: usd(0), layout: { width: 190 } },
      {
        id: 'change',
        field: 'change',
        title: 'Year on year',
        type: 'number',
        format: { ...usd(0), signed: true },
        layout: { width: 170 },
      },
      {
        id: 'changePct',
        field: 'changePct',
        title: 'Year on year %',
        type: 'number',
        format: { type: 'number', decimals: 2, suffix: '%', signed: true },
        cell: { decoration: { type: 'bar', min: -pctMax, max: pctMax, origin: 0 } },
        layout: { width: 140 },
      },
    ];
  }

  /** The revenue-by-year columns, with the grid's own shadow columns. */
  function byYearColumns(maxRevenue) {
    return [
      { id: 'fy', field: 'fy', title: 'Fiscal year', type: 'number', layout: { width: 110 } },
      {
        id: 'revenue',
        field: 'revenue',
        title: 'Total revenue',
        type: 'number',
        format: usd(0),
        total: 'sum',
        cell: { decoration: { type: 'bar', min: 0, max: maxRevenue } },
        layout: { width: 220 },
      },
      { id: 'companies', field: 'companies', title: 'Companies', type: 'number', total: 'sum', layout: { width: 100 } },
      {
        id: 'yoy',
        title: 'Year on year',
        type: 'number',
        shadow: { kind: 'periodOverPeriod', of: 'revenue', orderBy: 'fy', within: 'all' },
        format: { ...usd(0), signed: true },
        layout: { width: 170 },
      },
      {
        id: 'cumulative',
        title: 'Running total',
        type: 'number',
        shadow: { kind: 'cumulativeToDate', of: 'revenue', orderBy: 'fy', within: 'all' },
        format: usd(0),
        layout: { width: 190 },
      },
      {
        id: 'delta',
        title: 'vs first year',
        type: 'number',
        shadow: { kind: 'delta', of: 'revenue' },
        format: { ...usd(0), signed: true },
        layout: { hidden: true },
      },
      {
        id: 'deltaPct',
        title: 'vs first year %',
        type: 'number',
        shadow: { kind: 'deltaPercent', of: 'revenue' },
        format: { type: 'number', decimals: 2, suffix: '%', signed: true },
        layout: { hidden: true },
      },
    ];
  }

  /** The revenue-by-company columns. */
  function byCompanyColumns(maxRevenue) {
    return [
      {
        id: 'company',
        field: 'company',
        title: 'Company',
        cell: { render: 'twoline', props: { secondary: 'ticker' } },
        filter: { type: 'set' },
        layout: { width: 220, pin: 'start' },
      },
      {
        id: 'revenue',
        field: 'revenue',
        title: 'Total revenue',
        type: 'number',
        format: usd(0),
        total: 'sum',
        cell: { decoration: { type: 'bar', min: 0, max: maxRevenue } },
        layout: { width: 220 },
      },
      { id: 'years', field: 'years', title: 'Years', type: 'number', total: 'sum', layout: { width: 90 } },
    ];
  }

  /** The profile columns: one row per profiled column. */
  function profileColumns() {
    return [
      { id: 'column', field: 'column', title: 'Column', layout: { width: 160 } },
      { id: 'rows', field: 'rows', title: 'Rows', type: 'number', layout: { width: 90 } },
      { id: 'present', field: 'present', title: 'Present', type: 'number', layout: { width: 90 } },
      { id: 'distinct', field: 'distinct', title: 'Distinct', type: 'number', layout: { width: 90 } },
      { id: 'min', field: 'min', title: 'Min', type: 'number', format: usd(0), layout: { width: 180 } },
      { id: 'max', field: 'max', title: 'Max', type: 'number', format: usd(0), layout: { width: 180 } },
      { id: 'mean', field: 'mean', title: 'Mean', type: 'number', format: usd(0), layout: { width: 180 } },
      { id: 'median', field: 'median', title: 'Median', type: 'number', format: usd(0), layout: { width: 180 } },
      { id: 'stddev', field: 'stddev', title: 'Std dev', type: 'number', format: usd(0), layout: { width: 180 } },
      { id: 'outliers', field: 'outliers', title: 'Outliers', type: 'number', layout: { width: 90 } },
    ];
  }

  /** The series-summary columns: one row per metric. */
  function seriesColumns() {
    return [
      { id: 'metric', field: 'metric', title: 'Metric', layout: { width: 220 } },
      { id: 'value', field: 'value', title: 'Value', type: 'number', layout: { width: 240 } },
      { id: 'n', field: 'n', title: 'n', type: 'number', layout: { width: 90 } },
    ];
  }

  /** The shared grid settings the tables use. */
  function baseGridConfig(title, extra) {
    return Object.assign(
      {
        rowKey: 'id',
        theme: 'light',
        density: 'compact',
        stripedRows: true,
        columnMenu: true,
        statusBar: true,
        find: true,
        grandTotalRow: false,
        toolPanel: { side: 'right', panels: ['filters', 'columns', 'formatting'] },
        title,
      },
      extra || {},
    );
  }

  /* ------------------------------------------------------------------ */
  /* A small tab strip                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * A minimal accessible tab strip. This demo builds its own rather than using
   * the tabs module because the derived views need `where`, `select` and
   * `statistics` projections that the module's `from` shorthand does not
   * forward; the grids are created directly and swapped in and out of sight.
   */
  function tabStrip(host, tabs) {
    const bar = el('div', 'tab-bar');
    bar.setAttribute('role', 'tablist');
    const panes = el('div', 'tab-panes');
    host.append(bar, panes);

    const buttons = {};
    const panels = {};
    for (const tab of tabs) {
      const btn = el('button', 'tab-btn', tab.label);
      btn.type = 'button';
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', 'false');
      btn.addEventListener('click', () => activate(tab.id));
      bar.append(btn);
      buttons[tab.id] = btn;

      const panel = el('div', 'tab-panel');
      panel.setAttribute('role', 'tabpanel');
      panel.hidden = true;
      panes.append(panel);
      panels[tab.id] = panel;
    }

    let activeId = null;
    function activate(id) {
      if (!buttons[id] || activeId === id) return;
      activeId = id;
      for (const key of Object.keys(buttons)) {
        const on = key === id;
        buttons[key].classList.toggle('on', on);
        buttons[key].setAttribute('aria-selected', String(on));
        panels[key].hidden = !on;
      }
    }
    activate(tabs[0].id);

    return { activate, panel: (id) => panels[id], activeId: () => activeId, bar };
  }

  /* ------------------------------------------------------------------ */
  /* The dashboard                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * Build the whole page into `host`.
   *
   * @param {object} options
   * @param {HTMLElement} options.root where the dashboard is drawn
   * @param {Function} options.createGrid the grid factory
   * @param {Function} options.createStat the statistic-tile factory
   * @param {Function} options.createChart the charts module's factory
   * @param {Function} options.createKPI the KPI module's factory
   * @param {object[]} options.rows the flat fact rows
   * @param {object} options.meta where the data came from, and when
   * @returns {object} the pieces that were built, for a caller that wants them
   */
  function buildDashboard({ root: host, createGrid, createStat, createChart, createKPI, rows, meta }) {
    host.textContent = '';

    const built = {
      resultsGrid: null,
      annualRevenueGrid: null,
      byYearGrid: null,
      byCompanyGrid: null,
      profileGrid: null,
      seriesGrid: null,
      stats: [],
      kpi: null,
      charts: [],
      tabs: null,
      status: { lastPoll: null, lastError: null, polls: 0, revisions: 0 },
    };

    /* ---------------- ranges for the in-cell bars ---------------- */

    const pctMax = (() => {
      let max = 0;
      for (const row of rows) if (row.changePct != null) max = Math.max(max, Math.abs(row.changePct));
      return max;
    })();
    const maxRevenue = (() => {
      const byYear = new Map();
      for (const row of rows) {
        if (row.concept !== 'Revenue' || row.freq !== 'annual') continue;
        byYear.set(row.fy, (byYear.get(row.fy) || 0) + row.value);
      }
      return Math.max(0, ...byYear.values());
    })();

    /* ---------------- the masthead ---------------- */

    const header = el('header', 'head');
    const heading = el('div', 'head-text');
    heading.append(el('h1', null, 'Six US public companies, reported to SEC EDGAR'));
    heading.append(
      el(
        'p',
        'lede',
        'Annual and quarterly revenue, net income, assets, liabilities and equity for Apple, Microsoft, ' +
          'Alphabet, Amazon, Meta and Netflix, read from the SEC\u2019s XBRL company-facts API and drawn as one ' +
          'table. Every view below reads that one table, so narrowing it moves everything else with it.',
      ),
    );
    if (meta.fellBack) {
      heading.append(
        el(
          'p',
          'notice',
          'The SEC EDGAR API could not be reached from the browser, so this is the saved copy. Reloading the page will try again.',
        ),
      );
    }
    header.append(heading);

    const provenance = el('div', 'head-note');
    const modePill = el('span', 'pill', meta.live ? 'Live' : 'Saved copy');
    const liveDot = el('span', 'dot');
    if (meta.live) modePill.prepend(liveDot);
    const freshness = el('span', 'freshness', 'Waiting for the first update...');
    provenance.append(modePill, freshness);
    header.append(provenance);
    host.append(header);

    /* ---------------- the grids ---------------- */

    const chartHost = el('section', 'chart-wrap');
    chartHost.setAttribute('aria-label', 'Charts');
    const chartBoxes = [];
    for (let i = 0; i < 4; i += 1) {
      const box = el('div', 'chart-box');
      chartHost.append(box);
      chartBoxes.push(box);
    }

    /* The primary results grid, built first so the derived views can read it.
       It is mounted into the first tab's panel below. */
    const resultsPane = el('div', 'grid-pane');
    const resultsGrid = createGrid(
      resultsPane,
      baseGridConfig('Reported results, annual and quarterly', {
        columns: resultsColumns(pctMax),
        sort: [{ col: 'end', dir: 'desc' }],
        formatting: {
          value: [
            {
              id: 'losses',
              label: 'Losses in red',
              when: { op: 'lt', value: 0 },
              style: { color: '#b42318', fontWeight: '600' },
            },
          ],
        },
      }),
    );
    built.resultsGrid = resultsGrid;

    /* The derived views. Each takes its rows from the results grid, so a filter
       on the results table re-derives them all. */
    const annualRevenueGrid = createGrid(
      el('div', 'grid-pane'),
      baseGridConfig('Annual revenue by company', {
        columns: annualRevenueColumns(pctMax),
        source: {
          mode: 'derived',
          from: resultsGrid,
          where: (row) => row.concept === 'Revenue' && row.freq === 'annual',
          follow: 'filtered',
          sort: [{ col: 'fy', dir: 'desc' }, { col: 'company', dir: 'asc' }],
        },
      }),
    );
    built.annualRevenueGrid = annualRevenueGrid;

    const byYearGrid = createGrid(
      el('div', 'grid-pane'),
      baseGridConfig('Revenue aggregated by fiscal year', {
        columns: byYearColumns(maxRevenue),
        grandTotalRow: 'bottom',
        source: {
          mode: 'derived',
          from: resultsGrid,
          where: (row) => row.concept === 'Revenue' && row.freq === 'annual',
          follow: 'filtered',
          groupBy: 'fy',
          select: { revenue: { of: 'value', fn: 'sum' }, companies: { fn: 'count' } },
          sort: [{ col: 'fy', dir: 'desc' }],
        },
      }),
    );
    built.byYearGrid = byYearGrid;

    const byCompanyGrid = createGrid(
      el('div', 'grid-pane'),
      baseGridConfig('Revenue by company (sum of annual figures)', {
        columns: byCompanyColumns(maxRevenue),
        grandTotalRow: 'bottom',
        source: {
          mode: 'derived',
          from: resultsGrid,
          where: (row) => row.concept === 'Revenue' && row.freq === 'annual',
          follow: 'filtered',
          groupBy: 'company',
          select: { revenue: { of: 'value', fn: 'sum' }, years: { fn: 'count' } },
          sort: [{ col: 'revenue', dir: 'desc' }],
        },
      }),
    );
    built.byCompanyGrid = byCompanyGrid;

    const profileGrid = createGrid(
      el('div', 'grid-pane'),
      baseGridConfig('Profile of the reported values', {
        columns: profileColumns(),
        source: { mode: 'derived', from: resultsGrid, profile: ['value', 'change', 'changePct'] },
      }),
    );
    built.profileGrid = profileGrid;

    /* The series summary reads the annual revenue pass-through, because a
       series statistic is a terminal producer: it replaces the pipeline, so it
       cannot itself filter to annual revenue. */
    const seriesGrid = createGrid(
      el('div', 'grid-pane'),
      baseGridConfig('The annual revenue series, one row per metric', {
        columns: seriesColumns(),
        source: {
          mode: 'derived',
          from: annualRevenueGrid,
          statistics: { fn: 'series', of: 'value', by: 'end', periodsPerYear: 1 },
        },
      }),
    );
    built.seriesGrid = seriesGrid;

    /* Two pass-through grids hold just the quarterly series the charts draw, so
       the charts read clean multi-series data without extra concepts mixed in.
       They are not tabs; they live in hidden containers. */
    const quarterlyRevenueGrid = createGrid(
      el('div'),
      baseGridConfig('Quarterly revenue', {
        columns: [
          { id: 'company', field: 'company' },
          { id: 'end', field: 'end', type: 'date' },
          { id: 'value', field: 'value', type: 'number' },
        ],
        source: {
          mode: 'derived',
          from: resultsGrid,
          where: (row) => row.concept === 'Revenue' && row.freq === 'quarter',
          follow: 'filtered',
        },
      }),
    );
    built.quarterlyRevenueGrid = quarterlyRevenueGrid;

    const quarterlyIncomeGrid = createGrid(
      el('div'),
      baseGridConfig('Quarterly net income', {
        columns: [
          { id: 'company', field: 'company' },
          { id: 'end', field: 'end', type: 'date' },
          { id: 'value', field: 'value', type: 'number' },
        ],
        source: {
          mode: 'derived',
          from: resultsGrid,
          where: (row) => row.concept === 'Net income' && row.freq === 'quarter',
          follow: 'filtered',
        },
      }),
    );
    built.quarterlyIncomeGrid = quarterlyIncomeGrid;

    /* ---------------- the tabs ---------------- */

    const tabsHost = el('section', 'tabs-host');
    const tabs = tabStrip(tabsHost, [
      { id: 'results', label: 'Results' },
      { id: 'annual', label: 'Annual revenue' },
      { id: 'byYear', label: 'Revenue by year' },
      { id: 'byCompany', label: 'Revenue by company' },
      { id: 'profile', label: 'Profile' },
      { id: 'series', label: 'Series stats' },
    ]);
    built.tabs = tabs;
    tabs.panel('results').append(resultsPane);
    tabs.panel('annual').append(annualRevenueGrid.element);
    tabs.panel('byYear').append(byYearGrid.element);
    tabs.panel('byCompany').append(byCompanyGrid.element);
    tabs.panel('profile').append(profileGrid.element);
    tabs.panel('series').append(seriesGrid.element);

    /* ---------------- the data ---------------- */

    resultsGrid.rows.load(rows);

    /* ---------------- the stat tiles ---------------- */

    const statStrip = el('section', 'stat-strip');
    statStrip.setAttribute('aria-label', 'Headline figures');
    host.append(statStrip);

    const statTile = () => el('div', 'stat-box');

    const revenueTile = statTile();
    const incomeTile = statTile();
    const meanTile = statTile();
    statStrip.append(revenueTile, incomeTile, meanTile);

    built.stats.push(
      createStat({
        grid: resultsGrid,
        container: revenueTile,
        title: 'Combined revenue',
        value: (g) => combinedLatest(plainRows(g), 'Revenue'),
        format: (v) => moneyCompact(v),
        baseline: (g) => combinedPrior(plainRows(g), 'Revenue'),
        goodWhen: 'up',
        bands: { good: 2e12, warn: 1.6e12, direction: 'up' },
        footer: (v, g) => {
          const n = latestPerCompany(plainRows(g), 'Revenue').length;
          return `Each company's latest annual revenue, summed across ${n} companies.`;
        },
      }),
      createStat({
        grid: resultsGrid,
        container: incomeTile,
        title: 'Combined net income',
        value: (g) => combinedLatest(plainRows(g), 'Net income'),
        format: (v) => moneyCompact(v),
        baseline: (g) => combinedPrior(plainRows(g), 'Net income'),
        goodWhen: 'up',
        bands: { good: 3.5e11, warn: 2.8e11, direction: 'up' },
        footer: 'Each company\u2019s latest annual net income, summed.',
      }),
      createStat({
        grid: annualRevenueGrid,
        container: meanTile,
        title: 'Mean annual revenue',
        value: (g) => g.statistics.reduce('value', 'avg'),
        format: (v) => moneyCompact(v),
        goodWhen: 'up',
        interval: (v, g) => g.statistics.interval('value'),
        footer: 'The average annual revenue in view, with its 95% confidence interval.',
      }),
    );

    /* ---------------- the KPI panel ---------------- */

    const kpiStrip = el('section', 'kpi-strip');
    kpiStrip.setAttribute('aria-label', 'Figures that follow the table');
    const panelHost = el('div', 'kpi-panel');
    kpiStrip.append(panelHost);
    host.append(kpiStrip);

    const kpi = createKPI(panelHost, {
      grid: resultsGrid,
      rowKey: 'id',
      fields: ['value', 'concept', 'period', 'fy', 'end', 'company'],
      columns: 4,
      ariaLabel: 'Figures that follow the table',
      tiles: [
        {
          id: 'revenue',
          label: 'Combined revenue',
          aggregation: 'custom',
          format: { type: 'currency', currency: 'USD', decimals: 0 },
          compute: (list) => combinedLatest(list, 'Revenue'),
        },
        {
          id: 'income',
          label: 'Combined net income',
          aggregation: 'custom',
          format: { type: 'currency', currency: 'USD', decimals: 0 },
          compute: (list) => combinedLatest(list, 'Net income'),
        },
        {
          id: 'revenueYoY',
          label: 'Revenue, year on year',
          aggregation: 'custom',
          format: { type: 'currency', currency: 'USD', decimals: 0 },
          compute: (list) => combinedLatest(list, 'Revenue') - combinedPrior(list, 'Revenue'),
        },
        {
          id: 'companies',
          label: 'Companies in view',
          aggregation: 'custom',
          format: 'number',
          compute: (list) => new Set(list.filter((r) => r.period === 'FY').map((r) => r.company)).size,
        },
      ],
    });
    built.kpi = kpi;

    /* ---------------- the charts ---------------- */

    const chartSpecs = [
      {
        type: 'line',
        x: 'end',
        y: 'value',
        series: 'company',
        title: 'Quarterly revenue by company',
        axis: { x: 'Quarter end', y: 'Revenue (USD)' },
      },
      {
        type: 'line',
        x: 'end',
        y: 'value',
        series: 'company',
        title: 'Quarterly net income by company',
        axis: { x: 'Quarter end', y: 'Net income (USD)' },
      },
      {
        type: 'area',
        x: 'fy',
        y: 'revenue',
        title: 'Total revenue by fiscal year',
        axis: { x: 'Fiscal year', y: 'Revenue (USD)' },
        legend: false,
      },
      {
        type: 'histogram',
        y: 'changePct',
        buckets: 20,
        title: 'Annual revenue, year on year %',
        axis: { x: 'Change (%)', y: 'Years' },
        legend: false,
      },
    ];

    const chartGrids = [quarterlyRevenueGrid, quarterlyIncomeGrid, byYearGrid, annualRevenueGrid];
    chartSpecs.forEach((spec, index) => {
      try {
        built.charts.push(createChart({ grid: chartGrids[index], container: chartBoxes[index], ...spec }));
      } catch (error) {
        chartBoxes[index].append(el('p', 'chart-error', `This chart could not be drawn: ${error.message}`));
        console.error('[sec edgar demo] chart', spec.type, error);
      }
    });
    host.append(chartHost);

    /* ---------------- the controls ---------------- */

    const actions = el('div', 'actions');
    host.append(actions);

    host.append(tabsHost);

    const recentButton = el('button', 'action toggle', 'Annual figures only');
    recentButton.type = 'button';
    recentButton.setAttribute('aria-pressed', 'false');
    recentButton.addEventListener('click', () => {
      const on = recentButton.getAttribute('aria-pressed') === 'true';
      resultsGrid.filters.where('annual', on ? null : (row) => row.freq === 'annual');
      recentButton.setAttribute('aria-pressed', String(!on));
      recentButton.classList.toggle('on', !on);
    });
    actions.append(el('span', 'actions-label', 'The results table drives everything else.'));
    actions.append(recentButton);
    built.recentButton = recentButton;

    /* ---------------- the live readout ---------------- */

    function setFreshness() {
      if (!meta.live) {
        const saved = new Date(meta.fetchedAt).toLocaleString('en-GB');
        freshness.textContent = `A saved copy of the SEC EDGAR data, taken on ${saved}.`;
        freshness.className = 'freshness';
        return;
      }
      if (built.status.lastError) {
        freshness.textContent = built.status.lastPoll
          ? `Could not reach the SEC. Still showing what arrived at ${clockText(built.status.lastPoll)}.`
          : 'Could not reach the SEC.';
        freshness.className = 'freshness failed';
        return;
      }
      if (!built.status.lastPoll) {
        freshness.textContent = 'Waiting for the first update...';
        freshness.className = 'freshness';
        return;
      }
      freshness.textContent = `Updated ${clockText(built.status.lastPoll)}. ${built.status.revisions} revisions since the page opened.`;
      freshness.className = 'freshness';
    }
    built.setFreshness = setFreshness;

    built.onPoll = (result) => {
      built.status.lastPoll = result.fetchedAt || Date.now();
      built.status.lastError = null;
      built.status.polls += 1;
      liveDot.classList.add('beat');
      setTimeout(() => liveDot.classList.remove('beat'), 900);
      if (result.rows && result.rows.length) {
        resultsGrid.rows.load(result.rows);
        built.status.revisions += 1;
      }
      setFreshness();
    };

    built.onPollError = (error) => {
      built.status.lastError = String((error && error.message) || error);
      setFreshness();
      console.warn('[sec edgar demo] a poll failed:', built.status.lastError);
    };

    /** Push rows through the same path a poll uses, for the verification script. */
    built.ingest = (incoming) => {
      if (!incoming || !incoming.length) return 0;
      resultsGrid.rows.apply({ update: incoming });
      return incoming.length;
    };

    setFreshness();

    /* ---------------- the footer ---------------- */

    const footer = el('footer', 'foot');
    const line = el('p', null, 'Data from the ');
    const link = el('a', null, 'SEC EDGAR company-facts API');
    link.href = 'https://data.sec.gov/';
    link.rel = 'noopener';
    line.append(link);
    line.append(
      document.createTextNode(
        '. The figures are as reported to the SEC in each company\u2019s XBRL filings and are in the public domain. ' +
          'Revenue is read from each company\u2019s own revenue tag, net income from NetIncomeLoss, and the balance-sheet ' +
          'lines from Assets, Liabilities and StockholdersEquity.',
      ),
    );
    footer.append(line);
    host.append(footer);

    built.destroy = () => {
      for (const chart of built.charts) chart.destroy();
      for (const stat of built.stats) stat.destroy();
      kpi.destroy();
      resultsGrid.destroy();
      annualRevenueGrid.destroy();
      byYearGrid.destroy();
      byCompanyGrid.destroy();
      profileGrid.destroy();
      seriesGrid.destroy();
      quarterlyRevenueGrid.destroy();
      quarterlyIncomeGrid.destroy();
    };

    return built;
  }

  root.EdgarDemo.buildDashboard = buildDashboard;
})(typeof globalThis !== 'undefined' ? globalThis : window);
