import type { Locale } from './types';

/** Compact countdown: 45s, 23m, 1h23m, 2d4h. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0m';
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return h ? `${d}d${h}h` : `${d}d`;
  if (h > 0) return m ? `${h}h${String(m).padStart(2, '0')}m` : `${h}h`;
  return `${m}m`;
}

/** Wall clock time, with weekday when it is not today: "14:05" / "周三 14:05". */
export function formatClock(iso: string, locale: Locale, now = Date.now()): string {
  const date = new Date(iso);
  const hm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return hm;
  const tomorrow = new Date(now + 86400000);
  if (date.toDateString() === tomorrow.toDateString()) return `${locale === 'zh-CN' ? '明天' : 'Tmr'} ${hm}`;
  const weekday = date.toLocaleDateString(locale === 'zh-CN' ? 'zh-CN' : 'en-US', { weekday: 'short' });
  return `${weekday} ${hm}`;
}

export function formatPercent(v: number): string {
  if (v > 0 && v < 1) return '<1';
  return String(Math.round(v));
}

export function formatMoney(v: number, unit = 'USD'): string {
  const sign = unit === 'USD' ? '$' : '';
  const abs = Math.abs(v);
  const digits = abs >= 1000 ? 0 : abs >= 1 ? 2 : 3;
  const body = abs.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${v < 0 ? '-' : ''}${sign}${body}${sign ? '' : ` ${unit}`}`;
}

export function formatCount(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e4) return `${(v / 1e3).toFixed(0)}K`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(Math.round(v));
}

export function hostOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
