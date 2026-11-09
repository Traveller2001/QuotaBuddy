import { formatMoney } from '../../shared/format';
import { emptyParts, HttpError, pct, requestJson, type FetchFn, type Parts } from './http';
import type { RefreshEvent } from '../../shared/types';

/** https://host/v1 -> https://host ; https://host/ -> https://host */
export function gatewayRoot(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}

export function originOf(baseUrl: string): string {
  return new URL(baseUrl).origin;
}

const auth = (key: string) => ({ Authorization: `Bearer ${key}`, Accept: 'application/json' });

/** GET /v1/usage with the API key. Returns null when the gateway is not Sub2API-like. */
export async function fetchKeyUsage(f: FetchFn, root: string, key: string): Promise<any | null> {
  const json = await requestJson(f, `${root}/v1/usage`, { headers: auth(key) });
  if (!json || typeof json !== 'object') return null;
  const looksLike = typeof json.isValid === 'boolean' || json.mode === 'quota_limited' || json.mode === 'unrestricted';
  return looksLike ? json : null;
}

export function parseKeyUsage(j: any): Parts {
  const parts = emptyParts();
  if (j.isValid === false) parts.notes.push({ level: 'error', key: 'note.keyInvalid' });

  const money = (v: number) => formatMoney(v, j.unit === 'USD' || !j.unit ? 'USD' : j.unit);
  if (j.mode === 'quota_limited') {
    const q = j.quota;
    if (q && q.limit > 0) {
      parts.windows.push({
        id: 'quota',
        label: 'quota',
        usedPercent: j.status === 'quota_exhausted' ? 100 : pct(q.used, q.limit),
        detail: `${money(q.used)} / ${money(q.limit)}`,
        scope: 'key',
      });
    }
    for (const r of Array.isArray(j.rate_limits) ? j.rate_limits : []) {
      if (!(r?.limit > 0)) continue;
      parts.windows.push({
        id: String(r.window),
        label: String(r.window),
        usedPercent: pct(r.used, r.limit),
        resetsAt: r.reset_at ?? undefined,
        detail: `${money(r.used)} / ${money(r.limit)}`,
        scope: 'key',
      });
    }
  } else if (j.subscription) {
    const s = j.subscription;
    const add = (id: string, used: number, limit: number | null | undefined, resetsAt?: string) => {
      if (typeof limit === 'number' && limit > 0) {
        parts.windows.push({ id, label: id, usedPercent: pct(used ?? 0, limit), resetsAt, detail: `${money(used ?? 0)} / ${money(limit)}`, scope: 'key' });
      }
    };
    const weeklyStart = s.weekly_window_start ? Date.parse(s.weekly_window_start) : NaN;
    add('daily', s.daily_usage_usd, s.daily_limit_usd);
    add('weekly', s.weekly_usage_usd, s.weekly_limit_usd, Number.isFinite(weeklyStart) ? new Date(weeklyStart + 7 * 86400000).toISOString() : undefined);
    add('monthly', s.monthly_usage_usd, s.monthly_limit_usd);
    if (typeof j.planName === 'string') parts.plan = j.planName;
  } else if (typeof j.balance === 'number') {
    parts.balance = { amount: j.balance, unit: j.unit || 'USD' };
  }

  if (typeof j.days_until_expiry === 'number' && j.days_until_expiry <= 7) {
    parts.notes.push({ level: 'warn', key: 'note.expiresIn', params: { days: Math.max(0, j.days_until_expiry) } });
  }
  const today = j.usage?.today;
  if (today) {
    parts.today = {
      requests: today.requests,
      costUsd: today.actual_cost ?? today.cost,
      tokens: today.total_tokens,
    };
  }
  return parts;
}

// ------------------------------------------------------------------ account session (web API)

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export type LoginResponse =
  | { kind: 'ok'; tokens: TokenPair; email: string }
  | { kind: 'totp'; tempToken: string };

function unwrap(json: any): any {
  if (json && typeof json === 'object' && 'code' in json) {
    if (json.code !== 0) throw new HttpError(400, json.message || `error code ${json.code}`);
    return json.data;
  }
  return json;
}

function toPair(d: any): TokenPair {
  if (!d?.access_token) throw new HttpError(500, 'Login response did not include a token');
  return {
    accessToken: d.access_token,
    refreshToken: d.refresh_token,
    expiresAt: Date.now() + (Number(d.expires_in) || 3600) * 1000,
  };
}

const jsonPost = (body: unknown, token?: string): RequestInit => ({
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify(body),
});

export async function login(
  f: FetchFn,
  origin: string,
  email: string,
  password: string,
  totp?: { tempToken: string; code: string },
): Promise<LoginResponse> {
  if (totp) {
    const d = unwrap(await requestJson(f, `${origin}/api/v1/auth/login/2fa`, jsonPost({ temp_token: totp.tempToken, totp_code: totp.code })));
    return { kind: 'ok', tokens: toPair(d), email: d.user?.email ?? email };
  }
  const d = unwrap(await requestJson(f, `${origin}/api/v1/auth/login`, jsonPost({ email, password })));
  if (d?.requires_2fa) return { kind: 'totp', tempToken: d.temp_token };
  return { kind: 'ok', tokens: toPair(d), email: d.user?.email ?? email };
}

