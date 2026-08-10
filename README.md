# Trade_Lens

A single-page mobile market dashboard: sector heatmap, live news, TradingView
charts with auto support/resistance, movers and insider flow, an earnings and
economic calendar, and a screening tab for sub-$1 stocks.

Runs entirely in the browser off one free **Finnhub** API key
([sign up](https://finnhub.io/register)), stored on your device only.

---

## Running it

**Hosted (recommended):** Settings → Pages → Deploy from a branch → `main`,
folder `/ (root)`. Your app is then at
`https://ewanmcewan.github.io/Trade_Lens/`.

**On your phone:** open that URL in Safari → Share → **Add to Home Screen**.
The page already declares `apple-mobile-web-app-capable` and an
`apple-touch-icon`, so it launches full-screen with its own icon. Note that on
iOS a Home Screen web app has its **own storage**, separate from Safari — so
enter your Finnhub key once more inside the installed app.

The Screening tab needs the app served over http(s); opening `index.html`
straight off disk will leave that one tab empty (everything else still works).

---

## The Screening tab

Two sections, both filtered to stocks under $1.

### Finviz

Mirrors this screener configuration:

| Filter | Setting |
|---|---|
| Market Cap | Small ($2bln) and under |
| Price | Under $1 |
| Relative Volume | Over 2 |
| Shares Outstanding | Under 5M |
| Float | Under 20M |
| Order by | Ticker, ascending |

### Open Insider

SEC Form 4 filings, matching this screener configuration:

| Filter | Setting |
|---|---|
| Transaction | P – Purchase only |
| Share price | Max $1 |
| Industry | All sectors except funds |
| Dates | All |
| Sort / group | Filing date, grouped by filing |
| Results | 100 |

Tap any row in either section to open that ticker's chart.

> Both screeners are US venues quoting in **US dollars**, so "under $1" is USD,
> not GBP.

### How the data gets there

Neither site can be read from the browser: both send no
`Access-Control-Allow-Origin` header, and openinsider is plain HTTP, which an
HTTPS page cannot fetch at all. So `.github/workflows/refresh-screeners.yml`
fetches and parses them in GitHub Actions every 30 minutes and commits
`data/screener.json`, which the app loads same-origin.

Setup: **Actions → Refresh screener data → Run workflow** once. It then runs on
its own. No API key or secret is needed for this tab.

If a refresh fails, the previous rows are kept and the tab shows an amber
"showing last good data" banner with the actual reason, rather than going
blank.

**A caveat on Finviz:** their terms of service restrict automated access, and
they run bot protection that may start returning challenge pages. The fetcher
detects that and reports it plainly instead of writing garbage, but the Finviz
half may stop working at their discretion. The sanctioned route is a Finviz
Elite subscription, which includes a proper data export. OpenInsider has no
such restriction. Both are fetched once per source per run.

---

## Fixes in this branch

**55 broken CSS declarations.** A previous edit (commit `d805d77`, "Refactor
CSS variables and styles") had smart-punctuation autocorrect applied to it:

- 46 × `var(–token)` with an en dash instead of `var(--token)` — every one of
  those properties silently fell back to unstyled
- 7 × `font-family: ‘Outfit’` / `‘JetBrains Mono’` with curly quotes, so
  neither custom font ever loaded
- 1 × `content: ‘’;` on the tile glow pseudo-element
- 1 × `.date-nav input[type=“date”]` — invalid selector, calendar date picker
  left unstyled

Genuine en/em dashes in display text were left alone.

**`event.currentTarget` read after dispatch** in the new refresh handler would
have thrown; the node is now captured first.
