# data/

`screener.json` is written by `.github/workflows/refresh-screeners.yml`
(which runs `scripts/fetch-screeners.mjs`). Do not edit it by hand — the
workflow overwrites it every 30 minutes.

It holds two Finviz screens:

| Key | What it is |
|---|---|
| `finviz` | The strict sub-$1 screen, shown as-is in the Screening tab |
| `universe` | Everything under $1, most active first — the ticker list the Insider Buys section sweeps against Finnhub |

It exists because finviz.com sends no `Access-Control-Allow-Origin` header, so
a page served over HTTPS from github.io cannot fetch it directly.

Until the workflow has run once the file has no `universe` key, and the
Insider Buys section says so rather than showing an empty list.

openinsider.com was previously scraped here. It serves the bare search form to
automated clients, so that section now sources Form 4 data from Finnhub in the
browser instead.
