// Viko "Make reports" worker for GitHub Actions.
// Takes the next waiting report from Supabase, re-checks every post and comment on Reddit (through your mobile proxy),
// takes screenshots, highlights your brand word in yellow, builds the PDF and saves it back for the website to download.
// No secrets live in this file: they come from GitHub Secrets.
import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Settings file for running on your own computer (settings.env next to this file). Not used on GitHub.
const HERE = path.dirname(fileURLToPath(import.meta.url));
for (const f of ['settings.env', '.env']) {
  try {
    for (const line of fs.readFileSync(path.join(HERE, f), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (m && !line.trim().startsWith('#') && m[2] !== '' && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
}
import { chromium } from 'playwright';

const SB = process.env.SB_URL || 'https://fkrgiaeglingmogcsyik.supabase.co';
const SERVICE = process.env.SUPABASE_SERVICE_KEY || '';     // secret: GitHub Secret SUPABASE_SERVICE_KEY
const PROXY = process.env.PROXY_URL || '';                  // secret: socks5h://user:pass@host:port
const ROTATE = process.env.ROTATE_URL || '';                // secret (optional): the "Rotate IP" link
const COOKIE = process.env.REDDIT_COOKIE || '';             // optional secret
const BASE = (process.env.REDDIT_BASE || 'https://www.reddit.com').replace(/\/+$/, '');
const OLD = (process.env.OLD_BASE || 'https://old.reddit.com').replace(/\/+$/, '');
const GAP_MS = +process.env.GAP_MS || 900;
const ONLY = process.env.REPORT_ID || '';
const UA_CURL = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const UA_WEB = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const GONE = ['[removed]', '[deleted]'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const LOCAL = process.env.LOCAL === '1';           // 1 = run on your own computer in your own logged-in Brave
const PROFILE = process.env.PROFILE_DIR || path.join(HERE, 'reports_profile');
function findBrowser() {
  if (process.env.BROWSER_PATH) return process.env.BROWSER_PATH;
  const c = ['C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe', 'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    path.join(process.env.LOCALAPPDATA || '', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', '/usr/bin/brave-browser'];
  return c.find((x) => x && fs.existsSync(x)) || '';
}
function findPdfBrowser() { // only used to turn the finished page into a PDF, so any Chromium browser will do (Edge is on every Windows PC)
  if (process.env.PDF_BROWSER_PATH) return process.env.PDF_BROWSER_PATH;
  const pf = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const c = [];
  pf.forEach((b) => { c.push(path.join(b, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(b, 'Google', 'Chrome', 'Application', 'chrome.exe')); });
  c.push('/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  return c.find((x) => x && fs.existsSync(x)) || findBrowser();
}
const killTree = (child) => { try { if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {}); else child.kill('SIGKILL'); } catch {} };
// Starts the real browser like a person would (no automation flags) and only then connects to it, so Reddit sees a genuine Brave.
async function openOwnBrowser({ exe, profile, headless = false, url = 'about:blank' }) {
  const port = 9300 + Math.floor(Math.random() * 600);
  const args = ['--remote-debugging-port=' + port, '--remote-allow-origins=*', '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--window-size=1250,1500']
    .concat(headless ? ['--headless=new'] : []).concat(process.env.EXTRA_ARGS ? process.env.EXTRA_ARGS.split(' ') : []).concat([url]);
  log('starting the browser:', exe);
  const child = spawn(exe, args, { stdio: 'ignore' });
  let exited = null, startErr = null;
  child.on('error', (e) => { startErr = e; log('could not start the browser:', e.message); });
  child.on('exit', (code) => { exited = code; });
  let up = false;
  for (let i = 0; i < 160 && !up; i++) {
    try { up = (await fetch('http://127.0.0.1:' + port + '/json/version')).ok; } catch {}
    if (!up) { if (startErr || exited !== null) break; await sleep(500); }
  }
  if (!up) {
    killTree(child);
    const why = startErr ? 'Windows could not open it (' + startErr.message + '). Check BROWSER_PATH in settings.env.'
      : exited !== null ? 'It closed straight away (code ' + exited + '). This almost always means another Brave window is already using the reports profile. Close it (also check near the clock) and try again.'
      : 'It opened but did not answer in 80 seconds.';
    throw new Error('The browser did not start. ' + why);
  }
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
  return { browser, child };
}
if (!SERVICE && !process.argv.includes('--login')) { console.error('SUPABASE_SERVICE_KEY is missing. On GitHub it is a Secret; on your computer it goes in settings.env.'); process.exit(1); }

/* ---------------- Supabase (REST, with the service key) ---------------- */
async function sb(path, { method = 'GET', body, headers = {}, raw } = {}) {
  const r = await fetch(SB + path, {
    method, body: raw ? body : body ? JSON.stringify(body) : undefined,
    headers: { apikey: SERVICE, ...(SERVICE.startsWith('eyJ') ? { Authorization: 'Bearer ' + SERVICE } : {}), ...(raw ? {} : { 'Content-Type': 'application/json' }), ...headers },
  });
  const t = await r.text();
  if (!r.ok) throw new Error('db ' + r.status + ' ' + t.slice(0, 200));
  try { return t ? JSON.parse(t) : null; } catch { return t; }
}
const patchJob = async (id, o) => {
  try { return await sb('/rest/v1/report_jobs?id=eq.' + id, { method: 'PATCH', body: o, headers: { Prefer: 'return=minimal' } }); }
  catch (e) { // database update 15 not run yet: carry on without the new column
    if (/retry_local/.test(String(e.message)) && 'retry_local' in o) { const { retry_local, ...rest } = o; return sb('/rest/v1/report_jobs?id=eq.' + id, { method: 'PATCH', body: rest, headers: { Prefer: 'return=minimal' } }); }
    throw e;
  }
};

/* ---------------- SOCKS5 relay: Chromium cannot log in to a SOCKS5 proxy, so we do it here ---------------- */
function reader(s) {
  let buf = Buffer.alloc(0), wake = null, err = null;
  const on = (d) => { buf = Buffer.concat([buf, d]); if (wake) wake(); };
  s.on('data', on);
  s.on('error', (e) => { err = e; if (wake) wake(); });
  s.on('close', () => { err = err || new Error('closed'); if (wake) wake(); });
  return {
    async read(n) { while (buf.length < n) { if (err) throw err; await new Promise((r) => { wake = r; }); wake = null; } const o = buf.subarray(0, n); buf = buf.subarray(n); return o; },
    detach() { s.removeListener('data', on); const r = buf; buf = Buffer.alloc(0); return r; },
  };
}
export function startRelay(proxyUrl) {
  const u = new URL(proxyUrl);
  const host = u.hostname, port = +u.port || 1080, user = decodeURIComponent(u.username), pass = decodeURIComponent(u.password);
  const server = net.createServer(async (c) => {
    let up;
    try {
      c.on('error', () => {});
      const cr = reader(c);
      const g = await cr.read(2); await cr.read(g[1]);
      c.write(Buffer.from([5, 0]));
      const h = await cr.read(4); // ver cmd rsv atyp
      if (h[1] !== 1) { c.end(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
      let addr;
      if (h[3] === 1) addr = Buffer.concat([Buffer.from([1]), await cr.read(4)]);
      else if (h[3] === 3) { const l = await cr.read(1); addr = Buffer.concat([Buffer.from([3]), l, await cr.read(l[0])]); }
      else if (h[3] === 4) addr = Buffer.concat([Buffer.from([4]), await cr.read(16)]);
      else { c.destroy(); return; }
      const dport = await cr.read(2);
      up = net.connect(port, host); up.on('error', () => {}); up.setTimeout(120000, () => up.destroy());
      await new Promise((res, rej) => { up.once('connect', res); up.once('error', rej); });
      const ur = reader(up);
      up.write(Buffer.from([5, 2, 0, 2]));
      const sel = await ur.read(2);
      if (sel[1] === 2) {
        const ub = Buffer.from(user), pb = Buffer.from(pass);
        up.write(Buffer.concat([Buffer.from([1, ub.length]), ub, Buffer.from([pb.length]), pb]));
        const ar = await ur.read(2); if (ar[1] !== 0) throw new Error('proxy login refused');
      } else if (sel[1] !== 0) throw new Error('proxy method refused');
      up.write(Buffer.concat([Buffer.from([5, 1, 0]), addr, dport]));
      const rp = await ur.read(4);
      if (rp[3] === 1) await ur.read(6); else if (rp[3] === 4) await ur.read(18); else { const l = await ur.read(1); await ur.read(l[0] + 2); }
      if (rp[1] !== 0) { c.end(Buffer.from([5, rp[1], 0, 1, 0, 0, 0, 0, 0, 0])); up.destroy(); return; }
      c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
      const a = cr.detach(), b = ur.detach();
      if (b.length) c.write(b); if (a.length) up.write(a);
      c.pipe(up); up.pipe(c);
      c.on('close', () => up.destroy()); up.on('close', () => c.destroy());
    } catch (e) { try { c.destroy(); } catch {} try { up && up.destroy(); } catch {} }
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ port: server.address().port, close: () => server.close() })));
}

/* ---------------- HTTP through the proxy with curl (config via stdin so secrets never show in the process list) ---------------- */
const q = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
function curl(url, { json = true } = {}) {
  return new Promise((resolve, reject) => {
    const cfg = ['silent', 'show-error', 'location', 'max-redirs = 5', 'max-time = 40',
      PROXY ? 'proxy = ' + q(PROXY) : '', 'user-agent = ' + q(UA_CURL),
      'header = ' + q('Accept: ' + (json ? 'application/json' : '*/*')), 'header = ' + q('Accept-Language: en-US,en;q=0.9'),
      COOKIE && json ? 'header = ' + q('Cookie: ' + COOKIE) : '',
      'write-out = ' + q('__CODE__%{http_code}__URL__%{url_effective}'), 'url = ' + q(url)].filter(Boolean).join('\n');
    const p = execFile('curl', ['-K', '-'], { maxBuffer: 32e6 }, (err, out, serr) => {
      if (err && !out) { const e = new Error('network: ' + (String(serr).trim().split('\n').pop() || err.message)); e.net = 1; return reject(e); }
      const m = out.match(/__CODE__(\d+)__URL__([^\n]*)$/);
      if (!m) { const e = new Error('network: unreadable answer'); e.net = 1; return reject(e); }
      resolve({ status: +m[1], url: m[2], body: out.slice(0, m.index) });
    });
    p.stdin.end(cfg);
  });
}
let lastRotate = 0;
async function rotate() {
  if (!ROTATE || Date.now() - lastRotate < 600000) return false;
  lastRotate = Date.now();
  try { const r = await fetch(ROTATE); log('rotated proxy IP, answer', r.status); } catch (e) { log('rotate failed:', e.message); return false; }
  await sleep(+process.env.ROTATE_WAIT_MS || 25000);
  return true;
}

/* ---------------- link helpers ---------------- */
const ids = (u) => { const m = String(u).match(/\/r\/([^/]+)\/comments\/([a-z0-9]+)(?:\/[^/?#]*)?(?:\/([a-z0-9]{4,10}))?/i); return m ? { sub: m[1], post: m[2], slug: m[0] } : null; };
const commentId = (u) => { const p = new URL(u).pathname.split('/').filter(Boolean); const i = p.indexOf('comments'); if (i < 0) return ''; const rest = p.slice(i + 2); // [slug|comment, id?]
  if (rest[0] === 'comment' && rest[1]) return rest[1]; if (rest[1]) return rest[1]; return ''; };
const subOf = (u) => { const m = String(u).match(/\/r\/([^/]+)/i); return m ? m[1] : ''; };
const toBase = (u, base) => base + new URL(u).pathname + (new URL(u).pathname.endsWith('/') ? '' : '/');
const snipOf = (t) => { t = String(t || '').replace(/\s+/g, ' ').trim(); return !t || GONE.includes(t) ? null : t.slice(0, 300); };

/* ---------------- liveness (JSON, like the checker) ---------------- */
async function getJson(path) {
  const r = await curl(BASE + path + '.json?raw_json=1&limit=1');
  if (r.status === 404) return { gone: 1 };
  if (r.status === 429 || (r.status === 403 && /blocked|too many|rate/i.test(r.body))) { const e = new Error('HTTP ' + r.status); e.slow = 1; throw e; }
  let j = null; try { j = JSON.parse(r.body); } catch {}
  if (!j) { const m = r.body.match(/<title>([^<]{0,50})/i); throw new Error('HTTP ' + r.status + ' got a web page' + (m ? ': ' + m[1].trim() : '')); }
  if (r.status >= 400) throw new Error('HTTP ' + r.status);
  return { j };
}
async function look(url, kind) {
  const res = await getJson(new URL(url).pathname.replace(/\/+$/, ''));
  if (res.gone) return { live: false, why: 'not found (removed)' };
  const j = res.j;
  if (!Array.isArray(j) || !j[0] || !j[0].data || !j[0].data.children[0]) throw new Error('unexpected answer from Reddit');
  const po = j[0].data.children[0].data;
  if (kind === 'comment') {
    const c = j[1] && j[1].data.children[0];
    if (!c || c.kind !== 't1') return { live: false, why: 'not found (removed)' };
    const d = c.data;
    return { live: !(GONE.includes(d.body) || d.author === '[deleted]'), why: 'removed or deleted', title: po.title, text: snipOf(d.body), sub: po.subreddit };
  }
  const gone = !!po.removed_by_category || GONE.includes(po.selftext) || po.author === '[deleted]';
  return { live: !gone, why: 'removed or deleted', title: po.title, text: snipOf(po.selftext), sub: po.subreddit };
}
async function lookRetry(url, kind) {
  for (let a = 0; ; a++) {
    try { return await look(url, kind); }
    catch (e) {
      if (e.slow && a < 2) { if (!(await rotate())) await sleep((+process.env.SLOW_WAIT_MS || 20000) * (a + 1)); continue; }
      throw e;
    }
  }
}
// If Reddit will not answer the quick check, do not give up: the page itself is checked after the screenshot instead.
async function lookSoft(url, kind) {
  try { return await lookRetry(url, kind); }
  catch (e) { if (e.net) throw e; log('quick check unavailable (' + String(e.message).slice(0, 80) + '), will verify on the page'); return { unknown: true }; }
}
// Reddit API first for "is it still live?": one request checks the comment and its post. Anything uncertain falls back to the old way.
let apiLiveUntil = 0;
async function apiLive(items) {
  if (process.env.API_CHECK === '0' || Date.now() < apiLiveUntil) return null;
  const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), 45000);
  try {
    const r = await fetch(SB + '/functions/v1/reddit-api', { method: 'POST', signal: ac.signal,
      headers: { 'Content-Type': 'application/json', apikey: SERVICE, ...(SERVICE.startsWith('eyJ') ? { Authorization: 'Bearer ' + SERVICE } : {}) },
      body: JSON.stringify({ op: 'check', items }) });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
    if (!j || j.ok !== true || !Array.isArray(j.results)) { apiLiveUntil = Date.now() + 5 * 60000; return null; }
    return j.results;
  } catch { apiLiveUntil = Date.now() + 5 * 60000; return null; }
  finally { clearTimeout(tm); }
}
async function liveCheck(pair) { // -> { lc, lp, viaApi }
  const a = await apiLive([{ url: pair.comment, kind: 'comment' }, { url: pair.post, kind: 'post' }]);
  const conv = (x, kind) => !x || x.s === 'unknown' ? null : { live: x.s === 'live', why: 'removed or deleted', title: x.title, text: x.snip };
  let lc = a && conv(a[0]), lp = a && conv(a[1]);
  const viaApi = !!(lc && lp);
  if (!lc) { lc = LOCAL ? { unknown: true } : await lookSoft(pair.comment, 'comment'); if (!LOCAL) await sleep(GAP_MS); }
  if (lc.live === false) return { lc, lp: lp || { unknown: true }, viaApi };
  if (!lp) { lp = LOCAL ? { unknown: true } : await lookSoft(pair.post, 'post'); if (!LOCAL) await sleep(GAP_MS); }
  return { lc, lp, viaApi };
}
const GONE_TXT = /\[removed\]|\[deleted\]|removed by (?:the )?moderators?|comment (?:removed|deleted)|this (?:comment|post) (?:was|has been) (?:removed|deleted)|post (?:removed|deleted) by/i;
async function resolveShort(url, keepComment = false) { // /r/Sub/s/xxxx -> the real post link (or comment link)
  const r = await curl(BASE + new URL(url).pathname, { json: false });
  const m = ids(r.url);
  if (!m) throw new Error('short link could not be opened');
  const o = new URL(r.url).origin;
  if (keepComment && commentId(r.url)) return o + new URL(r.url).pathname;
  return o + '/r/' + m.sub + '/comments/' + m.post + '/';
}

async function resolveShortInBrowser(page, url, keepComment = false) { // your own browser follows the short link
  await page.goto(BASE + new URL(url).pathname, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1500);
  const u = page.url(), m = ids(u);
  if (!m) throw new Error('short link could not be opened');
  const o = new URL(u).origin;
  if (keepComment && commentId(u)) return o + new URL(u).pathname;
  return o + '/r/' + m.sub + '/comments/' + m.post + '/';
}

/* ---------------- screenshots ---------------- */
const CLEAN_CSS = `shreddit-comment shreddit-comment,shreddit-comment [slot="children"],.thing.comment .child{display:none!important}
 shreddit-async-loader[bundlename*="xpromo"],[class*="xpromo"],xpromo-bottom-sheet,#onetrust-consent-sdk,#cmp-app-container,faceplate-dialog,shreddit-scrim,.infobar-toaster-container,#eu-cookie-policy,.cookie-infobar{display:none!important}
 body{overflow:auto!important}`;
async function prep(page) {
  await page.addStyleTag({ content: CLEAN_CSS }).catch(() => {});
  await page.evaluate(() => {
    document.querySelectorAll('button').forEach((b) => { const t = (b.innerText || '').trim().toLowerCase(); if (t === 'accept all' || t === 'accept' || t === 'i agree') { try { b.click(); } catch {} } });
  }).catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
}
function highlightFn(el, words) {
  const esc2 = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const list = words.filter(Boolean).sort((a, b) => b.length - a.length).map(esc2);
  if (!list.length) return 0;
  const re = new RegExp('(' + list.join('|') + ')', 'gi'), test = new RegExp('(' + list.join('|') + ')', 'i');
  let n = 0;
  const walk = (root) => {
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (t) => (t.parentElement && !/^(SCRIPT|STYLE|MARK|NOSCRIPT|TEXTAREA)$/.test(t.parentElement.tagName) && test.test(t.nodeValue)) ? 1 : 2 });
    const arr = []; while (tw.nextNode()) arr.push(tw.currentNode);
    arr.forEach((t) => {
      const s = t.nodeValue, f = document.createDocumentFragment(); let last = 0, m; re.lastIndex = 0;
      while ((m = re.exec(s))) {
        f.appendChild(document.createTextNode(s.slice(last, m.index)));
        const k = document.createElement('mark'); k.style.cssText = 'background:#ffeb3b;color:#000;padding:0 1px;border-radius:2px'; k.textContent = m[0]; f.appendChild(k); last = m.index + m[0].length; n++;
        if (m[0].length === 0) re.lastIndex++;
      }
      f.appendChild(document.createTextNode(s.slice(last))); t.parentNode.replaceChild(f, t);
    });
    root.querySelectorAll('*').forEach((e) => { if (e.shadowRoot) walk(e.shadowRoot); });
  };
  walk(el); if (el.shadowRoot) walk(el.shadowRoot);
  return n;
}
const DEBUG_DIR = process.env.DEBUG_DIR || 'debug';
const BLOCKED = /blocked by network security|you['’]ve been blocked|whoa there|verify you are (?:a )?human|are you a human|captcha|too many requests|access denied|log in to continue|sign in to continue|please wait for verification/i;
const LAYOUTS = {
  modern: {
    base: () => BASE,
    post: ['shreddit-post', '[data-testid="post-container"]', 'article'],
    comment: (cid) => [`shreddit-comment[thingid="t1_${cid}"]`, `shreddit-comment[thingid*="${cid}"]`, `shreddit-comment[permalink*="${cid}"]`, 'shreddit-comment'],
  },
  classic: {
    base: () => OLD,
    post: ['#siteTable .thing.link', '.thing.link'],
    comment: (cid) => [`.thing.comment[data-fullname="t1_${cid}"] > .entry`, `.thing.comment[data-fullname="t1_${cid}"]`, '.commentarea .thing.comment > .entry'],
  },
};
async function pick(page, sels, ms) { // wait for any of the selectors, then use the most specific one that exists
  await page.locator(sels.join(',')).first().waitFor({ state: 'attached', timeout: ms });
  for (const sel of sels) if (await page.locator(sel).count()) return page.locator(sel).first();
  throw new Error('nothing matched');
}
async function diag(page, tag) { // what did the browser actually see? kept as short text + a picture saved for you
  const d = { url: page.url(), title: '', text: '' };
  try { d.title = (await page.title()).slice(0, 80); d.text = (await page.evaluate(() => document.body ? document.body.innerText : '')).replace(/\s+/g, ' ').trim().slice(0, 200); } catch {}
  try { fs.mkdirSync(DEBUG_DIR, { recursive: true }); await page.screenshot({ path: DEBUG_DIR + '/' + tag + '.png', timeout: 8000 }); fs.writeFileSync(DEBUG_DIR + '/' + tag + '.txt', d.url + '\n' + d.title + '\n\n' + (await page.content().catch(() => '')).slice(0, 150000)); } catch {}
  return d;
}
async function shoot(page, pair, words, layout, tag) {
  const L = LAYOUTS[layout], cid = commentId(pair.comment);
  const url = toBase(pair.comment, L.base()) + (layout === 'classic' ? '?context=0' : '');
  const go = async () => { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); };
  try { await go(); } catch (e) { log('page was slow, trying once more'); await go(); }
  await page.waitForTimeout(1500);
  if (layout === 'classic') { // 18+ gate on old Reddit
    await page.locator('button[value="yes"], input[value="yes"]').first().click({ timeout: 1500 }).catch(() => {});
  }
  const snap = await page.evaluate(() => (document.title + ' ' + (document.body ? document.body.innerText.slice(0, 400) : ''))).catch(() => '');
  if (BLOCKED.test(snap) && !/shreddit-comment|thing comment/.test(await page.content().catch(() => ''))) {
    const d = await diag(page, tag); const e = new Error('Reddit blocked the browser (' + (d.title || d.text).slice(0, 90) + ')'); e.diag = d; throw e;
  }
  let comEl, postEl;
  try {
    comEl = await pick(page, L.comment(cid), 45000);
    postEl = await pick(page, L.post, 15000);
  } catch (e) { const d = await diag(page, tag); e.diag = d; e.message = 'comment not found on the page; page says: "' + (d.title + ' | ' + d.text).slice(0, 140) + '"'; throw e; }
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await prep(page);
  await page.waitForTimeout(600);
  const hp = await postEl.evaluateHandle((e) => e), hc = await comEl.evaluateHandle((e) => e);
  const nP = await page.evaluate(([e, w, f]) => (new Function('return ' + f))()(e, w), [hp, words, highlightFn.toString()]);
  const nC = await page.evaluate(([e, w, f]) => (new Function('return ' + f))()(e, w), [hc, words, highlightFn.toString()]);
  await page.waitForTimeout(250);
  const postText = await postEl.innerText().catch(() => ''), comText = await comEl.innerText().catch(() => '');
  await page.evaluate(() => (document.fonts && document.fonts.ready) || null).catch(() => {});
  const snapEl = async (el) => { // normal element screenshot; if the browser stalls on it, cut the same area out of a full-page picture
    try { return await el.screenshot({ type: 'png', timeout: 20000 }); }
    catch (e) {
      const bb = await el.boundingBox(); if (!bb) throw e;
      const sy = await page.evaluate(() => window.scrollY), sx = await page.evaluate(() => window.scrollX);
      return await page.screenshot({ type: 'png', fullPage: true, clip: { x: bb.x + sx, y: bb.y + sy, width: Math.min(bb.width, 1400), height: Math.min(bb.height, 6000) }, timeout: 40000 });
    }
  };
  const post = await snapEl(postEl);
  const com = await snapEl(comEl);
  return { post, com, postText, comText, hits: { post: nP, comment: nC } };
}


/* ---------------- typed-up copy: used only when a screenshot is not possible ---------------- */
async function apiCard(postUrl, commentUrl) { // asks the website's reddit-api function (it holds the Reddit API key; this worker never sees it)
  if (process.env.TYPED_COPY === '0') return null;
  const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), 45000);
  try {
    const r = await fetch(SB + '/functions/v1/reddit-api', { method: 'POST', signal: ac.signal,
      headers: { 'Content-Type': 'application/json', apikey: SERVICE, ...(SERVICE.startsWith('eyJ') ? { Authorization: 'Bearer ' + SERVICE } : {}) },
      body: JSON.stringify({ op: 'card', url: postUrl, comment: commentUrl || '' }) });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
    if (!r.ok && !j) { log('typed copy: function answered', r.status, t.slice(0, 120)); return null; }
    if (!j || j.ok === false) { log('typed copy not possible:', (j && (j.message || j.code)) || r.status); return null; }
    return j;
  } catch (e) { log('typed copy not possible:', String(e.message).slice(0, 100)); return null; }
  finally { clearTimeout(tm); }
}
const fmtDate = (sec) => { try { return sec ? new Date(sec * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : ''; } catch { return ''; } };
function hlText(t, words) {
  const e = esc(t); const w = (words || []).filter(Boolean);
  if (!w.length) return { html: e, n: 0 };
  const rx = new RegExp('(' + w.map((x) => esc(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'gi'); let n = 0;
  return { html: e.replace(rx, (m) => { n++; return '<mark>' + m + '</mark>'; }), n };
}
const CARD_CSS = `*{box-sizing:border-box}body{margin:0;background:#fff;font-family:"Segoe UI",Helvetica,Arial,"Liberation Sans",sans-serif;color:#1e2a25}
 #c{width:900px;padding:22px 26px 20px;background:#faf8f4;border:1px solid #e6e2d9;border-left:8px solid #c26a1b;border-radius:14px}
 #c.cm{border-left-color:#2f5d4a;background:#f6f4ef}.tag{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.6px;color:#c26a1b;background:#fbebda;border-radius:999px;padding:3px 10px;margin-bottom:10px}
 .meta{font-size:13px;color:#6b7068;margin-bottom:8px}h1{font-size:23px;line-height:1.25;margin:0 0 10px;color:#14201a}.body{font-size:16px;line-height:1.55;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere}
 .stats{margin-top:14px;font-size:15px;font-weight:700;color:#c26a1b}mark{background:#ffe94d;color:#000;padding:0 1px;border-radius:2px}.note{margin-top:10px;font-size:11.5px;color:#8a8f86}`;
async function renderCard(ctx, html) {
  const pg = await ctx.newPage();
  try { await pg.setViewportSize({ width: 960, height: 800 }).catch(() => {}); await pg.setContent('<!doctype html><html><head><meta charset="utf-8"><style>' + CARD_CSS + '</style></head><body>' + html + '</body></html>', { waitUntil: 'load' });
    return await (await pg.$('#c')).screenshot({ type: 'png', timeout: 20000 }); }
  finally { await pg.close().catch(() => {}); }
}
async function typedShot(ctx, pair, words) { // returns the same shape as shoot(): { post, com, postText, comText, hits }, or null
  const card = await apiCard(pair.post, pair.comment); if (!card) return null;
  const p = card.post || {}, c = card.target;
  if (!c) { log('typed copy: the comment was not found in the first pages of comments'); return null; }
  if (!p.title && !p.selftext) { log('typed copy: the post text was not available'); return null; }
  const when = fmtDate(Math.floor(Date.now() / 1000));
  const pt = hlText(p.selftext || '', words), pti = hlText(p.title || '', words), ct = hlText(c.body || '', words);
  const stat = (a) => a.filter(Boolean).join('  ·  ');
  const postHtml = '<div id="c"><div class="tag">TYPED-UP COPY OF THE POST</div><div class="meta">' + esc(stat(['r/' + (p.subreddit || subOf(pair.post)), p.author ? 'Posted by u/' + p.author : '', fmtDate(p.created_utc)])) + '</div><h1>' + pti.html + '</h1>' + (pt.html ? '<div class="body">' + pt.html + '</div>' : '') +
    '<div class="stats">' + esc(stat([p.score != null && p.score !== '' ? '▲ ' + Number(p.score).toLocaleString('en-US') + ' upvotes' : '', p.num_comments ? Number(p.num_comments).toLocaleString('en-US') + ' comments' : ''])) + '</div><div class="note">Copied from Reddit data on ' + esc(when) + '. Not a screenshot.</div></div>';
  const comHtml = '<div id="c" class="cm"><div class="tag" style="color:#2f5d4a;background:#e3efe9">TYPED-UP COPY OF THE COMMENT</div><div class="meta">' + esc(stat([c.author ? 'u/' + c.author : '', c.top === false ? 'a reply' : '', fmtDate(c.created_utc)])) + '</div><div class="body">' + ct.html + '</div>' +
    '<div class="stats" style="color:#2f5d4a">' + esc(c.score != null ? '▲ ' + c.score + ' point' + (Number(c.score) === 1 ? '' : 's') : '') + '</div><div class="note">Copied from Reddit data on ' + esc(when) + '. Not a screenshot.</div></div>';
  const post = await renderCard(ctx, postHtml), com = await renderCard(ctx, comHtml);
  return { post, com, postText: (p.title || '') + ' ' + (p.selftext || ''), comText: c.body || '', hits: { post: pt.n + pti.n, comment: ct.n }, typed: true };
}

/* ---------------- the PDF ---------------- */
const pngSize = (b64) => { try { const b = Buffer.from(b64.slice(0, 64), 'base64'); return { w: b.readUInt32BE(16) || 1, h: b.readUInt32BE(20) || 1 }; } catch { return { w: 1, h: 1 }; } };
const REPORT_CSS = `
  @page{size:Letter;margin:0}*{box-sizing:border-box}body{margin:0;font-family:Helvetica,Arial,"Liberation Sans",sans-serif;color:#1e2a25}
  .pg{width:8.5in;height:11in;padding:.72in .75in .62in;position:relative;page-break-after:always;overflow:hidden;display:flex;flex-direction:column}
  .topbar{position:absolute;left:0;right:0;top:0;height:6pt;background:#c26a1b}
  .run{display:flex;justify-content:space-between;font-size:7.5pt;letter-spacing:.4px;color:#6b7068;border-bottom:1px solid #e6e2d9;padding-bottom:6pt;margin:-.38in 0 .36in}
  .hero{background:#1e2a25;color:#fff;border-left:.12in solid #c26a1b;border-radius:.16in;padding:.26in .32in .24in;margin:-.28in 0 .3in}
  .kick{color:#c26a1b;font-weight:700;font-size:8.5pt;letter-spacing:.5px}.hero h1{font-size:25pt;margin:.06in 0 .05in;line-height:1.1}.sb{color:#b0bbb5;font-size:10pt;margin:0 0 .12in;padding-bottom:.1in;border-bottom:1px solid #2f3d36}
  .stats{display:flex}.stats div{flex:1;padding-left:.16in;border-left:1px solid #3a4a43;display:flex;flex-direction:column}.stats div:first-child{padding-left:0;border-left:0}
  .stats b{font-size:22pt;line-height:1.1}.stats span{font-size:7.5pt;font-weight:700;letter-spacing:.3px;color:#e4e5e3}
  .eh{display:flex;align-items:center;gap:.16in;margin-bottom:.2in}.num{width:.52in;height:.52in;border-radius:.1in;background:#c26a1b;color:#fff;font-weight:700;font-size:15pt;display:flex;align-items:center;justify-content:center}
  .et{flex:1}.et h2{margin:0;font-size:19pt;line-height:1.1}.rs{font-size:10pt;color:#6b7068;margin-top:2pt}
  .pill{background:#fbebda;border:1px solid #f4d9b8;border-radius:999px;padding:5pt 10pt;font-size:8.5pt;font-weight:700;display:flex;align-items:center;gap:5pt;white-space:nowrap}.pill i{width:6pt;height:6pt;border-radius:50%;background:#c26a1b;display:block}
  .links{background:#faf8f4;border:1px solid #e9e5dc;border-left:.06in solid #2f5d4a;border-radius:.12in;padding:.14in .2in;margin-bottom:.2in}
  .lb{font-size:7.5pt;font-weight:700;letter-spacing:.3px;color:#6b7068;margin-bottom:2pt}.lb.c{margin-top:.1in}.links a{display:block;font-size:8.5pt;color:#1a56d6;word-break:break-all;line-height:1.3}
  .shots{flex:1;min-height:0;display:flex;flex-direction:column;gap:.1in;background:#faf8f4;border:1px solid #e9e5dc;border-left:.06in solid #c26a1b;border-radius:.12in;padding:.14in;margin-bottom:.42in}
  .si{min-height:0;display:flex;align-items:flex-start;justify-content:center}.si img{display:block;max-width:100%;max-height:100%;width:auto;height:auto;border-radius:.05in}
  .ft{position:absolute;left:.75in;right:.75in;bottom:.3in;display:flex;justify-content:space-between;font-size:8pt;color:#6b7068;border-top:1px solid #e6e2d9;padding-top:.08in}
  
  .why{font-size:8.5pt;line-height:1.4;color:#1e2a25}.meta{font-size:8pt;color:#6b7068;margin-top:3pt}`;
function reportHtml(job, items) {
  const kws = String(job.keyword || '').split(',').map((s) => s.trim()).filter(Boolean);
  const brand = (job.brand_name || kws[0] || String(job.title || '').replace(/\s*Reddit.*$/i, '') || 'Reddit').trim();
  const nSub = new Set(items.map((i) => String(i.sub || '').toLowerCase()).filter(Boolean)).size || items.length;
  const inCom = items.filter((i) => i.hits && i.hits.comment > 0).length, inPost = items.filter((i) => i.hits && i.hits.post > 0).length;
  const named = kws.length ? inCom : items.length;
  const pl = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  let sub = 'Named in ' + pl(named, 'comment') + ' across ' + pl(nSub, 'subreddit') + (inPost ? ', and in ' + pl(inPost, 'post') + '.' : '.');
  const total = items.length;
  const pages = items.map((it, i) => {
    const where = it.hits ? (it.hits.post > 0 && it.hits.comment > 0 ? 'Post &amp; Comment' : it.hits.post > 0 ? 'Post' : it.hits.comment > 0 ? 'Comment' : '') : '';
    const sp = pngSize(it.postImg), sc = pngSize(it.comImg);
    const first = i === 0;
    return `<section class="pg${first ? ' p1' : ''}"><div class="topbar"></div>
   ${first ? `<div class="hero"><div class="kick">REDDIT POST REPORT</div><h1>${esc(brand)}</h1><p class="sb">${esc(sub)}</p>
     <div class="stats"><div><b>${items.length}</b><span>TOTAL POSTS</span></div><div><b>${nSub}</b><span>SUBREDDITS</span></div><div><b>${inCom}</b><span>MENTIONS IN COMMENTS</span></div><div><b>${inPost}</b><span>MENTIONS IN POST BODY</span></div></div></div>`
       : `<div class="run"><span>${esc(brand.toUpperCase())}</span><span>REDDIT POST REPORT</span></div>`}
   <div class="eh"><div class="num">${String(i + 1).padStart(2, '0')}</div><div class="et"><h2>POST ${i + 1}</h2><div class="rs">${it.sub ? 'r/' + esc(it.sub) : ''}</div></div>${where ? `<div class="pill"><i></i>Brand mentioned in: ${where}</div>` : ''}</div>
   <div class="links"><div class="lb">POST LINK</div><a href="${esc(it.post)}">${esc(it.post)}</a><div class="lb c">COMMENT LINK</div><a href="${esc(it.comment)}">${esc(it.comment)}</a>${it.typed ? '<div class="lb c">NOTE</div><div class="why">A screenshot of this page was not possible, so the post and the comment are typed up below from Reddit data (same wording, upvotes and comments). They are marked as typed-up copies.</div>' : ''}</div>
   <div class="shots"><div class="si" style="flex:${(sp.h / sp.w).toFixed(3)} 1 0"><img src="data:image/png;base64,${it.postImg}"></div><div class="si" style="flex:${(sc.h / sc.w).toFixed(3)} 1 0"><img src="data:image/png;base64,${it.comImg}"></div></div>
   <div class="ft"><span>${esc(brand)} &bull; Reddit Post Report</span><span>Page ${i + 1} of ${total}</span></div></section>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(job.title)}</title><style>${REPORT_CSS}</style></head><body>${pages}</body></html>`;
}

/* ---------------- Find posts: searches Reddit for live posts that fit a brand, ranks them by keywords (no AI) ---------------- */
const patchFind = (id, o) => sb('/rest/v1/find_jobs?id=eq.' + id, { method: 'PATCH', body: o, headers: { Prefer: 'return=minimal' } });
const reEsc = (t) => t.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
const termRx = (t) => new RegExp('(?<![a-z0-9])' + reEsc(t) + '(?![a-z0-9])', 'i');
const ASKING = /\b(recommend\w*|suggest\w*|looking for|looking to|searching for|where (?:can|do|should|to) (?:i|we)|which (?:one|is|are|should)|best|advice|help|need(?:ed)?|anyone (?:know|tried|used|have|recommend)|has anyone|does anyone|worth it|alternatives?|how (?:do|to|can|should) (?:i|we)|any tips|thoughts|experiences?|reviews?)\b/i;
const NEG_TITLE = /\b(hiring|for hire|we are hiring|sponsored|giveaway|promo code|discount code)\b/i;
function scorePost(p, o) { // o: {topics, brand, exclude, subs, now}
  const title = String(p.title || ''), body = String(p.selftext || '');
  const why = []; let topical = 0, matched = 0, inTitle = 0;
  for (const t of o.topics) {
    const rx = termRx(t), words = t.split(/\s+/).filter((w) => w.length > 2);
    if (rx.test(title)) { topical += inTitle === 0 ? 30 : 10; inTitle++; matched++; why.push('title has "' + t + '"'); }
    else if (words.length > 1 && words.every((w) => termRx(w).test(title))) { topical += inTitle === 0 ? 26 : 9; inTitle++; matched++; why.push('title has the words of "' + t + '"'); }
    else if (rx.test(body)) { topical += matched === 0 ? 12 : 5; matched++; why.push('post text has "' + t + '"'); }
    else if (words.length > 1 && words.every((w) => termRx(w).test(body))) { topical += 8; matched++; why.push('post text has the words of "' + t + '"'); }
  }
  if (!matched) return { score: 0, why: [], brandMentioned: false };
  let s = Math.min(65, topical);
  if (ASKING.test(title)) { s += 14; why.push('asks for help or a recommendation'); } else if (ASKING.test(body.slice(0, 500))) { s += 6; why.push('looks like a question or request'); }
  if (/\?/.test(title)) s += 5;
  const n = +p.num_comments || 0; s += Math.min(8, Math.round(Math.log2(n + 1) * 1.6)); if (n > 200) s -= 5;
  const age = (o.now - p.created_utc) / 86400; if (age <= 2) s += 6; else if (age <= 7) s += 4; else if (age <= 30) s += 2;
  if (o.subs.length && o.subs.some((x) => x.toLowerCase() === String(p.subreddit || '').toLowerCase())) { s += 6; why.push('in a community you chose'); }
  const text = title + ' ' + body;
  const ex = o.exclude.find((t) => termRx(t).test(text)); if (ex) { s -= 40; why.push('mentions "' + ex + '" (word to avoid)'); }
  if (NEG_TITLE.test(title)) s -= 25;
  const brandMentioned = o.brand.some((t) => termRx(t).test(text));
  if (n) why.push(n + ' comment' + (n === 1 ? '' : 's')); else why.push('no comments yet');
  return { score: Math.max(0, Math.min(100, Math.round(s))), why, brandMentioned };
}
async function redditListing(path) { // one search page, with patience when Reddit says slow down
  for (let a = 0; ; a++) {
    const r = await curl(BASE + path);
    if (r.status === 429 || (r.status === 403 && /blocked|too many|rate/i.test(r.body))) {
      if (a < 2) { if (!(await rotate())) await sleep((+process.env.SLOW_WAIT_MS || 20000) * (a + 1)); continue; }
      const e = new Error('HTTP ' + r.status); e.slow = 1; throw e;
    }
    let j = null; try { j = JSON.parse(r.body); } catch {}
    if (!j || !j.data) throw new Error('HTTP ' + r.status + (j ? ' unexpected answer' : ' got a web page instead of search results'));
    return j.data;
  }
}
async function runFind(job) {
  const k = job.keywords || {}, list = (a) => (Array.isArray(a) ? a : []).map((x) => String(x).trim()).filter(Boolean);
  const topics = list(k.topics).slice(0, 15), exclude = list(k.exclude), subs = list(k.subs).map((x) => x.replace(/^\/?r\//i, '')).filter((x) => /^\w+$/.test(x)), brand = list(k.brand);
  const want = Math.max(1, Math.min(200, +job.want || 20));
  const now = Math.floor(Date.now() / 1000);
  const fromTs = Date.parse((job.date_from || '1970-01-01') + 'T00:00:00Z') / 1000, toTs = Date.parse((job.date_to || '2999-01-01') + 'T23:59:59Z') / 1000;
  const ageDays = (now - fromTs) / 86400, T = ageDays <= 1.5 ? 'day' : ageDays <= 8 ? 'week' : ageDays <= 32 ? 'month' : ageDays <= 370 ? 'year' : 'all';
  const windowDays = Math.max(1, (Math.min(toTs, now) - fromTs) / 86400);
  const found = new Map(); let reqs = 0, ok = 0, failed = 0, lastErr = '';
  const bump = (n) => patchFind(job.id, { progress: n }).catch(() => {});
  if (!topics.length) { await patchFind(job.id, { status: 'failed', retry_local: false, note: 'There are no keywords to search for.', finished_at: new Date().toISOString() }); return; }
  const ipt = process.env.SHOW_IP === '1' ? await curl('https://api.ipify.org', { json: false }).catch(() => null) : null; if (ipt) log('exit IP seen by the internet:', ipt.body.trim(), PROXY ? '(through proxy)' : '(NO proxy set)');
  const base = subs.length ? '/r/' + subs.join('+') + '/search.json?restrict_sr=1&' : '/search.json?';
  for (let ti = 0; ti < topics.length; ti++) {
    const t = topics[ti], q = encodeURIComponent(/\s/.test(t) ? '"' + t + '"' : t);
    const plans = [{ sort: 'relevance', pages: 1 }, ...(windowDays <= 31 ? [{ sort: 'new', pages: 2 }] : [])];
    log((ti + 1) + '/' + topics.length, 'searching', t);
    for (const pl of plans) {
      let after = '';
      for (let pg = 0; pg < pl.pages; pg++) {
        if (reqs >= (+process.env.MAX_REQS || 90)) break;
        reqs++;
        try {
          const d = await redditListing(base + 'q=' + q + '&sort=' + pl.sort + '&t=' + T + '&type=link&limit=100&raw_json=1' + (after ? '&after=' + after : ''));
          ok++;
          const kids = d.children || [];
          for (const c of kids) if (c.kind === 't3' && c.data && !found.has(c.data.id)) found.set(c.data.id, c.data);
          const oldest = kids.length ? Math.min(...kids.map((c) => c.data.created_utc || now)) : 0;
          after = d.after || ''; if (!after || !kids.length || (pl.sort === 'new' && oldest < fromTs)) break;
        } catch (e) { failed++; lastErr = String(e.message || e).slice(0, 120); log('search problem:', lastErr); if (e.net) throw e; break; }
        await sleep(GAP_MS);
      }
    }
    bump(ti + 1);
  }
  log('collected', found.size, 'posts from', ok, 'searches,', failed, 'problems');
  const bad = [], res = [];
  for (const p of found.values()) {
    if (p.created_utc < fromTs || p.created_utc > toTs) continue;
    const gone = p.removed_by_category || GONE.includes(String(p.selftext || '').trim()) || p.author === '[deleted]' || p.locked || p.archived || p.over_18 || p.quarantine;
    if (gone) { bad.push(p.id); continue; }
    const sc = scorePost(p, { topics, brand, exclude, subs, now });
    if (sc.score < (+process.env.MIN_SCORE || 25)) continue;
    res.push({ title: String(p.title || '').slice(0, 220), url: 'https://www.reddit.com' + p.permalink, sub: p.subreddit, created: new Date(p.created_utc * 1000).toISOString(), comments: p.num_comments || 0, upvotes: p.score || 0, relevance: sc.score, why: sc.why.slice(0, 4), brand_mentioned: sc.brandMentioned, snippet: String(p.selftext || '').replace(/\s+/g, ' ').trim().slice(0, 220), body: String(p.selftext || '').replace(/\r/g, '').trim().slice(0, 1500), author: p.author || '' });
  }
  res.sort((a, b) => b.relevance - a.relevance || new Date(b.created) - new Date(a.created));
  const top = res.slice(0, want);
  if (!ok) { // nothing could be searched at all
    const esc2 = !LOCAL && process.env.ESCALATE !== '0';
    await patchFind(job.id, { status: 'failed', retry_local: esc2, note: 'Reddit would not answer the search (' + lastErr + ').' + (esc2 ? ' Your computer will try next. It needs the Keep_running window open.' : ' Try again in a few minutes.'), finished_at: new Date().toISOString() });
    return;
  }
  const note = top.length ? (top.length < want ? 'Found ' + top.length + ' fitting posts in this period (you asked for ' + want + '). Try wider dates or more keywords for more.' : null) : 'No live posts fitted these keywords in this period. Try wider dates or more keywords.';
  const rules = {}; // community rules are not collected any more (slow, and Reddit blocks them)
  const doneRow = { status: 'done', retry_local: false, results: top, found: top.length, progress: topics.length, note: (note || '') + (failed ? (note ? ' ' : '') + failed + ' search' + (failed === 1 ? '' : 'es') + ' could not be completed, so some posts may be missing.' : '') || null, finished_at: new Date().toISOString() };
  try { await patchFind(job.id, Object.keys(rules).length ? { ...doneRow, rules } : doneRow); }
  catch (e) { log('saving the community rules failed (is supabase_update_20.sql run?), saving the posts without them:', String(e.message || e).slice(0, 100)); await patchFind(job.id, doneRow); }
  log('find saved:', top.length, 'posts');
}
async function fetchRules(subs) { // the written rules of each community, so they can be added to the downloads
  const out = {}, seen = new Set(), list = [];
  for (const s of subs) { const k = String(s || '').toLowerCase(); if (k && /^\w+$/.test(k) && !seen.has(k)) { seen.add(k); list.push(String(s)); } }
  let n = 0;
  const L = list.slice(0, 30);
  const one = async (s) => {
    try {
      const r = await curl(BASE + '/r/' + s + '/about/rules.json?raw_json=1');
      let j = null; try { j = JSON.parse(r.body); } catch {}
      const arr = j && Array.isArray(j.rules) ? j.rules : [];
      if (arr.length) { out[s.toLowerCase()] = { rules: arr.slice(0, 20).map((x) => ({ n: String(x.short_name || '').slice(0, 120), d: String(x.description || '').replace(/\s+/g, ' ').trim().slice(0, 500) })) }; n++; }
    } catch (e) { log('rules for r/' + s + ' not available:', String(e.message || e).slice(0, 60)); }
  };
  for (let i = 0; i < L.length; i += 4) { await Promise.all(L.slice(i, i + 4).map(one)); await sleep(300); }
  log('community rules collected for', n, 'of', list.length, 'communities');
  return out;
}
async function claimFind() {
  const hdr = { Prefer: 'return=representation' };
  const rows = LOCAL
    ? await sb('/rest/v1/find_jobs?retry_local=eq.true&order=created_at.asc&limit=1').catch(() => [])
    : await (async () => {
      const stale = new Date(Date.now() - 45 * 60000).toISOString(), staleWeb = new Date(Date.now() - 4 * 60000).toISOString();
      await sb('/rest/v1/find_jobs?status=eq.running&started_at=lt.' + stale, { method: 'PATCH', body: { status: 'pending' }, headers: { Prefer: 'return=minimal' } }).catch(() => {});
      // a search that was running in the website's own browser and was left (page closed) is taken over after 4 minutes without a sign of life
      await sb('/rest/v1/find_jobs?status=eq.running&note=like.' + encodeURIComponent('Searching from your browser*') + '&started_at=lt.' + staleWeb, { method: 'PATCH', body: { status: 'pending', progress: 0, note: 'The search in your browser was interrupted, so the background worker took it over.' }, headers: { Prefer: 'return=minimal' } }).catch(() => {});
      return sb('/rest/v1/find_jobs?status=eq.pending&order=created_at.asc&limit=1').catch(() => []);
    })();
  if (!rows || !rows[0]) return null;
  const cond = LOCAL ? '&retry_local=eq.true' : '&status=eq.pending';
  const got = await sb('/rest/v1/find_jobs?id=eq.' + rows[0].id + cond, { method: 'PATCH', body: { status: 'running', retry_local: false, started_at: new Date().toISOString(), progress: 0, note: LOCAL ? 'Your computer is searching.' : null }, headers: hdr });
  return got && got[0] ? got[0] : null;
}


async function claim() {
  const hdr = { Prefer: 'return=representation' };
  if (LOCAL) {
    // Your computer: first the reports GitHub could not finish, then (only if you chose so) brand-new ones.
    let rows = await sb('/rest/v1/report_jobs?retry_local=eq.true&order=created_at.asc&limit=1').catch(() => []);
    if ((!rows || !rows[0]) && process.env.LOCAL_TAKE_NEW === '1') {
      const stale = new Date(Date.now() - 45 * 60000).toISOString();
      await sb('/rest/v1/report_jobs?status=eq.running&started_at=lt.' + stale, { method: 'PATCH', body: { status: 'pending' }, headers: { Prefer: 'return=minimal' } }).catch(() => {});
      rows = await sb('/rest/v1/report_jobs?status=eq.pending&order=created_at.asc&limit=1');
      if (!rows || !rows[0]) return null;
      const got = await sb('/rest/v1/report_jobs?id=eq.' + rows[0].id + '&status=eq.pending', { method: 'PATCH', body: { status: 'running', started_at: new Date().toISOString(), progress: 0, note: 'Your computer is making this report.' }, headers: hdr });
      return got && got[0] ? got[0] : null;
    }
    if (!rows || !rows[0]) return null;
    const got = await sb('/rest/v1/report_jobs?id=eq.' + rows[0].id + '&retry_local=eq.true', { method: 'PATCH', body: { status: 'running', retry_local: false, started_at: new Date().toISOString(), progress: 0, skipped: [], included: 0, note: 'Your computer is making this report.' }, headers: hdr });
    return got && got[0] ? got[0] : null;
  }
  const stale = new Date(Date.now() - 45 * 60000).toISOString();
  await sb('/rest/v1/report_jobs?status=eq.running&started_at=lt.' + stale, { method: 'PATCH', body: { status: 'pending' }, headers: { Prefer: 'return=minimal' } }).catch(() => {});
  const f = ONLY ? '&id=eq.' + ONLY : '';
  const rows = await sb('/rest/v1/report_jobs?status=eq.pending' + f + '&order=created_at.asc&limit=1');
  if (!rows || !rows[0]) return null;
  const got = await sb('/rest/v1/report_jobs?id=eq.' + rows[0].id + '&status=eq.pending', { method: 'PATCH', body: { status: 'running', started_at: new Date().toISOString(), progress: 0, note: null }, headers: hdr });
  return got && got[0] ? got[0] : null;
}

async function runJob(job) {
  if (job.source === 'posts') { // old request from before: post pages are now made in the website itself
    await patchJob(job.id, { status: 'failed', retry_local: false, note: 'Post pages are now typed up inside the website (Reddit work > Find posts > Make post pages). This old request was closed.', finished_at: new Date().toISOString() });
    return;
  }
  const kws = String(job.keyword || '').split(',').map((s) => s.trim()).filter(Boolean);
  const pairs = Array.isArray(job.pairs) ? job.pairs : [];
  const skipped = [], items = [];
  let relay = null, browser = null, ctx = null, ownChild = null, noHit = 0;
  const bump = (n) => patchJob(job.id, { progress: n }).catch(() => {});
  try {
    if (PROXY) { relay = await startRelay(PROXY); log('proxy relay on port', relay.port); }
    try { const r = await curl('https://api.ipify.org', { json: false }); log('exit IP seen by the internet:', r.body.trim(), PROXY ? '(through proxy)' : '(NO proxy set)'); } catch (e) { log('IP test failed:', e.message); }
    if (LOCAL) {
      const exe = findBrowser();
      if (!exe) throw new Error('Brave was not found on this computer. Put its path in settings.env as BROWSER_PATH=...');
      log('using your own browser:', exe);
      const own = await openOwnBrowser({ exe, profile: PROFILE, headless: process.env.HEADLESS === '1' });
      browser = own.browser; ownChild = own.child;
      ctx = browser.contexts()[0] || await browser.newContext();
    } else {
      const largs = ['--disable-blink-features=AutomationControlled', '--disable-background-networking'].concat(relay ? ['--proxy-server=socks5://127.0.0.1:' + relay.port] : []);
      try { browser = await chromium.launch({ channel: 'chromium', args: largs }); } catch (e) { log('using the standard browser build'); browser = await chromium.launch({ args: largs }); }
      ctx = await browser.newContext({ viewport: { width: 1100, height: 1400 }, deviceScaleFactor: 1.6, locale: 'en-US', userAgent: UA_WEB });
    }
    if (COOKIE && !LOCAL) {
      const host = new URL(BASE).hostname.replace(/^www\./, '');
      await ctx.addCookies(COOKIE.split(';').map((c) => c.trim()).filter(Boolean).map((c) => { const i = c.indexOf('='); return { name: c.slice(0, i), value: c.slice(i + 1), domain: host, path: '/' }; })).catch(() => {});
    }
    if (!LOCAL) await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
    const page = await ctx.newPage();
    page.setDefaultNavigationTimeout(60000);
    if (LOCAL) { // sharp screenshots (like a high-resolution screen) without changing how the browser looks to Reddit
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 1400, deviceScaleFactor: 1.6, mobile: false });
    }
    let n = 0;
    for (const raw of pairs) {
      n++;
      const pair = { post: raw.post || '', comment: raw.comment || '', sub: raw.sub || '' };
      const skip = (why, retry = false) => { skipped.push({ post: pair.post, comment: pair.comment, reason: why, ...(retry ? { retry: true } : {}) }); log(n + '/' + pairs.length, 'skipped:', why); bump(n); };
      try {
        if (pair.comment && /\/r\/[^/]+\/s\/[A-Za-z0-9]+/.test(pair.comment)) { // short comment link: find the real one
          try { pair.comment = LOCAL ? await resolveShortInBrowser(page, pair.comment, true) : await resolveShort(pair.comment, true); await sleep(GAP_MS); } catch (e) { skip('Short comment link could not be opened (' + String(e.message).slice(0, 80) + ')', true); continue; }
        }
        if (!pair.comment || !ids(pair.comment) || !commentId(pair.comment)) { skip('Link is not a Reddit comment link'); continue; }
        if (!pair.post || !ids(pair.post)) { try { pair.post = /\/s\//.test(pair.post) ? (LOCAL ? await resolveShortInBrowser(page, pair.post) : await resolveShort(pair.post)) : toBase(pair.comment, 'https://www.reddit.com').replace(/(\/comments\/[a-z0-9]+\/).*/i, '$1'); } catch { pair.post = toBase(pair.comment, 'https://www.reddit.com').replace(/(\/comments\/[a-z0-9]+\/).*/i, '$1'); } }
        const shownPost = raw.post || pair.post;
        log(n + '/' + pairs.length, 'opening', pair.comment.replace(/^https?:\/\/[^/]+/, '').slice(0, 70));
        const { lc, lp } = await liveCheck(pair);
        if (!lc.unknown && !lc.live) { skip('Comment is no longer live (' + lc.why + ')'); continue; }
        if (!lp.unknown && !lp.live) { skip('Post is no longer live (' + lp.why + ')'); continue; }
        let shot = null; const errs = [];
        for (const layout of ['modern']) { // old Reddit is not used: it needs a login and is being phased out
          try { shot = await shoot(page, pair, kws, layout, n + '_' + layout); break; } catch (e) { errs.push(layout + ': ' + String(e.message).split('\n')[0].slice(0, 160)); log(n + '/' + pairs.length, layout, 'layout failed:', String(e.message).split('\n')[0]); }
        }
        if (!shot) { // the screenshot failed: type the post and comment up from the Reddit API instead
          try { shot = await typedShot(ctx, pair, kws); } catch (e) { log(n + '/' + pairs.length, 'typed copy failed:', String(e.message).split('\n')[0]); }
          if (shot) log(n + '/' + pairs.length, 'screenshot not possible, typed-up copy used');
        }
        if (!shot) { skip('Could not capture the page. ' + errs.join(' || ').slice(0, 330), true); continue; }
        if (shot.typed && GONE.includes(String(shot.comText).trim())) { skip('Comment is no longer live (removed or deleted)'); continue; }
        if (lc.unknown && GONE_TXT.test(shot.comText.slice(0, 300))) { skip('Comment is no longer live (checked on the page)'); continue; }
        if (lc.unknown && !shot.comText.trim()) { skip('Could not read the comment on the page (it may still be loading)', true); continue; }
        if (lp.unknown && GONE_TXT.test(shot.postText.slice(0, 300))) { skip('Post is no longer live (checked on the page)'); continue; }
        if (lp.unknown && !shot.postText.trim()) { skip('Could not read the post on the page (it may still be loading)', true); continue; }
        if (kws.length && !shot.hits.comment) noHit++;
        items.push({ post: shownPost, comment: pair.comment, typed: !!shot.typed, sub: pair.sub || lc.sub || subOf(pair.comment), hits: shot.hits, postImg: shot.post.toString('base64'), comImg: shot.com.toString('base64') });
        bump(n); log(n + '/' + pairs.length, 'captured (highlights: post ' + shot.hits.post + ', comment ' + shot.hits.comment + ')');
      } catch (e) {
        if (e.net) { skip('Network or proxy problem: ' + e.message, true); }
        else if (e.slow) { skip('Reddit asked us to slow down. Try this one again later.', true); await sleep(20000); }
        else skip('Could not check on Reddit (' + String(e.message).slice(0, 100) + ')', true);
      }
    }
    const retryable = skipped.filter((x) => x.retry).length, escalate = !LOCAL && retryable > 0 && process.env.ESCALATE !== '0';
    if (!items.length) {
      await patchJob(job.id, { status: 'failed', retry_local: escalate, note: escalate ? 'GitHub could not open these pages (' + retryable + '). Your computer will try next. It needs the Keep_running window open.' : 'None of the ' + pairs.length + ' engagements could be included, so no report was made. See the list below for the reasons.', skipped, included: 0, progress: pairs.length, finished_at: new Date().toISOString() });
      return;
    }
    const html = reportHtml(job, items);
    let pdf;
    if (!LOCAL) {
      const pdfPage = await ctx.newPage();
      await pdfPage.setContent(html, { waitUntil: 'load' });
      pdf = await pdfPage.pdf({ format: 'Letter', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
    } else { // a visible browser cannot print to PDF, so a hidden one does it
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'viko-pdf-'));
      const pb = await openOwnBrowser({ exe: findPdfBrowser(), profile: tmp, headless: true });
      try {
        const pc = pb.browser.contexts()[0] || await pb.browser.newContext();
        const pg = await pc.newPage();
        await pg.setContent(html, { waitUntil: 'load' });
        const cdp = await pc.newCDPSession(pg);
        const r = await cdp.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0 });
        pdf = Buffer.from(r.data, 'base64');
      } finally { await pb.browser.close().catch(() => {}); killTree(pb.child); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
    }
    const objPath = job.id + '/report.pdf';
    await sb('/storage/v1/object/reports/' + objPath, { method: 'POST', raw: true, body: pdf, headers: { 'Content-Type': 'application/pdf', 'x-upsert': 'true' } });
    const nTyped = items.filter((x) => x.typed).length;
    let note = kws.length && noHit ? noHit + ' comment' + (noHit === 1 ? '' : 's') + ' did not show the highlight word on the page.' : null;
    if (escalate) note = 'Partly ready: ' + retryable + (job.source === 'posts' ? ' post' : ' engagement') + (retryable === 1 ? '' : 's') + ' could not be captured on GitHub. Your computer will redo the whole report to include them (needs the Keep_running window open).';
    if (nTyped) note = (note ? note + ' ' : '') + nTyped + ' of ' + items.length + ' could not be screenshotted and were typed up instead (marked in the PDF).';
    await patchJob(job.id, { status: 'done', retry_local: escalate, file_path: objPath, included: items.length, skipped, progress: pairs.length, finished_at: new Date().toISOString(), note });
    log('report saved:', items.length, 'included,', skipped.length, 'skipped,', Math.round(pdf.length / 1024), 'KB');
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (ownChild) killTree(ownChild);
    if (relay) relay.close();
  }
}

async function loginOnly() { // opens your real Brave (no automation at all) with the reports profile so you can log in like normal
  const exe = findBrowser();
  if (!exe) { console.error('Brave was not found. Put its path in settings.env as BROWSER_PATH=...'); process.exit(1); }
  fs.mkdirSync(PROFILE, { recursive: true });
  const child = spawn(exe, ['--user-data-dir=' + PROFILE, '--no-first-run', '--no-default-browser-check', 'https://www.reddit.com/login'], { stdio: 'ignore' });
  log('Brave opened. Log in to Reddit there like normal, then CLOSE the window. Your login is remembered for the reports.');
  await new Promise((r) => child.on('exit', r));
  log('Done. Next, double-click Keep_running.bat');
}
async function testBrowser() { // quick check that the browser starts and Reddit shows you as logged in
  const exe = findBrowser();
  if (!exe) { console.error('Brave was not found. Put its path in settings.env as BROWSER_PATH=...'); return; }
  log('Brave found at', exe, '| profile folder:', PROFILE);
  let own;
  try { own = await openOwnBrowser({ exe, profile: PROFILE, headless: process.env.HEADLESS === '1', url: 'https://www.reddit.com/' }); } catch (e) { console.error('FAILED:', e.message); return; }
  try {
    log('Brave started and answered. Good.');
    const ctx = own.browser.contexts()[0] || await own.browser.newContext();
    const pg = ctx.pages()[0] || await ctx.newPage();
    await pg.goto('https://www.reddit.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);
    const info = await pg.evaluate(() => ({ title: document.title, loggedIn: !!document.querySelector('[id*="expand-user-drawer"], faceplate-tracker[source="user_menu"], #USER_DROPDOWN_ID, [aria-label="Open user menu"], [data-testid="user-drawer-button"]'), text: (document.body ? document.body.innerText : '').slice(0, 120).replace(/\s+/g, ' ') }));
    log('Reddit page title:', info.title);
    log(info.loggedIn ? 'Reddit looks LOGGED IN.' : 'Could not see a logged-in Reddit menu (you may be logged out, or Reddit looks different). First text on the page: ' + info.text);
  } catch (e) { console.error('The browser started but Reddit did not load:', e.message); }
  finally { await own.browser.close().catch(() => {}); killTree(own.child); }
}
async function main() {
  if (process.argv.includes('--login')) { await loginOnly(); return; }
  if (process.argv.includes('--test')) { await testBrowser(); return; }
  if (process.argv.includes('--watch')) { // keep running and check every minute
    log('Watching for reports that GitHub could not finish. Leave this window open (you can minimise it).');
    let idle = 0;
    for (;;) {
      let did = false;
      try { did = await once(); } catch (e) { log('could not reach the database, will try again:', String(e.message).slice(0, 100)); }
      if (did) idle = 0; else if (++idle % 10 === 0) log('still watching, nothing waiting');
      await sleep(60000);
    }
  }
  const any = await once();
  if (!any) log('nothing waiting');
}
async function once() {
  let any = false;
  for (let i = 0; i < 20; i++) { // one run works through every waiting report
    const job = await claim();
    if (!job) break;
    any = true;
    log('making report', job.id, '-', job.title, '-', (job.pairs || []).length, 'engagements');
    try { await runJob(job); }
    catch (e) { console.error(e); await patchJob(job.id, { status: 'failed', retry_local: !LOCAL && process.env.ESCALATE !== '0', note: 'The report stopped: ' + String(e.message || e).slice(0, 200) + (LOCAL ? '' : ' Your computer will try next.'), finished_at: new Date().toISOString() }).catch(() => {}); process.exitCode = 1; }
  }
  for (let i = 0; i < 20; i++) { // then the searches from Find posts
    const fj = await claimFind();
    if (!fj) break;
    any = true;
    log('finding posts', fj.id, '-', fj.brand_name, '-', (fj.keywords && fj.keywords.topics || []).length, 'keywords');
    try { await runFind(fj); }
    catch (e) { console.error(e); await patchFind(fj.id, { status: 'failed', retry_local: !LOCAL && process.env.ESCALATE !== '0', note: 'The search stopped: ' + String(e.message || e).slice(0, 200) + (LOCAL ? '' : ' Your computer will try next.'), finished_at: new Date().toISOString() }).catch(() => {}); process.exitCode = 1; }
  }
  return any;
}
if (process.argv[1] && process.argv[1].endsWith('report.mjs')) main();
