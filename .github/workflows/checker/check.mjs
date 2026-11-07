// Viko Reddit checker for GitHub Actions.
// Reads the links that are due from Supabase, looks each one up on Reddit THROUGH your mobile proxy,
// and saves live / removed back to Supabase. No secrets live in this file: they come from GitHub Secrets.
import { execFile } from 'node:child_process';

const SB = process.env.SB_URL || 'https://fkrgiaeglingmogcsyik.supabase.co';
const PUB = process.env.SB_PUB || 'sb_publishable_A-f9c-pdyCSPwE8wdpzPlg_M6k6ttjf'; // public key, same one the website uses
const KEY = process.env.CHECKER_KEY || '';      // secret: GitHub Secret CHECKER_KEY
const PROXY = process.env.PROXY_URL || '';      // secret: socks5h://user:pass@host:port
const ROTATE = process.env.ROTATE_URL || '';    // secret: the "Reboot/Rotate IP" link (optional)
const COOKIE = process.env.REDDIT_COOKIE || ''; // optional secret, only if you must read 18+ communities
const BASE = process.env.REDDIT_BASE || 'https://www.reddit.com';
const RUN_MS = (+process.env.RUN_SECONDS || 270) * 1000; // how long one run keeps working (cron restarts it)
const POLL_MS = (+process.env.POLL_SECONDS || 30) * 1000;
const GAP_MS = +process.env.GAP_MS || 1500;
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const GONE = ['[removed]', '[deleted]'];
const snipOf = (t) => { t = String(t || '').replace(/\s+/g, ' ').trim(); return !t || GONE.includes(t) ? null : t.slice(0, 300); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

if (!KEY) { console.error('CHECKER_KEY secret is missing. See README.'); process.exit(1); }

/* ---- Supabase ---- */
async function rpc(fn, body) {
  const r = await fetch(SB + '/rest/v1/rpc/' + fn, {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: PUB }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('db ' + r.status);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

/* ---- HTTP through the proxy (curl is on every GitHub runner; the config goes via stdin so secrets never show in the process list) ---- */
const q = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
function curl(url, { json = true } = {}) {
  return new Promise((resolve, reject) => {
    const cfg = ['silent', 'show-error', 'location', 'max-redirs = 5', 'max-time = 40',
      PROXY ? 'proxy = ' + q(PROXY) : '', 'user-agent = ' + q(UA),
      'header = ' + q('Accept: ' + (json ? 'application/json' : '*/*')), 'header = ' + q('Accept-Language: en-US,en;q=0.9'),
      COOKIE && json ? 'header = ' + q('Cookie: ' + COOKIE) : '',
      'write-out = ' + q('__CODE__%{http_code}__URL__%{url_effective}'), 'url = ' + q(url)].filter(Boolean).join('\n');
    const p = execFile('curl', ['-K', '-'], { maxBuffer: 16e6 }, (err, out, serr) => {
      if (err && !out) { const e = new Error('network: ' + (String(serr).trim().split('\n').pop() || err.message)); e.net = 1; return reject(e); }
      const m = out.match(/__CODE__(\d+)__URL__([^\n]*)$/);
      if (!m) { const e = new Error('network: unreadable answer'); e.net = 1; return reject(e); }
      resolve({ status: +m[1], url: m[2], body: out.slice(0, m.index) });
    });
    p.stdin.end(cfg);
  });
}

/* ---- Reddit ---- */
async function getJson(path) {
  const r = await curl(BASE + path + '.json?raw_json=1&limit=1');
  if (r.status === 404) return { gone: 1 };
  if (r.status === 429 || r.status === 403 && /blocked|too many|rate/i.test(r.body)) { const e = new Error('HTTP ' + r.status); e.slow = 1; throw e; }
  let j = null;
  try { j = JSON.parse(r.body); } catch (_) {}
  if (!j) {
    const m = r.body.match(/<title>([^<]{0,50})/i);
    throw new Error('HTTP ' + r.status + ' got a web page' + (m ? ': ' + m[1].trim() : ''));
  }
  if (r.status >= 400) throw new Error('HTTP ' + r.status);
  return { j };
}

async function look(url, kind) {
  const path = new URL(url).pathname.replace(/\/+$/, '');
  const res = await getJson(path);
  if (res.gone) return { s: 'removed' };
  const j = res.j;
  if (!Array.isArray(j) || !j[0] || !j[0].data || !j[0].data.children[0]) throw new Error('unexpected answer from Reddit');
  const po = j[0].data.children[0].data;
  if (kind === 'comment') {
    const c = j[1] && j[1].data.children[0];
    if (!c || c.kind !== 't1') return { s: 'removed' };
    const d = c.data;
    const rep = d.replies && d.replies.data ? d.replies.data.children.filter((x) => x.kind === 't1').length : 0;
    return { s: GONE.includes(d.body) || d.author === '[deleted]' ? 'removed' : 'live', sc: d.score, rp: rep, t: po.title, n: snipOf(d.body) };
  }
  const gone = !!po.removed_by_category || GONE.includes(po.selftext) || po.author === '[deleted]';
  return { s: gone ? 'removed' : 'live', sc: po.score, rp: po.num_comments, t: po.title, n: snipOf(po.selftext) };
}

/* ---- new IP when Reddit says slow down (at most once every 10 minutes) ---- */
let lastRotate = 0;
async function rotate() {
  if (!ROTATE || Date.now() - lastRotate < 600000) return false;
  lastRotate = Date.now();
  try { const r = await fetch(ROTATE); log('rotated proxy IP, answer', r.status); } catch (e) { log('rotate failed:', e.message); return false; }
  await sleep(+process.env.ROTATE_WAIT_MS || 25000);
  return true;
}

async function showIp() {
  try { const r = await curl('https://api.ipify.org', { json: false }); log('exit IP seen by the internet:', r.body.trim(), PROXY ? '(through proxy)' : '(NO proxy set)'); }
  catch (e) { log('proxy test failed:', e.message); }
}

/* ---- main loop ---- */
async function main() {
  const end = Date.now() + RUN_MS;
  let done = 0, pauseUntil = 0;
  await showIp();
  while (Date.now() < end) {
    if (Date.now() < pauseUntil) { await sleep(Math.min(5000, end - Date.now())); continue; }
    let due = [];
    try { due = await rpc('checker_due', { k: KEY }); } catch (e) { log('database problem:', e.message); }
    due = due || [];
    log(due.length ? 'checking ' + due.length : 'nothing due (' + done + ' checked this run)');
    for (const p of due) {
      if (Date.now() > end + 60000) break;
      let r, err;
      for (let attempt = 0; attempt < 2; attempt++) {
        try { r = await look(p.url, p.kind); err = null; break; }
        catch (e) { err = e; if (e.slow && attempt === 0 && await rotate()) continue; break; }
      }
      if (err && err.net) { log('proxy/network problem, stopping this round:', err.message); pauseUntil = Date.now() + 60000; break; }
      try {
        if (r) await rpc('checker_report', { k: KEY, pid: p.id, st: r.s, sc: r.sc ?? null, rp: r.rp ?? null, ttl: r.t ?? null, msg: null, snip: r.n ?? null });
        else await rpc('checker_report', { k: KEY, pid: p.id, st: 'error', sc: null, rp: null, ttl: null, msg: 'checker: ' + String(err.message || err) });
        if (r) done++;
      } catch (e) { log('could not save result:', e.message); }
      if (err && err.slow) { log('Reddit said slow down, pausing 2 min'); pauseUntil = Date.now() + 120000; break; }
      await sleep(GAP_MS);
    }
    if (!due.length || Date.now() < pauseUntil) await sleep(Math.min(POLL_MS, Math.max(0, end - Date.now())));
  }
  log('run finished,', done, 'checked');
}
main().catch((e) => { console.error(e); process.exit(1); });