export async function refreshTokens(f: FetchFn, origin: string, refreshToken: string): Promise<TokenPair> {
  return toPair(unwrap(await requestJson(f, `${origin}/api/v1/auth/refresh`, jsonPost({ refresh_token: refreshToken }))));
}

/** Finds the id of the API key used locally among the logged-in user's keys. */
export async function findKeyId(f: FetchFn, origin: string, accessToken: string, apiKey: string): Promise<number | null> {
  for (let page = 1; page <= 20; page++) {
    const d = unwrap(
      await requestJson(f, `${origin}/api/v1/keys?page=${page}&page_size=100`, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      }),
    );
    const items: any[] = Array.isArray(d?.items) ? d.items : Array.isArray(d) ? d : [];
    const hit = items.find((k) => k?.key === apiKey);
    if (hit) return Number(hit.id);
    const pages = Number(d?.pages) || 1;
    if (page >= pages || items.length === 0) break;
  }
  return null;
}

export async function fetchPoolUsage(f: FetchFn, origin: string, accessToken: string, keyId: number): Promise<any | null> {
  const d = unwrap(await requestJson(f, `${origin}/api/v1/keys/pool-usage`, jsonPost({ api_key_ids: [keyId] }, accessToken)));
  return d?.stats?.[String(keyId)] ?? null;
}

export function parsePool(s: any): Parts {
  const parts = emptyParts();
  if (!s) return parts;
  if (!s.available) {
    parts.notes.push({ level: 'warn', key: 'note.poolUnavailable', params: { reason: s.reason ? `: ${s.reason}` : '' } });
  }
  if (s.partial) parts.notes.push({ level: 'info', key: 'note.poolPartial' });
  // Newer Sub2API reports what is usable now (blocked / used-up accounts count as 0, each account
  // limited by its tightest window); older ones only the average over every account.
  const usable = new Map<string, number>();
  const add = (id: string, w: any) => {
    if (!w || typeof w.used_percent !== 'number') return;
    if (typeof w.available_remaining_percent === 'number') usable.set(id, w.available_remaining_percent);
    parts.windows.push({
      id,
      label: id,
      usedPercent: w.used_percent,
      resetsAt: w.next_reset_at ?? undefined,
      restorePercent: typeof w.next_restore_percent === 'number' ? w.next_restore_percent : undefined,
      scope: 'pool',
      poolRemaining: 100 - w.used_percent,
    });
  };
  add('5h', s.five_hour);
  add('7d', s.seven_day);
  const total = Number(s.accounts_total) || 0;
  const available = Number(s.accounts_available) || 0;
  if (total > 0) parts.accounts = { total, available };
  const raw: any[] = Array.isArray(s.refreshes) ? s.refreshes : [];
  // With account indexes: a window reset of an account that stays blocked past it gives nothing usable
  const blockedUntil = new Map<number, number>();
  for (const r of raw) {
    if (r.kind !== 'account' || !Array.isArray(r.account_indexes)) continue;
    for (const i of r.account_indexes) blockedUntil.set(i, Math.max(blockedUntil.get(i) ?? 0, Date.parse(r.at)));
  }
  const stillBlocked = (r: any) =>
    r.kind !== 'account' &&
    Array.isArray(r.account_indexes) &&
    r.account_indexes.length > 0 &&
    r.account_indexes.every((i: number) => (blockedUntil.get(i) ?? 0) > Date.parse(r.at) + SAME_MOMENT_MS);
  parts.refreshes = raw
    .filter((r) => !stillBlocked(r))
    .map((r: any) => {
      const accounts = typeof r.accounts === 'number' ? r.accounts : undefined;
      let restorePercent = typeof r.restore_percent === 'number' ? r.restore_percent : undefined;
      // n accounts are never more than n / total of the pool
      if (restorePercent !== undefined && accounts && total > 0) restorePercent = Math.min(restorePercent, Math.round(((accounts * 100) / total) * 10) / 10);
      return { at: r.at, kind: r.kind, restorePercent, accounts };
    });
  if (total > 0) correctForRateLimitedAccounts(parts, total);
  const exhausted = Number(s.accounts_exhausted) || 0;
  const explained = parts.windows.some((w) => w.usedPercent >= 99.5) || (total > 0 && exhausted >= total);
  if (total > 0) capToAvailableAccounts(parts, total, available, usable);
  if (total > 0 && available === 0 && !explained) {
    // every account is out but no window explains it (overloaded / paused): show that on its own
    const back = parts.refreshes.find((r) => r.kind === 'account');
    parts.windows.push({ id: 'accounts', label: 'accounts', usedPercent: 100, resetsAt: back?.at, detail: `0 / ${total}`, scope: 'pool' });
  }
  return parts;
}

