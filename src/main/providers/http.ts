import type { Note, RefreshEvent, UsageStats, UsageWindow } from '../../shared/types';

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Partial snapshot data a provider contributes. */
export interface Parts {
  windows: UsageWindow[];
  refreshes: RefreshEvent[];
  notes: Note[];
  balance?: { amount: number; unit: string };
  today?: UsageStats;
  accounts?: { total: number; available: number };
  plan?: string;
}

export const emptyParts = (): Parts => ({ windows: [], refreshes: [], notes: [] });

function messageOf(body: any): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  if (typeof body.error === 'string') return body.error;
  return body.error?.message ?? body.message ?? body.detail ?? body.msg;
}

export async function requestJson(
  f: FetchFn,
  url: string,
  init: RequestInit = {},
  timeoutMs = 15000,
): Promise<any> {
  const res = await f(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    throw new HttpError(res.status, `HTTP ${res.status}: ${messageOf(body) ?? (text.slice(0, 160) || res.statusText)}`);
  }
  if (body === undefined) throw new HttpError(res.status, `Unexpected non-JSON response from ${new URL(url).host}`);
  return body;
}

export function pct(used: number, limit: number): number {
  if (!(limit > 0)) return 0;
  return Math.max(0, Math.min(100, (used / limit) * 100));
}

export function windowIdForSeconds(seconds: number | undefined, fallback: string): string {
  if (!seconds) return fallback;
  if (Math.abs(seconds - 18000) < 120) return '5h';
  if (Math.abs(seconds - 604800) < 3600) return '7d';
  if (Math.abs(seconds - 86400) < 600) return '1d';
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  return `${Math.round(seconds / 3600)}h`;
}

export function errorText(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'Request timed out';
    return err.message;
  }
  return String(err);
}

/** QB_DEBUG=1 prints raw upstream payloads (never credentials) to help diagnose odd numbers. */
export function debug(label: string, data: unknown): void {
  if (process.env.QB_DEBUG) console.log(`[debug] ${label}`, JSON.stringify(data));
}
