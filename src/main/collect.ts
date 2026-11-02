import { finalize } from '../shared/mood';
import type { AgentId, BuddySnapshot, Note, SourceKind, Thresholds } from '../shared/types';
import type { ClaudeDetection } from './detect/claude';
import type { CodexDetection } from './detect/codex';
import { fetchClaudeSubscription, TokenExpiredError } from './providers/anthropic';
import { fetchChatGPTUsage, latestSessionSnapshot } from './providers/chatgpt';
import { errorText, HttpError, type FetchFn, type Parts } from './providers/http';
import { fetchOpenAIBilling } from './providers/relay';
import {
  fetchKeyUsage,
  fetchPoolUsage,
  findKeyId,
  gatewayRoot,
  originOf,
  parseKeyUsage,
  parsePool,
  refreshTokens,
} from './providers/sub2api';
import { fingerprint, SessionExpiredError, type SessionStore } from './sessions';

export interface CollectContext {
  fetch: FetchFn;
  sessions: SessionStore;
  thresholds: Thresholds;
}

type Draft = Omit<BuddySnapshot, 'remainingPercent' | 'mood' | 'nextRefresh'>;

function draft(agent: AgentId, kind: SourceKind, label: string, extra: Partial<Draft['source']> = {}): Draft {
  return {
    agent,
    status: 'ok',
    source: { kind, label, ...extra },
    windows: [],
    refreshes: [],
    notes: [],
    fetchedAt: new Date().toISOString(),
  };
}

function merge(d: Draft, p: Parts): void {
  d.windows.push(...p.windows);
  d.refreshes.push(...p.refreshes);
  d.notes.push(...p.notes);
  if (p.balance) d.balance = p.balance;
  if (p.today) d.today = p.today;
  if (p.accounts) d.accounts = p.accounts;
  if (p.plan) d.plan = p.plan;
}

const fail = (d: Draft, err: unknown, note?: Note): Draft => {
  d.status = 'error';
  d.error = errorText(err);
  if (note) d.notes.push(note);
  return d;
};

async function poolParts(ctx: CollectContext, origin: string, apiKey: string): Promise<Parts> {
  const refresh = (rt: string) => refreshTokens(ctx.fetch, origin, rt);
  let session = await ctx.sessions.fresh(origin, refresh);
  const run = async () => {
    let id = session.keyIds?.[fingerprint(apiKey)];
    if (!id) {
      const found = await findKeyId(ctx.fetch, origin, session.accessToken, apiKey);
      if (!found) throw new Error('this API key does not belong to the logged-in account');
      ctx.sessions.rememberKeyId(origin, apiKey, found);
      id = found;
    }
    return parsePool(await fetchPoolUsage(ctx.fetch, origin, session.accessToken, id));
  };
  try {
    return await run();
  } catch (e) {
    if (e instanceof HttpError && e.status === 401) {
      session = await ctx.sessions.fresh(origin, refresh, true);
      return run();
    }
    throw e;
  }
}

/** Any OpenAI / Anthropic compatible relay: Sub2API first, then one-api style billing. */
async function collectRelay(agent: AgentId, baseUrl: string, key: string | undefined, ctx: CollectContext, notes: Note[]): Promise<Draft> {
  let host = baseUrl;
  let origin = baseUrl;
  try {
    host = new URL(baseUrl).host;
    origin = originOf(baseUrl);
  } catch {
    const d = draft(agent, 'relay', baseUrl, { baseUrl });
    return fail(d, new Error(`Invalid base URL: ${baseUrl}`));
  }
  const d = draft(agent, 'relay', host, { baseUrl, origin });
  d.notes.push(...notes);
  if (!key) return fail(d, new Error('No API key found'));
  const root = gatewayRoot(baseUrl);

  let usage: any = null;
  try {
    usage = await fetchKeyUsage(ctx.fetch, root, key);
  } catch (e) {
    if (e instanceof HttpError && e.status === 401) return fail(d, e, { level: 'error', key: 'note.keyInvalid' });
    if (!(e instanceof HttpError && (e.status === 404 || e.status === 405))) return fail(d, e);
  }

  if (usage) {
    d.source.kind = 'sub2api';
    merge(d, parseKeyUsage(usage));
    const session = ctx.sessions.get(origin);
    d.login = { origin, loggedIn: !!session, email: session?.email };
    if (!session) {
      d.notes.push({ level: 'info', key: 'note.loginForPool', params: { host } });
      return d;
    }
    try {
      merge(d, await poolParts(ctx, origin, key));
    } catch (e) {
      if (e instanceof SessionExpiredError) {
        d.login = { origin, loggedIn: false };
        d.notes.push({ level: 'warn', key: 'note.sessionExpired', params: { host } });
      } else {
        d.notes.push({ level: 'warn', key: 'note.poolUnavailable', params: { reason: `: ${errorText(e)}` } });
      }
    }
    return d;
  }

  try {
    const billing = await fetchOpenAIBilling(ctx.fetch, root, key);
    if (billing) {
      merge(d, billing);
      return d;
    }
  } catch {
    // fall through
  }
  d.status = 'error';
  d.notes.push({ level: 'warn', key: 'note.unknownRelay' });
  return d;
}

