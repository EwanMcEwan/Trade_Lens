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
import { parseTable, firstHref, toNumber } from "./parse-table.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data", "screener.json");

const UA = "Mozilla/5.0 (compatible; Trade_Lens/1.0; +https://github.com/EwanMcEwan/Trade_Lens)";

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
const OPENINSIDER_URL =
  "http://openinsider.com/screener?s=&o=&pl=&ph=1&ll=&lh=" +
  "&fd=0&fdr=&td=0&tdr=&fdlyl=&fdlyh=&daysago=" +
  "&xp=1&xs=0&xa=0&xd=0&xg=0&xf=0&xm=0&xx=0&xc=0&xw=0" +
  "&vl=&vh=&ocl=&och=&sic1=-1&sicl=100&sich=9999&grp=0" +
  "&nfl=&nfh=&nil=&nih=&nol=&noh=&v2l=&v2h=&oc2l=&oc2h=" +
  "&sortcol=0&cnt=100&page=1";

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

async function fetchFinviz() {
  const html = await getHtml(FINVIZ_URL);
  const table = parseTable(html, ["ticker", "price"]);
  if (!table) throw new Error("could not locate the screener table (markup may have changed)");

  const rows = table.rows.map(r => ({
    ticker: r.ticker || "",
    company: r.company || "",
    sector: r.sector || "",
    industry: r.industry || "",
    country: r.country || "",
    marketCap: r.market_cap || "",
    price: toNumber(r.price),
    changePct: toNumber(r.change),
    volume: toNumber(r.volume),
  })).filter(r => /^[A-Z][A-Z0-9.\-]{0,7}$/.test(r.ticker));

  if (!rows.length) throw new Error("table found but no ticker rows parsed");
  return { rows, url: FINVIZ_URL, filters: FINVIZ_LABELS };
}

async function fetchOpenInsider() {
  const html = await getHtml(OPENINSIDER_URL);
  const table = parseTable(html, ["ticker", "trade date"]);
  if (!table) throw new Error("could not locate the screener table (markup may have changed)");

  const rows = table.rows.map(r => {
    // Header names vary slightly between openinsider views; accept either.
    const qty = r.qty ?? r.quantity;
    const own = r.owned ?? r.own;
    return {
      filingDate: (r.filing_date || "").slice(0, 16),
      tradeDate: r.trade_date || "",
      ticker: (r.ticker || "").toUpperCase(),
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
  }).filter(r => /^[A-Z][A-Z0-9.\-]{0,7}$/.test(r.ticker));

  if (!rows.length) throw new Error("table found but no ticker rows parsed");
  return { rows, url: OPENINSIDER_URL };
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
