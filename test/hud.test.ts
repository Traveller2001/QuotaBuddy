import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hudRows, windowViews } from '../src/shared/hud';
import { DEFAULT_THRESHOLDS, finalize } from '../src/shared/mood';
import type { UsageWindow } from '../src/shared/types';

const NOW = Date.parse('2026-11-03T08:00:00Z');
const iso = (minutes: number) => new Date(NOW + minutes * 60000).toISOString();

function snap(windows: UsageWindow[], refreshes: { at: string; kind: string; restorePercent?: number }[] = []) {
  return finalize(
    { agent: 'claude', status: 'ok', source: { kind: 'sub2api', label: 'x' }, windows, refreshes, notes: [], fetchedAt: iso(0) },
    DEFAULT_THRESHOLDS,
    NOW,
  );
}

// Real numbers from a Sub2API pool: 5h used 60%, 7d used 21%.
const pool = snap(
  [
    { id: '5h', label: '5h', usedPercent: 60, scope: 'pool', resetsAt: iso(170), restorePercent: 60 },
    { id: '7d', label: '7d', usedPercent: 21, scope: 'pool', resetsAt: iso(60), restorePercent: 21 },
  ],
  [
    { at: iso(60), kind: 'seven_day', restorePercent: 21 },
    { at: iso(170), kind: 'five_hour', restorePercent: 60 },
  ],
);

test('calm: only the tightest window is shown, with its own refill', () => {
  const { urgent, rows } = hudRows(pool, DEFAULT_THRESHOLDS, NOW);
  assert.equal(urgent, false);
  assert.deepEqual(
    rows.map((r) => [r.id, r.remaining, r.refillAt, r.refill]),
    [['5h', 40, iso(170), 60]],
  );
});

test('urgent: every limiting window is shown, tightest first', () => {
  const tight = snap([
    { id: '7d', label: '7d', usedPercent: 70, scope: 'account', resetsAt: iso(4000) },
    { id: '5h', label: '5h', usedPercent: 92, scope: 'account', resetsAt: iso(50) },
    { id: '7d·Opus', label: '7d·Opus', usedPercent: 99, scope: 'account', informational: true },
  ]);
  const { urgent, rows } = hudRows(tight, DEFAULT_THRESHOLDS, NOW);
  assert.equal(urgent, true);
  assert.deepEqual(
    rows.map((r) => [r.id, r.remaining, r.refill]),
    [
      ['5h', 8, 92],
      ['7d', 30, 70],
    ],
  );
});

test('a tight long window alone also counts as urgent and shows the short one too', () => {
  const weekly = snap([
    { id: '5h', label: '5h', usedPercent: 10, scope: 'pool' },
    { id: '7d', label: '7d', usedPercent: 85, scope: 'pool' },
  ]);
  const { urgent, rows } = hudRows(weekly, DEFAULT_THRESHOLDS, NOW);
  assert.equal(urgent, true);
  assert.deepEqual(
    rows.map((r) => r.id),
    ['7d', '5h'],
  );
});

test('no windows (unlimited balance) yields no rows; panel rows keep informational ones last', () => {
  assert.deepEqual(hudRows(snap([]), DEFAULT_THRESHOLDS, NOW), { urgent: false, rows: [] });
  const views = windowViews(
    snap([
      { id: '7d·Opus', label: '7d·Opus', usedPercent: 99, scope: 'account', informational: true },
      { id: '5h', label: '5h', usedPercent: 50, scope: 'account' },
    ]),
    NOW,
  );
  assert.deepEqual(
    views.map((v) => v.id),
    ['5h', '7d·Opus'],
  );
});
