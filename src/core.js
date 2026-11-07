// Shared addon logic (runs on Node >= 18 and Cloudflare Workers).
//
// dulo.mov serves streams two ways (see README):
//   * ZCDN ("Pickle", 4K): the link is bound to the caller's IP and a datacenter IP gets a promo clip, so it can
//     only work from the playing device. It is therefore NOT offered by this server-side addon (the Nuvio plugin has it).
//   * /api/streams/resolve through the zstream-proxy worker: payload links that work from any IP as long as the
//     request carries a dulo.mov Referer/Origin. That is what this addon returns.
const SITE = 'https://dulo.mov';
const DEFAULT_DOMAIN = '2wwlgkfo-31a.workers.dev';
const DEFAULT_TMDB = 'https://epfopf2vba.2wwlgkfo-31a.workers.dev';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, Origin: SITE, Referer: SITE + '/', Accept: 'application/json' };
const PLAY_HEADERS = { Referer: SITE + '/', Origin: SITE, 'User-Agent': UA };
const REQUEST_TIMEOUT_MS = 10000;
const CONFIG_TTL = 10 * 60 * 1000;
const RESULT_TTL = 5 * 60 * 1000;
const POLL_GAP = 700;          // Workers allow ~50 subrequests per call on the free plan
const MAX_POLLS = 18;          // per query; two queries run in parallel
const BUDGET_MS = 24000;       // give up polling after this
const ENOUGH_MS = 6000;        // once at least one source exists, stop polling after this
const SHOW_ALL = true;

export const manifest = {
  id: 'community.dulo',
  version: '1.0.0',
  name: 'Dulo',
  description: 'Movies and TV from dulo.mov. First stream is an automatic best pick, followed by every working source.',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
  behaviorHints: { configurable: false },
};

const cfg = { domain: DEFAULT_DOMAIN, tmdb: DEFAULT_TMDB, at: 0 };
const tmdbCache = new Map();
const resultCache = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (prefix) => `https://${prefix}${1 + Math.floor(Math.random() * 3)}.${cfg.domain}`;

