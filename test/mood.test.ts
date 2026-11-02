import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDuration } from '../src/shared/format';
import { DEFAULT_THRESHOLDS, finalize, moodFor, nextRefresh, remainingPercent } from '../src/shared/mood';
import type { UsageWindow } from '../src/shared/types';

const NOW = Date.parse('2026-11-03T08:00:00Z');
const iso = (minutes: number) => new Date(NOW + minutes * 60000).toISOString();

test('moods follow the remaining-percent thresholds', () => {
  assert.equal(moodFor(null), 'energetic');
  assert.equal(moodFor(100), 'energetic');
  assert.equal(moodFor(60), 'energetic');
  assert.equal(moodFor(59.9), 'relaxed');
  assert.equal(moodFor(35), 'relaxed');
  assert.equal(moodFor(20), 'tired');
  assert.equal(moodFor(14), 'anxious');
  assert.equal(moodFor(3.5), 'anxious');
  assert.equal(moodFor(3), 'exhausted');
  assert.equal(moodFor(0), 'exhausted');
});

test('remaining is the tightest window, ignoring informational and already-reset windows', () => {
  const windows: UsageWindow[] = [
    { id: '5h', label: '5h', usedPercent: 30, scope: 'account', resetsAt: iso(60) },
    { id: '7d', label: '7d', usedPercent: 70, scope: 'account', resetsAt: iso(3000) },
    { id: '7d·Opus', label: '7d·Opus', usedPercent: 99, scope: 'account', informational: true },
    { id: '1d', label: '1d', usedPercent: 95, scope: 'key', resetsAt: iso(-5) },
  ];
  assert.equal(remainingPercent(windows, NOW), 30);
  assert.equal(remainingPercent([], NOW), null);
});

test('pool windows keep their usage after next_reset_at (it is only a partial refill)', () => {
  const pool: UsageWindow[] = [{ id: '5h', label: '5h', usedPercent: 90, scope: 'pool', resetsAt: iso(-1) }];
  assert.equal(remainingPercent(pool, NOW), 10);
});

test('next refresh prefers the explicit pool schedule, else the soonest window reset', () => {
  const windows: UsageWindow[] = [
    { id: '5h', label: '5h', usedPercent: 40, scope: 'account', resetsAt: iso(90) },
    { id: '7d', label: '7d', usedPercent: 10, scope: 'account', resetsAt: iso(30) },
  ];
  assert.deepEqual(nextRefresh(windows, [], NOW), { at: iso(30), kind: '7d', restorePercent: 10 });
  const refreshes = [
    { at: iso(-10), kind: 'five_hour', restorePercent: 5 },
    { at: iso(45), kind: 'account', accounts: 1 },
    { at: iso(20), kind: 'five_hour', restorePercent: 12, accounts: 2 },
  ];
  assert.equal(nextRefresh(windows, refreshes, NOW)?.at, iso(20));
});

test('finalize derives mood; errors are never "energetic"; empty balance is exhausted', () => {
  const base = { agent: 'claude' as const, source: { kind: 'sub2api' as const, label: 'x' }, refreshes: [], notes: [], fetchedAt: iso(0) };
  const ok = finalize({ ...base, status: 'ok', windows: [{ id: '5h', label: '5h', usedPercent: 92, scope: 'pool' }] }, DEFAULT_THRESHOLDS, NOW);
  assert.equal(ok.mood, 'anxious');
  assert.equal(ok.remainingPercent, 8);
  const err = finalize({ ...base, status: 'error', windows: [] }, DEFAULT_THRESHOLDS, NOW);
  assert.equal(err.mood, 'relaxed');
  const broke = finalize({ ...base, status: 'ok', windows: [], balance: { amount: 0, unit: 'USD' } }, DEFAULT_THRESHOLDS, NOW);
  assert.equal(broke.mood, 'exhausted');
});

test('durations are compact', () => {
  assert.equal(formatDuration(30_000), '30s');
  assert.equal(formatDuration(23 * 60000), '23m');
  assert.equal(formatDuration(83 * 60000), '1h23m');
  assert.equal(formatDuration(120 * 60000), '2h');
  assert.equal(formatDuration((2 * 1440 + 300) * 60000), '2d5h');
});
