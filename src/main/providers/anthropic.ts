import type { ClaudeOAuth } from '../detect/claude';
import { emptyParts, HttpError, requestJson, type FetchFn, type Parts } from './http';

export class TokenExpiredError extends Error {}

const WINDOWS: [key: string, id: string, informational: boolean][] = [
  ['five_hour', '5h', false],
  ['seven_day', '7d', false],
  ['seven_day_opus', '7d·Opus', true],
  ['seven_day_sonnet', '7d·Sonnet', true],
];

/** Official Claude subscription usage (the numbers behind Claude Code's /usage). */
export async function fetchClaudeSubscription(f: FetchFn, oauth: ClaudeOAuth, now = Date.now()): Promise<Parts> {
  if (oauth.expiresAt && oauth.expiresAt < now) throw new TokenExpiredError('Claude OAuth token expired');
  let json: any;
  try {
    json = await requestJson(f, 'https://api.anthropic.com/api/oauth/usage', {
      headers: {
        Authorization: `Bearer ${oauth.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        Accept: 'application/json',
        'User-Agent': 'QuotaBuddy',
      },
    });
  } catch (e) {
    if (e instanceof HttpError && (e.status === 401 || e.status === 403)) throw new TokenExpiredError(e.message);
    throw e;
  }
  return parseClaudeSubscription(json, oauth.subscriptionType);
}

export function parseClaudeSubscription(json: any, plan?: string): Parts {
  const parts = emptyParts();
  for (const [key, id, informational] of WINDOWS) {
    const w = json?.[key];
    if (!w || typeof w.utilization !== 'number') continue;
    parts.windows.push({
      id,
      label: id,
      usedPercent: w.utilization,
      resetsAt: w.resets_at ?? undefined,
      scope: 'account',
      ...(informational ? { informational: true } : {}),
    });
  }
  if (plan) parts.plan = plan;
  return parts;
}
