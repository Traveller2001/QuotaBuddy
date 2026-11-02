import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectClaude, collectCodex, type CollectContext } from '../src/main/collect';
import type { ClaudeDetection } from '../src/main/detect/claude';
import type { CodexDetection } from '../src/main/detect/codex';
import { SessionStore, type Session } from '../src/main/sessions';
import { DEFAULT_THRESHOLDS } from '../src/shared/mood';

const memoryCipher = { available: async () => false, encrypt: async (s: string) => s, decrypt: async (s: string) => s };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A tiny fake Sub2API: /v1/usage by key, login + rotating refresh tokens, key list, pool usage. */
function fakeSub2api(opts: { accessTtl?: number } = {}) {
  const calls: string[] = [];
  let tokenGen = 0;
  let validAccess = new Set<string>();
  let validRefresh = new Set<string>();
  const issue = () => {
    tokenGen++;
    const access = `at-${tokenGen}`;
    const refresh = `rt-${tokenGen}`;
    validAccess = new Set([access]);
    validRefresh = new Set([refresh]);
    return { access_token: access, refresh_token: refresh, expires_in: opts.accessTtl ?? 3600, token_type: 'Bearer' };
  };
  const fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url);
    calls.push(`${init.method ?? 'GET'} ${u.pathname}`);
    const auth = new Headers(init.headers).get('Authorization')?.replace('Bearer ', '');
    const body = init.body ? JSON.parse(String(init.body)) : {};
    switch (u.pathname) {
      case '/v1/usage':
        if (auth !== 'sk-local') return json(401, { error: { message: 'Invalid API key' } });
        return json(200, { mode: 'unrestricted', isValid: true, balance: 100, unit: 'USD', usage: { today: { requests: 3, actual_cost: 0.2, total_tokens: 1000 } } });
      case '/api/v1/auth/login':
        if (body.password !== 'pw') return json(401, { code: 401, message: 'invalid email or password' });
        return json(200, { code: 0, message: 'success', data: { ...issue(), user: { email: body.email } } });
      case '/api/v1/auth/refresh':
        if (!validRefresh.has(body.refresh_token)) return json(401, { code: 401, message: 'invalid refresh token' });
        return json(200, { code: 0, message: 'success', data: issue() });
      case '/api/v1/keys':
        if (!auth || !validAccess.has(auth)) return json(401, { code: 401, message: 'unauthorized' });
        return json(200, { code: 0, data: { items: [{ id: 7, key: 'sk-other' }, { id: 9, key: 'sk-local' }], total: 2, page: 1, page_size: 100, pages: 1 } });
      case '/api/v1/keys/pool-usage':
        if (!auth || !validAccess.has(auth)) return json(401, { code: 401, message: 'unauthorized' });
        assert.deepEqual(body, { api_key_ids: [9] });
        return json(200, {
          code: 0,
          data: {
            stats: {
              '9': {
                available: true,
                partial: false,
                five_hour: { used_percent: 91, remaining_percent: 9, next_reset_at: '2099-01-01T01:00:00Z', next_restore_percent: 30 },
                seven_day: { used_percent: 20, remaining_percent: 80 },
                accounts_total: 3,
                accounts_available: 2,
                refreshes: [{ at: '2099-01-01T01:00:00Z', kind: 'five_hour', restore_percent: 30, accounts: 1 }],
              },
            },
          },
        });
    }
    return json(404, { error: 'not found' });
  };
  return { fetch: fetch as CollectContext['fetch'], calls, expireAccess: () => (validAccess = new Set()) };
}

const relay = (baseUrl: string): ClaudeDetection => ({ configDir: '', mode: 'relay', baseUrl, token: 'sk-local', notes: [] });

test('sub2api without login: key usage + a login hint, mood from balance', async () => {
  const server = fakeSub2api();
  const ctx: CollectContext = { fetch: server.fetch, sessions: new SessionStore('unused', memoryCipher), thresholds: DEFAULT_THRESHOLDS };
  const snap = await collectClaude(relay('https://gw.example:8443/v1'), ctx);
  assert.equal(snap.status, 'ok');
  assert.equal(snap.source.kind, 'sub2api');
  assert.equal(snap.mood, 'energetic');
  assert.deepEqual(snap.login, { origin: 'https://gw.example:8443', loggedIn: false, email: undefined });
  assert.equal(snap.notes[0].key, 'note.loginForPool');
  assert.equal(snap.today?.requests, 3);
});

