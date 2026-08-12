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

### Insider Buys

Open-market insider purchases (SEC Form 4, transaction code **P**) in sub-$1
stocks, from the last 90 days.

**This section originally scraped openinsider.com and no longer does.**
OpenInsider serves the bare search form to automated clients — including for
its static listing pages, which take no query parameters at all — so nothing
could be read from GitHub Actions. The data now comes from Finnhub's Form 4
endpoint, using the API key already in the app.

How it works:

1. The Action collects a second, broad Finviz screen — everything under $1,
   most active first — into `data/screener.json` as the `universe` list.
2. When you open the section, the app sweeps the first 25 of those tickers
   against Finnhub's `/stock/insider-transactions` and keeps only purchases.
3. Results are cached for 30 minutes. The refresh button forces a re-sweep.

The sweep costs one Finnhub call per ticker, so it stops the moment Finnhub
rate-limits and shows what it has with a note, rather than hammering the free
tier.

**An empty list is a normal result.** Insider buying in sub-$1 names is
genuinely rare, and the section says so rather than looking broken.

Tap any row in either section to open that ticker's chart.

> Both screens are US venues quoting in **US dollars**, so "under $1" is USD,
> not GBP.

### How the Finviz data gets there

finviz.com sends no `Access-Control-Allow-Origin` header, so a page served
over HTTPS from github.io cannot fetch it. `.github/workflows/refresh-screeners.yml`
fetches and parses it in GitHub Actions every 30 minutes and commits
`data/screener.json`, which the app loads same-origin.

Setup: **Actions → Refresh screener data → Run workflow** once. It then runs on
its own. No API key or secret is needed for that workflow.

If a refresh fails, the previous rows are kept and the tab shows an amber
"showing last good data" banner with the actual reason, rather than going
blank.

**A caveat on Finviz:** their terms of service restrict automated access, and
they run bot protection that may start returning challenge pages. The fetcher
detects that and reports it plainly instead of writing garbage, but the Finviz
half may stop working at their discretion. The sanctioned route is a Finviz
Elite subscription, which includes a proper data export.

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
