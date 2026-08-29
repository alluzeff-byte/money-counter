import { randomUUID } from 'node:crypto';

// Money Counter API — per-user GBP balances.
//
// Auth comes from the Netlify Identity JWT that Netlify decodes into
// context.clientContext.user. Each user's balances live in their Identity
// app_metadata.balances = [{ id, label, amount, history[], request|null }].
// There is no external datastore.

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

// Normalise one stored balance object.
const normBalance = (b, i) => {
  const req = b && b.request && typeof b.request === 'object' ? b.request : null;
  return {
    id: String((b && b.id) || i),
    label: cleanLabel(b && b.label),
    amount: money(b && b.amount),
    archived: !!(b && b.archived),
    history: Array.isArray(b && b.history) ? b.history.slice(-100) : [],
    request: req ? {
      amount: money(req.amount),
      comment: cleanComment(req.comment),
      at: req.at || null,
      by: req.by || null,
    } : null,
  };
};

// A user's balances as a normalised array. Falls back to the legacy single
// `balance` / `balanceLabel` fields (and folds any legacy user-level history
// into the first balance).
const normBalances = (meta) => {
  const arr = meta && meta.balances;
  if (Array.isArray(arr)) return arr.map(normBalance); // may legitimately be []
  return [normBalance({
    id: 'default',
    label: meta && meta.balanceLabel,
    amount: meta && meta.balance,
    history: Array.isArray(meta && meta.history) ? meta.history : [],
  }, 0)];
};

const pushBalHist = (b, entry) => {
  b.history = (Array.isArray(b.history) ? b.history : []).concat([entry]).slice(-100);
};

