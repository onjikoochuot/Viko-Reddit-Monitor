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
const GAP_MS = +process.env.GAP_MS || 1500;
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

/* ---------------- the PDF ---------------- */
function reportHtml(job, items) {
  const kws = String(job.keyword || '').split(',').map((s) => s.trim()).filter(Boolean);
  const first = (job.brand_name || kws[0] || '').trim();
  let sub = String(job.title || '').trim();
  if (first && sub.toLowerCase().startsWith(first.toLowerCase())) sub = sub.slice(first.length).trim();
  if (!sub) sub = 'Reddit Engagement Report';
  const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const feat = kws.length ? ' featuring ' + kws.join(', ') : '';
  const pages = items.map((it, i) => `
  <section class="pg"><h2>Post ${i + 1} &middot; r/${esc(it.sub)}</h2><div class="rule"></div>
   <p class="lk"><b>Post:</b> <a href="${esc(it.post)}">${esc(it.post)}</a></p><p class="lk"><b>Comment:</b> <a href="${esc(it.comment)}">${esc(it.comment)}</a></p>
   <h3>POST SCREENSHOT</h3><div class="im post"><img src="data:image/png;base64,${it.postImg}"></div>
   <h3>COMMENT / REPLY</h3><div class="im com"><img src="data:image/png;base64,${it.comImg}"></div>
   <div class="ft">${esc(job.title)} &middot; Page ${i + 1}</div></section>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(job.title)}</title><style>
  @page{size:Letter;margin:0}*{box-sizing:border-box}body{margin:0;font-family:Helvetica,Arial,"Liberation Sans",sans-serif;color:#1b1b2f}
  .pg{width:8.5in;height:11in;padding:.6in .55in .5in;position:relative;page-break-after:always;overflow:hidden}
  .cover{padding:0 .6in}.cover .bar{margin-top:3.1in;height:6px;background:#f0405a;border-radius:3px}.cover h1{font-size:30pt;text-align:center;margin:.35in 0 0;letter-spacing:.5px}
  .cover h1.s{margin-top:.08in}.cover .bar2{height:4px;width:2.3in;background:#f0405a;border-radius:2px;margin-top:.3in}
  .cover p{text-align:center;color:#6b7280;font-size:11pt;line-height:1.5;margin:.08in 0}.cover p.n{margin-top:.35in}
  h2{font-size:19pt;margin:0 0 .1in}.rule{height:2px;background:#f0405a;margin-bottom:.14in}.lk{font-size:9pt;margin:.03in 0;word-break:break-all}.lk a{color:#1a56d6;text-decoration:none}
  h3{font-size:10pt;margin:.2in 0 .08in;letter-spacing:.3px}
  .im{display:flex;justify-content:flex-start;align-items:flex-start}.im img{max-width:100%;display:block;object-fit:contain}
  .im.post img{max-height:5.2in}.im.com img{max-height:2.4in}
  .ft{position:absolute;left:0;right:0;bottom:.3in;text-align:center;font-size:8pt;color:#8b8fa3;border-top:1px solid #e5e7eb;margin:0 .55in;padding-top:.08in}
  </style></head><body>
  <section class="pg cover"><div class="bar"></div><h1>${esc(first.toUpperCase())}</h1><h1 class="s">${esc(sub)}</h1><div class="bar2"></div>
   <p class="n">Collection of Reddit posts &amp; comments${esc(feat)}<br>${items.length} engagement${items.length === 1 ? '' : 's'} documented</p>
   <p>Each page contains one post screenshot, the corresponding comment screenshot, and direct links to both.</p><p>Prepared ${esc(date)}</p></section>${pages}</body></html>`;
}

/* ---------------- main ---------------- */
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
        const lc = LOCAL ? { unknown: true } : await lookSoft(pair.comment, 'comment'); if (!LOCAL) await sleep(GAP_MS);
        if (!lc.unknown && !lc.live) { skip('Comment is no longer live (' + lc.why + ')'); continue; }
        const lp = LOCAL ? { unknown: true } : await lookSoft(pair.post, 'post'); if (!LOCAL) await sleep(GAP_MS);
        if (!lp.unknown && !lp.live) { skip('Post is no longer live (' + lp.why + ')'); continue; }
        let shot = null; const errs = [];
        for (const layout of ['modern']) { // old Reddit is not used: it needs a login and is being phased out
          try { shot = await shoot(page, pair, kws, layout, n + '_' + layout); break; } catch (e) { errs.push(layout + ': ' + String(e.message).split('\n')[0].slice(0, 160)); log(n + '/' + pairs.length, layout, 'layout failed:', String(e.message).split('\n')[0]); }
        }
        if (!shot) { skip('Could not capture the page. ' + errs.join(' || ').slice(0, 330), true); continue; }
        if (lc.unknown && GONE_TXT.test(shot.comText.slice(0, 300))) { skip('Comment is no longer live (checked on the page)'); continue; }
        if (lc.unknown && !shot.comText.trim()) { skip('Could not read the comment on the page (it may still be loading)', true); continue; }
        if (lp.unknown && GONE_TXT.test(shot.postText.slice(0, 300))) { skip('Post is no longer live (checked on the page)'); continue; }
        if (lp.unknown && !shot.postText.trim()) { skip('Could not read the post on the page (it may still be loading)', true); continue; }
        if (kws.length && !shot.hits.comment) noHit++;
        items.push({ post: shownPost, comment: pair.comment, sub: pair.sub || lc.sub || subOf(pair.comment), postImg: shot.post.toString('base64'), comImg: shot.com.toString('base64') });
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
    let note = kws.length && noHit ? noHit + ' comment' + (noHit === 1 ? '' : 's') + ' did not show the highlight word on the page.' : null;
    if (escalate) note = 'Partly ready: ' + retryable + ' engagement' + (retryable === 1 ? '' : 's') + ' could not be captured on GitHub. Your computer will redo the whole report to include them (needs the Keep_running window open).';
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
  if (!any) log('no report waiting');
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
  return any;
}
if (process.argv[1] && process.argv[1].endsWith('report.mjs')) main();
