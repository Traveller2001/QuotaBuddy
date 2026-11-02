import { finalize } from '../shared/mood';
import type { AgentId, BuddySnapshot, Mood, Thresholds } from '../shared/types';

const LEVELS: Record<Mood, number> = { energetic: 88, relaxed: 48, tired: 24, anxious: 8, exhausted: 0 };
const CYCLE: Mood[] = ['energetic', 'relaxed', 'tired', 'anxious', 'exhausted'];

/**
 * Fake data for `--demo`: each buddy walks through all moods (or stays on the moods given as
 * `--demo=energetic,anxious`) so the UI can be previewed without any account.
 */
export function demoSnapshots(now: number, startedAt: number, thresholds: Thresholds, fixed?: Mood[]): BuddySnapshot[] {
  const step = Math.floor((now - startedAt) / 7000);
  const agents: AgentId[] = ['claude', 'codex'];
  return agents.map((agent, i) => {
    const mood = fixed?.[i] ?? CYCLE[(step + i * 2) % CYCLE.length];
    const remaining = LEVELS[mood];
    const used = 100 - remaining;
    const min = 60000;
    const base = {
      agent,
      status: 'ok' as const,
      source: { kind: 'sub2api' as const, label: agent === 'claude' ? 'claude.example.com' : 'codex.example.com', origin: 'https://demo.example.com' },
      windows: [
        { id: '5h', label: '5h', usedPercent: used, resetsAt: new Date(now + 83 * min).toISOString(), restorePercent: Math.min(used, 18), scope: 'pool' as const },
        { id: '7d', label: '7d', usedPercent: Math.round(used * 0.55), resetsAt: new Date(now + 3 * 1440 * min).toISOString(), restorePercent: 12, scope: 'pool' as const },
      ],
      refreshes: [
        { at: new Date(now + (agent === 'claude' ? 23 : 47) * min).toISOString(), kind: 'five_hour', restorePercent: Math.min(used, 18), accounts: 2 },
        { at: new Date(now + 100 * min).toISOString(), kind: 'account', accounts: 1 },
        { at: new Date(now + 2 * 1440 * min + 300 * min).toISOString(), kind: 'seven_day', restorePercent: 30, accounts: 3 },
      ],
      accounts: { total: 4, available: remaining <= 0 ? 0 : 3 },
      today: { requests: 128 + i * 40, costUsd: 3.42 + i, tokens: 1830000 + i * 400000 },
      notes: [],
      login: { origin: 'https://demo.example.com', loggedIn: true, email: 'demo@example.com' },
      fetchedAt: new Date(now).toISOString(),
    };
    return finalize(base, thresholds, now);
  });
}

export function parseDemoArg(argv: string[], env: NodeJS.ProcessEnv): { on: boolean; fixed?: Mood[] } {
  const arg = argv.find((a) => a === '--demo' || a.startsWith('--demo='));
  const raw = arg?.includes('=') ? arg.split('=')[1] : env.QB_DEMO && env.QB_DEMO !== '1' ? env.QB_DEMO : undefined;
  if (!arg && !env.QB_DEMO) return { on: false };
  const fixed = raw
    ?.split(',')
    .map((m) => m.trim())
    .filter((m): m is Mood => CYCLE.includes(m as Mood));
  return { on: true, fixed: fixed?.length ? fixed : undefined };
}
