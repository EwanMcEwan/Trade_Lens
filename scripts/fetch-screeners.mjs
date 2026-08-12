#!/usr/bin/env node
/**
 * Builds data/screener.json for the app's Screening tab.
 *
 * Neither source can be called from the browser:
 *   - finviz.com and openinsider.com send no Access-Control-Allow-Origin
 *     header, so a page on github.io is blocked by CORS.
 *   - openinsider.com is plain HTTP, which an HTTPS page cannot fetch at all
 *     (mixed content).
 * Both are fine server-side, so this runs in GitHub Actions and commits the
 * parsed result, which the page then loads same-origin.
 *
 * Filters mirror the screenshots supplied with the request; see FINVIZ_FILTERS
 * and the OpenInsider query below. Run locally with:
 *     node scripts/fetch-screeners.mjs
 */

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTable, firstHref, allLinks, snippetAround, toNumber } from "./parse-table.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data", "screener.json");

const UA = "Mozilla/5.0 (compatible; Trade_Lens/1.0; +https://github.com/EwanMcEwan/Trade_Lens)";

/* Tickers can carry class suffixes and, on openinsider, occasional lowercase. */
const TICKER_RE = /^[A-Za-z][A-Za-z0-9.\-]{0,9}$/;

/**
 * Pull the ticker out of a cell.
 *
 * Finviz puts a logo placeholder link holding the company's initial ahead of
 * the real ticker link, so neither the cell's full text ("BBQ") nor its first
 * link ("B") is right. Its quote href carries ?t=BQ, which is authoritative;
 * openinsider has no such param, so fall back to the longest ticker-shaped
 * link text, then to the cell text.
 */
function tickerAt(row, headers, key = "ticker") {
  const idx = headers.indexOf(key);
  const cell = idx === -1 ? null : row._html?.[idx];
  if (cell) {
    const links = allLinks(cell);
    for (const l of links) {
      const m = l.href && /[?&]t=([A-Za-z0-9.\-]+)/i.exec(l.href);
      if (m) return m[1];
    }
    const texts = links.map(l => l.text).filter(t => TICKER_RE.test(t));
    if (texts.length) return texts.sort((a, b) => b.length - a.length)[0];
  }
  return String(row[key] || "").trim();
}

/* A screener page's search form is also a table whose labels overlap the
   results headers, so require the chosen table to actually yield tickers. */
const yieldsTickers = (key) => ({ headers, rows }) =>
  rows.some(r => TICKER_RE.test(tickerAt(r, headers, key)));

/* ── Finviz ──────────────────────────────────────────────────────────────
   Descriptive filters, exactly as configured in the screener screenshot:
     Market Cap        Small ($2bln) and under   cap_smallunder
     Price             Under $1                  sh_price_u1
     Relative Volume   Over 2                    sh_relvol_o2
     Shares Outstanding Under 5M                 sh_outstanding_u5
     Float             Under 20M                 sh_float_u20
     Order by          Ticker, ascending         o=ticker
   v=111 is the Overview table.                                            */
const FINVIZ_FILTERS = [
  "cap_smallunder",
  "sh_float_u20",
  "sh_outstanding_u5",
  "sh_price_u1",
  "sh_relvol_o2",
];
const FINVIZ_LABELS = [
  "Market cap: small & under",
  "Float: under 20M",
  "Shares outstanding: under 5M",
  "Price: under $1",
  "Relative volume: over 2",
];
const FINVIZ_URL =
  `https://finviz.com/screener.ashx?v=111&f=${FINVIZ_FILTERS.join(",")}&o=ticker`;

/* ── OpenInsider ─────────────────────────────────────────────────────────
   All Sectors (except Funds), P–Purchase only, share price max $1,
   all dates, grouped by filing, sorted by filing date, 100 results.
     ph=1     share price high = 1
     xp=1     include P (purchase); every other x* flag is 0
     sic1=-1  all sectors except funds
     sortcol=0 / cnt=100 / page=1                                          */
const OI_BASE = "http://openinsider.com/screener";
const OI_COMMON =
  "s=&o=&pl=&ph=1&ll=&lh=" +
  "&fdr=&tdr=&fdlyl=&fdlyh=&daysago=" +
  "&vl=&vh=&ocl=&och=&sic1=-1&sicl=100&sich=9999&grp=0" +
  "&nfl=&nfh=&nil=&nih=&nol=&noh=&v2l=&v2h=&oc2l=&oc2h=" +
  "&sortcol=0&cnt=100&page=1";