async function getJson(url) {
  try {
    const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

// The worker domain is published by the site and changes now and then.
async function loadConfig() {
  if (Date.now() - cfg.at < CONFIG_TTL) return;
  try {
    const r = await fetch(SITE + '/dulo-config.js', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(5000) });
    const t = r.ok ? await r.text() : '';
    const d = /WORKER_DOMAIN:\s*'([a-z0-9.-]+)'/i.exec(t);
    const m = /TMDB_PROXY_URL:\s*'(https:\/\/[a-z0-9.-]+)'/i.exec(t);
    if (d) { cfg.domain = d[1].toLowerCase(); cfg.at = Date.now(); }
    if (m) cfg.tmdb = m[1].toLowerCase();
  } catch { /* keep last known values */ }
}

// Stremio sends IMDb ids; dulo needs TMDB ids. Cinemeta exposes the mapping.
async function toTmdb(type, imdb) {
  if (tmdbCache.has(imdb)) return tmdbCache.get(imdb);
  try {
    const r = await fetch(`https://v3-cinemeta.strem.io/meta/${type}/${imdb}.json`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const id = (await r.json())?.meta?.moviedb_id;
    if (id) tmdbCache.set(imdb, String(id));
    return id ? String(id) : null;
  } catch {
    return null;
  }
}

// title / year / runtime: the site sends them with resolve.
async function metadata(tmdb, isTv, season, episode) {
  const base = cfg.tmdb + '/3/';
  if (!isTv) {
    const m = await getJson(base + 'movie/' + tmdb);
    return m ? { title: m.title, year: (m.release_date || '').slice(0, 4), runtime: m.runtime } : {};
  }
  const [t, s] = await Promise.all([getJson(base + 'tv/' + tmdb), getJson(base + 'tv/' + tmdb + '/season/' + season)]);
  const ep = ((s && s.episodes) || []).find((e) => e.episode_number === episode);
  return t ? { title: t.name, year: (t.first_air_date || '').slice(0, 4), runtime: ep && ep.runtime } : {};
}

const qs = (v) => encodeURIComponent(String(v)).replace(/%20/g, '+');

function resolveQuery(tmdb, isTv, season, episode, md) {
  let q = `tmdbId=${tmdb}&type=${isTv ? 'tv' : 'movie'}&progressive=true`;
  if (isTv) q += `&seasonId=${season}&episodeId=${episode}`;
  if (md.title) q += '&title=' + qs(md.title);
  if (md.year) q += '&year=' + qs(md.year);
  if (md.runtime > 0) q += '&runtime=' + Math.round(md.runtime);
  return q;
}

// Poll resolve while pending:true; sources accumulate progressively (instant when cached, up to ~20s otherwise).
async function resolve(query) {
  const started = Date.now();
  let best = [];
  let proxy = pick('zstream-proxy');
  for (let polls = 1; polls <= MAX_POLLS; polls++) {
    const j = await getJson(`${proxy}/?destination=${encodeURIComponent(SITE + '/api/streams/resolve?' + query)}`);
    if (!j) {
      proxy = pick('zstream-proxy');
      if (polls >= 3) break;
      continue;
    }
    if (j.sources && j.sources.length) best = j.sources;
    const elapsed = Date.now() - started;
    if (!j.pending || elapsed >= BUDGET_MS || (best.length && elapsed >= ENOUGH_MS)) break;
    await sleep(POLL_GAP);
  }
  return best;
}

function height(label) {
  if (/\b4K\b/i.test(label)) return 2160;
  const m = /(\d{3,4})\s*p/i.exec(label);
  return m ? parseInt(m[1], 10) : 720; // unlabeled = assume 720
}

const ISO3 = { en: 'eng', ar: 'ara', he: 'heb', ja: 'jpn', ko: 'kor', ro: 'rum', th: 'tha', hr: 'hrv', cs: 'cze', fr: 'fre', el: 'gre', hu: 'hun', id: 'ind', it: 'ita', nl: 'dut', pl: 'pol', pt: 'por', ru: 'rus', es: 'spa', tr: 'tur', uk: 'ukr', de: 'ger', da: 'dan', no: 'nor', sv: 'swe', fi: 'fin', zh: 'chi', vi: 'vie' };
const NAME_FIX = { germany: 'ger', danish: 'dan', norwegian: 'nor', icelandic: 'ice', malay: 'may' };

// Subtitle links are refused without a Referer, which players do not send: route them through /sub.
function subtitlesOf(sources, origin) {
  const out = [];
  const seen = new Set();
  for (const s of sources) {
    for (const c of s.captions || []) {
      const lang = String(c.language || '').toLowerCase();
      if (!c.url || seen.has(lang)) continue;
      seen.add(lang);
      out.push({ id: `dulo-${lang}`, url: `${origin}/sub?u=${encodeURIComponent(c.url)}`, lang: ISO3[lang] || NAME_FIX[lang] || lang });
    }
  }
  out.sort((a, b) => (b.lang === 'eng') - (a.lang === 'eng'));
  return out;
}

function toStream(c, name, subs) {
  return {
    name: name || `Dulo - ${c.label}`,
    title: `${c.label}${subs.length ? ` | ${subs.length} subs` : ''}`,
    url: c.url,
    subtitles: subs,
    behaviorHints: {
      notWebReady: true,
      proxyHeaders: { request: PLAY_HEADERS },
    },
  };
}

// Merge source lists, one entry per label; prefer the entry that carries captions.
function mergeSources(lists) {
  const out = [];
  const idx = new Map();
  for (const list of lists) {
    for (const s of list || []) {
      if (!s || !s.url) continue;
      const k = s.label || s.url;
      if (!idx.has(k)) { idx.set(k, out.length); out.push(s); }
      else if (!(out[idx.get(k)].captions || []).length && (s.captions || []).length) out[idx.get(k)] = s;
    }
  }
  return out;
}

async function fetchSources(type, id) {
  const [imdb, s, e] = id.split(':');
  if (!/^tt\d+$/.test(imdb)) return [];
  const isTv = type === 'series';
  const season = parseInt(s, 10) || 1;
  const episode = parseInt(e, 10) || 1;
  const key = `${type}:${id}`;
  const hit = resultCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.sources;

  await loadConfig();
  const tmdb = await toTmdb(type, imdb);
  if (!tmdb) return [];
  // dulo caches/scrapes per exact query: the bare query and the title/year/runtime query surface different servers.
  const qBare = resolveQuery(tmdb, isTv, season, episode, {});
  const [bare, meta] = await Promise.all([
    resolve(qBare),
    (async () => {
      const md = await metadata(tmdb, isTv, season, episode).catch(() => ({}));
      const q = resolveQuery(tmdb, isTv, season, episode, md);
      return q === qBare ? [] : resolve(q);
    })().catch(() => []),
  ]);
  const sources = mergeSources([bare, meta]);
  if (sources.length) {
    resultCache.set(key, { expires: Date.now() + RESULT_TTL, sources });
    if (resultCache.size > 100) resultCache.delete(resultCache.keys().next().value);
  }
  return sources;
}

// type: 'movie' | 'series'; id: 'tt1234567' or 'tt1234567:season:episode'
export async function getStreams(type, id, origin) {
  const sources = await fetchSources(type, id);
  const seen = new Set();
  const cands = [];
  for (const s of sources) {
    if (!s || !s.url || seen.has(s.url)) continue;
    seen.add(s.url);
    const h = height(s.label || '');
    cands.push({ label: s.label || 'Dulo', url: s.url, height: h, subs: (s.captions || []).length > 0 });
  }
  if (!cands.length) return [];
  const subs = subtitlesOf(sources, origin);
  cands.sort((a, b) => b.height + (b.subs ? 50 : 0) - (a.height + (a.subs ? 50 : 0)));
  const best = cands[0];
  const out = [toStream(best, 'Dulo - Auto (Best)', subs)];
  out[0].title = `${best.label} (auto pick)${subs.length ? ` | ${subs.length} subs` : ''}`;
  if (SHOW_ALL) for (const c of cands.slice(1)) out.push(toStream(c, null, subs));
  return out;
}

// Subtitle proxy: only dulo's own payload links on its worker hosts.
async function subtitle(u) {
  await loadConfig();
  let t;
  try { t = new URL(u); } catch { return null; }
  const okHost = t.protocol === 'https:' && t.hostname.endsWith('.' + cfg.domain) && /^zstream-proxy\d?\./.test(t.hostname) && t.searchParams.has('payload');
  if (!okHost) return null;
  const r = await fetch(t.href, { headers: PLAY_HEADERS, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }).catch(() => null);
  if (!r || !r.ok) return null;
  return await r.text();
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Content-Type': 'application/json; charset=utf-8',
};

// Framework-neutral router: takes a URL, returns { status, headers, body }.
export async function route(url) {
  const p = decodeURIComponent(url.pathname);
  if (p === '/' || p === '/manifest.json') return { status: 200, headers: CORS, body: JSON.stringify(manifest) };
  const m = /^\/stream\/(movie|series)\/([^/]+)\.json$/.exec(p);
  if (m) {
    const streams = await getStreams(m[1], m[2], url.origin).catch(() => []);
    return { status: 200, headers: { ...CORS, 'Cache-Control': 'max-age=60' }, body: JSON.stringify({ streams }) };
  }
  if (p === '/sub') {
    const text = await subtitle(url.searchParams.get('u') || '').catch(() => null);
    if (text == null) return { status: 404, headers: CORS, body: JSON.stringify({ error: 'subtitle unavailable' }) };
    return { status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'max-age=3600' }, body: text };
  }
  return { status: 404, headers: CORS, body: JSON.stringify({ error: 'not found' }) };
}
