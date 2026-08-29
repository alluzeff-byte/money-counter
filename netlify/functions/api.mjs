import { getStore } from '@netlify/blobs';

// ---- helpers ---------------------------------------------------------------

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

// Route path, with the /api or function prefix stripped.
const routeOf = (event) => {
  let p = event.path || '';
  p = p.replace(/^\/\.netlify\/functions\/api/, '').replace(/^\/api/, '');
  return p.replace(/\/+$/, '') || '/';
};

const rolesOf = (user) =>
  (user && user.app_metadata && user.app_metadata.roles) || [];
const isAdmin = (user) => rolesOf(user).indexOf('admin') !== -1;

const store = () => getStore('balances');

const getBalance = async (userId) => {
  const rec = await store().get(userId, { type: 'json' });
  return rec && typeof rec.balance === 'number' ? rec.balance : 0;
};

// Netlify Identity admin API (uses the short-lived admin token from context).
const identityFetch = async (identity, path, init = {}) => {
  const res = await fetch(`${identity.url}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${identity.token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && (data.msg || data.error_description || data.error)) || `Identity ${res.status}`;
    throw new Error(msg);
  }
  return data;
};

// ---- handler -------------------------------------------------------------

export async function handler(event, context) {
  const cc = context.clientContext || {};
  const user = cc.user;
  const identity = cc.identity;

  if (!user) return json(401, { error: 'Not signed in.' });

  const route = routeOf(event);
  const method = event.httpMethod;
  const admin = isAdmin(user);

  try {
    // GET /me  -> the caller's own view
    if (route === '/me' && method === 'GET') {
      return json(200, {
        id: user.sub,
        email: user.email,
        isAdmin: admin,
        balance: await getBalance(user.sub),
      });
    }

    // Everything below is admin-only.
    if (!admin) return json(403, { error: 'Admin only.' });
    if (!identity || !identity.url || !identity.token) {
      return json(500, { error: 'Identity admin context unavailable.' });
    }

    // GET /users -> every user with their balance
    if (route === '/users' && method === 'GET') {
      const data = await identityFetch(identity, '/admin/users?per_page=1000');
      const users = (data && data.users) || [];
      const rows = await Promise.all(
        users.map(async (u) => ({
          id: u.id,
          email: u.email,
          isAdmin: (u.app_metadata && u.app_metadata.roles || []).indexOf('admin') !== -1,
          confirmed: !!u.confirmed_at,
          balance: await getBalance(u.id),
        })),
      );
      rows.sort((a, b) => a.email.localeCompare(b.email));
      return json(200, { users: rows });
    }

    // PUT /balance  { userId, balance } -> set a user's balance
    if (route === '/balance' && method === 'PUT') {
      const { userId, balance } = readBody(event);
      if (!userId) return json(400, { error: 'userId is required.' });
      const n = Number(balance);
      if (!Number.isFinite(n) || n < 0) {
        return json(400, { error: 'balance must be a number >= 0.' });
      }
      const rounded = Math.round(n * 100) / 100;
      await store().setJSON(userId, {
        balance: rounded,
        updatedAt: new Date().toISOString(),
        updatedBy: user.email,
      });
      return json(200, { userId, balance: rounded });
    }

    // POST /invite  { email } -> send a Netlify Identity invite
    if (route === '/invite' && method === 'POST') {
      const { email } = readBody(event);
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return json(400, { error: 'A valid email is required.' });
      }
      await identityFetch(identity, '/invite', {
        method: 'POST',
        body: JSON.stringify({ email: email.toLowerCase() }),
      });
      return json(200, { invited: email.toLowerCase() });
    }

    return json(404, { error: `No route for ${method} ${route}` });
  } catch (err) {
    return json(500, { error: err.message || 'Server error.' });
  }
}
