import { open, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { UsageWindow } from '../../shared/types';
import type { ChatGPTAuth } from '../detect/codex';
import { emptyParts, HttpError, requestJson, windowIdForSeconds, type FetchFn, type Parts } from './http';
import { TokenExpiredError } from './anthropic';

function resetIso(w: any, now: number): string | undefined {
  if (typeof w?.reset_at === 'number') return new Date(w.reset_at * 1000).toISOString();
  if (typeof w?.resets_at === 'number') return new Date(w.resets_at * 1000).toISOString();
  if (typeof w?.reset_after_seconds === 'number') return new Date(now + w.reset_after_seconds * 1000).toISOString();
  if (typeof w?.resets_in_seconds === 'number') return new Date(now + w.resets_in_seconds * 1000).toISOString();
  return undefined;
}

/** Official ChatGPT plan usage for Codex (the numbers behind Codex's /status). */
export async function fetchChatGPTUsage(f: FetchFn, auth: ChatGPTAuth, now = Date.now()): Promise<Parts> {
  if (auth.expiresAt && auth.expiresAt < now) throw new TokenExpiredError('ChatGPT token expired');
  let json: any;
  try {
    json = await requestJson(f, 'https://chatgpt.com/backend-api/wham/usage', {
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        ...(auth.accountId ? { 'ChatGPT-Account-Id': auth.accountId } : {}),
        Accept: 'application/json',
        'User-Agent': 'codex_cli_rs (quota-buddies)',
        originator: 'codex_cli_rs',
      },
    });
  } catch (e) {
    if (e instanceof HttpError && (e.status === 401 || e.status === 403)) throw new TokenExpiredError(e.message);
    throw e;
  }
  return parseChatGPTUsage(json, now);
}

export function parseChatGPTUsage(json: any, now = Date.now()): Parts {
  const parts = emptyParts();
  const rl = json?.rate_limit ?? {};
  const pairs: [any, string][] = [
    [rl.primary_window, '5h'],
    [rl.secondary_window, '7d'],
  ];
  for (const [w, fallback] of pairs) {
    if (!w || typeof w.used_percent !== 'number') continue;
    const id = windowIdForSeconds(w.limit_window_seconds, fallback);
    parts.windows.push({ id, label: id, usedPercent: w.used_percent, resetsAt: resetIso(w, now), scope: 'account' });
  }
  if (typeof json?.plan_type === 'string') parts.plan = json.plan_type;
  if (json?.credits?.has_credits && !json.credits.unlimited && json.credits.balance != null) {
    parts.balance = { amount: Number(json.credits.balance), unit: 'credits' };
  }
  return parts;
}

// ------------------------------------------------------------------ session log fallback

/** Converts a Codex `rate_limits` snapshot ({primary, secondary}) into windows. */
export function windowsFromSnapshot(rl: any, observedAt: number): UsageWindow[] {
  const out: UsageWindow[] = [];
  const pairs: [any, string][] = [
    [rl?.primary, '5h'],
    [rl?.secondary, '7d'],
  ];
  for (const [w, fallback] of pairs) {
    if (!w || typeof w.used_percent !== 'number') continue;
    const id = windowIdForSeconds(typeof w.window_minutes === 'number' ? w.window_minutes * 60 : undefined, fallback);
    out.push({ id, label: id, usedPercent: w.used_percent, resetsAt: resetIso(w, observedAt), scope: 'account' });
  }
  return out;
}

async function newestEntries(dir: string, n: number): Promise<string[]> {
  try {
    const names = (await readdir(dir)).sort().reverse();
    return names.slice(0, n).map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

async function tail(file: string, bytes: number): Promise<string> {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

/**
 * Codex writes the rate limit headers it receives into its session logs
 * (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl). Reading the newest snapshot works offline and
 * for any upstream that forwards those headers.
 */
export async function latestSessionSnapshot(codexHome: string): Promise<{ windows: UsageWindow[]; at: number } | null> {
  const files: string[] = [];
  for (const year of await newestEntries(path.join(codexHome, 'sessions'), 2)) {
    for (const month of await newestEntries(year, 2)) {
      for (const day of await newestEntries(month, 3)) {
        files.push(...(await newestEntries(day, 4)).filter((f) => f.endsWith('.jsonl')));
        if (files.length >= 6) break;
      }
      if (files.length >= 6) break;
    }
    if (files.length >= 6) break;
  }
  files.sort((a, b) => path.basename(b).localeCompare(path.basename(a)));
  for (const file of files.slice(0, 6)) {
    let text: string;
    try {
      text = await tail(file, 512 * 1024);
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.includes('"rate_limits"') || !line.includes('"used_percent"')) continue;
      try {
        const entry = JSON.parse(line);
        const rl = entry?.payload?.rate_limits ?? entry?.rate_limits;
        const at = Date.parse(entry?.timestamp) || Date.now();
        const windows = windowsFromSnapshot(rl, at);
        if (windows.length) return { windows, at };
      } catch {
        // partial first line of the tail or unrelated record
      }
    }
  }
  return null;
}