/*
 * Candidate query shapes, tried in order until one returns a results table.
 *
 * The first attempt sent every transaction checkbox explicitly (xp=1&xs=0&
 * xa=0&…). openinsider answered with the bare search form and no results at
 * all — a browser omits unchecked boxes rather than sending them as 0, and
 * sending the zeros appears to filter everything out. So the primary shape
 * now sends only xp=1, with the older shapes kept as fallbacks in case the
 * real cause was the date preset instead.
 */
const OPENINSIDER_URLS = [
  // Purchases only, unchecked boxes omitted, all dates.
  { url: `${OI_BASE}?${OI_COMMON}&fd=0&td=0&xp=1` },
  // Same, but the site's default two-year filing window.
  { url: `${OI_BASE}?${OI_COMMON}&fd=730&td=0&xp=1` },
  // Minimal query — only what the filter actually needs.
  { url: `${OI_BASE}?s=&o=&pl=&ph=1&fd=0&xp=1&sic1=-1&sicl=100&sich=9999&sortcol=0&cnt=100&page=1` },
  // Original shape, in case the explicit zeros were not the problem.
  { url: `${OI_BASE}?${OI_COMMON}&fd=0&td=0&xp=1&xs=0&xa=0&xd=0&xg=0&xf=0&xm=0&xx=0&xc=0&xw=0` },
  // Every screener query above came back as the bare search form. These are
  // openinsider's plain static listings, which take no query parameters at
  // all — if they carry a results table then the screener endpoint is the
  // problem, and if they don't then we are being served the form on purpose.
  // They are unfiltered, so the price ceiling is applied here instead.
  { url: "http://openinsider.com/latest-insider-purchases", localFilter: true },
  { url: "http://openinsider.com/latest-insider-trading", localFilter: true },
];

const MAX_SHARE_PRICE = 1;

async function getHtml(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "en-GB,en;q=0.9",
    },
    redirect: "follow",
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  // Cloudflare and friends answer 200 with an interstitial; treat that as a block.
  if (/just a moment|cf-browser-verification|challenge-platform|enable javascript and cookies/i.test(body)) {
    throw new Error("blocked by bot protection (anti-scraping interstitial)");
  }
  return body;
}

/* When a parse comes back empty the log needs to say what the page actually
   contained, otherwise there is nothing to debug from — the sites are not
   reachable from a dev machine behind a restrictive egress policy. */
function reportDiag(name, html, diag, markers = []) {
  console.error(`  [diag] ${name}: ${html.length} bytes, ${diag.tablesFound ?? 0} tables`);
  if (diag.matchedHeaders) {
    console.error(`  [diag] matched headers: ${diag.matchedHeaders.join(", ")}`);
    console.error(`  [diag] rows after header: ${diag.matchedRows}, skipped as too-short: ${diag.skippedRows}`);
  }
  for (const r of (diag.rejected || [])) {
    console.error(`  [diag] rejected (no tickers): ${r.rows} rows | headers: ${JSON.stringify(r.headers)}`);
  }
  // The results table is the big one; show the largest candidates first so a
  // 200-row table is not buried under a dozen one-row layout tables.
  const byRows = [...(diag.candidates || [])].sort((a, b) => b.rows - a.rows).slice(0, 6);
  for (const c of byRows) {
    console.error(`  [diag] biggest candidate: ${c.rows} rows x ${c.cells} cells | first row: ${JSON.stringify(c.firstRow)}`);
  }
  for (const mk of markers) {
    console.error(`  [diag] around "${mk}": ${snippetAround(html, mk, 600)}`);
  }
}

async function fetchFinviz() {
  const html = await getHtml(FINVIZ_URL);
  const diag = {};
  const table = parseTable(html, ["ticker", "price"], diag, yieldsTickers("ticker"));
  if (!table) {
    reportDiag("finviz", html, diag, ["screener", "Ticker"]);
    throw new Error("could not locate the screener table (markup may have changed)");
  }

  const rows = table.rows.map(r => ({
    ticker: tickerAt(r, table.headers),
    company: r.company || "",
    sector: r.sector || "",
    industry: r.industry || "",
    country: r.country || "",
    marketCap: r.market_cap || "",
    price: toNumber(r.price),
    changePct: toNumber(r.change),
    volume: toNumber(r.volume),
  })).filter(r => TICKER_RE.test(r.ticker));

  if (!rows.length) {
    reportDiag("finviz", html, diag);
    console.error(`  [diag] tickers seen: ${JSON.stringify(table.rows.slice(0, 8).map(r => r.ticker))}`);
    throw new Error("table found but no ticker rows parsed");
  }
  return { rows, url: FINVIZ_URL, filters: FINVIZ_LABELS };
}