export async function collectClaude(det: ClaudeDetection, ctx: CollectContext): Promise<BuddySnapshot> {
  let d: Draft;
  switch (det.mode) {
    case 'relay':
      d = await collectRelay('claude', det.baseUrl!, det.token, ctx, det.notes);
      break;
    case 'official-api':
      d = draft('claude', 'anthropic-api', det.cloud ?? 'api.anthropic.com');
      d.notes.push({ level: 'info', key: 'note.payg' });
      break;
    case 'official-oauth':
      d = draft('claude', 'anthropic-oauth', 'claude.ai');
      try {
        merge(d, await fetchClaudeSubscription(ctx.fetch, det.oauth!));
      } catch (e) {
        fail(d, e, e instanceof TokenExpiredError ? { level: 'warn', key: 'note.oauthExpired' } : undefined);
      }
      break;
    default:
      d = draft('claude', 'none', '');
      d.status = 'unconfigured';
      d.notes.push(...det.notes, { level: 'info', key: 'note.notConfigured', params: { agent: 'Claude Code' } });
  }
  return finalize(d, ctx.thresholds);
}

async function withSessionSnapshot(d: Draft, codexHome: string): Promise<boolean> {
  const snap = await latestSessionSnapshot(codexHome).catch(() => null);
  if (!snap) return false;
  d.windows.push(...snap.windows);
  const at = new Date(snap.at);
  d.notes.push({
    level: 'info',
    key: 'note.sessionSnapshot',
    params: { time: `${at.getMonth() + 1}/${at.getDate()} ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}` },
  });
  return true;
}

export async function collectCodex(det: CodexDetection, ctx: CollectContext): Promise<BuddySnapshot> {
  let d: Draft;
  switch (det.mode) {
    case 'relay':
      d = await collectRelay('codex', det.baseUrl!, det.apiKey, ctx, det.notes);
      // Pass-through relays forward Codex's rate limit headers; use them when nothing else is known.
      if (d.status === 'ok' && d.windows.length === 0) await withSessionSnapshot(d, det.home);
      break;
    case 'official-api':
      d = draft('codex', 'openai-api', 'api.openai.com');
      d.notes.push({ level: 'info', key: 'note.payg' });
      break;
    case 'official-chatgpt':
      d = draft('codex', 'chatgpt', 'chatgpt.com');
      try {
        merge(d, await fetchChatGPTUsage(ctx.fetch, det.chatgpt!));
      } catch (e) {
        const expired = e instanceof TokenExpiredError;
        if (!(await withSessionSnapshot(d, det.home))) {
          fail(d, e, expired ? { level: 'warn', key: 'note.chatgptExpired' } : undefined);
        } else if (expired) {
          d.notes.push({ level: 'warn', key: 'note.chatgptExpired' });
        }
      }
      break;
    default:
      d = draft('codex', 'none', '');
      d.status = 'unconfigured';
      d.notes.push(...det.notes, { level: 'info', key: 'note.notConfigured', params: { agent: 'Codex' } });
  }
  return finalize(d, ctx.thresholds);
}
