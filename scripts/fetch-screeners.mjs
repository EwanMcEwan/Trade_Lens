#!/usr/bin/env node
/**
 * Builds data/screener.json for the app's Screening tab.
 *
 * finviz.com sends no Access-Control-Allow-Origin header, so a page served
 * from github.io cannot fetch it — this runs in GitHub Actions instead and
 * commits the parsed result, which the page then loads same-origin.
 *
 * Two screens are produced:
 *   finviz    the strict sub-$1 screen, shown as-is in the Screening tab
 *   universe  a broad "everything under $1, most active first" list, used by
 *             the Insider Buys section as the set of tickers to check
 *
 * openinsider.com used to be scraped here for the second section. It serves
 * the bare search form to automated clients — even for its static listing
 * pages, which take no query parameters — so that section now sources Form 4
 * data from Finnhub in the browser instead.
 *
 * Run locally with:  node scripts/fetch-screeners.mjs
 */

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTable, firstHref, allLinks, snippetAround, toNumber } from "./parse-table.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data", "screener.json");

const UA = "Mozilla/5.0 (compatible; Trade_Lens/1.0; +https://github.com/EwanMcEwan/Trade_Lens)";

/* Tickers can carry class suffixes and occasionally arrive lowercased. */
const TICKER_RE = /^[A-Za-z][A-Za-z0-9.\-]{0,9}$/;

/**
 * Pull the ticker out of a cell.
 *
 * Finviz puts a logo placeholder link holding the company's initial ahead of
 * the real ticker link, so neither the cell's full text ("BBQ") nor its first
 * link ("B") is right. Its quote href carries ?t=BQ, which is authoritative;
 * fall back to the longest ticker-shaped link text, then to the cell text.
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

/*
 * A second, deliberately broad screen: every stock under $1, most active
 * first. This is the universe the app checks for insider buying — the strict
 * screen above usually returns only a handful of names, far too few for
 * insider filings to show up in. v=111 pages 20 rows at a time, so two pages
 * gives 40 tickers, which is plenty for a client-side sweep.
 */
const FINVIZ_UNIVERSE_URLS = [
  "https://finviz.com/screener.ashx?v=111&f=sh_price_u1&o=-volume",
  "https://finviz.com/screener.ashx?v=111&f=sh_price_u1&o=-volume&r=21",
];


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

/* The sub-$1 universe the Insider Buys section sweeps for Form 4 purchases. */
async function fetchUniverse() {
  const seen = new Set();
  const rows = [];
  for (const url of FINVIZ_UNIVERSE_URLS) {
    const html = await getHtml(url);
    const diag = {};
    const table = parseTable(html, ["ticker", "price"], diag, yieldsTickers("ticker"));
    if (!table) {
      reportDiag("finviz-universe", html, diag, ["Ticker"]);
      break;
    }
    for (const r of table.rows) {
      const ticker = tickerAt(r, table.headers);
      if (!TICKER_RE.test(ticker) || seen.has(ticker)) continue;
      seen.add(ticker);
      rows.push({
        ticker,
        company: r.company || "",
        price: toNumber(r.price),
        volume: toNumber(r.volume),
      });
    }
    await new Promise(res => setTimeout(res, 1500));
  }
  if (!rows.length) throw new Error("no sub-$1 tickers parsed");
  return { rows, url: FINVIZ_UNIVERSE_URLS[0], filters: ["Price: under $1", "Most active first"] };
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
const universe = await build("universe", fetchUniverse, previous);

await writeFile(OUT, JSON.stringify({
  generated: new Date().toISOString(),
  finviz,
  universe,
}, null, 1));

console.log(`\nWrote ${OUT}`);
if (!finviz.ok && !universe.ok && !finviz.rows.length && !universe.rows.length) {
  console.error("Both sources failed with no previous data to fall back on.");
  process.exit(1);
}
