import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseClaudeSubscription } from '../src/main/providers/anthropic';
import { latestSessionSnapshot, parseChatGPTUsage, windowsFromSnapshot } from '../src/main/providers/chatgpt';
import { parseBilling } from '../src/main/providers/relay';
import { gatewayRoot, parseKeyUsage, parsePool } from '../src/main/providers/sub2api';

test('gateway root strips trailing /v1 and slashes', () => {
  assert.equal(gatewayRoot('https://a.example:8443'), 'https://a.example:8443');
  assert.equal(gatewayRoot('https://a.example/v1/'), 'https://a.example');
  assert.equal(gatewayRoot('http://1.2.3.4:8080/openai/v1'), 'http://1.2.3.4:8080/openai');
});

test('sub2api /v1/usage: balance mode', () => {
  const p = parseKeyUsage({
    mode: 'unrestricted',
    isValid: true,
    planName: '钱包余额',
    remaining: 983832.78,
    balance: 983832.78,
    unit: 'USD',
    usage: { today: { requests: 5, cost: 0.54, actual_cost: 0.5, total_tokens: 245546 } },
  });
  assert.deepEqual(p.windows, []);
  assert.deepEqual(p.balance, { amount: 983832.78, unit: 'USD' });
  assert.deepEqual(p.today, { requests: 5, costUsd: 0.5, tokens: 245546 });
});

test('sub2api /v1/usage: quota-limited key with rate-limit windows', () => {
  const p = parseKeyUsage({
    mode: 'quota_limited',
    isValid: true,
    status: 'active',
    quota: { limit: 50, used: 12.5, remaining: 37.5, unit: 'USD' },
    rate_limits: [
      { window: '5h', limit: 5, used: 4, remaining: 1, window_start: '2026-11-03T05:00:00Z', reset_at: '2026-11-03T10:00:00Z' },
      { window: '7d', limit: 0, used: 0 },
    ],
    days_until_expiry: 3,
  });
  assert.equal(p.windows.length, 2);
  assert.equal(p.windows[0].id, 'quota');
  assert.equal(p.windows[0].usedPercent, 25);
  assert.equal(p.windows[0].detail, '$12.50 / $50.00');
  assert.equal(p.windows[1].id, '5h');
  assert.equal(p.windows[1].usedPercent, 80);
  assert.equal(p.windows[1].resetsAt, '2026-11-03T10:00:00Z');
  assert.equal(p.notes[0].key, 'note.expiresIn');
});

test('sub2api /v1/usage: subscription group limits', () => {
  const p = parseKeyUsage({
    mode: 'unrestricted',
    isValid: true,
    planName: 'Pro',
    subscription: {
      daily_usage_usd: 3,
      weekly_usage_usd: 30,
      monthly_usage_usd: 50,
      daily_limit_usd: 10,
      weekly_limit_usd: 40,
      monthly_limit_usd: null,
      weekly_window_start: '2026-11-01T00:00:00Z',
    },
  });
  assert.deepEqual(
    p.windows.map((w) => [w.id, w.usedPercent, w.resetsAt]),
    [
      ['daily', 30, undefined],
      ['weekly', 75, '2026-11-08T00:00:00.000Z'],
    ],
  );
  assert.equal(p.plan, 'Pro');
});

test('sub2api pool usage: windows, refill schedule, accounts', () => {
  const p = parsePool({
    available: true,
    partial: false,
    five_hour: { used_percent: 62.5, remaining_percent: 37.5, next_reset_at: '2026-11-03T09:12:00Z', next_restore_percent: 18 },
    seven_day: { used_percent: 40, remaining_percent: 60 },
    accounts_total: 4,
    accounts_available: 3,
    refreshes: [
      { at: '2026-11-03T09:12:00Z', kind: 'five_hour', restore_percent: 18, accounts: 2 },
      { at: '2026-11-03T10:00:00Z', kind: 'account', accounts: 1 },
    ],
  });
  assert.deepEqual(
    p.windows.map((w) => [w.id, w.usedPercent, w.restorePercent, w.scope]),
    [
      ['5h', 62.5, 18, 'pool'],
      ['7d', 40, undefined, 'pool'],
    ],
  );
  assert.deepEqual(p.accounts, { total: 4, available: 3 });
  assert.equal(p.refreshes.length, 2);
  assert.equal(p.refreshes[0].restorePercent, 18);
});

