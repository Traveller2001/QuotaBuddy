import type { BuddySnapshot, Mood, RefreshEvent, Thresholds, UsageWindow } from './types';

export const DEFAULT_THRESHOLDS: Thresholds = { energetic: 60, relaxed: 35, tired: 15, anxious: 3 };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A window whose reset time has passed has (most likely) been refilled since we last looked. */
export function effectiveUsed(w: UsageWindow, now = Date.now()): number {
  if (w.resetsAt && Date.parse(w.resetsAt) <= now && w.scope !== 'pool') return 0;
  return clamp(w.usedPercent, 0, 100);
}

const counts = (w: UsageWindow) => Number.isFinite(w.usedPercent) && !w.informational;

export function remainingPercent(windows: UsageWindow[], now = Date.now()): number | null {
  const values = windows.filter(counts).map((w) => 100 - effectiveUsed(w, now));
  return values.length ? Math.min(...values) : null;
}

/** The window that limits the user right now (lowest remaining). */
export function bindingWindow(windows: UsageWindow[], now = Date.now()): UsageWindow | undefined {
  let best: UsageWindow | undefined;
  for (const w of windows) {
    if (!counts(w)) continue;
    if (!best || effectiveUsed(w, now) > effectiveUsed(best, now)) best = w;
  }
  return best;
}

export function moodFor(remaining: number | null, t: Thresholds = DEFAULT_THRESHOLDS): Mood {
  if (remaining === null) return 'energetic';
  if (remaining >= t.energetic) return 'energetic';
  if (remaining >= t.relaxed) return 'relaxed';
  if (remaining >= t.tired) return 'tired';
  if (remaining > t.anxious) return 'anxious';
  return 'exhausted';
}

/**
 * Next moment capacity comes back. Prefers explicit refresh events (pool schedule), otherwise
 * derives one from window reset times (an official window restores what was used).
 */
export function nextRefresh(
  windows: UsageWindow[],
  refreshes: RefreshEvent[],
  now = Date.now(),
): RefreshEvent | undefined {
  const upcoming = refreshes
    .filter((r) => Date.parse(r.at) > now)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (upcoming.length) return upcoming[0];
  const fromWindows = windows
    .filter((w) => w.resetsAt && Date.parse(w.resetsAt) > now && w.usedPercent > 0)
    .map<RefreshEvent>((w) => ({
      at: w.resetsAt!,
      kind: w.id,
      restorePercent: w.restorePercent ?? w.usedPercent,
    }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return fromWindows[0];
}

/** Fill in remainingPercent / mood / nextRefresh from the raw windows. */
export function finalize(
  snap: Omit<BuddySnapshot, 'remainingPercent' | 'mood' | 'nextRefresh'>,
  thresholds: Thresholds,
  now = Date.now(),
): BuddySnapshot {
  let remaining = remainingPercent(snap.windows, now);
  if (snap.balance && snap.balance.amount <= 0 && remaining === null) remaining = 0;
  const mood = snap.status === 'ok' ? moodFor(remaining, thresholds) : 'relaxed';
  return {
    ...snap,
    remainingPercent: remaining === null ? null : Math.round(remaining * 10) / 10,
    mood,
    nextRefresh: nextRefresh(snap.windows, snap.refreshes, now),
  };
}
