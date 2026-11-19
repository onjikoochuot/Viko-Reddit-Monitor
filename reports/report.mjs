// Supabase Edge Function: reddit-api
// Lets the Reddit Monitor page search Reddit through AnyAPI without ever showing the key to the browser.
// The key lives ONLY in the Supabase secret named ANYAPI_KEY. It is never written in this file.
// Turn "Verify JWT" OFF for this function: it checks every caller itself (signed-in team member, worker key or checker key).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const BASE = 'https://api.getanyapi.com/v1/run/'
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const out = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

// ---------- AnyAPI call ----------
// AnyAPI says: send ONLY the fields an API declares. So the function first reads the field list of each API (GET /v1/apis/{sku}),
// renames my fields to the declared names, and drops any that are not declared. If a call is still refused, it is retried with
// only the main field (query or url). A wrong shape costs nothing.
const API_INFO = 'https://api.getanyapi.com/v1/apis/'
const ALIAS: Record<string, string[]> = {
  query: ['query', 'q', 'keyword', 'keywords', 'search', 'searchquery', 'search_query', 'term', 'text'],
  sort: ['sort', 'sortby', 'sort_by', 'order', 'orderby', 'order_by'],
  timeframe: ['timeframe', 'time', 't', 'period', 'timerange', 'time_range', 'timefilter', 'time_filter', 'date_range'],
  cursor: ['cursor', 'after', 'pagetoken', 'page_token', 'nextcursor', 'next_cursor', 'next', 'page'],
  url: ['url', 'posturl', 'post_url', 'link', 'permalink', 'postlink', 'post_link'],
}
type Info = { props: Record<string, any>; required: string[] } | null
const infoCache: Record<string, { at: number; info: Info }> = {}
async function infoOf(sku: string, key: string): Promise<Info> {
  const c = infoCache[sku]
  if (c && Date.now() - c.at < (c.info ? 6 * 3600e3 : 10 * 60e3)) return c.info
  let info: Info = null
  try {
    const r = await fetch(API_INFO + sku, { headers: { Authorization: 'Bearer ' + key } })
    const j: any = await r.json().catch(() => null)
    const root = j && (j.api || j.data || j)
    const sc = root && (root.inputSchema || root.input_schema || (root.schema && (root.schema.input || root.schema.inputSchema)) || root.input)
    const props = sc && (sc.properties || (sc.schema && sc.schema.properties))
    if (r.ok && isObj(props)) info = { props, required: Array.isArray(sc.required) ? sc.required : [] }
  } catch { /* offline: the plain names are used */ }
  infoCache[sku] = { at: Date.now(), info }
  return info
}
function enumFit(spec: any, v: any): any {
  const en = spec && (Array.isArray(spec.enum) ? spec.enum : null)
  if (!en) return v
  if (en.includes(v)) return v
  const lv = String(v).toLowerCase()
  const hit = en.find((e: any) => String(e).toLowerCase() === lv) ?? en.find((e: any) => String(e).toLowerCase().includes(lv)) ?? en.find((e: any) => lv.includes(String(e).toLowerCase()))
  return hit === undefined ? undefined : hit
}
function fit(info: Info, input: Record<string, unknown>): Record<string, unknown> {
  if (!info) return input
  const names = Object.keys(info.props), low = (n: string) => n.toLowerCase().replace(/[\s-]/g, '')
  const outp: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(input)) {
    if (v == null || v === '') continue
    const al = ALIAS[k] || [k]
    let name = names.find((n) => low(n) === k) || names.find((n) => al.includes(low(n)))
    if (!name && (k === 'query' || k === 'url')) { const req = info.required.filter((n) => !outp[n]); if (req.length === 1) name = req[0] }
    if (!name) continue // not declared: not sent
    const fv = enumFit(info.props[name], v)
    if (fv !== undefined) outp[name] = fv
  }
  return outp
}
let shape: 'flat' | 'input' | '' = ''
async function post(sku: string, input: Record<string, unknown>, key: string) {
  const tries: ('flat' | 'input')[] = shape ? [shape] : ['flat', 'input']
  let last: { status: number; json: any; text: string } = { status: 0, json: null, text: '' }
  for (const t of tries) {
    const r = await fetch(BASE + sku, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(t === 'flat' ? input : { input }),
    })
    const text = await r.text()
    let json: any = null
    try { json = JSON.parse(text) } catch { /* not json */ }
    last = { status: r.status, json, text }
    if (r.ok) { shape = t; return last }
    if (r.status === 401 || r.status === 402 || r.status === 429 || r.status >= 500) return last
    // 4xx that looks like a wrong body shape: try the other one
  }
  return last
}
async function run(sku: string, input: Record<string, unknown>, key: string) {
  const info = await infoOf(sku, key)
  const sent = fit(info, input)
  let r = await post(sku, sent, key)
  const refused = (x: { status: number }) => x.status >= 400 && x.status < 500 && ![401, 402, 403, 429].includes(x.status)
  if (refused(r)) { // still refused: try again with only the main field
    const main: Record<string, unknown> = {}
    if (input.query != null) main.query = input.query
    else if (input.url != null) main.url = input.url
    const m = fit(info, main)
    if (Object.keys(m).length && JSON.stringify(m) !== JSON.stringify(sent)) { const r2 = await post(sku, m, key); if (!refused(r2)) r = r2; else r = { ...r2, text: r.text || r2.text } }
  }
  if (!(r.status >= 200 && r.status < 300)) console.error('AnyAPI', sku, r.status, 'sent', JSON.stringify(info ? fit(info, input) : input).slice(0, 200), 'got', r.text.slice(0, 300))
  return r
}