test('sub2api logged in: pool windows drive the mood and the refill countdown', async () => {
  const server = fakeSub2api();
  const sessions = new SessionStore('unused', memoryCipher);
  const { login } = await import('../src/main/providers/sub2api');
  const r = await login(server.fetch, 'https://gw.example:8443', 'me@example.com', 'pw');
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  sessions.set('https://gw.example:8443', { email: r.email, ...r.tokens, keyIds: {} });
  const ctx: CollectContext = { fetch: server.fetch, sessions, thresholds: DEFAULT_THRESHOLDS };

  const snap = await collectClaude(relay('https://gw.example:8443'), ctx);
  assert.equal(snap.remainingPercent, 9);
  assert.equal(snap.mood, 'anxious');
  assert.equal(snap.nextRefresh?.restorePercent, 30);
  assert.equal(snap.login?.loggedIn, true);
  assert.equal(sessions.get('https://gw.example:8443')?.keyIds && Object.values(sessions.get('https://gw.example:8443')!.keyIds)[0], 9);

  // second poll reuses the cached key id
  server.calls.length = 0;
  await collectClaude(relay('https://gw.example:8443'), ctx);
  assert.ok(!server.calls.includes('GET /api/v1/keys'));
});

test('sub2api: an expired access token is refreshed once, shared by concurrent pollers', async () => {
  const server = fakeSub2api();
  const sessions = new SessionStore('unused', memoryCipher);
  const { login } = await import('../src/main/providers/sub2api');
  const r = await login(server.fetch, 'https://gw.example:8443', 'me@example.com', 'pw');
  if (r.kind !== 'ok') throw new Error('login failed');
  const stale: Session = { email: r.email, ...r.tokens, expiresAt: Date.now() - 1000, keyIds: {} };
  sessions.set('https://gw.example:8443', stale);
  const ctx: CollectContext = { fetch: server.fetch, sessions, thresholds: DEFAULT_THRESHOLDS };
  const codex: CodexDetection = { home: '/nonexistent', mode: 'relay', baseUrl: 'https://gw.example:8443', apiKey: 'sk-local', notes: [] };
  const [a, b] = await Promise.all([collectClaude(relay('https://gw.example:8443'), ctx), collectCodex(codex, ctx)]);
  assert.equal(a.remainingPercent, 9);
  assert.equal(b.remainingPercent, 9);
  assert.equal(server.calls.filter((c) => c === 'POST /api/v1/auth/refresh').length, 1);
});

test('sub2api: a revoked session degrades to key usage and asks to log in again', async () => {
  const server = fakeSub2api();
  const sessions = new SessionStore('unused', memoryCipher);
  sessions.set('https://gw.example:8443', { email: 'me@example.com', accessToken: 'dead', refreshToken: 'dead', expiresAt: Date.now() + 3600_000, keyIds: {} });
  const ctx: CollectContext = { fetch: server.fetch, sessions, thresholds: DEFAULT_THRESHOLDS };
  const snap = await collectClaude(relay('https://gw.example:8443'), ctx);
  assert.equal(snap.status, 'ok');
  assert.equal(snap.login?.loggedIn, false);
  assert.ok(snap.notes.some((n) => n.key === 'note.sessionExpired'));
  assert.equal(sessions.get('https://gw.example:8443'), undefined);
});

test('relay errors: wrong key and unreachable host', async () => {
  const server = fakeSub2api();
  const ctx: CollectContext = { fetch: server.fetch, sessions: new SessionStore('unused', memoryCipher), thresholds: DEFAULT_THRESHOLDS };
  const bad = await collectClaude({ ...relay('https://gw.example'), token: 'sk-wrong' }, ctx);
  assert.equal(bad.status, 'error');
  assert.ok(bad.notes.some((n) => n.key === 'note.keyInvalid'));
  const down = await collectClaude(relay('https://gw.example'), {
    ...ctx,
    fetch: async () => {
      throw new TypeError('fetch failed');
    },
  });
  assert.equal(down.status, 'error');
  assert.equal(down.error, 'fetch failed');
  assert.equal(down.mood, 'relaxed');
});

test('unconfigured agents', async () => {
  const ctx: CollectContext = { fetch: fakeSub2api().fetch, sessions: new SessionStore('unused', memoryCipher), thresholds: DEFAULT_THRESHOLDS };
  const c = await collectClaude({ configDir: '', mode: 'none', notes: [] }, ctx);
  assert.equal(c.status, 'unconfigured');
  const x = await collectCodex({ home: '', mode: 'official-api', apiKey: 'sk', notes: [] }, ctx);
  assert.equal(x.source.kind, 'openai-api');
  assert.equal(x.notes[0].key, 'note.payg');
});

test('sessions persist encrypted and survive a restart', async () => {
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'qb-sess-')), 'sessions.json');
  const cipher = {
    available: async () => true,
    encrypt: async (s: string) => Buffer.from(s).toString('base64'),
    decrypt: async (s: string) => Buffer.from(s, 'base64').toString(),
  };
  const a = new SessionStore(file, cipher);
  await a.load();
  a.set('https://gw', { email: 'me@x', accessToken: 'at', refreshToken: 'rt', expiresAt: 1, keyIds: {} });
  a.rememberKeyId('https://gw', 'sk-local', 9);
  await a.flush();
  assert.ok(!readFileSync(file, 'utf8').includes('rt'), 'tokens are not stored in clear text');
  const b = new SessionStore(file, cipher);
  await b.load();
  assert.equal(b.get('https://gw')?.refreshToken, 'rt');
  assert.equal(Object.values(b.get('https://gw')!.keyIds)[0], 9);
});