const idFetch = async (baseUrl, token, path, init = {}) => {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
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
  if (!identity || !identity.url) {
    return json(500, { error: 'Identity context unavailable.' });
  }

  const bearer = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '');
  const route = routeOf(event);
  const method = event.httpMethod;
  const admin = isAdminMeta(user.app_metadata);

  // Admin-scoped Identity call. Uses the platform admin token; if that token
  // is rejected (notably under `netlify dev`, which injects a locally-signed
  // one), retry with the caller's own token, which carries the admin role.
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

  // Email every admin who has enabled notifications, via Resend. No-ops
  // silently if RESEND_API_KEY is not configured.
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
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.NOTIFY_FROM || 'Money Counter <onboarding@resend.dev>',
        to: recipients,
        subject,
        text,
      }),
    });
  };

  // Persist a balances array and return the normalised result. The first
  // balance is mirrored to the legacy fields for any external reader.
  const saveBalances = async (userId, targetMeta, balances) => {
    const merged = { ...(targetMeta || {}), balances };
    if (balances[0]) { merged.balance = balances[0].amount; merged.balanceLabel = balances[0].label; }
    else { delete merged.balance; delete merged.balanceLabel; }
    delete merged.history; // history now lives per balance
    const updated = await adminFetch(`/admin/users/${encodeURIComponent(userId)}`, {
      method: 'PUT',
      body: JSON.stringify({ app_metadata: merged }),
    });
    return normBalances(updated.app_metadata);
  };

  const findBalance = (balances, balanceId) =>
    balances.find((x) => x.id === String(balanceId)) || (balanceId == null ? balances[0] : null);

  try {
    // ---- Any authenticated user ------------------------------------------

    // GET /me — the caller's own record (fresh, via their own token)
    if (route === '/me' && method === 'GET') {
      let meta = user.app_metadata || {};
      try {
        const fresh = await idFetch(identity.url, bearer, '/user');
        if (fresh && fresh.app_metadata) meta = fresh.app_metadata;
      } catch { /* fall back to JWT copy */ }
      return json(200, {
        id: user.sub,
        email: user.email,
        name: nameOf(meta, user.email),
        isAdmin: isAdminMeta(meta),
        notifyEmail: notifyEmailOf(meta, user.email),
        notifyEnabled: !!(meta && meta.notifyEnabled),
        balances: normBalances(meta),
      });
    }

    // POST /request { balanceId, amount, comment } — the caller asks for a
    // top-up on one of their own balances. Persisted with the admin token
    // because users cannot write their own app_metadata.
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
      b.request = { amount: money(n), comment: c, at: nowIso(), by: user.email };
      pushBalHist(b, { at: b.request.at, by: user.email, type: 'topup-requested', amount: b.request.amount, comment: c });
      const out = await saveBalances(user.sub, target.app_metadata, balances);

      // Best-effort email notification to subscribed admins.
      await notifyAdmins(
        `Top-up request: ${gbp(b.request.amount)} on "${b.label}"`,
        `${user.email} requested a top-up of ${gbp(b.request.amount)} on "${b.label}".\n\n`
        + `Comment: ${c || '(none)'}\n\n`
        + `Review it in the admin console.`,
      ).catch(() => {});

      return json(200, { balances: out });
    }

    // ---- Admin only -----------------------------------------------------
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

    // GET /users — all users with their balances
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
      return json(200, { users: rows });
    }

    // POST /balances { userId } — add a new empty balance
    if (route === '/balances' && method === 'POST') {
      const { userId } = readBody(event);
      const target = await loadManagedUser(userId);
      const balances = normBalances(target.app_metadata);
      const nb = normBalance({ id: randomUUID(), label: 'Balance', amount: 0 }, balances.length);
      pushBalHist(nb, { at: nowIso(), by: user.email, type: 'created' });
      balances.push(nb);
      const out = await saveBalances(userId, target.app_metadata, balances);
      return json(200, { userId, balances: out });
    }

    // POST /balance-archive { userId, balanceId } — move a balance to Archived
    if (route === '/balance-archive' && method === 'POST') {
      const { userId, balanceId } = readBody(event);
      const target = await loadManagedUser(userId);
      const balances = normBalances(target.app_metadata);
      const b = findBalance(balances, balanceId);
      if (!b) return json(404, { error: 'Balance not found.' });
      if (!b.archived) {
        b.archived = true;
        b.request = null;
        pushBalHist(b, { at: nowIso(), by: user.email, type: 'archived' });
      }
      const out = await saveBalances(userId, target.app_metadata, balances);
      return json(200, { userId, balances: out });
    }

    // POST /balance-delete { userId, balanceId } — permanently remove an
    // archived balance
    if (route === '/balance-delete' && method === 'POST') {
      const { userId, balanceId } = readBody(event);
      const target = await loadManagedUser(userId);
      const balances = normBalances(target.app_metadata);
      const i = balances.findIndex((x) => x.id === String(balanceId));
      if (i === -1) return json(404, { error: 'Balance not found.' });
      if (!balances[i].archived) return json(400, { error: 'Only archived balances can be deleted.' });
      balances.splice(i, 1);
      const out = await saveBalances(userId, target.app_metadata, balances);
      return json(200, { userId, balances: out });
    }

    // PUT /balance { userId, balanceId, amount, mode } — set (absolute) or
    // adjust (mode: "delta", amount may be negative) one balance's amount
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

      const raw = delta ? b.amount + n : n;
      const next = Math.round(raw * 100) / 100;
      if (next < 0) return json(400, { error: 'That change would make the balance negative.' });

      if (b.amount !== next) {
        const prev = b.amount;
        b.amount = next;
        pushBalHist(b, delta
          ? { at: nowIso(), by: user.email, type: 'adjusted', delta: Math.round(n * 100) / 100, from: prev, to: next }
          : { at: nowIso(), by: user.email, type: 'set', from: prev, to: next });
      }
      const out = await saveBalances(userId, target.app_metadata, balances);
      return json(200, { userId, balances: out });
    }

    // PUT /balance-label { userId, balanceId, label } — rename one balance
    if (route === '/balance-label' && method === 'PUT') {
      const { userId, balanceId, label } = readBody(event);
      const target = await loadManagedUser(userId);
      const balances = normBalances(target.app_metadata);
      const b = findBalance(balances, balanceId);
      if (!b) return json(404, { error: 'Balance not found.' });
      const next = cleanLabel(label);
      if (b.label !== next) {
        const prev = b.label;
        b.label = next;
        pushBalHist(b, { at: nowIso(), by: user.email, type: 'renamed', from: prev, to: next });
      }
      const out = await saveBalances(userId, target.app_metadata, balances);
      return json(200, { userId, balances: out });
    }

    // POST /approve { userId, balanceId, comment } — grant a pending top-up
    if (route === '/approve' && method === 'POST') {
      const { userId, balanceId, comment } = readBody(event);
      const target = await loadManagedUser(userId);
      const balances = normBalances(target.app_metadata);
      const b = findBalance(balances, balanceId);
      if (!b) return json(404, { error: 'Balance not found.' });
      if (!b.request) return json(400, { error: 'No pending request for this balance.' });

      const req = b.request;
      const c = comment == null ? req.comment : cleanComment(comment);
      b.amount = money(b.amount + req.amount);
      pushBalHist(b, {
        at: nowIso(), by: user.email, type: 'topup-approved',
        amount: req.amount, comment: c, requestedBy: req.by,
      });
      b.request = null;
      const out = await saveBalances(userId, target.app_metadata, balances);
      return json(200, { userId, balances: out });
    }

    // POST /reject { userId, balanceId, comment } — decline a pending top-up
    if (route === '/reject' && method === 'POST') {
      const { userId, balanceId, comment } = readBody(event);
      const target = await loadManagedUser(userId);
      const balances = normBalances(target.app_metadata);
      const b = findBalance(balances, balanceId);
      if (!b) return json(404, { error: 'Balance not found.' });
      if (!b.request) return json(400, { error: 'No pending request for this balance.' });

      const req = b.request;
      const c = comment == null ? req.comment : cleanComment(comment);
      pushBalHist(b, {
        at: nowIso(), by: user.email, type: 'topup-rejected',
        amount: req.amount, comment: c, requestedBy: req.by,
      });
      b.request = null;
      const out = await saveBalances(userId, target.app_metadata, balances);
      return json(200, { userId, balances: out });
    }

    // PUT /name { userId, name } — assign a display name (blank/email clears it)
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

    // PUT /notify { email, enabled } — the calling admin's own notification
    // settings (recipient address + on/off)
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

    // POST /invite { email } — send a Netlify Identity invite
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
    return json(err.status && err.status < 500 ? err.status : 500, { error: err.message || 'Server error.' });
  }
}
