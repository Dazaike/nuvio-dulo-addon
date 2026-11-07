# nuvio-dulo-addon

Stremio-style stream addon for [dulo.mov](https://dulo.mov) on Cloudflare Workers.

- Manifest: `https://dulo-addon.dazaike.workers.dev/manifest.json`
- Routes: `/manifest.json`, `/stream/{movie|series}/{imdbId}.json` (series id `tt123:season:episode`), `/sub?u=<dulo subtitle link>`; CORS `*`.
- IMDb id -> TMDB id via Cinemeta. Streams come from dulo's `/api/streams/resolve` (via its `zstream-proxy` worker), polled while `pending:true`.
  Two queries run in parallel (bare, and with title/year/runtime like the site) and are merged, because dulo scrapes per exact query.
- The first stream is `Dulo - Auto (Best)` (highest resolution, +subtitle bonus), the rest are listed after it.
- Playlists/segments need a dulo.mov `Referer`/`Origin`: streams carry `behaviorHints.proxyHeaders.request` + `notWebReady`.
  Subtitle links need it too and players do not send it, so subtitles are served through `/sub` (restricted to dulo's own `?payload=` links).
- Not offered here: dulo's 4K "Pickle" (ZCDN) link. It is IP-bound and a datacenter IP gets a promo clip, so it only works when requested
  from the playing device. The Nuvio plugin (Dazaike/nuvio-dulo) includes it.
- The worker domain dulo uses changes now and then; it is read from `https://dulo.mov/dulo-config.js` (cached 10 min) with a hard-coded fallback.

## Run / deploy

```
node server.js            # http://127.0.0.1:7000/manifest.json
wrangler deploy           # worker name: dulo-addon
node test/verify.js <base-url>
```
