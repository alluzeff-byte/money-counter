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
const balanceOf = (meta) => {
  const b = meta && meta.balance;
  return typeof b === 'number' && isFinite(b) ? b : 0;
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

  try {
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
        isAdmin: rolesOf(meta).indexOf('admin') !== -1,
        balance: balanceOf(meta),
      });
    }

    // Everything below requires admin + the admin token.
    if (!admin) return json(403, { error: 'Admin only.' });
    if (!identity.token) return json(500, { error: 'Identity admin token unavailable.' });

    // GET /users — all users with balances
    if (route === '/users' && method === 'GET') {
      const perPage = 200;
      let users = [];
      for (let page = 1; page <= 25; page++) {
        const data = await idFetch(
          identity.url, identity.token,
          `/admin/users?per_page=${perPage}&page=${page}`,
        );
        const batch = (data && data.users) || [];
        users = users.concat(batch);
        if (batch.length < perPage) break;
      }
      const rows = users.map((u) => ({
        id: u.id,
        email: u.email,
        isAdmin: rolesOf(u.app_metadata).indexOf('admin') !== -1,
        confirmed: !!u.confirmed_at,
        balance: balanceOf(u.app_metadata),
      }));
      rows.sort((a, b) => a.email.localeCompare(b.email));
      return json(200, { users: rows });
    }

    // PUT /balance { userId, balance } — set a user's balance
    if (route === '/balance' && method === 'PUT') {
      const { userId, balance } = readBody(event);
      if (!userId) return json(400, { error: 'userId is required.' });
      const n = Number(balance);
      if (!isFinite(n) || n < 0) return json(400, { error: 'balance must be a number >= 0.' });
      const rounded = Math.round(n * 100) / 100;

      const target = await idFetch(identity.url, identity.token, `/admin/users/${encodeURIComponent(userId)}`);
      const merged = { ...(target.app_metadata || {}), balance: rounded };
      const updated = await idFetch(identity.url, identity.token, `/admin/users/${encodeURIComponent(userId)}`, {
        method: 'PUT',
        body: JSON.stringify({ app_metadata: merged }),
      });
      return json(200, { userId, balance: balanceOf(updated.app_metadata) });
    }

    // POST /invite { email } — send a Netlify Identity invite
    if (route === '/invite' && method === 'POST') {
      const { email } = readBody(event);
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return json(400, { error: 'A valid email is required.' });
      }
      await idFetch(identity.url, identity.token, '/invite', {
        method: 'POST',
        body: JSON.stringify({ email: email.toLowerCase() }),
      });
      return json(200, { invited: email.toLowerCase() });
    }

    return json(404, { error: `No route for ${method} ${route}` });
  } catch (err) {
    return json(err.status && err.status < 500 ? err.status : 500, { error: err.message || 'Server error.' });
  }
}
