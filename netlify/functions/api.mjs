import { randomUUID } from 'node:crypto';
import { getStore } from '@netlify/blobs';

// Money Counter API — per-user GBP balances.
//
// Auth comes from the Netlify Identity JWT (context.clientContext.user).
// Balances live in the user's Identity app_metadata:
//   balances = [{ id, label, amount, archived, request|null }]
// Per-balance history lives in Netlify Blobs (store "mc-history", key
// "<userId>__<balanceId>") so it never bloats the access token.

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

const readBody = (event) => {
  if (!event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  try { return JSON.parse(raw); } catch { return {}; }
};

const routeOf = (event) => {
  let p = event.path || '';
  p = p.replace(/^\/\.netlify\/functions\/api/, '').replace(/^\/api/, '');
  return p.replace(/\/+$/, '') || '/';
};

const rolesOf = (meta) => (meta && meta.roles) || [];
const isAdminMeta = (meta) => rolesOf(meta).indexOf('admin') !== -1;
const nameOf = (meta, email) => {
  const n = meta && typeof meta.name === 'string' && meta.name.trim();
  return n || email;
};

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);
const money = (v) => Math.max(0, Math.round(num(v) * 100) / 100);
const cleanLabel = (v) => {
  const s = typeof v === 'string' ? v.trim().slice(0, 60) : '';
  return !s || s.toLowerCase() === 'balance' ? 'Balance' : s;
};
const cleanComment = (v) => String(v == null ? '' : v).trim().slice(0, 500);
const nowIso = () => new Date().toISOString();
const gbp = (n) => '£' + (Math.round(num(n) * 100) / 100).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const isEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || ''));
const notifyEmailOf = (meta, fallback) => {
  const e = meta && typeof meta.notifyEmail === 'string' && meta.notifyEmail.trim();
  return e || fallback;
};

// ---- history store (Netlify Blobs) --------------------------------------

const HIST_CAP = 500;
const SITE_ID = process.env.NETLIFY_BLOBS_SITE_ID || 'e90c937d-8d31-44a2-bc71-895f6783ccaa';

const histStore = () => {
  const token = process.env.NETLIFY_BLOBS_TOKEN;
  return token
    ? getStore({ name: 'mc-history', siteID: SITE_ID, token })
    : getStore('mc-history'); // implicit context, if Netlify provides it
};
const histKey = (userId, balanceId) => `${userId}__${balanceId}`;

// Raw read — throws on store error so callers can surface it.
const readHistRaw = async (userId, balanceId) => {
  const v = await histStore().get(histKey(userId, balanceId), { type: 'json' });
  return Array.isArray(v) ? v : [];
};
const appendHist = async (userId, balanceId, entry) => {
  try {
    const s = histStore();
    const k = histKey(userId, balanceId);
    const cur = await s.get(k, { type: 'json' }).catch(() => null);
    const next = (Array.isArray(cur) ? cur : []).concat([entry]).slice(-HIST_CAP);
    await s.setJSON(k, next);
    return null;
  } catch (e) { console.error('appendHist:', (e && e.stack) || e); return (e && (e.message || String(e))) || 'blob write failed'; }
};
const deleteHist = async (userId, balanceId) => {
  try { await histStore().delete(histKey(userId, balanceId)); } catch (e) { console.error('deleteHist:', e && e.message); }
};
// Move any history embedded in old app_metadata balances into Blobs (once).
const migrateEmbeddedHistory = async (userId, meta) => {
  const raw = Array.isArray(meta && meta.balances) ? meta.balances : [];
  await Promise.all(raw.map(async (rb) => {
    if (!rb || !rb.id || !Array.isArray(rb.history) || !rb.history.length) return;
    try {
      const k = histKey(userId, String(rb.id));
      const existing = await histStore().get(k, { type: 'json' }).catch(() => null);
      if (!Array.isArray(existing) || !existing.length) {
        await histStore().setJSON(k, rb.history.slice(-HIST_CAP));
      }
    } catch (e) { console.error('migrate hist:', e && e.message); }
  }));
};

// ---- balance normalisation --------------------------------------------

const normRequest = (r, i) => ({
  id: String((r && r.id) || `r${i}`),
  amount: money(r && r.amount),
  comment: cleanComment(r && r.comment),
  at: (r && r.at) || null,
  by: (r && r.by) || null,
});