// ---------- reading whatever shape the reply has ----------
const isObj = (x: any) => x && typeof x === 'object' && !Array.isArray(x)
function findArray(root: any, want: (o: any) => boolean, keys: string[]): any[] {
  const seen = new Set<any>()
  const walk = (n: any, d: number): any[] | null => {
    if (!n || typeof n !== 'object' || seen.has(n) || d > 5) return null
    seen.add(n)
    if (Array.isArray(n)) {
      if (n.length && n.some((x) => isObj(x) && want(x))) return n
      for (const x of n) { const r = walk(x, d + 1); if (r) return r }
      return null
    }
    for (const k of keys) if (k in n) { const r = walk(n[k], d + 1); if (r) return r }
    for (const k of Object.keys(n)) { const r = walk(n[k], d + 1); if (r) return r }
    return null
  }
  return walk(root, 0) || []
}
const pick = (o: any, ks: string[]) => { for (const k of ks) if (o && o[k] != null && o[k] !== '') return o[k]; return undefined }
const str = (v: any) => (v == null ? '' : String(v))
const secs = (v: any): number => {
  if (v == null || v === '') return 0
  if (typeof v === 'number') return v > 1e11 ? Math.floor(v / 1000) : Math.floor(v)
  const n = Number(v); if (!isNaN(n)) return secs(n)
  const t = Date.parse(String(v)); return isNaN(t) ? 0 : Math.floor(t / 1000)
}
const bool = (v: any) => v === true || v === 'true' || v === 1
function nextOf(j: any): string {
  const o = j && (j.output ?? j)
  const cands = [o, o && o.data, j]
  for (const c of cands) {
    if (!isObj(c)) continue
    const v = pick(c, ['nextCursor', 'next_cursor', 'cursor', 'after', 'next'])
    if (typeof v === 'string' && v) return v
    if (isObj(c.pagination) || isObj(c.page)) {
      const p = c.pagination || c.page
      const w = pick(p, ['nextCursor', 'next_cursor', 'cursor', 'after', 'next'])
      if (typeof w === 'string' && w) return w
    }
  }
  return ''
}
function normPost(p: any) {
  const permalink = str(pick(p, ['permalink', 'postUrl', 'url', 'link', 'postLink']))
  const full = /^https?:/i.test(permalink) ? permalink : permalink ? 'https://www.reddit.com' + permalink : ''
  const rel = full.replace(/^https?:\/\/(www\.|old\.|new\.)?reddit\.com/i, '')
  let id = str(pick(p, ['id', 'postId', 'post_id', 'name'])).replace(/^t3_/, '')
  if (!id) { const m = rel.match(/\/comments\/(\w+)/); if (m) id = m[1] }
  const sub = str(pick(p, ['subreddit', 'subredditName', 'subreddit_name', 'sub', 'community'])).replace(/^\/?r\//i, '')
  const sub2 = sub || (rel.match(/^\/r\/(\w+)/i) || [])[1] || ''
  return {
    id,
    title: str(pick(p, ['title', 'postTitle', 'name_'])),
    selftext: str(pick(p, ['selftext', 'selfText', 'text', 'body', 'content', 'postText'])),
    subreddit: sub2,
    permalink: rel.startsWith('/') ? rel : full ? rel : '',
    created_utc: secs(pick(p, ['created_utc', 'createdUtc', 'created', 'createdAt', 'postedAt', 'date', 'timestamp'])),
    num_comments: Number(pick(p, ['num_comments', 'numComments', 'commentCount', 'comments', 'commentsCount'])) || 0,
    score: Number(pick(p, ['score', 'upvotes', 'ups', 'points'])) || 0,
    author: str(pick(p, ['author', 'authorName', 'username', 'user'])),
    over_18: bool(pick(p, ['over_18', 'over18', 'isNsfw', 'nsfw', 'isOver18'])),
    locked: bool(pick(p, ['locked', 'isLocked'])),
    archived: bool(pick(p, ['archived', 'isArchived'])),
    removed_by_category: str(pick(p, ['removed_by_category', 'removedByCategory'])) || null,
    quarantine: bool(pick(p, ['quarantine', 'isQuarantined'])),
    removed: bool(pick(p, ['removed', 'isRemoved', 'is_removed'])),
  }
}
function normComment(c: any) {
  const parent = str(pick(c, ['parentId', 'parent_id', 'parent']))
  const depth = pick(c, ['depth', 'level'])
  return {
    id: str(pick(c, ['id', 'commentId', 'name'])).replace(/^t1_/, ''),
    body: str(pick(c, ['body', 'text', 'content', 'selftext'])),
    author: str(pick(c, ['author', 'authorName', 'username', 'user'])),
    score: Number(pick(c, ['score', 'upvotes', 'ups', 'points'])) || 0,
    parent,
    top: (depth != null ? Number(depth) === 0 : false) || !parent || /^t3_/.test(parent),
    created_utc: secs(pick(c, ['created_utc', 'createdUtc', 'created', 'createdAt', 'postedAt'])),
  }
}
function postObj(j: any): any {
  const o = j && j.output, d = o && o.data
  const c = [d && d.post, o && o.post, j && j.post, d, o, j].find((x) => isObj(x) && postLike(x))
  if (c) return c
  const a = findArray(j, postLike, ['post', 'posts'])
  return a.length ? a[0] : null
}
const postLike = (o: any) => !!pick(o, ['title', 'postTitle']) && !!pick(o, ['permalink', 'url', 'link', 'postUrl', 'id', 'postId'])
const commentLike = (o: any) => !!pick(o, ['body', 'text', 'content']) && !pick(o, ['title'])


let CSKU = '' // the comment-search name that worked
let CSKU_NO = 0 // when none worked (asked again after 6 hours)
// ---------- who is calling ----------
const svcCache = new Map<string, boolean>()
async function isService(token: string): Promise<boolean> { // the Supabase service key (any format): only it can read the locked app_secret table
  if (!token) return false
  if (token === (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '')) return true
  if (svcCache.has(token)) return svcCache.get(token)!
  let ok = false
  try {
    const r = await fetch(Deno.env.get('SUPABASE_URL') + '/rest/v1/app_secret?select=k&limit=1', {
      headers: { apikey: token, ...(token.startsWith('eyJ') ? { Authorization: 'Bearer ' + token } : {}) },
    })
    const j = r.ok ? await r.json() : null
    ok = Array.isArray(j) && j.length > 0
  } catch { /* not a service key */ }
  svcCache.set(token, ok)
  return ok
}
async function checkerOk(k: string): Promise<boolean> { // the same checker key the GitHub checker and the browser checker already use
  if (!k) return false
  try {
    const svc = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const r = await svc.from('app_secret').select('v').eq('k', 'checker').single()
    return !r.error && !!r.data && r.data.v === k
  } catch { return false }
}

// ---------- live or deleted ----------
const GONE_ = ['[removed]', '[deleted]']
async function call(sku: string, input: Record<string, unknown>, key: string, acc: { cost: number; log?: string[] }): Promise<any | null> {
  const r = await run(sku, input, key)
  if (r.status === 402) { const e: any = new Error('The Reddit API wallet is empty.'); e.code = 'no_credit'; throw e }
  if (r.status === 401 || r.status === 403) { const e: any = new Error('AnyAPI did not accept the saved key.'); e.code = 'bad_key'; throw e }
  if (r.status < 200 || r.status >= 300) { if (acc.log) acc.log.push(sku.replace('reddit.', '') + ' HTTP ' + r.status + ' ' + String(r.text || '').replace(/\s+/g, ' ').slice(0, 80)); return null }
  const j = r.json || {}
  acc.cost += Number(j.costUsd ?? j.cost ?? (j.output && j.output.costUsd)) || 0
  return j
}
// every comment anywhere in the answer, replies included (a reply under another comment is found too)
function allComments(j: any): any[] {
  const out: any[] = [], ids = new Set<string>(), seen = new Set<any>()
  const walk = (n: any, d: number) => {
    if (!n || typeof n !== 'object' || seen.has(n) || d > 40) return
    seen.add(n)
    if (Array.isArray(n)) { for (const x of n) walk(x, d + 1); return }
    if (commentLike(n)) {
      const c = normComment(n)
      if (c.body && !(c.id && ids.has(c.id))) { if (c.id) ids.add(c.id); out.push(c) }
    }
    for (const k of Object.keys(n)) if (n[k] && typeof n[k] === 'object') walk(n[k], d + 1)
  }
  walk(j, 0)
  return out
}
// the same words? (a team member may fix a typo or the formatting when posting)
const normT = (t: string) => String(t || '').toLowerCase().replace(/https?:\/\/\S+/g, ' ').replace(/&amp;/g, '&').replace(/[^a-z0-9]+/g, ' ').trim()
function sameText(saved: string, onReddit: string): boolean {
  const x = normT(saved), y = normT(onReddit)
  if (!x || !y || x.length < 12 || y.length < 12) return x === y && !!x
  if (x === y) return true
  const n = Math.min(60, x.length, y.length)
  if (n >= 25 && (y.includes(x.slice(0, n)) || x.includes(y.slice(0, n)))) return true
  const wa = new Set(x.split(' ').filter((w) => w.length > 2)), wb = y.split(' ').filter((w) => w.length > 2)
  if (wa.size < 6 || !wb.length) return false
  const hit = new Set(wb.filter((w) => wa.has(w))).size
  return hit / Math.max(wa.size, new Set(wb).size) >= 0.7
}
async function commentsOf(url: string, key: string, acc: { cost: number }, maxPages: number, want = '', body = '') {
  const all: any[] = []; let post: any = null, cursor = '', done = false
  const hit = () => all.find((c) => (want && c.id === want) || (body && sameText(body, c.body)))
  for (let pg = 0; pg < maxPages; pg++) {
    const input: Record<string, unknown> = { url }
    if (cursor) input.cursor = cursor
    const j = await call('reddit.post_comments', input, key, acc)
    if (!j) break
    const have = new Set(all.map((c) => c.id)), got = allComments(j)
    got.forEach((c) => { if (!c.id || !have.has(c.id)) all.push(c) })
    if ((acc as any).log) (acc as any).log.push('comments ' + (url.match(/\/comments\/\w+\/(.*)$/) || [, ''])[1].slice(0, 30) + ' page ' + (pg + 1) + ': ' + got.length + (nextOf(j) ? ' +more' : '') + (postObj(j) ? '' : ' (no post info)') + (got.length ? '' : ' keys ' + Object.keys((j && (j.output || j)) || {}).slice(0, 6).join(',')))
    if (!post) { const po = postObj(j); post = po ? normPost(po) : null }
    cursor = nextOf(j)
    if (!cursor) { done = true; break }
    if ((want || body) && hit()) break
  }
  return { comments: all, post, done, hit: hit() || null }
}
// Read a post's comments deeply: at least the first 120, and up to 500 when the post has more than 120.
// The API gives about 25 at a time and its "next page" often adds very few, so when paging stalls it also asks
// for the comments in other orders (top, new, old, controversial...) and puts everything together.
async function readDeep(url: string, key: string, acc: { cost: number; log?: string[] }, n: number, want = '', body = '', until = Date.now() + 80000) {
  const target = n > 120 ? Math.min(500, n) : 120
  const all: any[] = [], ids = new Set<string>(); let post: any = null, done = false, req = 0
  const hit = () => all.find((c) => (want && c.id === want) || (body && sameText(body, c.body))) || null
  let firstIds = ''
  const sig = (j: any) => allComments(j).slice(0, 10).map((c: any) => c.id).join(',')
  const add = (j: any) => { let k = 0; allComments(j).forEach((c: any) => { const id = c.id || ('x' + all.length); if (!ids.has(id)) { ids.add(id); all.push(c); k++ } }); if (!post) { const po = postObj(j); if (po) post = normPost(po) } return k }
  const enough = () => !!hit() || all.length >= target || (n > 0 && all.length >= n) || Date.now() > until
  // 1) page by page
  let cursor = '', stall = 0
  for (let pg = 0; pg < 24 && !enough(); pg++) {
    const input: Record<string, unknown> = { url }; if (cursor) input.cursor = cursor
    const j = await call('reddit.post_comments', input, key, acc); req++
    if (!j) break
    if (pg === 0) firstIds = sig(j)
    const k = add(j); cursor = nextOf(j)
    if (!cursor) { done = true; break }
    stall = k < 3 ? stall + 1 : 0
    if (stall >= 3) break
  }
  // 2) paging stalled before the end: ask in other orders too
  const orders: string[] = []
  if (!done && !enough()) {
    let ignored = 0
    for (const sort of ['top', 'new', 'old', 'controversial', 'qa', 'best']) {
      if (enough() || req >= 45) break
      let cur = '', same = false, added = 0, dry = 0
      for (let pg = 0; pg < 12 && !enough() && req < 45; pg++) {
        const input: Record<string, unknown> = { url, sort }; if (cur) input.cursor = cur
        const j = await call('reddit.post_comments', input, key, acc); req++
        if (!j) break
        if (pg === 0 && firstIds && sig(j) === firstIds) { same = true; break } // the same answer as without an order
        const k = add(j); added += k; cur = nextOf(j)
        dry = k ? 0 : dry + 1
        if (!cur || dry >= 2) break
      }
      if (added) orders.push(sort)
      if (same) { if (++ignored >= 2) break } else ignored = 0 // the API ignores the order: stop asking
    }
  }
  if (acc.log) acc.log.push('read ' + all.length + (n ? ' of ' + n : '') + ' comments in ' + req + ' requests' + (orders.length ? ' (also sorted by ' + orders.join(', ') + ')' : '') + (done ? ', reached the end' : ''))
  return { comments: all, post, done: done || (n > 0 && all.length >= n * 0.95), hit: hit(), read: all.length, target }
}
// Reddit "share" links (reddit.com/r/name/s/AbC123, redd.it/abc) hide the real link. Follow them to the full link first.
const isShare = (u: string) => /reddit\.com\/(?:r|u|user)\/[\w-]+\/s\/\w+|redd\.it\/\w+|reddit\.app\.link\//i.test(u)
async function resolveShare(url: string): Promise<string> {
  if (!isShare(url)) return ''
  const full = (u: string) => /reddit\.com\/r\/\w+\/comments\/\w+/i.test(u) ? u.split(/[?#]/)[0].replace(/^http:/i, 'https:').replace(/\/\/(old|new|np|m)\.reddit/i, '//www.reddit').replace(/\/?$/, '/') : ''
  // Reddit refuses many servers, but it answers the programs that make link previews (chat apps and social sites). Try a few.
  const agents = [
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
    'Twitterbot/1.0',
    'WhatsApp/2.23.20.0',
    'TelegramBot (like TwitterBot)',
    'Discordbot/2.0 (+https://discordapp.com)',
  ]
  const tries = [url, url.replace(/\/\/(www\.)?reddit\.com/i, '//old.reddit.com'), url.replace(/\/\/(www\.)?reddit\.com/i, '//m.reddit.com')]
  const until = Date.now() + 25000 // never spend more than 25 seconds here
  for (const start of [...new Set(tries)]) for (const ua of agents) {
    if (Date.now() > until) return ''
    try {
      let u = start
      for (let i = 0; i < 4; i++) {
        const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), 8000)
        const r = await fetch(u, { redirect: 'manual', signal: ac.signal, headers: { 'User-Agent': ua, Accept: 'text/html,*/*' } }).finally(() => clearTimeout(tm))
        const loc = r.headers.get('location')
        if (loc) { try { await r.body?.cancel() } catch { /* ignore */ } u = new URL(loc, u).toString(); const f = full(u); if (f) return f; continue }
        if (r.ok) { // no redirect: the page itself names its real address
          const html = (await r.text()).slice(0, 300000)
          const m = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i) || html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i) || html.match(/https:\/\/www\.reddit\.com\/r\/\w+\/comments\/\w+\/[^"'\s<>\\]*/i)
          const f = m ? full((m[1] || m[0]).replace(/&amp;/g, '&')) : ''
          if (f) return f
        } else { try { await r.body?.cancel() } catch { /* ignore */ } }
        break
      }
    } catch { /* try the next one */ }
  }
  return ''
}
// What the website knows about a link: the words that were posted and the post it went under.
async function hintFor(url: string, given: any): Promise<{ post: string; body: string }> {
  const h = { post: str(given && given.post).trim(), body: str(given && given.body) }
  if (h.post && h.body) return h
  try {
    const svc = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const u = url.replace(/\/+$/, '')
    const r = await svc.from('pieces').select('body, url, tasks(thread)').in('url', [u, u + '/']).limit(1)
    const p: any = r.data && r.data[0]
    if (p) { if (!h.body) h.body = str(p.body); if (!h.post) h.post = str(p.tasks && p.tasks.thread) }
  } catch { /* nothing known */ }
  return h
}
const postBase = (u: string) => { const m = u.match(/reddit\.com\/r\/(\w+)\/comments\/(\w+)/i); return m ? 'https://www.reddit.com/r/' + m[1] + '/comments/' + m[2] + '/' : '' }
async function postOfShare(url: string, key: string, acc: { cost: number }): Promise<string> { // a share link to a post -> the full post link
  if (!url) return ''
  if (!isShare(url)) return postBase(url)
  const f = await resolveShare(url)
  if (f) return postBase(f)
  try { // let the Reddit API open the share link itself
    const pj = await call('reddit.post', { url }, key, acc)
    const po = pj && postObj(pj)
    const pl = po ? String(normPost(po).permalink || '') : ''
    if (postBase('https://www.reddit.com' + pl)) return postBase('https://www.reddit.com' + pl)
    const g = await commentsOf(url, key, acc, 1)
    const pl2 = g.post && String(g.post.permalink || '')
    if (pl2 && postBase('https://www.reddit.com' + pl2)) return postBase('https://www.reddit.com' + pl2)
  } catch (e) { if ((e as any).code) throw e }
  return ''
}
const snip = (t: string) => { t = String(t || '').replace(/\s+/g, ' ').trim(); return !t || GONE_.includes(t) ? null : t.slice(0, 300) }
// Is this comment still there? Looked up by its id, or (for share links) by its words under the right post.
async function commentState(postUrl: string, cid: string, body: string, key: string, acc: { cost: number; log?: string[] }, saved = '') {
  const log: string[] = []; const prev = acc.log; acc.log = log
  try {
    let g: any = null, c: any = null
    if (cid) { // the comment's own page first: one cheap request, in the link forms Reddit uses
      const forms = [...new Set([saved && /\/comments\/\w+\/[^/]*\/\w+/.test(saved) ? saved.split(/[?#]/)[0].replace(/\/?$/, '/') : '', postUrl + '_/' + cid + '/', postUrl + 'comment/' + cid + '/'].filter(Boolean))]
      for (const f of forms) {
        g = await commentsOf(f, key, acc, 1, cid)
        c = g.comments.find((x: any) => x.id === cid) || null
        if (c || g.comments.length) break
      }
    }
    let full: any = null, post = g && g.post
    if (!c && (!post || !post.title)) { // how many comments the post has decides how deep to read
      const pj = await call('reddit.post', { url: postUrl }, key, acc)
      const po = pj && postObj(pj)
      if (po) post = normPost(po)
    }
    if (!c) { // then read the post's comments deeply (120, or up to 500 on a busy post), replies included
      full = await readDeep(postUrl, key, acc, post && Number(post.num_comments) || 0, cid, cid ? '' : body)
      c = full.hit
      if (!post || !post.title) post = full.post
    }
    if (c) {
      const gone = GONE_.includes(String(c.body).trim()) || c.author === '[deleted]'
      return { found: true, r: { s: gone ? 'removed' : 'live', score: c.score, replies: null, title: (post && post.title) || null, snip: gone ? null : snip(c.body), via: 'api' }, id: c.id }
    }
    const info = ' [' + log.join('; ').slice(0, 240) + ']'
    const n = post && Number(post.num_comments) || 0
    const read = full ? full.comments.length : 0, aim = full ? full.target : 0
    if (!post || !post.title) return { found: false, r: { s: 'unknown', why: 'the post could not be opened by the API' + info } }
    const postGone = !!(post.removed_by_category || post.removed)
    // Reddit's comment count also counts comments that were removed or deleted and are no longer shown,
    // so a full list (no "more" left) is usually a bit shorter than the count. Small or moderate gaps = the full public list.
    // Read to the end, or read the 120 / 500 it aims for: the comment would have been among them.
    const complete = !!(full && read > 0 && ((full.done && (!n || read >= n * 0.6 || n - read <= 20)) || read >= aim || (n && read >= n * 0.85)))
    if (complete || (postGone && full && full.done)) return { found: false, r: { s: 'unknown', why: 'the comment was not in the API answer' + info } }
    return { found: false, r: { s: 'unknown', why: 'the post has ' + n + ' comments and the API gave ' + read + ' even after asking in several ways, so this one could not be confirmed' + info } }
  } finally { acc.log = prev }
}
async function checkOne(url: string, kind: string, key: string, acc: { cost: number }, item: any = {}): Promise<any> {
  url = String(url || '').trim().replace(/^http:/i, 'https:')
  const m = url.match(/^https?:\/\/(?:www\.|old\.|new\.|np\.|m\.)?reddit\.com\/r\/(\w+)\/comments\/(\w+)(?:\/[^/?#]*)?(?:\/(\w+))?/i)
  if (!m) {
    if (!isShare(url)) return { s: 'unknown', why: 'not a post or comment link' }
    const full = await resolveShare(url)
    const fm = full && full.match(/\/comments\/\w+(?:\/[^/?#]*)?\/(\w+)/)
    if (full && (kind !== 'comment' || fm)) { const r = await checkOne(full, kind, key, acc); return { ...r, resolved: full } }
    if (kind !== 'comment') {
      const pu = await postOfShare(url, key, acc)
      if (pu) { const r = await checkOne(pu, kind, key, acc); return { ...r, resolved: pu } }
      return { s: 'unknown', why: 'a share link that could not be opened' }
    }
    // A comment share link Reddit would not open: find the comment by its words under its post.
    const h = await hintFor(url, item)
    const pu = (full && postBase(full)) || await postOfShare(h.post, key, acc)
    if (!pu || !h.body) return { s: 'unknown', why: 'a share link that could not be opened' + (!h.body ? ' (the comment text is not saved, so it could not be looked up)' : ' (the post of this task is not known)') }
    const st = await commentState(pu, '', h.body, key, acc)
    if (st.found) { const res = pu + 'comment/' + st.id + '/'; return { ...st.r, resolved: res, via: 'api (found by its words)' } }
    return st.r
  }
  const postUrl = 'https://www.reddit.com/r/' + m[1] + '/comments/' + m[2] + '/'
  if (kind === 'comment') {
    let cid = m[3] && m[3].toLowerCase() !== 'comment' ? m[3] : ''
    if (!cid) { const m2 = url.match(/\/comments\/\w+\/comment\/(\w+)/i); if (m2) cid = m2[1] }
    if (!cid) { // a post link saved for a comment: look for the comment's words under it
      const h = await hintFor(url, item)
      if (!h.body) return { s: 'unknown', why: 'no comment id in the link' }
      const st = await commentState(postUrl, '', h.body, key, acc)
      return st.found ? { ...st.r, resolved: postUrl + 'comment/' + st.id + '/' } : st.r
    }
    return (await commentState(postUrl, cid, '', key, acc, url)).r
  }
  let post: any = null
  const pj = await call('reddit.post', { url: postUrl }, key, acc)
  if (pj) { const po = postObj(pj); post = po ? normPost(po) : null }
  if (!post || !post.title) { post = (await commentsOf(postUrl, key, acc, 1)).post }
  if (!post || !post.title) return { s: 'unknown', why: 'the post was not in the API answer' }
  const gone = !!post.removed_by_category || post.removed || GONE_.includes(String(post.selftext).trim()) || post.author === '[deleted]'
  return { s: gone ? 'removed' : 'live', score: post.score, replies: post.num_comments, title: post.title, snip: gone ? null : snip(post.selftext), via: 'api' }
}

// true when the reply is simply "nothing found" (an empty list, or found:false), not a reply in an unknown form
function emptyList(j: any): boolean {
  const o = j && (j.output ?? j)
  if (isObj(o) && (o.found === false || o.count === 0 || o.total === 0)) return true
  let hit = false
  const walk = (n: any, d: number) => { if (hit || !n || typeof n !== 'object' || d > 4) return; if (Array.isArray(n)) { if (!n.length) hit = true; return } for (const k of Object.keys(n)) walk(n[k], d + 1) }
  walk(o, 0)
  return hit
}

// ---------- the function ----------
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const key = Deno.env.get('ANYAPI_KEY') || ''
    let b: any = {}
    try { b = await req.json() } catch { /* empty */ }
    const op = String(b.op || '')
    // who is calling: a signed-in team member (the website), the report worker (service key), or a checker (checker key, only to check links)
    const auth = req.headers.get('Authorization') || ''
    const token = auth.replace(/^Bearer\s+/i, '')
    let who = ''
    let memberDb: any = null
    if (await isService(token)) who = 'worker'
    else if (op === 'check' && (await checkerOk(req.headers.get('x-checker-key') || ''))) who = 'checker'
    // A shared work link (no sign-in): the same checks, only for the work of that one brand.
    let openBrand = ''
    if (!who && b.tok && ['checksave', 'linkkind'].includes(op)) {
      try {
        const svcT = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
        const br = await svcT.from('brands').select('id, access, status').eq('open_token', String(b.tok).slice(0, 200)).maybeSingle()
        if (br.data && br.data.access === 'open' && br.data.status === 'live') { openBrand = String(br.data.id); who = 'open' }
      } catch { /* not a valid link */ }
      if (!who) return out({ ok: false, code: 'not_allowed', message: 'This work link is not valid any more.' }, 403)
    }
    if (!who) {
      const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } } })
      const u = await sb.auth.getUser()
      if (u.error || !u.data.user) return out({ ok: false, code: 'not_signed_in', message: 'Sign in again, then retry.' }, 401)
      const st = await sb.rpc('is_staff')
      if (!st.error && st.data === true) who = 'staff'
      else {
        // Team members (role "member") may check links with the Reddit API exactly like the admin does,
        // but only work they can see themselves. Searching (which spends more credit) stays for admins and managers.
        const svc0 = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
        let pr: any = { data: null }
        try { pr = await svc0.from('profiles').select('role, status').eq('id', u.data.user.id).maybeSingle() } catch { /* not allowed */ }
        const okMember = !!(pr.data && pr.data.status === 'active' && ['member', 'manager', 'supermanager', 'admin'].includes(String(pr.data.role)))
        if (!okMember || !['check', 'checksave', 'linkkind', 'ping'].includes(op)) return out({ ok: false, code: 'not_allowed', message: 'Only team members can use the Reddit API.' }, 403)
        who = 'member'
        memberDb = sb
      }
    }

    if (op === 'ping') return out({ ok: true, key_set: !!key })
    if (!key) return out({ ok: false, code: 'no_key', message: 'The Reddit API key is not saved in Supabase yet (secret ANYAPI_KEY).' })

    if (op === 'search') {
      const q = String(b.query || '').slice(0, 480).trim()
      if (!q) return out({ ok: false, code: 'bad', message: 'Nothing to search for.' }, 400)
      const input: Record<string, unknown> = { query: q, sort: ['relevance', 'new', 'top', 'hot'].includes(b.sort) ? b.sort : 'relevance' }
      if (['hour', 'day', 'week', 'month', 'year', 'all'].includes(b.timeframe)) input.timeframe = b.timeframe
      if (b.cursor) input.cursor = String(b.cursor).slice(0, 400)
      const dropped = ''
      const r = await run('reddit.search', input, key)
      if (r.status === 402) return out({ ok: false, code: 'no_credit', message: 'The Reddit API wallet is empty. Add credit at getanyapi.com.' })
      if (r.status === 401 || r.status === 403) return out({ ok: false, code: 'bad_key', message: 'AnyAPI did not accept the saved key. Check the ANYAPI_KEY secret.' })
      if (r.status === 429) return out({ ok: false, code: 'busy', message: 'The Reddit API is busy. Try again in a minute.' })
      if (r.status < 200 || r.status >= 300) return out({ ok: false, code: 'upstream', status: r.status, message: 'The Reddit API said: ' + r.text.slice(0, 220) })
      const j = r.json || {}
      const arr = findArray(j, postLike, ['posts', 'results', 'items', 'data', 'output'])
      const posts = arr.filter(isObj).map(normPost).filter((p) => p.id && p.title)
      const cost = Number(j.costUsd ?? j.cost ?? (j.output && j.output.costUsd)) || 0
      const res: Record<string, unknown> = { ok: true, posts, next: nextOf(j), cost, dropped }
      if (!posts.length && !emptyList(j)) res.shape = JSON.stringify(j).slice(0, 700) // only when the reply is not simply an empty list
      return out(res)
    }

    if (op === 'read') { // Reddit search page: one post in full with its comments (replies included)
      const url = String(b.url || '').trim().replace(/^http:/i, 'https:')
      if (!/^https:\/\/(www\.|old\.|new\.)?reddit\.com\/r\/\w+\/comments\/\w+/i.test(url)) return out({ ok: false, code: 'bad', message: 'That is not a Reddit post link.' }, 400)
      const pages = Math.max(1, Math.min(6, Number(b.pages) || 3))
      const acc = { cost: 0 }
      try {
        const pu = postBase(url) || url
        let post: any = null
        { const pj = await call('reddit.post', { url: pu }, key, acc); const po = pj && postObj(pj); if (po) post = normPost(po) }
        const n = post && Number(post.num_comments) || 0
        const g = b.deep ? await readDeep(pu, key, acc, n, '', '', Date.now() + 90000) : await commentsOf(pu, key, acc, pages)
        if ((!post || !post.title) && g.post) post = g.post
        return out({ ok: true, post: post || null, comments: g.comments, more: !g.done && !(n && g.comments.length >= n * 0.9), total: n, cost: acc.cost })
      } catch (e) { const c = (e as any).code; return out({ ok: false, code: c || 'error', message: (e as Error).message }) }
    }

    if (op === 'csearch') { // Brand mentions: search Reddit COMMENTS directly, if the API offers it (tried once, then remembered)
      const q = String(b.query || '').slice(0, 300).trim()
      if (!q) return out({ ok: false, code: 'bad', message: 'Nothing to search for.' }, 400)
      const input: Record<string, unknown> = { query: q, sort: 'new' }
      if (['hour', 'day', 'week', 'month', 'year', 'all'].includes(b.timeframe)) input.timeframe = b.timeframe
      if (b.cursor) input.cursor = String(b.cursor).slice(0, 400)
      if (!CSKU && CSKU_NO > Date.now() - 6 * 3600e3) return out({ ok: true, unsupported: true, comments: [] })
      const skus = CSKU ? [CSKU] : ['reddit.search_comments', 'reddit.comment_search', 'reddit.comments_search']
      for (const sku of skus) {
        const r = await run(sku, input, key)
        if (r.status === 402) return out({ ok: false, code: 'no_credit', message: 'The Reddit API wallet is empty. Add credit at getanyapi.com.' })
        if (r.status === 401 || r.status === 403) return out({ ok: false, code: 'bad_key', message: 'AnyAPI did not accept the saved key.' })
        if (r.status < 200 || r.status >= 300) continue
        const j = r.json || {}
        CSKU = sku
        const comments = allComments(j).map((c: any) => c)
        // keep where each comment lives, when the answer says it
        const raw = findArray(j, commentLike, ['comments', 'results', 'items', 'data', 'output']).filter(isObj)
        const where: Record<string, any> = {}
        raw.forEach((x: any) => { const id = str(pick(x, ['id', 'commentId', 'name'])).replace(/^t1_/, ''); if (id) where[id] = { permalink: str(pick(x, ['permalink', 'url', 'link', 'commentUrl'])), sub: str(pick(x, ['subreddit', 'subredditName', 'community'])).replace(/^\/?r\//i, ''), post_title: str(pick(x, ['postTitle', 'post_title', 'linkTitle', 'link_title', 'submissionTitle'])), post_url: str(pick(x, ['postUrl', 'post_url', 'linkUrl', 'link_permalink', 'link_url'])) } })
        return out({ ok: true, comments: comments.map((c: any) => ({ ...c, ...(where[c.id] || {}) })), next: nextOf(j), cost: Number(j.costUsd ?? j.cost ?? (j.output && j.output.costUsd)) || 0, sku })
      }
      CSKU_NO = Date.now()
      return out({ ok: true, unsupported: true, comments: [] })
    }

    if (op === 'diag') { // shows what AnyAPI says about its fields and one tiny test search (about 0.04 cent)
      const lines: string[] = []
      for (const sku of ['reddit.search', 'reddit.post_comments', 'reddit.post']) {
        const info = await infoOf(sku, key)
        lines.push(sku + ': ' + (info ? 'fields ' + Object.keys(info.props).join(', ') + (info.required.length ? ' (needs ' + info.required.join(', ') + ')' : '') : 'field list not available (plain names are used)'))
      }
      const r = await run('reddit.search', { query: 'shopify', sort: 'relevance' }, key)
      const j = r.json || {}
      const posts = findArray(j, postLike, ['posts', 'results', 'items', 'data', 'output']).filter(isObj).map(normPost).filter((p) => p.id && p.title)
      lines.push('test search: HTTP ' + r.status + ', ' + posts.length + ' posts read' + (posts[0] ? ' (first: ' + String(posts[0].title).slice(0, 60) + ')' : ''))
      if (!posts.length) lines.push('reply: ' + r.text.slice(0, 500))
      const count = async (q: string) => { const x = await run('reddit.search', { query: q, sort: 'relevance' }, key); const ps = findArray(x.json || {}, postLike, ['posts', 'results', 'items', 'data', 'output']).filter(isObj).map(normPost).filter((p) => p.id && p.title); return { st: x.status, ps } }
      const a = await count('("shopify seo" OR "shopify apps")')
      lines.push('groups with OR: HTTP ' + a.st + ', ' + a.ps.length + ' posts')
      const c = await count('seo subreddit:shopify')
      const inSub = c.ps.filter((p) => String(p.subreddit).toLowerCase() === 'shopify').length
      lines.push('only one community: HTTP ' + c.st + ', ' + c.ps.length + ' posts, ' + inSub + ' of them in r/shopify')
      return out({ ok: true, text: lines.join('\n') })
    }

    if (op === 'check') { // live or deleted for up to 20 links at once. "unknown" means: ask Reddit the old way instead
      const items = Array.isArray(b.items) ? b.items.slice(0, 20) : []
      const acc = { cost: 0 }
      const results: any[] = new Array(items.length)
      let fatal: { code: string; message: string } | null = null, idx = 0
      const t0 = Date.now()
      const wk = async () => {
        while (!fatal) {
          const i = idx++
          if (i >= items.length) return
          if (Date.now() - t0 > 100000) { results[i] = { s: 'unknown', why: 'not checked this time (busy), it is tried again soon' }; continue }
          try { results[i] = await checkOne(String((items[i] && items[i].url) || ''), items[i] && items[i].kind === 'comment' ? 'comment' : 'post', key, acc, items[i] || {}) }
          catch (e) {
            const c = (e as any).code
            if (c === 'no_credit' || c === 'bad_key') { fatal = { code: c, message: (e as Error).message }; return }
            results[i] = { s: 'unknown', why: String((e as Error).message || e).slice(0, 100) }
          }
        }
      }
      await Promise.all([wk(), wk(), wk()])
      if (fatal) return out({ ok: false, code: (fatal as any).code, message: (fatal as any).message })
      return out({ ok: true, results: results.map((r) => r || { s: 'unknown', why: 'not checked' }), cost: acc.cost })
    }

    if (op === 'linkkind') { // before "Done": is this link a post or a comment? (short links are opened or looked up by their words)
      const pid = String(b.pid || ''), raw = String(b.url || '').trim().replace(/^http:/i, 'https:')
      if (!/^[0-9a-f-]{36}$/i.test(pid) || !raw) return out({ ok: false, code: 'bad', message: 'Nothing to check.' }, 400)
      const svc = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
      if (memberDb) { const vis = await memberDb.from('pieces').select('id').in('id', [pid]); if (!((vis.data || []) as any[]).length) return out({ ok: false, code: 'not_allowed', message: 'This work is not on your page.' }, 403) }
      const got = await svc.from('pieces').select('kind, body, ptitle, brand_id, tasks(thread)').in('id', [pid])
      const p: any = got.data && got.data[0]
      if (!p || (openBrand && String(p.brand_id) !== openBrand)) return out({ ok: false, code: 'bad', message: 'That task was not found.' }, 400)
      const want = p.kind === 'comment' ? 'comment' : 'post'
      const kindOf = (u: string) => /reddit\.com\/r\/[^/]+\/comments\/[a-z0-9]+\/[^/?#]*\/[a-z0-9]+/i.test(u) ? 'comment' : /reddit\.com\/r\/[^/]+\/comments\/[a-z0-9]+/i.test(u) ? 'post' : ''
      const direct = kindOf(raw)
      if (direct) return out({ ok: true, kind: direct, want, full: null })
      if (!isShare(raw)) return out({ ok: true, kind: 'bad', want, full: null })
      const acc = { cost: 0 }
      const full = await resolveShare(raw)
      if (full && (kindOf(full) === 'comment' || want === 'post')) return out({ ok: true, kind: kindOf(full), want, full, cost: acc.cost })
      try {
        if (want === 'comment') { // Reddit would not open it (or gave only the post): find the comment by its words under the task's post
          const pu = (full && postBase(full)) || await postOfShare(str(p.tasks && p.tasks.thread), key, acc)
          if (pu && p.body) {
            const st = await commentState(pu, '', str(p.body), key, acc)
            if (st.found) return out({ ok: true, kind: 'comment', want, full: pu + 'comment/' + st.id + '/', cost: acc.cost })
          }
          return out({ ok: true, kind: full ? 'post' : 'unknown', want, full: null, cost: acc.cost })
        }
        const pu = await postOfShare(raw, key, acc)
        if (pu) return out({ ok: true, kind: 'post', want, full: pu, cost: acc.cost })
      } catch (e) { const c = (e as any).code; if (c === 'no_credit' || c === 'bad_key') return out({ ok: false, code: c, message: (e as Error).message }) }
      return out({ ok: true, kind: 'unknown', want, full: null, cost: acc.cost })
    }

    if (op === 'checksave') { // check saved work by its id and save the answer at once (team members' "Check again", the same way for everyone)
      const pids = (Array.isArray(b.pids) ? b.pids : []).map((x: any) => String(x)).filter((x: string) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 10)
      if (!pids.length) return out({ ok: false, code: 'bad', message: 'Nothing to check.' }, 400)
      const svc = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
      let allowed = pids
      if (memberDb) { // a team member: only the work they can see on their own page
        const vis = await memberDb.from('pieces').select('id').in('id', pids)
        allowed = ((vis.data || []) as any[]).map((x) => String(x.id))
        if (!allowed.length) return out({ ok: false, code: 'not_allowed', message: 'This work is not on your page.' }, 403)
      }
      const got = await svc.from('pieces').select('*, tasks(thread)').in('id', allowed)
      if (got.error) return out({ ok: false, code: 'error', message: got.error.message })
      if (openBrand) got.data = ((got.data || []) as any[]).filter((x) => String(x.brand_id) === openBrand)
      const acc = { cost: 0 }, OFF = [1, 30, 60, 480], DAY = 864e5, results: any[] = []
      const goneRun = (h: any[]) => { let n = 0; for (let i = h.length - 1; i >= 0 && h[i].s === 'removed'; i--) n++; return n }
      const t0 = Date.now()
      for (const p of (got.data || []) as any[]) {
        if (!p.url || p.status === 'todo') { results.push({ id: p.id, s: 'skipped' }); continue }
        if (Date.now() - t0 > 95000) { results.push({ id: p.id, s: 'unknown', why: 'not checked this time (busy), it is tried again soon' }); continue }
        let r: any
        try { r = await checkOne(String(p.url), p.kind === 'comment' ? 'comment' : 'post', key, acc, { post: p.tasks && p.tasks.thread, body: p.body }) }
        catch (e) { const c = (e as any).code; if (c === 'no_credit' || c === 'bad_key') return out({ ok: false, code: c, message: (e as Error).message }); r = { s: 'unknown', why: String((e as Error).message || e).slice(0, 100) } }
        const now = Date.now(), hist = Array.isArray(p.hist) ? p.hist : []
        let s = r.s
        if (s === 'unknown' && /not in the API answer/.test(String(r.why || ''))) s = 'removed' // the whole post was read and it is not there
        let upd: Record<string, unknown>
        if (s === 'live' || s === 'removed') {
          const stage = (p.stage || 0) + 1, pub = new Date(p.published_at || now).getTime()
          upd = {
            status: s, stage, hist: [...hist, { t: now, s, m: 'api' }].slice(-400),
            score: r.score ?? p.score, replies: r.replies ?? p.replies, title: r.title || p.title,
            ...(r.snip ? { snip: r.snip } : {}), ...(r.resolved ? { url: r.resolved } : {}),
            last_check: new Date(now).toISOString(),
            next_check: s === 'removed' ? (goneRun(hist) >= 3 ? null : new Date(now + DAY).toISOString()) : new Date(stage < OFF.length ? pub + OFF[stage] * 60000 : now + DAY).toISOString(),
          }
        } else {
          upd = { hist: [...hist, { t: now, s: 'error', m: 'api: ' + String(r.why || '').slice(0, 300) }].slice(-400), last_check: new Date(now).toISOString(), next_check: new Date(now + 10 * 60000).toISOString() }
        }
        let w = await svc.from('pieces').update(upd).eq('id', p.id)
        if (w.error && 'snip' in upd) { delete upd.snip; w = await svc.from('pieces').update(upd).eq('id', p.id) }
        results.push({ id: p.id, s, why: s === 'live' || s === 'removed' ? '' : r.why, resolved: r.resolved || null })
      }
      return out({ ok: true, results, cost: acc.cost })
    }

    if (op === 'comments' || op === 'card') {
      const url = String(b.url || '').trim()
      if (!/^https:\/\/(www\.|old\.)?reddit\.com\/r\/\w+\/comments\/\w+/i.test(url)) return out({ ok: false, code: 'bad', message: 'That is not a Reddit post link.' }, 400)
      const want = op === 'card' ? ((String(b.comment || '').match(/\/comments\/\w+\/[^/]*\/(\w+)/) || [])[1] || '') : ''
      let cursor = String(b.cursor || '').slice(0, 400), cost = 0, post: any = null, shape = ''
      const all: any[] = []
      const maxPages = op === 'card' ? 3 : 1
      for (let pg = 0; pg < maxPages; pg++) {
        const input: Record<string, unknown> = { url: url.slice(0, 400) }
        if (cursor) input.cursor = cursor
        const r = await run('reddit.post_comments', input, key)
        if (r.status === 402) return out({ ok: false, code: 'no_credit', message: 'The Reddit API wallet is empty. Add credit at getanyapi.com.' })
        if (r.status === 401 || r.status === 403) return out({ ok: false, code: 'bad_key', message: 'AnyAPI did not accept the saved key. Check the ANYAPI_KEY secret.' })
        if (r.status === 429) return out({ ok: false, code: 'busy', message: 'The Reddit API is busy. Try again in a minute.' })
        if (r.status < 200 || r.status >= 300) return out({ ok: false, code: 'upstream', status: r.status, message: 'The Reddit API said: ' + r.text.slice(0, 220) })
        const j = r.json || {}
        cost += Number(j.costUsd ?? j.cost ?? (j.output && j.output.costUsd)) || 0
        const got = op === 'card' ? allComments(j) : findArray(j, commentLike, ['comments', 'results', 'items', 'data', 'output']).filter(isObj).map(normComment).filter((c) => c.body)
        got.forEach((c) => all.push(c))
        if (!post) {
          const po = postObj(j)
          post = po ? normPost(po) : null
        }
        if (!got.length && pg === 0) shape = JSON.stringify(j).slice(0, 700)
        cursor = nextOf(j)
        if (!cursor || !want || all.some((c) => c.id === want)) break
      }
      const res: Record<string, unknown> = { ok: true, comments: all, post, next: cursor, cost }
      if (op === 'card') {
        // the post itself, if the comments reply did not carry it (a wrong guess costs nothing)
        if (!post || !post.title) {
          try {
            const pr = await run('reddit.post', { url: url.slice(0, 400) }, key)
            if (pr.status >= 200 && pr.status < 300 && pr.json) {
              const one = postObj(pr.json)
              if (one) { post = normPost(one); res.post = post }
              cost += Number(pr.json.costUsd ?? pr.json.cost ?? (pr.json.output && pr.json.output.costUsd)) || 0
              res.cost = cost
            }
          } catch { /* optional */ }
        }
        res.target = want ? all.find((c) => c.id === want) || null : null
      }
      if (!all.length) res.shape = shape
      return out(res)
    }

    return out({ ok: false, code: 'bad', message: 'Unknown request.' }, 400)
  } catch (e) {
    return out({ ok: false, code: 'error', message: String((e as Error).message || e).slice(0, 200) }, 500)
  }
})
