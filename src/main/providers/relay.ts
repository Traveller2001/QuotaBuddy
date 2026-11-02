import { formatMoney } from '../../shared/format';
import { emptyParts, pct, requestJson, type FetchFn, type Parts } from './http';

const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * OpenAI-style billing endpoints implemented by one-api / new-api and many other relays.
 * Returns null when the relay does not implement them.
 */
export async function fetchOpenAIBilling(f: FetchFn, root: string, key: string): Promise<Parts | null> {
  const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' };
  let sub: any;
  try {
    sub = await requestJson(f, `${root}/v1/dashboard/billing/subscription`, { headers });
  } catch {
    return null;
  }
  const limit = Number(sub?.hard_limit_usd ?? sub?.system_hard_limit_usd);
  if (!Number.isFinite(limit)) return null;
  const now = new Date();
  const start = new Date(now.getTime() - 99 * 86400000);
  const end = new Date(now.getTime() + 86400000);
  let usedUsd = 0;
  try {
    const usage = await requestJson(f, `${root}/v1/dashboard/billing/usage?start_date=${day(start)}&end_date=${day(end)}`, { headers });
    usedUsd = Number(usage?.total_usage ?? 0) / 100;
  } catch {
    // some relays only implement the subscription endpoint
  }
  return parseBilling(limit, usedUsd);
}

export function parseBilling(limitUsd: number, usedUsd: number): Parts {
  const parts = emptyParts();
  if (limitUsd >= 1e8) {
    // one-api reports "unlimited" tokens as a huge hard limit
    parts.balance = { amount: limitUsd - usedUsd, unit: 'USD' };
    return parts;
  }
  parts.windows.push({
    id: 'quota',
    label: 'quota',
    usedPercent: pct(usedUsd, limitUsd),
    detail: `${formatMoney(usedUsd)} / ${formatMoney(limitUsd)}`,
    scope: 'key',
  });
  return parts;
}