test('sub2api pool usage: every account limited means empty, until accounts come back', () => {
  const p = parsePool({
    available: true,
    accounts_total: 2,
    accounts_available: 0,
    five_hour: { used_percent: 100 },
    refreshes: [{ at: '2026-11-03T10:00:00Z', kind: 'account', accounts: 2 }],
  });
  const acc = p.windows.find((w) => w.id === 'accounts');
  assert.equal(acc?.usedPercent, 100);
  assert.equal(acc?.resetsAt, '2026-11-03T10:00:00Z');
  const unavailable = parsePool({ available: false, reason: 'no accounts', accounts_total: 0, accounts_available: 0 });
  assert.equal(unavailable.notes[0].key, 'note.poolUnavailable');
});

test('official Claude subscription usage', () => {
  const p = parseClaudeSubscription(
    {
      five_hour: { utilization: 37, resets_at: '2026-11-03T11:00:00Z' },
      seven_day: { utilization: 12.5, resets_at: '2026-11-07T00:00:00Z' },
      seven_day_opus: { utilization: 80, resets_at: null },
      seven_day_oauth_apps: null,
    },
    'max',
  );
  assert.deepEqual(
    p.windows.map((w) => [w.id, w.usedPercent, !!w.informational]),
    [
      ['5h', 37, false],
      ['7d', 12.5, false],
      ['7d·Opus', 80, true],
    ],
  );
  assert.equal(p.plan, 'max');
});

test('official ChatGPT / Codex usage', () => {
  const now = Date.parse('2026-11-03T08:00:00Z');
  const p = parseChatGPTUsage(
    {
      plan_type: 'plus',
      rate_limit: {
        allowed: true,
        primary_window: { used_percent: 23, limit_window_seconds: 18000, reset_after_seconds: 3600 },
        secondary_window: { used_percent: 51, limit_window_seconds: 604800, reset_at: 1_793_000_000 },
      },
      credits: { has_credits: false },
    },
    now,
  );
  assert.deepEqual(
    p.windows.map((w) => [w.id, w.usedPercent, w.resetsAt]),
    [
      ['5h', 23, '2026-11-03T09:00:00.000Z'],
      ['7d', 51, new Date(1_793_000_000 * 1000).toISOString()],
    ],
  );
  assert.equal(p.plan, 'plus');
});

test('Codex session-log snapshots (relayed rate-limit headers)', async () => {
  const at = Date.parse('2026-11-01T10:00:00Z');
  assert.deepEqual(windowsFromSnapshot({ primary: null, secondary: null }, at), []);
  const w = windowsFromSnapshot({ primary: { used_percent: 10, window_minutes: 300, resets_in_seconds: 600 }, secondary: { used_percent: 3, window_minutes: 10080, resets_at: 1_793_000_000 } }, at);
  assert.deepEqual(
    w.map((x) => [x.id, x.usedPercent, x.resetsAt]),
    [
      ['5h', 10, '2026-11-01T10:10:00.000Z'],
      ['7d', 3, new Date(1_793_000_000 * 1000).toISOString()],
    ],
  );

  const home = mkdtempSync(path.join(os.tmpdir(), 'qb-codex-'));
  const day = path.join(home, 'sessions', '2026', '11', '01');
  mkdirSync(day, { recursive: true });
  const line = (rl: object, ts: string) => JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', rate_limits: rl } });
  writeFileSync(
    path.join(day, 'rollout-2026-11-01T09-00-00-a.jsonl'),
    [
      line({ primary: { used_percent: 44, window_minutes: 300, resets_at: 1_793_000_000 } }, '2026-11-01T09:00:00Z'),
      line({ primary: { used_percent: 47, window_minutes: 300, resets_at: 1_793_000_000 } }, '2026-11-01T09:05:00Z'),
      line({ primary: null, secondary: null }, '2026-11-01T09:06:00Z'),
    ].join('\n'),
  );
  const snap = await latestSessionSnapshot(home);
  assert.equal(snap?.windows[0].usedPercent, 47);
  assert.equal(snap?.at, Date.parse('2026-11-01T09:05:00Z'));
});

test('one-api style billing', () => {
  assert.equal(parseBilling(20, 5).windows[0].usedPercent, 25);
  const unlimited = parseBilling(100000000, 12);
  assert.equal(unlimited.windows.length, 0);
  assert.ok(unlimited.balance);
});
