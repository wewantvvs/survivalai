'use strict';
// Survival AI - zero-dependency Node 18+ server. See README.md.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const E = process.env, PORT = +E.PORT || 3000, DIR = E.DATA_DIR || path.join(__dirname, 'data');
const BASE = E.BASE_URL || `http://localhost:${PORT}`;
if (!E.ADMIN_PASSWORD || E.ADMIN_PASSWORD.length < 12) { console.error('Set ADMIN_PASSWORD (12+ chars).'); process.exit(1); }
fs.mkdirSync(DIR, { recursive: true });
const LF = path.join(DIR, 'ledger.jsonl'), MF = path.join(DIR, 'memory.json'), SF = path.join(DIR, 'state.json');
const rd = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const wr = (f, o) => { fs.writeFileSync(f + '.tmp', JSON.stringify(o)); fs.renameSync(f + '.tmp', f); };
const id = () => crypto.randomBytes(6).toString('hex');
const ledger = fs.existsSync(LF) ? fs.readFileSync(LF, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
let mem = rd(MF, []), st = rd(SF, { running: false, proposals: [], withdrawals: [] });
const save = () => { wr(MF, mem); wr(SF, st); };

// ---- Ledger: append-only, integer cents (AUD). Balance is always derived. ----
const CREDIT = { deposit: 1, revenue: 1 };
function add(type, cents, ref, note) {
  if (!Number.isInteger(cents) || cents <= 0) throw Error('bad amount');
  if (ref && ledger.some(e => e.ref === ref)) return null; // idempotent (webhook retries)
  const e = { id: id(), ts: Date.now(), type, cents, ref: ref || null, note: note || '' };
  fs.appendFileSync(LF, JSON.stringify(e) + '\n'); ledger.push(e); return e;
}
const sum = t => ledger.filter(e => e.type === t).reduce((s, e) => s + e.cents, 0);
const bal = () => ledger.reduce((s, e) => s + (CREDIT[e.type] ? e.cents : -e.cents), 0);
const reserved = () => st.withdrawals.filter(w => w.status === 'pending').reduce((s, w) => s + w.cents, 0);
const spentToday = () => ledger.filter(e => e.type === 'expense' && e.ts > Date.now() - 864e5).reduce((s, e) => s + e.cents, 0);

// ---- Stripe via REST (real money moves only through Stripe) ----
const live = (E.STRIPE_SECRET_KEY || '').startsWith('sk_live');
async function stripe(p, body, key) {
  if (!E.STRIPE_SECRET_KEY) throw Error('STRIPE_SECRET_KEY not set');
  const r = await fetch('https://api.stripe.com/v1/' + p, { method: 'POST', body: new URLSearchParams(body),
    headers: { Authorization: 'Bearer ' + E.STRIPE_SECRET_KEY, 'Idempotency-Key': key || id() } });
  const j = await r.json(); if (!r.ok) throw Error(j.error?.message || 'Stripe ' + r.status); return j;
}
function verifyStripe(raw, header) {
  if (!E.STRIPE_WEBHOOK_SECRET || !header) return false;
  const p = Object.fromEntries(header.split(',').map(s => s.split('=')));
  if (!p.t || Math.abs(Date.now() / 1e3 - +p.t) > 300) return false;
  const want = crypto.createHmac('sha256', E.STRIPE_WEBHOOK_SECRET).update(p.t + '.' + raw).digest('hex');
  const a = Buffer.from(want), b = Buffer.from(p.v1 || '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- Agent: real Claude calls; its real API cost is booked as an expense ----
const tools = [
  { name: 'remember', description: 'Save a durable fact or lesson to long-term memory.', input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'propose', description: 'Propose an action for the human owner to approve and carry out. You cannot spend or move money yourself.', input_schema: { type: 'object', properties: { title: { type: 'string' }, detail: { type: 'string' }, est_cost_aud: { type: 'number' } }, required: ['title', 'detail'] } }];
function agentReady() {
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'PRICE_IN_USD_PER_MTOK', 'PRICE_OUT_USD_PER_MTOK', 'USD_TO_AUD']) if (!E[k]) return 'Missing env ' + k;
  return null;
}
let busy = false;
async function agentStep() {
  if (busy || !st.running) return; busy = true;
  try {
    const cap = Math.round(+(E.DAILY_CAP_AUD || 5) * 100);
    if (bal() <= 0) { st.running = false; save(); return; }           // survival rule
    if (spentToday() >= cap || bal() < 1) return;                       // hard daily cap
    const ctx = { balance_aud: bal() / 100, spent_last_24h_aud: spentToday() / 100, daily_cap_aud: cap / 100,
      memory: mem.slice(-40).map(m => m.text), recent_ledger: ledger.slice(-10), proposals: st.proposals.slice(-10).map(p => ({ title: p.title, status: p.status })) };
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST',
      headers: { 'x-api-key': E.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: E.ANTHROPIC_MODEL, max_tokens: 800, tools,
        system: 'You are Survival AI, an agent that must earn more than it costs to keep running. Each run costs real money from your balance. Use remember for lessons; use propose for concrete, legal, honest income ideas the human can execute. Do not repeat earlier proposals. Be brief.',
        messages: [{ role: 'user', content: JSON.stringify(ctx) }] }) });
    const j = await r.json(); if (!r.ok) throw Error(j.error?.message || 'Anthropic ' + r.status);
    for (const b of j.content || []) if (b.type === 'tool_use') {
      if (b.name === 'remember' && b.input.text) mem.push({ id: id(), ts: Date.now(), text: String(b.input.text).slice(0, 500), src: 'agent' });
      if (b.name === 'propose' && b.input.title) st.proposals.push({ id: id(), ts: Date.now(), title: String(b.input.title).slice(0, 120), detail: String(b.input.detail || '').slice(0, 800), est: +b.input.est_cost_aud || 0, status: 'pending' });
    }
    mem = mem.slice(-200); st.proposals = st.proposals.slice(-100);
    const usd = (j.usage.input_tokens * +E.PRICE_IN_USD_PER_MTOK + j.usage.output_tokens * +E.PRICE_OUT_USD_PER_MTOK) / 1e6;
    const c = Math.max(1, Math.ceil(usd * +E.USD_TO_AUD * 100));
    add('expense', Math.min(c, Math.max(bal(), 1)), 'run-' + id(), `Claude run (${j.usage.input_tokens} in / ${j.usage.output_tokens} out)`);
    if (bal() <= 0) st.running = false; save();
  } catch (e) { console.error('agent:', e.message); add('expense', 1, 'err-' + id(), 'Agent error: ' + e.message.slice(0, 80)); }
  finally { busy = false; }
}
setInterval(agentStep, Math.max(1, +(E.AGENT_INTERVAL_MIN || 30)) * 6e4);

