// node test/verify.js <base-url> [type id]   e.g. http://127.0.0.1:7000 or https://dulo-addon.dazaike.workers.dev
// Calls the addon for three ids, then checks every stream: playlist -> first / middle / last segment, with the stream's proxyHeaders.
const base = (process.argv[2] || 'http://127.0.0.1:7000').replace(/\/$/, '');
const abs = (u, b) => new URL(u, b).href;
const get = (url, headers) => fetch(url, { headers, signal: AbortSignal.timeout(25000) });
function kind(buf) {
  let n = 0, ok = 0;
  for (let i = 0; i + 188 <= buf.length; i += 188) { n++; if (buf[i] === 0x47) ok++; }
  if (n > 5 && ok === n) return 'TS';
  const t = String.fromCharCode(...buf.slice(4, 8));
  return /^(ftyp|moof|styp)$/.test(t) ? 'fMP4:' + t : null;
}
async function check(s) {
  const H = s.behaviorHints.proxyHeaders.request;
  const r = await get(s.url, H);
  let txt = await r.text();
  if (!txt.startsWith('#EXTM3U')) return { ok: false, detail: `playlist ${r.status} ${txt.slice(0, 30)}` };
  let media = s.url;
  const vi = txt.split(/\r?\n/).findIndex((l) => l.startsWith('#EXT-X-STREAM-INF'));
  if (vi >= 0) { media = abs(txt.split(/\r?\n/)[vi + 1], s.url); txt = await (await get(media, H)).text(); }
  const segs = txt.split(/\r?\n/).filter((l) => l && l[0] !== '#');
  const parts = [];
  let ok = segs.length > 0;
  for (const i of [0, Math.floor(segs.length / 2), segs.length - 1]) {
    try {
      const sr = await get(abs(segs[i], media), H);
      const b = new Uint8Array(await sr.arrayBuffer());
      const k = kind(b);
      ok = ok && sr.status === 200 && b.length > 10000 && !!k;
      parts.push(`seg${i} ${sr.status} ${(b.length / 1048576).toFixed(2)}MB ${k}`);
    } catch (e) { ok = false; parts.push(`seg${i} ERR ${e.name}`); }
  }
  return { ok, detail: `${segs.length} segs; ${parts.join('; ')}` };
}
const cases = process.argv[3] ? [[process.argv[3], process.argv[4]]] : [['movie', 'tt0137523'], ['series', 'tt0903747:1:1'], ['series', 'tt37692332:1:6']];
for (const [type, id] of cases) {
  const t0 = Date.now();
  const j = await (await fetch(`${base}/stream/${type}/${encodeURIComponent(id)}.json`)).json();
  console.log(`\n## ${type} ${id}: ${j.streams.length} streams in ${Date.now() - t0}ms`);
  if (j.streams[0]?.subtitles?.length) {
    const sub = j.streams[0].subtitles[0];
    const r = await get(sub.url);
    const t = await r.text();
    console.log(`   subtitles: ${j.streams[0].subtitles.length} tracks, first ${sub.lang} -> ${r.status} ${t.startsWith('WEBVTT') ? 'WEBVTT ok' : t.slice(0, 30)}`);
  } else console.log('   subtitles: none');
  for (const s of j.streams) {
    const c = await check(s).catch((e) => ({ ok: false, detail: 'ERR ' + e.name + ' ' + e.message }));
    console.log(`  ${c.ok ? 'PASS' : 'FAIL'} ${s.name} | ${s.title.replace(/\n/g, ' ')} | ${c.detail}`);
  }
}