const normBalance = (b, i) => {
  // Accept the legacy single `request` object or the `requests` array.
  let requests = [];
  if (Array.isArray(b && b.requests)) requests = b.requests;
  else if (b && b.request && typeof b.request === 'object') requests = [b.request];
  return {
    id: String((b && b.id) || i),
    label: cleanLabel(b && b.label),
    amount: money(b && b.amount),
    archived: !!(b && b.archived),
    requests: requests.slice(0, 25).map(normRequest),
  };
};

const normBalances = (meta) => {
  const arr = meta && meta.balances;
  if (Array.isArray(arr)) return arr.map(normBalance); // may legitimately be []
  return [normBalance({ id: 'default', label: meta && meta.balanceLabel, amount: meta && meta.balance }, 0)];
};

// ---- Identity (GoTrue) fetch -----------------------------------------

const idFetch = async (baseUrl, token, path, init = {}) => {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    signal: init.signal || AbortSignal.timeout(7000),
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && (data.msg || data.error_description || data.error)) || `Identity ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
};

export async function handler(event, context) {
  const cc = context.clientContext || {};
  const user = cc.user;
  const identity = cc.identity;

  if (!user) return json(401, { error: 'Not signed in.' });
  if (!identity || !identity.url) return json(500, { error: 'Identity context unavailable.' });

  const bearer = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '');
  const route = routeOf(event);
  const method = event.httpMethod;
  const admin = isAdminMeta(user.app_metadata);

  const adminFetch = async (path, init) => {
    if (!identity.token) return idFetch(identity.url, bearer, path, init);
    try {
      return await idFetch(identity.url, identity.token, path, init);
    } catch (err) {
      if (bearer && /signature is invalid|invalid (jwt|token|claim)|jwt|401|403/i.test(String(err.message))) {
        return await idFetch(identity.url, bearer, path, init);
      }
      throw err;
    }
  };

  const getUserById = (userId) => adminFetch(`/admin/users/${encodeURIComponent(userId)}`);

  // Strip legacy fields / embedded history from a user's app_metadata.
  const healUser = async (userId, meta) => {
    try {
      if (!meta || typeof meta !== 'object' || isAdminMeta(meta)) return;
      const hasStuff = Array.isArray(meta.balances) || meta.history != null
        || meta.balance != null || meta.balanceLabel != null;
      if (!hasStuff) return;
      await migrateEmbeddedHistory(userId, meta);
      const cleaned = { ...meta, balances: normBalances(meta) };
      delete cleaned.history;
      delete cleaned.balance;
      delete cleaned.balanceLabel;
      if (JSON.stringify(cleaned).length >= JSON.stringify(meta).length) return;
      await adminFetch(`/admin/users/${encodeURIComponent(userId)}`, {
        method: 'PUT',
        body: JSON.stringify({ app_metadata: cleaned }),
      });
    } catch (e) { console.error('healUser:', e && e.message); }
  };

  const notifyAdmins = async (subject, text) => {
    const key = process.env.RESEND_API_KEY;
    if (!key) return;
    const data = await adminFetch('/admin/users?per_page=200');
    const recipients = [...new Set(
      ((data && data.users) || [])
        .filter((u) => isAdminMeta(u.app_metadata) && u.app_metadata && u.app_metadata.notifyEnabled)
        .map((u) => notifyEmailOf(u.app_metadata, u.email))
        .filter(isEmail),
    )];
    if (!recipients.length) return;
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      signal: AbortSignal.timeout(7000),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.NOTIFY_FROM || 'Money Counter <onboarding@resend.dev>',
        to: recipients,
        subject,
        text,
      }),
    });
  };

  const saveBalances = async (userId, targetMeta, balances) => {
    await migrateEmbeddedHistory(userId, targetMeta);
    const merged = { ...(targetMeta || {}), balances };
    delete merged.balance;
    delete merged.balanceLabel;
    delete merged.history;
    const updated = await adminFetch(`/admin/users/${encodeURIComponent(userId)}`, {
      method: 'PUT',
      body: JSON.stringify({ app_metadata: merged }),
    });
    return normBalances(updated.app_metadata);
  };

  const findBalance = (balances, balanceId) =>
    balances.find((x) => x.id === String(balanceId)) || (balanceId == null ? balances[0] : null);

  try {
    // ---- Any authenticated user ---------------------------------------

    // GET /me — the caller's own record
    if (route === '/me' && method === 'GET') {
      let meta = user.app_metadata || {};
      let fetched = false;
      try {
        const fresh = await idFetch(identity.url, bearer, '/user');
        if (fresh && fresh.app_metadata) { meta = fresh.app_metadata; fetched = true; }
      } catch { /* fall back to the token copy */ }

      let balances = [];
      try { balances = normBalances(meta); }
      catch (e) { console.error('normBalances(/me):', (e && e.stack) || e); }

      if (fetched) await healUser(user.sub, meta);

      return json(200, {
        id: user.sub,
        email: user.email,
        name: nameOf(meta, user.email),
        isAdmin: isAdminMeta(meta),
        notifyEmail: notifyEmailOf(meta, user.email),
        notifyEnabled: !!(meta && meta.notifyEnabled),
        balances,
      });
    }

    // GET /history?userId=&balanceId=  — one balance's audit trail, newest first
    if (route === '/history' && method === 'GET') {
      const q = event.queryStringParameters || {};
      const userId = q.userId || user.sub;
      const balanceId = q.balanceId;
      if (!balanceId) return json(400, { error: 'balanceId is required.' });
      if (userId !== user.sub && !admin) return json(403, { error: 'Not allowed.' });
      try {
        const hist = await readHistRaw(userId, balanceId);
        return json(200, { userId, balanceId, history: hist.slice().reverse() });
      } catch (e) {
        console.error('/history:', (e && e.stack) || e);
        return json(500, { error: 'History store: ' + ((e && (e.message || String(e))) || 'unavailable') });
      }
    }

    // GET /blobcheck — admin diagnostic: write/read/delete round-trip
    if (route === '/blobcheck' && method === 'GET') {
      if (!admin) return json(403, { error: 'Admin only.' });
      const out = { hasToken: !!process.env.NETLIFY_BLOBS_TOKEN, siteID: SITE_ID };
      try {
        const s = histStore();
        await s.setJSON('__diag', { at: nowIso() });
        out.readBack = await s.get('__diag', { type: 'json' });
        await s.delete('__diag');
        out.ok = true;
      } catch (e) {
        out.ok = false;
        out.error = (e && (e.message || String(e))) || 'unknown';
        out.name = e && e.name;
      }
      return json(200, out);
    }

    // POST /request { balanceId, amount, comment } — caller asks for a top-up
    if (route === '/request' && method === 'POST') {
      const { balanceId, amount, comment } = readBody(event);
      const n = Number(amount);
      if (!isFinite(n) || n <= 0) return json(400, { error: 'Amount must be greater than 0.' });

      const target = await getUserById(user.sub);
      if (isAdminMeta(target.app_metadata)) return json(400, { error: 'Admins do not have balances.' });
      const balances = normBalances(target.app_metadata);
      const b = findBalance(balances, balanceId);
      if (!b) return json(404, { error: 'Balance not found.' });

      const c = cleanComment(comment);
      const reqAmount = money(n);
      b.requests = [...b.requests, { id: randomUUID(), amount: reqAmount, comment: c, at: nowIso(), by: user.email }].slice(-25);
      const out = await saveBalances(user.sub, target.app_metadata, balances);

      await notifyAdmins(
        `Top-up request: ${gbp(reqAmount)} on "${b.label}"`,
        `${user.email} requested a top-up of ${gbp(reqAmount)} on "${b.label}".\n\n`
        + `Comment: ${c || '(none)'}\n\nReview it in the admin console.`,
      ).catch(() => {});

      return json(200, { balances: out });
    }

    // ---- Admin only -------------------------------------------------
    if (!admin) return json(403, { error: 'Admin only.' });
    if (!identity.token && !bearer) return json(500, { error: 'No usable Identity token.' });

    const loadManagedUser = async (userId) => {
      if (!userId) { const e = new Error('userId is required.'); e.status = 400; throw e; }
      const target = await getUserById(userId);
      if (isAdminMeta(target.app_metadata)) {
        const e = new Error('Admins do not have balances.'); e.status = 400; throw e;
      }
      return target;
    };

    // GET /users
    if (route === '/users' && method === 'GET') {
      const perPage = 200;
      let users = [];
      for (let page = 1; page <= 25; page++) {
        const data = await adminFetch(`/admin/users?per_page=${perPage}&page=${page}`);
        const batch = (data && data.users) || [];
        users = users.concat(batch);
        if (batch.length < perPage) break;
      }
      const rows = users.map((u) => ({
        id: u.id,
        email: u.email,
        name: nameOf(u.app_metadata, u.email),
        isAdmin: isAdminMeta(u.app_metadata),
        confirmed: !!u.confirmed_at,
        balances: normBalances(u.app_metadata),
      }));
      rows.sort((a, b) => a.name.localeCompare(b.name));
      await Promise.all(users.map((u) => healUser(u.id, u.app_metadata)));
      return json(200, { users: rows });
    }

    // POST /balances { userId } — add a new empty balance
    if (route === '/balances' && method === 'POST') {
      const { userId } = readBody(event);
      const target = await loadManagedUser(userId);
      const balances = normBalances(target.app_metadata);
      const nb = normBalance({ id: randomUUID(), label: 'Balance', amount: 0 }, balances.length);
      balances.push(nb);
      const out = await saveBalances(userId, target.app_metadata, balances);
      await appendHist(userId, nb.id, { at: nowIso(), by: user.email, type: 'created' });
      return json(200, { userId, balances: out });
    }

    // POST /balance-archive { userId, balanceId }
    if (route === '/balance-archive' && method === 'POST') {
      const { userId, balanceId } = readBody(event);
      const target = await loadManagedUser(userId);
      const balances = normBalances(target.app_metadata);
      const b = findBalance(balances, balanceId);
      if (!b) return json(404, { error: 'Balance not found.' });
      let changed = false;
      if (!b.archived) { b.archived = true; b.requests = []; changed = true; }
      const out = await saveBalances(userId, target.app_metadata, balances);
      if (changed) await appendHist(userId, b.id, { at: nowIso(), by: user.email, type: 'archived' });
      return json(200, { userId, balances: out });
    }

    // POST /balance-restore { userId, balanceId }
    if (route === '/balance-restore' && method === 'POST') {
      const { userId, balanceId } = readBody(event);
      const target = await loadManagedUser(userId);
      const balances = normBalances(target.app_metadata);
      const b = findBalance(balances, balanceId);
      if (!b) return json(404, { error: 'Balance not found.' });
      let changed = false;
      if (b.archived) { b.archived = false; changed = true; }
      const out = await saveBalances(userId, target.app_metadata, balances);
      if (changed) await appendHist(userId, b.id, { at: nowIso(), by: user.email, type: 'restored' });
      return json(200, { userId, balances: out });
    }

    // POST /balance-delete { userId, balanceId } — remove an archived balance
    if (route === '/balance-delete' && method === 'POST') {
      const { userId, balanceId } = readBody(event);
      const target = await loadManagedUser(userId);
      const balances = normBalances(target.app_metadata);
      const i = balances.findIndex((x) => x.id === String(balanceId));
      if (i === -1) return json(404, { error: 'Balance not found.' });
      if (!balances[i].archived) return json(400, { error: 'Only archived balances can be deleted.' });
      balances.splice(i, 1);
      const out = await saveBalances(userId, target.app_metadata, balances);
      await deleteHist(userId, String(balanceId));
      return json(200, { userId, balances: out });
    }

    // PUT /balance { userId, balanceId, amount, mode }
    if (route === '/balance' && method === 'PUT') {
      const { userId, balanceId, amount, mode } = readBody(event);
      const n = Number(amount);
      if (!isFinite(n)) return json(400, { error: 'amount must be a number.' });
      const delta = mode === 'delta';
      if (!delta && n < 0) return json(400, { error: 'amount must be >= 0.' });

      const target = await loadManagedUser(userId);
      const balances = normBalances(target.app_metadata);
      const b = findBalance(balances, balanceId);
      if (!b) return json(404, { error: 'Balance not found.' });

      const next = Math.round((delta ? b.amount + n : n) * 100) / 100;
      if (next < 0) return json(400, { error: 'That change would make the balance negative.' });

      let entry = null;
      if (b.amount !== next) {
        const prev = b.amount;
        b.amount = next;
        entry = delta
          ? { at: nowIso(), by: user.email, type: 'adjusted', delta: Math.round(n * 100) / 100, from: prev, to: next }
          : { at: nowIso(), by: user.email, type: 'set', from: prev, to: next };
      }
      const out = await saveBalances(userId, target.app_metadata, balances);
      if (entry) await appendHist(userId, b.id, entry);
      return json(200, { userId, balances: out });
    }

    // PUT /balance-label { userId, balanceId, label }
    if (route === '/balance-label' && method === 'PUT') {
      const { userId, balanceId, label } = readBody(event);
      const target = await loadManagedUser(userId);
      const balances = normBalances(target.app_metadata);
      const b = findBalance(balances, balanceId);
      if (!b) return json(404, { error: 'Balance not found.' });
      const next = cleanLabel(label);
      let entry = null;
      if (b.label !== next) {
        const prev = b.label;
        b.label = next;
        entry = { at: nowIso(), by: user.email, type: 'renamed', from: prev, to: next };
      }
      const out = await saveBalances(userId, target.app_metadata, balances);
      if (entry) await appendHist(userId, b.id, entry);
      return json(200, { userId, balances: out });
    }

    // Pull one pending request out of a balance by id (or the first if no id).
    const takeRequest = (b, requestId) => {
      const idx = requestId != null
        ? b.requests.findIndex((r) => r.id === String(requestId))
        : (b.requests.length ? 0 : -1);
      if (idx === -1) return null;
      return b.requests.splice(idx, 1)[0];
    };

    // POST /approve { userId, balanceId, requestId, comment }
    if (route === '/approve' && method === 'POST') {
      const { userId, balanceId, requestId, comment } = readBody(event);
      const target = await loadManagedUser(userId);
      const balances = normBalances(target.app_metadata);
      const b = findBalance(balances, balanceId);
      if (!b) return json(404, { error: 'Balance not found.' });
      const req = takeRequest(b, requestId);
      if (!req) return json(400, { error: 'That request is no longer pending.' });

      const c = comment == null ? req.comment : cleanComment(comment);
      b.amount = money(b.amount + req.amount);
      const out = await saveBalances(userId, target.app_metadata, balances);
      await appendHist(userId, b.id, {
        at: nowIso(), by: user.email, type: 'topup-approved',
        amount: req.amount, comment: c, requestedBy: req.by, total: b.amount,
      });
      return json(200, { userId, balances: out });
    }

    // POST /reject { userId, balanceId, requestId, comment }
    if (route === '/reject' && method === 'POST') {
      const { userId, balanceId, requestId, comment } = readBody(event);
      const target = await loadManagedUser(userId);
      const balances = normBalances(target.app_metadata);
      const b = findBalance(balances, balanceId);
      if (!b) return json(404, { error: 'Balance not found.' });
      const req = takeRequest(b, requestId);
      if (!req) return json(400, { error: 'That request is no longer pending.' });

      const c = comment == null ? req.comment : cleanComment(comment);
      const out = await saveBalances(userId, target.app_metadata, balances);
      await appendHist(userId, b.id, {
        at: nowIso(), by: user.email, type: 'topup-rejected',
        amount: req.amount, comment: c, requestedBy: req.by,
      });
      return json(200, { userId, balances: out });
    }

    // PUT /name { userId, name }
    if (route === '/name' && method === 'PUT') {
      const { userId, name } = readBody(event);
      if (!userId) return json(400, { error: 'userId is required.' });
      const clean = typeof name === 'string' ? name.trim().slice(0, 120) : '';
      const target = await getUserById(userId);
      const email = target.email;
      const merged = { ...(target.app_metadata || {}) };
      if (!clean || clean === email) delete merged.name;
      else merged.name = clean;
      const updated = await adminFetch(`/admin/users/${encodeURIComponent(userId)}`, {
        method: 'PUT',
        body: JSON.stringify({ app_metadata: merged }),
      });
      return json(200, { userId, name: nameOf(updated.app_metadata, email), email });
    }

    // PUT /notify { email, enabled } — the calling admin's own settings
    if (route === '/notify' && method === 'PUT') {
      const { email, enabled } = readBody(event);
      const clean = typeof email === 'string' ? email.trim().slice(0, 200) : '';
      if (clean && !isEmail(clean)) return json(400, { error: 'Enter a valid email address.' });
      const me = await getUserById(user.sub);
      const merged = { ...(me.app_metadata || {}) };
      if (clean) merged.notifyEmail = clean; else delete merged.notifyEmail;
      merged.notifyEnabled = !!enabled;
      const updated = await adminFetch(`/admin/users/${encodeURIComponent(user.sub)}`, {
        method: 'PUT',
        body: JSON.stringify({ app_metadata: merged }),
      });
      return json(200, {
        notifyEmail: notifyEmailOf(updated.app_metadata, user.email),
        notifyEnabled: !!updated.app_metadata.notifyEnabled,
      });
    }

    // POST /invite { email }
    if (route === '/invite' && method === 'POST') {
      const { email } = readBody(event);
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return json(400, { error: 'A valid email is required.' });
      }
      const lc = email.toLowerCase();
      await adminFetch('/invite', { method: 'POST', body: JSON.stringify({ email: lc }) });
      return json(200, { invited: lc });
    }

    return json(404, { error: `No route for ${method} ${route}` });
  } catch (err) {
    console.error('api handler error:', (err && err.stack) || err);
    return json(err.status && err.status < 500 ? err.status : 500, { error: (err && err.message) || 'Server error.' });
  }
}