// ---- HTTP ----
const sessions = new Set(); let fails = 0, lockUntil = 0;
const send = (res, code, o, h = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff', ...h }); res.end(JSON.stringify(o)); };
const body = req => new Promise((ok, no) => { let b = '', n = 0; req.on('data', c => { n += c.length; if (n > 1e5) { no(Error('big')); req.destroy(); } else b += c; }); req.on('end', () => ok(b)); });
const authed = req => sessions.has(((req.headers.cookie || '').match(/sid=([a-f0-9]+)/) || [])[1]);
const view = () => ({ balance: bal(), available: bal() - reserved(), revenue: sum('revenue'), expenses: sum('expense'), deposits: sum('deposit'), withdrawn: sum('withdrawal'),
  running: st.running, stripe: E.STRIPE_SECRET_KEY ? (live ? 'LIVE' : 'TEST') : 'OFF', agentIssue: agentReady(), dailyCap: +(E.DAILY_CAP_AUD || 5) * 100, spentToday: spentToday(),
  ledger: ledger.slice(-25).reverse(), proposals: st.proposals.slice(-20).reverse(), withdrawals: st.withdrawals.slice(-10).reverse(), memory: mem.slice().reverse() });

http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, BASE), m = req.method, p = u.pathname;
    if (m === 'GET' && (p === '/' || p === '/index.html')) { res.writeHead(200, { 'Content-Type': 'text/html', 'X-Frame-Options': 'DENY' }); return res.end(fs.readFileSync(path.join(__dirname, 'public/index.html'))); }
    if (m === 'POST' && p === '/webhook/stripe') {
      const raw = await body(req);
      if (!verifyStripe(raw, req.headers['stripe-signature'])) return send(res, 400, { error: 'bad signature' });
      const ev = JSON.parse(raw), s = ev.data?.object;
      if (ev.type === 'checkout.session.completed' && s.payment_status === 'paid' && s.currency === 'aud')
        add(s.metadata?.kind === 'revenue' ? 'revenue' : 'deposit', s.amount_total, s.id, 'Stripe checkout');
      return send(res, 200, { ok: 1 });
    }
    if (!p.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    if (m === 'POST' && p === '/api/login') {
      if (Date.now() < lockUntil) return send(res, 429, { error: 'locked, try later' });
      const { password = '' } = JSON.parse((await body(req)) || '{}');
      const a = crypto.createHash('sha256').update(password).digest(), b = crypto.createHash('sha256').update(E.ADMIN_PASSWORD).digest();
      if (!crypto.timingSafeEqual(a, b)) { if (++fails >= 5) { lockUntil = Date.now() + 9e5; fails = 0; } return send(res, 401, { error: 'wrong password' }); }
      fails = 0; const sid = crypto.randomBytes(24).toString('hex'); sessions.add(sid);
      return send(res, 200, { ok: 1 }, { 'Set-Cookie': `sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${BASE.startsWith('https') ? '; Secure' : ''}` });
    }
    if (!authed(req)) return send(res, 401, { error: 'login required' });
    if (m === 'GET' && p === '/api/state') return send(res, 200, view());
    if (m !== 'POST' && m !== 'DELETE') return send(res, 405, { error: 'method' });
    if (m === 'POST' && !(req.headers['content-type'] || '').includes('application/json')) return send(res, 415, { error: 'json only' });
    const b = m === 'POST' ? JSON.parse((await body(req)) || '{}') : {}, seg = p.split('/');
    if (p === '/api/agent') {
      if (b.running) { const why = agentReady(); if (why) return send(res, 400, { error: why }); if (bal() <= 0) return send(res, 400, { error: 'No funds: deposit first' }); }
      st.running = !!b.running; save(); if (st.running) agentStep(); return send(res, 200, view());
    }
    if (p === '/api/deposit') {
      const c = Math.round(+b.amount * 100); if (!(c >= 500 && c <= 50000000)) return send(res, 400, { error: 'Amount must be $5 - $500,000' });
      const s = await stripe('checkout/sessions', { mode: 'payment', 'line_items[0][quantity]': 1, 'line_items[0][price_data][currency]': 'aud',
        'line_items[0][price_data][unit_amount]': c, 'line_items[0][price_data][product_data][name]': 'Survival AI funding',
        'metadata[kind]': 'deposit', success_url: BASE + '/?paid=1', cancel_url: BASE + '/' });
      return send(res, 200, { url: s.url });
    }
    if (p === '/api/withdraw') {
      const c = Math.round(+b.amount * 100); if (!(c >= 100)) return send(res, 400, { error: 'Minimum $1' });
      if (c > bal() - reserved()) return send(res, 400, { error: 'Exceeds available balance' });
      st.withdrawals.push({ id: id(), ts: Date.now(), cents: c, status: 'pending' }); save(); return send(res, 200, view());
    }
    if (seg[2] === 'withdraw' && seg[4]) {
      const w = st.withdrawals.find(x => x.id === seg[3] && x.status === 'pending'); if (!w) return send(res, 404, { error: 'not pending' });
      if (seg[4] === 'reject') w.status = 'rejected';
      else if (seg[4] === 'approve') {
        if (b.confirm_cents !== w.cents) return send(res, 400, { error: 'Confirm the exact amount' });
        if (w.cents > bal()) return send(res, 400, { error: 'Insufficient balance' });
        w.status = 'sending'; save();
        try { const po = await stripe('payouts', { amount: w.cents, currency: 'aud' }, 'wd-' + w.id); w.status = 'paid'; add('withdrawal', w.cents, po.id, 'Stripe payout to bank'); }
        catch (e) { w.status = 'failed'; w.error = e.message; }
      }
      save(); return send(res, 200, view());
    }
    if (seg[2] === 'proposal' && seg[4]) { const x = st.proposals.find(q => q.id === seg[3]); if (x && ['approved', 'rejected', 'done'].includes(seg[4])) x.status = seg[4]; save(); return send(res, 200, view()); }
    if (p === '/api/memory' && m === 'POST') { if (b.text) mem.push({ id: id(), ts: Date.now(), text: String(b.text).slice(0, 500), src: 'owner' }); save(); return send(res, 200, view()); }
    if (seg[2] === 'memory' && m === 'DELETE') { mem = mem.filter(x => x.id !== seg[3]); save(); return send(res, 200, view()); }
    if (p === '/api/revenue') { const c = Math.round(+b.amount * 100); if (!(c > 0)) return send(res, 400, { error: 'bad amount' }); add('revenue', c, null, String(b.note || 'Manual revenue entry (already received)').slice(0, 100)); return send(res, 200, view()); }
    send(res, 404, { error: 'not found' });
  } catch (e) { send(res, 500, { error: e.message }); }
}).listen(PORT, () => console.log(`Survival AI on ${BASE} | Stripe: ${E.STRIPE_SECRET_KEY ? (live ? 'LIVE' : 'TEST') : 'OFF'}`));