/**
 * Whatever stopped them (a 429 no window explains, overload, a banned or expired account), accounts
 * that can't take requests still count with their last sampled usage, so the pool windows show room
 * nobody can use. Each account is at most 1/total of the pool, so what is usable now is at most
 * available / total of every window, minus what the available accounts have used of it.
 *
 * That usage is in the refresh list: every account with usage in a window has a refill of that window
 * at its own reset. A refill that coincides with accounts coming back belongs to blocked accounts;
 * the rest belongs to accounts still taking requests (or to blocked ones whose comeback is something
 * else, which only makes the estimate more cautious). Without this, an available account that has
 * used up its 5h looks like a fresh one as long as the blocked accounts have 5h left.
 *
 * The capacity cut off that way comes back with the accounts, not with the window's own reset: each
 * time accounts come back, the window gets their share back (never more than was cut). That becomes
 * a refill of the window, merged into its own reset when both happen at the same moment.
 */
export function capToAvailableAccounts(parts: Parts, total: number, available: number, usable = new Map<string, number>()): void {
  const share = (Math.min(available, total) * 100) / total;
  const comeback = parts.refreshes
    .filter((r) => r.kind === 'account')
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const blocked = (r: RefreshEvent) => comeback.some((b) => Math.abs(Date.parse(b.at) - Date.parse(r.at)) <= SAME_MOMENT_MS);
  const usedByAvailable = new Map<string, number>();
  for (const r of parts.refreshes) {
    if (r.kind !== 'account' && !blocked(r)) usedByAvailable.set(r.kind, (usedByAvailable.get(r.kind) ?? 0) + (r.restorePercent ?? 0));
  }
  for (const w of parts.windows) {
    if (w.scope !== 'pool') continue;
    // the gateway's own figure when it has one: it knows each account, the estimate only infers it
    const maxRemaining = usable.get(w.id) ?? Math.max(0, share - (usedByAvailable.get(WINDOW_REFRESH[w.id]) ?? 0));
    let cut = 100 - w.usedPercent - maxRemaining;
    if (cut <= 0.05) continue;
    w.usedPercent = Math.round((100 - maxRemaining) * 10) / 10;
    const kind = WINDOW_REFRESH[w.id];
    if (!kind) continue;
    for (const back of comeback) {
      if (cut < 1) break;
      const gain = Math.min(cut, ((back.accounts ?? 1) * 100) / total);
      cut -= gain;
      const at = Date.parse(back.at);
      const same = parts.refreshes.find((r) => r.kind === kind && Math.abs(Date.parse(r.at) - at) <= SAME_MOMENT_MS);
      if (same) same.restorePercent = Math.round(Math.max(same.restorePercent ?? 0, gain) * 10) / 10;
      else parts.refreshes.push({ at: back.at, kind, restorePercent: Math.round(gain * 10) / 10, accounts: back.accounts });
    }
  }
  parts.refreshes.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

const WINDOW_REFRESH: Record<string, string> = { '5h': 'five_hour', '7d': 'seven_day' };
/** An account's "back at" and a window's reset are the same moment when that window limited it. */
const SAME_MOMENT_MS = 10 * 60_000;

/**
 * Sub2API samples each account's 5h / 7d utilisation from successful responses only. When Anthropic
 * answers 429 the account is marked rate limited until the window resets, but its utilisation stays
 * frozen at the last value seen before the limit, so the pool looks like it still has room.
 *
 * The pool summary does say when blocked accounts come back ("account" refreshes) and when each
 * window resets for how many accounts and how much ("five_hour" / "seven_day" refreshes). When those
 * coincide, those accounts were stopped by that window: their real share of it is 100%, so the pool
 * window is raised by the difference, and so is what its reset gives back.
 */
export function correctForRateLimitedAccounts(parts: Parts, total: number): void {
  const blocked = parts.refreshes.filter((r) => r.kind === 'account');
  if (!blocked.length) return;
  for (const w of parts.windows) {
    const kind = WINDOW_REFRESH[w.id];
    if (!kind) continue;
    let raise = 0;
    for (const refresh of parts.refreshes) {
      if (refresh.kind !== kind) continue;
      const at = Date.parse(refresh.at);
      const back = blocked.find((b) => Math.abs(Date.parse(b.at) - at) <= SAME_MOMENT_MS);
      if (!back) continue;
      const accounts = Math.min(back.accounts ?? 1, refresh.accounts ?? back.accounts ?? 1);
      const full = (accounts * 100) / total;
      const delta = full - (refresh.restorePercent ?? 0);
      if (delta <= 0.05) continue;
      refresh.restorePercent = Math.round(full * 10) / 10;
      raise += delta;
    }
    if (raise <= 0) continue;
    w.usedPercent = Math.min(100, Math.round((w.usedPercent + raise) * 10) / 10);
    const next = parts.refreshes
      .filter((r) => r.kind === kind)
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
    if (next && w.resetsAt && Math.abs(Date.parse(next.at) - Date.parse(w.resetsAt)) <= SAME_MOMENT_MS) {
      w.restorePercent = next.restorePercent;
    }
  }
}
