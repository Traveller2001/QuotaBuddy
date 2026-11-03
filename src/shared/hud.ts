import { effectiveUsed } from './mood';
import type { BuddySnapshot, HudMode, RefreshEvent, Thresholds, UsageWindow } from './types';

export interface WindowView {
  id: string;
  label: string;
  scope: UsageWindow['scope'];
  /** 0..100 */
  remaining: number;
  /** Next moment this window gives capacity back, and how much (percentage points). */
  refillAt?: string;
  refill?: number;
  detail?: string;
  informational: boolean;
}

/** Pool refresh kinds reported by Sub2API, keyed by our window ids. */
const REFRESH_KIND: Record<string, string> = { '5h': 'five_hour', '7d': 'seven_day', accounts: 'account' };

/** Shorter windows first when two are equally tight: they refill sooner, so they matter now. */
const RANK = ['5h', '1d', 'daily', '7d', 'weekly', 'monthly', 'quota', 'accounts'];
const rank = (id: string) => {
  const i = RANK.indexOf(id);
  return i < 0 ? RANK.length : i;
};

function refillFor(w: UsageWindow, refreshes: RefreshEvent[], now: number): Pick<WindowView, 'refillAt' | 'refill'> {
  const kind = REFRESH_KIND[w.id];
  if (kind) {
    const next = refreshes
      .filter((r) => r.kind === kind && Date.parse(r.at) > now)
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
    if (next) return { refillAt: next.at, refill: next.restorePercent };
  }
  if (w.resetsAt && Date.parse(w.resetsAt) > now) {
    // An official / key window resets to zero: everything used comes back.
    return { refillAt: w.resetsAt, refill: w.restorePercent ?? (w.scope === 'pool' ? undefined : w.usedPercent) };
  }
  return {};
}

/** All windows as display rows, most urgent first (informational ones last). */
export function windowViews(b: BuddySnapshot, now = Date.now()): WindowView[] {
  return b.windows
    .filter((w) => Number.isFinite(w.usedPercent))
    .map((w) => ({
      id: w.id,
      label: w.label,
      scope: w.scope,
      remaining: Math.max(0, Math.min(100, 100 - effectiveUsed(w, now))),
      detail: w.detail,
      informational: !!w.informational,
      ...refillFor(w, b.refreshes, now),
    }))
    .sort((a, b) => Number(a.informational) - Number(b.informational) || a.remaining - b.remaining || rank(a.id) - rank(b.id));
}

/**
 * Rows for the compact meter under a buddy. An explicit choice (5h and 7d together, or one of them)
 * is shown exactly as chosen. Auto shows the tightest window, and every limiting window (up to three)
 * once any drops below the "relaxed" threshold, so the user can tell whether a short wait (5h) or a
 * long one (7d) is coming. A choice the source doesn't have falls back to auto.
 */
export function hudRows(
  b: BuddySnapshot,
  t: Thresholds,
  mode: HudMode = 'auto',
  now = Date.now(),
): { urgent: boolean; rows: WindowView[] } {
  const all = windowViews(b, now).filter((w) => !w.informational);
  if (!all.length) return { urgent: false, rows: [] };
  const urgent = all[0].remaining < t.relaxed;
  const ids = mode === 'both' ? ['5h', '7d'] : mode === 'auto' ? [] : [mode];
  const chosen = ids.map((id) => all.find((w) => w.id === id)).filter((w): w is WindowView => !!w);
  // "every pool account is out" overrides any choice: the windows alone would look usable
  const outage = all.find((w) => w.id === 'accounts' && w.remaining <= 0);
  if (outage && chosen.length) return { urgent: true, rows: [outage, ...chosen] };
  if (chosen.length) return { urgent, rows: chosen };
  return { urgent, rows: urgent ? all.slice(0, 3) : all.slice(0, 1) };
}
