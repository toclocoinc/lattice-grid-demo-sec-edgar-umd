/**
 * The entry point: work out where the data should come from, fetch it, hand
 * it to the dashboard, and then keep it moving.
 *
 * Two ways to open the page:
 *
 *   (nothing)            live, reading the SEC EDGAR API and polling
 *   ?source=snapshot     the saved copy in `data/snapshot`, no API needed
 *
 * When the live API cannot be reached the page opens the saved copy instead
 * and says so at the top, rather than showing an error. In a browser the SEC
 * API is effectively always unreachable: it does not send the cross-origin
 * header a `fetch` needs to read the response, and it asks for a User-Agent a
 * browser cannot set. The saved copy is therefore what a browser shows.
 *
 * This is the script-tag edition. The grid and its modules arrived as classic
 * `<script src>` tags from jsDelivr, ahead of this file, and left globals
 * behind: `LatticeGrid` (the core, which the charts module extends),
 * `LatticeGridDataRouter`, `LatticeGridKPI` and `LatticeGridTabs`. This file
 * picks the factories off those globals and hands them to the dashboard, which
 * never touches a global itself.
 */
(function (root) {
  'use strict';

  const TITLE = 'Six US public companies, reported to SEC EDGAR';

  const host = document.querySelector('#app');
  const params = new URLSearchParams(location.search);
  const mode = params.get('source') === 'snapshot' ? 'snapshot' : 'live';

  /** Draw the waiting state, and return a function that updates its message. */
  function showProgress(first) {
    host.textContent = '';
    const panel = document.createElement('div');
    panel.className = 'loading';
    const title = document.createElement('h1');
    title.textContent = TITLE;
    const message = document.createElement('p');
    message.className = 'loading-message';
    message.textContent = first;
    const bar = document.createElement('div');
    bar.className = 'loading-bar';
    const fill = document.createElement('div');
    fill.className = 'loading-fill';
    bar.append(fill);
    panel.append(title, message, bar);
    host.append(panel);
    return (text, fraction) => {
      message.textContent = text;
      fill.style.width = `${Math.round((fraction || 0) * 100)}%`;
    };
  }

  /** Say what went wrong, in words a reader can act on. */
  function showError(error) {
    host.textContent = '';
    const panel = document.createElement('div');
    panel.className = 'loading';
    const title = document.createElement('h1');
    title.textContent = 'The SEC data could not be loaded';
    const message = document.createElement('p');
    message.className = 'loading-message';
    message.textContent = String((error && error.message) || error);
    const hint = document.createElement('p');
    hint.className = 'loading-message';
    hint.textContent = 'You can open the same dashboard from the saved copy by adding ?source=snapshot to the address.';
    panel.append(title, message, hint);
    host.append(panel);
    console.error('[sec edgar demo]', error);
  }

  /**
   * The grid's factories, read off the globals the script tags left behind.
   *
   * Checked by name rather than assumed, so a script tag that did not load,
   * or loaded in the wrong order, is reported as the sentence it is rather
   * than as "undefined is not a function" somewhere inside the dashboard.
   *
   * @returns {object} the factories and `setLicence`
   */
  function libraryFromGlobals() {
    const missing = [];
    const need = (object, name, what) => {
      const value = object && object[name];
      if (typeof value !== 'function') missing.push(what);
      return value;
    };
    const createGrid = need(root.LatticeGrid, 'createGrid', 'lattice-grid.min.js (LatticeGrid.createGrid)');
    const setLicence = need(root.LatticeGrid, 'setLicence', 'lattice-grid.min.js (LatticeGrid.setLicence)');
    const createStat = need(root.LatticeGrid, 'createStat', 'lattice-grid.min.js (LatticeGrid.createStat)');
    /* The charts module extends the core global rather than defining its own,
       so it has to be loaded after the core; this is where that shows. */
    const createChart = need(root.LatticeGrid, 'createChart', 'modules/charts.min.js (LatticeGrid.createChart)');
    const createDataRouter = need(root.LatticeGridDataRouter, 'createDataRouter', 'modules/data-router.min.js (LatticeGridDataRouter.createDataRouter)');
    const createKPI = need(root.LatticeGridKPI, 'createKPI', 'modules/kpi.min.js (LatticeGridKPI.createKPI)');
    const createTabs = need(root.LatticeGridTabs, 'createTabs', 'modules/tabs.min.js (LatticeGridTabs.createTabs)');
    if (missing.length) {
      throw new Error(
        `The grid did not load from the CDN. Missing: ${missing.join('; ')}. ` +
          'Check that the script tags in index.html are reachable and in order, with the core first.',
      );
    }
    return { createGrid, setLicence, createStat, createChart, createDataRouter, createKPI, createTabs };
  }

  async function start() {
    const started = performance.now();
    try {
      const { createGrid, setLicence, createStat, createChart, createDataRouter, createKPI, createTabs } = libraryFromGlobals();
      const { buildDashboard, fetchInitial, readSnapshot, startPolling, POLL_MS } = root.EdgarDemo;

      /* Applied before anything is drawn, because a grid that already exists
         keeps whatever licence was in force when it was built. */
      setLicence(DEMO_LICENCE);

      let rows;
      let meta;

      if (mode === 'snapshot') {
        const update = showProgress('Reading the saved copy...');
        const saved = await readSnapshot();
        meta = saved.meta;
        rows = saved.rows;
        update('Building the dashboard...', 1);
      } else {
        const update = showProgress('Reading the SEC EDGAR API...');
        try {
          const initial = await fetchInitial({ onProgress: update });
          rows = initial;
          meta = { live: true, fetchedAt: Date.now(), rows: rows.length };
        } catch (liveError) {
          /* The SEC is out of our hands, so a bad day for it should not be a
             blank page here. The saved copy shows the same dashboard, and the
             masthead says plainly that is what you are looking at. */
          console.warn('[sec edgar demo] the live fetch failed, falling back to the saved copy:', liveError);
          update('The SEC EDGAR API could not be reached. Opening the saved copy...', 1);
          const saved = await readSnapshot();
          rows = saved.rows;
          meta = { ...saved.meta, live: false, fellBack: true };
        }
      }

      const fetched = performance.now();

      const built = buildDashboard({
        root: host,
        createGrid,
        createStat,
        createChart,
        createKPI,
        createTabs,
        createDataRouter,
        rows,
        meta,
      });

      /* Not started after a fallback: the saved rows are not a live feed, and
         a poll that later got through would mix fresh rows in with them. */
      let poller = null;
      if (mode === 'live' && meta.live) {
        poller = startPolling({
          intervalMs: POLL_MS,
          onPoll: (result) => built.onPoll(result),
          onError: (error) => built.onPollError(error),
        });
        built.poller = poller;
      }

      const finished = performance.now();
      const timings = {
        mode,
        fellBack: !!meta.fellBack,
        resultsRows: built.resultsGrid ? built.resultsGrid.rows.count() : 0,
        loaded: rows.length,
        fetchMs: Math.round(fetched - started),
        buildMs: Math.round(finished - fetched),
        totalMs: Math.round(finished - started),
      };

      root.__edgarDemo = Object.assign(built, { meta, timings, ready: true });
      console.log('[sec edgar demo] ready', timings);
    } catch (error) {
      root.__edgarDemo = { ready: false, error: String((error && error.message) || error) };
      showError(error);
    }
  }

  start();
})(window);
