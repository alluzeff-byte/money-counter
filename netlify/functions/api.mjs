import { randomUUID } from 'node:crypto';

// Money Counter API — per-user GBP balances.
//
// Auth comes from the Netlify Identity JWT that Netlify decodes into
// context.clientContext.user. Balances are stored in each user's Identity
// app_metadata.balance (admin-writable), so there is no external datastore.

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
const cleanLabel = (v) => {
  const s = typeof v === 'string' ? v.trim().slice(0, 60) : '';
  return !s || s.toLowerCase() === 'balance' ? 'Balance' : s;
};

// A user's balances as a normalised [{ id, label, amount }] array.
// Falls back to the legacy single `balance` / `balanceLabel` fields.
const normBalances = (meta) => {
  const arr = meta && meta.balances;
  if (Array.isArray(arr) && arr.length) {
    return arr.map((b, i) => ({
      id: String((b && b.id) || i),
      label: cleanLabel(b && b.label),
      amount: Math.max(0, Math.round(num(b && b.amount) * 100) / 100),
    }));
  }
  return [{
    id: 'default',
    label: cleanLabel(meta && meta.balanceLabel),
    amount: Math.max(0, Math.round(num(meta && meta.balance) * 100) / 100),
  }];
};

// Append an audit entry to app_metadata.history, keeping the most recent 100.
const pushHistory = (meta, entry) => {
  const hist = Array.isArray(meta && meta.history) ? meta.history.slice() : [];
  hist.push(entry);
  return hist.slice(-100);
};

