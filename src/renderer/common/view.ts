import { formatClock, formatDuration, formatPercent, hostOf } from '../../shared/format';
import { bindingWindow } from '../../shared/mood';
import { hasKey, t } from '../../shared/i18n';
import type { BuddySnapshot, Locale, Mood, RefreshEvent, UsageWindow } from '../../shared/types';

export const MOOD_COLORS: Record<Mood, string> = {
  energetic: '#4fe07a',
  relaxed: '#a6e05a',
  tired: '#f2c94c',
  anxious: '#ff9142',
  exhausted: '#ff5a5a',
};

export const AGENT_COLORS = { claude: '#e07a55', codex: '#d9dbe3' } as const;

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function windowLabel(L: Locale, w: UsageWindow): string {
  return hasKey(`win.${w.id}`) ? t(L, `win.${w.id}`) : w.label;
}

export function sourceLabel(L: Locale, b: BuddySnapshot): string {
  return t(L, `source.${b.source.kind}`, { host: b.source.label || hostOf(b.source.baseUrl) });
}

export function remainingText(b: BuddySnapshot): string {
  if (b.status === 'error') return '?';
  if (b.status === 'unconfigured') return '-';
  if (b.remainingPercent === null) return '∞';
  return `${formatPercent(b.remainingPercent)}%`;
}

export function refreshRestore(r: RefreshEvent): number | undefined {
  return typeof r.restorePercent === 'number' && r.restorePercent > 0 ? Math.round(r.restorePercent) : undefined;
}

/** "1h23m +18%" (compact, for the HUD) */
export function compactRefill(r: RefreshEvent | undefined, now = Date.now()): string {
  if (!r) return '';
  const left = Date.parse(r.at) - now;
  if (left <= 0) return '';
  const pct = refreshRestore(r);
  return `↻${formatDuration(left)}${pct ? ` +${pct}%` : ''}`;
}

/** Sentence for bubbles: "1h23m 后 +18%" / "+18% in 1h23m" */
export function refillSentence(L: Locale, r: RefreshEvent | undefined, now = Date.now()): string | null {
  if (!r) return null;
  const left = Date.parse(r.at) - now;
  if (left <= 0) return null;
  const pct = refreshRestore(r);
  if (pct) return t(L, 'ui.restoreIn', { time: formatDuration(left), pct });
  return t(L, 'ui.resetsIn', { time: formatDuration(left) });
}

export function windowResetText(L: Locale, w: UsageWindow, now = Date.now()): string {
  if (!w.resetsAt) return '';
  const left = Date.parse(w.resetsAt) - now;
  if (left <= 0) return '';
  if (w.scope === 'pool' && w.restorePercent) {
    return t(L, 'ui.restoreAt', { clock: formatClock(w.resetsAt, L, now), pct: Math.round(w.restorePercent) });
  }
  return t(L, 'ui.resetsIn', { time: formatDuration(left) });
}

export function hudWindow(b: BuddySnapshot): UsageWindow | undefined {
  return bindingWindow(b.windows);
}

export function kindLabel(L: Locale, kind: string): string {
  return hasKey(`kind.${kind}`) ? t(L, `kind.${kind}`) : kind;
}
