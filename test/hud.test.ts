import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sanitize } from '../src/main/settings';
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
  const { urgent, rows } = hudRows(pool, DEFAULT_THRESHOLDS, 'auto', NOW);
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
  const { urgent, rows } = hudRows(tight, DEFAULT_THRESHOLDS, 'auto', NOW);
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
  const { urgent, rows } = hudRows(weekly, DEFAULT_THRESHOLDS, 'auto', NOW);
  assert.equal(urgent, true);
  assert.deepEqual(
    rows.map((r) => r.id),
    ['7d', '5h'],
  );
});

test('no windows (unlimited balance) yields no rows; panel rows keep informational ones last', () => {
  assert.deepEqual(hudRows(snap([]), DEFAULT_THRESHOLDS, 'auto', NOW), { urgent: false, rows: [] });
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

test('default mode shows 5h then 7d even when calm, each with its own refill', () => {
  const { urgent, rows } = hudRows(pool, DEFAULT_THRESHOLDS, 'both', NOW);
  assert.equal(urgent, false);
  assert.deepEqual(
    rows.map((r) => [r.id, r.remaining, r.refillAt]),
    [
      ['5h', 40, iso(170)],
      ['7d', 79, iso(60)],
    ],
  );
});

test('an explicit choice is shown as chosen, even when another window is tight', () => {
  assert.deepEqual(
    hudRows(pool, DEFAULT_THRESHOLDS, '7d', NOW).rows.map((r) => r.id),
    ['7d'],
  );
  const weekly = snap([
    { id: '5h', label: '5h', usedPercent: 0, scope: 'pool' },
    { id: '7d', label: '7d', usedPercent: 91, scope: 'pool' },
  ]);
  const { urgent, rows } = hudRows(weekly, DEFAULT_THRESHOLDS, '5h', NOW);
  assert.equal(urgent, true);
  assert.deepEqual(
    rows.map((r) => r.id),
    ['5h'],
  );
});

test('a chosen window the source does not have falls back to the tightest', () => {
  const relay = snap([{ id: 'quota', label: 'quota', usedPercent: 30, scope: 'key' }]);
  assert.deepEqual(
    hudRows(relay, DEFAULT_THRESHOLDS, 'both', NOW).rows.map((r) => r.id),
    ['quota'],
  );
});

test('meter choice is per buddy; the old shared setting applies to both', () => {
  assert.deepEqual(sanitize({ hudMode: '5h' }).hudMode, { claude: '5h', codex: '5h' });
  assert.deepEqual(sanitize({ hudMode: { codex: '7d', claude: 'nope' } }).hudMode, { claude: 'both', codex: '7d' });
  assert.deepEqual(sanitize({}).hudMode, { claude: 'both', codex: 'both' });
});

test('a pool outage is always on the meter, whatever window was chosen', () => {
  const out = snap(
    [
      { id: '5h', label: '5h', usedPercent: 40, scope: 'pool' },
      { id: '7d', label: '7d', usedPercent: 20, scope: 'pool' },
      { id: 'accounts', label: 'accounts', usedPercent: 100, scope: 'pool', resetsAt: iso(80) },
    ],
    [{ at: iso(80), kind: 'account' }],
  );
  for (const mode of ['both', '5h', '7d', 'auto'] as const) {
    const { urgent, rows } = hudRows(out, DEFAULT_THRESHOLDS, mode, NOW);
    assert.equal(urgent, true, mode);
    assert.equal(rows[0].id, 'accounts', mode);
    assert.equal(rows[0].refillAt, iso(80), mode);
  }
  assert.equal(out.mood, 'exhausted');
});

test('a shorter window shows no more than a longer one has left, and refills with it', () => {
  // Real case: the only available Codex account has 7d used up but 5h mostly free
  const codex = snap(
    [
      { id: '5h', label: '5h', usedPercent: 83.8, scope: 'pool', resetsAt: iso(160) },
      { id: '7d', label: '7d', usedPercent: 99.8, scope: 'pool', resetsAt: iso(2000) },
    ],
    [
      { at: iso(160), kind: 'five_hour', restorePercent: 8.8 },
      { at: iso(2000), kind: 'seven_day', restorePercent: 24.8 },
    ],
  );
  const views = windowViews(codex, NOW);
  assert.deepEqual(
    views.map((v) => [v.id, Math.round(v.remaining * 10) / 10, v.boundBy, v.refillAt, v.refill && Math.round(v.refill * 10) / 10]),
    [
      ['7d', 0.2, undefined, iso(2000), 24.8],
      ['5h', 0.2, '7d', iso(2000), 16],
    ],
  );
  // 7d is not held back by an empty 5h: its budget is still there
  const short = windowViews(
    snap([
      { id: '5h', label: '5h', usedPercent: 100, scope: 'account' },
      { id: '7d', label: '7d', usedPercent: 30, scope: 'account' },
    ]),
    NOW,
  );
  assert.equal(short.find((v) => v.id === '7d')?.remaining, 70);
});