async function fetchOpenInsider() {
  let html = null, table = null, diag = null, used = null, localFilter = false;

  for (const candidate of OPENINSIDER_URLS) {
    const d = {};
    const body = await getHtml(candidate.url);
    const t = parseTable(body, ["ticker", "trade date"], d, yieldsTickers("ticker"));
    if (t) {
      html = body; table = t; diag = d;
      used = candidate.url; localFilter = !!candidate.localFilter;
      break;
    }
    console.error(`  [try] no results table from ${candidate.url}`);
    html = body; diag = d; used = candidate.url;
    // Be gentle: this is a small site and we may ask several times.
    await new Promise(res => setTimeout(res, 1500));
  }

  if (!table) {
    reportDiag("openinsider", html, diag, ["tinytable", "Trade Type", "Filing Date"]);
    throw new Error(
      "openinsider served the bare search form for every URL tried, including its " +
      "static listing pages — the site is most likely refusing automated requests");
  }
  console.error(`  [ok] openinsider source: ${used}${localFilter ? " (filtering locally)" : ""}`);

  const rows = table.rows.map(r => {
    // Header names vary slightly between openinsider views; accept either.
    const qty = r.qty ?? r.quantity;
    const own = r.owned ?? r.own;
    return {
      filingDate: (r.filing_date || "").slice(0, 16),
      tradeDate: r.trade_date || "",
      ticker: tickerAt(r, table.headers).toUpperCase(),
      company: r.company_name || r.company || "",
      insider: r.insider_name || r.insider || "",
      title: r.title || "",
      tradeType: r.trade_type || "",
      price: toNumber(r.price),
      qty: toNumber(qty),
      owned: toNumber(own),
      // "ΔOwn" normalises differently depending on whether the site emits the
      // character or the &Delta; entity, so accept every spelling we've seen.
      deltaOwnPct: toNumber(r.delta_own ?? r.own_2 ?? r.d_own ?? r.own_chg ?? r.own_chg_2),
      value: toNumber(r.value),
      link: firstHref(r._html?.[3]) || null,
    };
  }).filter(r => TICKER_RE.test(r.ticker));

  if (!rows.length) {
    reportDiag("openinsider", html, diag);
    console.error(`  [diag] tickers seen: ${JSON.stringify(table.rows.slice(0, 8).map(r => r.ticker))}`);
    throw new Error("table found but no ticker rows parsed");
  }

  // The static listing pages carry every trade at every price, so the
  // screener's own filters have to be reapplied here.
  const filters = ["Purchases only (P)", `Share price: under $${MAX_SHARE_PRICE}`];
  let out = rows;
  if (localFilter) {
    out = rows.filter(r =>
      /^P\b|purchase/i.test(r.tradeType || "") &&
      r.price != null && r.price <= MAX_SHARE_PRICE);
    console.error(`  [ok] local filter kept ${out.length} of ${rows.length} rows`);
    filters.push("filtered locally from the latest-trades listing");
  }
  if (!out.length) throw new Error(`no purchases under $${MAX_SHARE_PRICE} in the ${rows.length} rows available`);

  return { rows: out, url: used, filters };
}

/* Keep the previous rows when a source fails, so one bad run does not empty
   the tab — the app shows the old data with a staleness warning instead. */
async function readPrevious() {
  try { return JSON.parse(await readFile(OUT, "utf8")); }
  catch { return null; }
}

async function build(name, fn, previous) {
  process.stdout.write(`${name}: `);
  try {
    const result = await fn();
    console.log(`ok — ${result.rows.length} rows`);
    return { ok: true, error: null, fetched: new Date().toISOString(), ...result };
  } catch (e) {
    console.error(`FAILED — ${e.message}`);
    const prev = previous?.[name];
    if (prev?.rows?.length) {
      console.error(`  keeping ${prev.rows.length} rows from ${prev.fetched}`);
      return { ...prev, ok: false, error: e.message };
    }
    return { ok: false, error: e.message, fetched: null, rows: [] };
  }
}

const previous = await readPrevious();
await mkdir(dirname(OUT), { recursive: true });

const finviz = await build("finviz", fetchFinviz, previous);
const openinsider = await build("openinsider", fetchOpenInsider, previous);

await writeFile(OUT, JSON.stringify({
  generated: new Date().toISOString(),
  finviz,
  openinsider,
}, null, 1));

console.log(`\nWrote ${OUT}`);
if (!finviz.ok && !openinsider.ok && !finviz.rows.length && !openinsider.rows.length) {
  console.error("Both sources failed with no previous data to fall back on.");
  process.exit(1);
}
