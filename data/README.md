# data/

`screener.json` is written by `.github/workflows/refresh-screeners.yml`
(which runs `scripts/fetch-screeners.mjs`). Do not edit it by hand — the
workflow overwrites it every 30 minutes.

It exists because the Screening tab's two sources cannot be read from a
browser:

| Source | Why it must be fetched server-side |
|---|---|
| finviz.com | No `Access-Control-Allow-Origin` header — blocked by CORS |
| openinsider.com | Same, plus it is plain HTTP, which an HTTPS page cannot fetch at all (mixed content) |

Until the workflow has run once the file does not exist, and the Screening
tab says so rather than showing an empty list.