// Call the Netlify Identity (GoTrue) API. `token` is either the caller's
// access token (for /user) or the admin token from clientContext.identity.
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
  const admin = rolesOf(user.app_metadata).indexOf('admin') !== -1;

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

  try {
    // GET /me — the caller's own record (fresh, via their own token)
    if (route === '/me' && method === 'GET') {
      let meta = user.app_metadata || {};
      try {
        const fresh = await idFetch(identity.url, bearer, '/user');
        if (fresh && fresh.app_metadata) meta = fresh.app_metadata;
      } catch { /* fall back to JWT copy */ }
      const balances = normBalances(meta);
      return json(200, {
        id: user.sub,
        email: user.email,
        name: nameOf(meta, user.email),
        isAdmin: rolesOf(meta).indexOf('admin') !== -1,
        balances,
      });
    }

    // Everything below requires admin.
    if (!admin) return json(403, { error: 'Admin only.' });
    if (!identity.token && !bearer) return json(500, { error: 'No usable Identity token.' });

    // Load a non-admin target user, or fail with a useful message.
    const loadManagedUser = async (userId) => {
      if (!userId) { const e = new Error('userId is required.'); e.status = 400; throw e; }
      const target = await adminFetch(`/admin/users/${encodeURIComponent(userId)}`);
      if (isAdminMeta(target.app_metadata)) {
        const e = new Error('Admins do not have balances.'); e.status = 400; throw e;
      }
      return target;
    };

    // Persist a balances array (+ optional history entry) and return the
    // normalised result. Also mirrors the first balance to the legacy fields.
    const saveBalances = async (userId, targetMeta, balances, historyEntry) => {
      const merged = { ...(targetMeta || {}), balances };
      if (balances[0]) { merged.balance = balances[0].amount; merged.balanceLabel = balances[0].label; }
      if (historyEntry) merged.history = pushHistory(targetMeta, historyEntry);
      const updated = await adminFetch(`/admin/users/${encodeURIComponent(userId)}`, {
        method: 'PUT',
        body: JSON.stringify({ app_metadata: merged }),
      });
      return normBalances(updated.app_metadata);
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
      balances.push({ id: randomUUID(), label: 'Balance', amount: 0 });
      const out = await saveBalances(userId, target.app_metadata, balances, {
        at: new Date().toISOString(), by: user.email, field: 'balance-added',
      });
      return json(200, { userId, balances: out });
    }

    // PUT /balance { userId, balanceId, amount } — set one balance's amount
    if (route === '/balance' && method === 'PUT') {
      const { userId, balanceId, amount } = readBody(event);
      const n = Number(amount);
      if (!isFinite(n) || n < 0) return json(400, { error: 'amount must be a number >= 0.' });
      const rounded = Math.round(n * 100) / 100;

      const target = await loadManagedUser(userId);
      const balances = normBalances(target.app_metadata);
      const b = balances.find((x) => x.id === String(balanceId)) || (balanceId == null && balances[0]);
      if (!b) return json(404, { error: 'Balance not found.' });
      const prev = b.amount;
      b.amount = rounded;
      const out = await saveBalances(userId, target.app_metadata, balances,
        prev !== rounded
          ? { at: new Date().toISOString(), by: user.email, field: 'balance', balanceLabel: b.label, from: prev, to: rounded }
          : null);
      return json(200, { userId, balances: out });
    }

    // PUT /balance-label { userId, balanceId, label } — rename one balance
    if (route === '/balance-label' && method === 'PUT') {
      const { userId, balanceId, label } = readBody(event);
      const target = await loadManagedUser(userId);
      const balances = normBalances(target.app_metadata);
      const b = balances.find((x) => x.id === String(balanceId)) || (balanceId == null && balances[0]);
      if (!b) return json(404, { error: 'Balance not found.' });
      const prev = b.label;
      b.label = cleanLabel(label);
      const out = await saveBalances(userId, target.app_metadata, balances,
        prev !== b.label
          ? { at: new Date().toISOString(), by: user.email, field: 'label', from: prev, to: b.label }
          : null);
      return json(200, { userId, balances: out });
    }

    // PUT /name { userId, name } — assign a display name (blank/email clears it)
    if (route === '/name' && method === 'PUT') {
      const { userId, name } = readBody(event);
      if (!userId) return json(400, { error: 'userId is required.' });
      const clean = typeof name === 'string' ? name.trim().slice(0, 120) : '';

      const target = await adminFetch(`/admin/users/${encodeURIComponent(userId)}`);
      const email = target.email;
      const prevName = nameOf(target.app_metadata, email);
      const merged = { ...(target.app_metadata || {}) };
      if (!clean || clean === email) delete merged.name;
      else merged.name = clean;
      const newName = nameOf(merged, email);
      if (prevName !== newName) {
        merged.history = pushHistory(target.app_metadata, {
          at: new Date().toISOString(), by: user.email, field: 'name', from: prevName, to: newName,
        });
      }

      const updated = await adminFetch(`/admin/users/${encodeURIComponent(userId)}`, {
        method: 'PUT',
        body: JSON.stringify({ app_metadata: merged }),
      });
      return json(200, { userId, name: nameOf(updated.app_metadata, email), email });
    }

    // GET /history?userId=... — audit trail for one user (newest first)
    if (route === '/history' && method === 'GET') {
      const userId = (event.queryStringParameters || {}).userId;
      if (!userId) return json(400, { error: 'userId is required.' });
      const target = await adminFetch(`/admin/users/${encodeURIComponent(userId)}`);
      const hist = Array.isArray(target.app_metadata && target.app_metadata.history)
        ? target.app_metadata.history.slice().reverse()
        : [];
      return json(200, { userId, email: target.email, history: hist });
    }

    // POST /invite { email } — send a Netlify Identity invite
    if (route === '/invite' && method === 'POST') {
      const { email } = readBody(event);
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return json(400, { error: 'A valid email is required.' });
      }
      const lc = email.toLowerCase();
      const created = await adminFetch('/invite', {
        method: 'POST',
        body: JSON.stringify({ email: lc }),
      });
      // Best-effort: seed the history with the invite event.
      if (created && created.id) {
        try {
          await adminFetch(`/admin/users/${created.id}`, {
            method: 'PUT',
            body: JSON.stringify({
              app_metadata: {
                ...(created.app_metadata || {}),
                history: pushHistory(created.app_metadata, {
                  at: new Date().toISOString(), by: user.email, field: 'invited', to: lc,
                }),
              },
            }),
          });
        } catch { /* non-fatal */ }
      }
      return json(200, { invited: lc });
    }

    return json(404, { error: `No route for ${method} ${route}` });
  } catch (err) {
    return json(err.status && err.status < 500 ? err.status : 500, { error: err.message || 'Server error.' });
  }
}
