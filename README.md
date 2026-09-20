# Six US public companies, reported to SEC EDGAR

A dashboard of the reported results - revenue, net income, assets, liabilities
and equity - of six well-known US public companies, read from the SEC's XBRL
company-facts API and drawn as one table, built on Lattice Grid loaded by
`<script>` tag: no npm install, no bundler, no build step, no
`type="module"`.

**[See it running](https://toclocoinc.github.io/lattice-grid-demo-sec-edgar-umd/)**

| | |
| --- | --- |
| Grid on npm | [@toclocoinc/lattice-grid](https://www.npmjs.com/package/@toclocoinc/lattice-grid) |
| Grid repository | [toclocoinc/latticegrid](https://github.com/toclocoinc/latticegrid) |
| Product site | [latticegrid.dev](https://www.latticegrid.dev) |

It is one table - every annual and quarterly fact, for every concept, for
Apple, Microsoft, Alphabet, Amazon, Meta and Netflix - with several views on
top of it: headline statistic tiles, a KPI panel, four charts, and five grids
derived straight from the results table. They all read the same stream, so
narrowing the results table moves everything else with it.

The point of the demo is the analysis the grid itself maintains. The
year-on-year revenue change on the by-year view is a `periodOverPeriod` shadow
column the grid computes; the revenue-by-company, revenue-by-year, statistical
profile and series summary are derived grids whose rows come from the results
table rather than from a second load; and the headline tiles read the grid so a
figure and the table beneath it can never disagree.

## How the grid gets onto the page

Six tags in `index.html`, and that is the whole of the library setup:

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.65.0/lattice-grid.min.css">

<script src="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.65.0/lattice-grid.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.65.0/modules/charts.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.65.0/modules/data-router.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.65.0/modules/kpi.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.65.0/modules/tabs.min.js"></script>
```

Each file is the package's UMD build (`*.min.js`, beside the `*.esm.min.js`
the ESM edition imports) and leaves a global behind:

| File | Global | Used here for |
| --- | --- | --- |
| `lattice-grid.min.js` | `LatticeGrid` | `createGrid`, `createStat`, `setLicence` |
| `modules/charts.min.js` | extends `LatticeGrid` | `LatticeGrid.createChart` |
| `modules/data-router.min.js` | `LatticeGridDataRouter` | loaded as part of the set |
| `modules/kpi.min.js` | `LatticeGridKPI` | `createKPI` |
| `modules/tabs.min.js` | `LatticeGridTabs` | loaded as part of the set |

The charts module folds its exports into the core global rather than defining
one of its own, so its tag must come after the core's. The other three are
self-contained and can go in any order. `main.js` checks that every factory it
needs is actually there before it draws anything, so a tag that did not load
is reported as a sentence rather than as an error from inside the grid.

This demo builds its own small tab strip because the derived views need
`where`, `select` and `statistics` projections that the tabs module's `from`
shorthand does not forward. The tabs and data-router tags are still loaded, as
the six-tag set is what the page is checked against.

Every address names the exact release, `1.65.0`, and every tag carries the
`integrity` hash of the file it expects. The page cannot quietly pick up a
different build than the one it was checked against, and the browser refuses a
file that does not match. The hashes are the SHA-384 of the published files.

The demo's own code is four classic scripts, loaded in order after the
library: `src/licence.js`, `src/edgar-feed.js`, `src/dashboard.js`, `main.js`.
Each file wraps itself in a function and puts what it offers on one plain
object, `EdgarDemo`, for the next file to read. `src/dashboard.js` is handed
the grid's factories as arguments and never touches a global itself.

## Running it

You need nothing but a browser and a way to serve the folder, because the page
fetches its data with `fetch()` and browsers will not do that from `file://`.
Any static server will do; one is included:

```
node tools/serve.mjs
```

That prints an address. Open it.

| Address | What you get |
| --- | --- |
| `/` | tries the SEC EDGAR API, then shows the saved copy (see below) |
| `/?source=snapshot` | the saved copy in `data/snapshot`, no API needed |

A browser cannot actually read the SEC API, for two reasons explained under
"The data" below, so the live address shows the same dashboard as the snapshot
address, with a notice saying the saved copy is standing in. The two paths
produce identical rows; the live path simply records why the API could not be
reached.

Running a copy on your own machine needs no licence key. Publishing it on a web
address does.

## What it shows

**The results table drives everything.** The primary grid holds every fact
row - annual and quarterly, every concept - newest first. The company and
concept columns are two-line cells (name over ticker, concept over its XBRL
tag), the period column is a pill that reads FY or Q, the result column is a
pill that reads green for a gain and red for a loss, and the change column
carries an in-cell bar so a large move is visible before its number is read.
Losses are coloured red by a conditional-formatting rule that a reader can open
the Formatting panel and change.

**Headline tiles that follow the table.** Three `createStat` tiles read the
grid directly: combined revenue, combined net income, and mean annual revenue.
The first two show their change against a year-earlier baseline and a tone from
threshold bands; the mean tile also shows the grid's own confidence interval,
so a narrow view narrows the figure and its band together.

**A KPI panel over the same table.** Combined revenue, combined net income, the
revenue change year on year, and the companies in view - all reduced from
whatever the table currently matches.

**Four charts.** A line of quarterly revenue for each company, a line of
quarterly net income for each company, an area of total revenue by fiscal year,
and a histogram of the annual revenue year-on-year change. Filter the table and
every chart follows.

**Grids built from the grid.** Five derived grids take their rows from the
results table: annual revenue per company (with the year-on-year change), total
revenue by fiscal year (with the grid's own period-over-period and running-total
shadow columns), revenue by company, a statistical profile of the numeric
columns, and a series summary that reports the growth and volatility of the
annual revenue - one row per metric.

**A feed that can fail.** When the SEC cannot be reached - which is always,
from a browser - the page shows the saved copy instead and says so under the
title.

## The data

Everything comes from the SEC EDGAR XBRL API:

- <https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json>

The CIK is zero-padded to ten digits (Apple is `0000320193`). One document per
company holds every `us-gaap` concept with its annual and quarterly time
series. The data are published by the SEC and are in the public domain.

A few things worth knowing about the data:

- **A browser cannot read it.** The SEC requires a descriptive `User-Agent`
  header identifying the caller, which a browser cannot set, and it answers
  without the `Access-Control-Allow-Origin` header a `fetch` from another
  origin needs to read the response. The snapshot tool runs the feed under
  Node, where it sets the User-Agent the SEC asks for; a browser always falls
  back to the saved copy. This is the one place this demo cannot work live.
- **Revenue is the classic XBRL gotcha.** Five of the six companies restated
  their revenue onto the ASC 606 tag
  `RevenueFromContractWithCustomerExcludingAssessedTax`, while Alphabet and
  Netflix kept the older `Revenues` name. The feed curates the tag per company
  rather than assuming one name fits all.
- **Amazon reports no "total liabilities"** under that name, so those rows are
  simply absent for Amazon.
- **Annual and quarterly are told apart by the numbers, not the labels.** A
  year-long span is annual, a single quarter is quarterly, and the six- and
  nine-month cumulative spans - and the trailing-twelve-month figures some
  companies also report - are dropped. Balance-sheet concepts are point-in-time
  and are told apart by the filing's `FY` versus `Q1`..`Q4` mark.
- **Restatements are common.** The same period often appears in several
  filings; the feed keeps the latest-filed value.
- The SEC rate-limits to about ten requests a second, and the feed spaces its
  six company reads out with a beat between them.

## Files

```
index.html                page shell, and the six library tags
main.js                   works out where the data comes from, then starts
src/licence.js            the key for this demo's own published address
src/edgar-feed.js         the SEC API: fetch, parse, snapshot encode/decode
src/dashboard.js          the views: grids, tiles, KPI, charts, derived grids
styles.css                the page around the grid
tools/serve.mjs           a small static file server
tools/build-snapshot.mjs  save a real run into data/snapshot
tools/verify.mjs          open it in a real browser and check it
data/snapshot/            a saved run, so the demo works without the API
```

There is no `package.json` and no `node_modules`. The tools need Node 22 or
newer and nothing else.

The saved copy is a compact array of arrays - one value per column, in the
order `meta.json` documents - so two thousand fact rows stay a manageable
download. The browser unpacks them with the same code that parses the live
API, so the two paths produce identical rows.

## Building the saved copy

```
node tools/build-snapshot.mjs
```

It reads the six companies from the live API - under Node, with the
descriptive User-Agent the SEC requires - and writes the compact form to
`data/snapshot/`. Re-run it to refresh the copy.

## Checking it

```
node tools/verify.mjs         # open the page in a real browser and assert
node tools/verify.mjs --all   # also open the live address
```

`tools/verify.mjs` is not a smoke test. It first insists on how the library
arrived: no `type="module"` script anywhere on the page, five script tags
pointing at the pinned release on the CDN, each with an integrity hash, and
each leaving the global it documents. It then recomputes the headline figures
from the saved data and compares them with what the page is showing, checks the
derived grids hold the rows they should (annual revenue, revenue by year,
revenue by company, a profile, and a series summary with the growth and
volatility metrics), pushes a revised reading and insists the "vs first
reading" shadow lights up without adding a row, narrows the table and insists
the tiles, the charts and the derived grids all moved with it, and finally
blocks the SEC API in the browser and insists the saved copy appears with a
notice saying why. The GitHub Pages workflow runs it before every publish.

## Licence

The demo code is MIT. See `LICENSE`.

The company-facts data is from SEC EDGAR and is in the public domain.

Lattice Grid itself is a separate commercial product with its own terms. It is
free to use on localhost, with no key and no watermark, so a copy of this
repository runs unrestricted on your own machine. This demo carries a key for
its own published address only, which is why you will find one in the source.
Keys for your own sites come from [latticegrid.dev](https://www.latticegrid.dev).
