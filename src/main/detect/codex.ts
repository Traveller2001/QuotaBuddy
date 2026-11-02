import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { Note } from '../../shared/types';
import type { Env } from '../env';

export interface ChatGPTAuth {
  accessToken: string;
  accountId?: string;
  expiresAt?: number;
}

export interface CodexDetection {
  home: string;
  mode: 'relay' | 'official-chatgpt' | 'official-api' | 'none';
  providerId?: string;
  baseUrl?: string;
  apiKey?: string;
  chatgpt?: ChatGPTAuth;
  notes: Note[];
}

const LOCAL_PROVIDERS = new Set(['oss', 'ollama', 'lmstudio']);

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

export function decodeJwt(token: string | undefined): any | null {
  if (!token) return null;
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

export function isOfficialOpenAI(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'api.openai.com' || host === 'chatgpt.com' || host.endsWith('.chatgpt.com');
  } catch {
    return false;
  }
}

function chatgptFromAuth(auth: any): ChatGPTAuth | undefined {
  const tokens = auth?.tokens;
  const accessToken = tokens?.access_token;
  if (typeof accessToken !== 'string' || !accessToken) return undefined;
  const access = decodeJwt(accessToken);
  const id = decodeJwt(tokens?.id_token);
  const claim = (c: any) => c?.['https://api.openai.com/auth']?.chatgpt_account_id;
  return {
    accessToken,
    accountId: tokens?.account_id ?? claim(id) ?? claim(access),
    expiresAt: typeof access?.exp === 'number' ? access.exp * 1000 : undefined,
  };
}

/** Resolves Codex's active model provider, endpoint and credentials from ~/.codex. */
export async function detectCodex(opts: { env: Env; home?: string }): Promise<CodexDetection> {
  const env = opts.env;
  const home = env.CODEX_HOME || path.join(opts.home ?? os.homedir(), '.codex');
  const notes: Note[] = [];
  const result: CodexDetection = { home, mode: 'none', notes };

  let config: any = {};
  const configText = await readText(path.join(home, 'config.toml'));
  if (configText) {
    try {
      config = parseToml(configText);
    } catch {
      config = {};
    }
  }
  let auth: any = null;
  const authText = await readText(path.join(home, 'auth.json'));
  if (authText) {
    try {
      auth = JSON.parse(authText);
    } catch {
      auth = null;
    }
  }
  if (!auth && config.cli_auth_credentials_store === 'keyring') notes.push({ level: 'warn', key: 'note.keyring' });

  const profile = typeof config.profile === 'string' ? config.profiles?.[config.profile] : undefined;
  const providerId: string = profile?.model_provider ?? config.model_provider ?? 'openai';
  result.providerId = providerId;

  const apiKeyFromAuth: string | undefined = auth?.OPENAI_API_KEY || undefined;
  const chatgpt = chatgptFromAuth(auth);
  const custom = config.model_providers?.[providerId];

  if (custom && typeof custom === 'object') {
    const baseUrl: string | undefined = custom.base_url;
    let key: string | undefined;
    if (custom.env_key) key = env[custom.env_key];
    else if (custom.experimental_bearer_token) key = custom.experimental_bearer_token;
    else if (custom.requires_openai_auth) key = apiKeyFromAuth ?? env.OPENAI_API_KEY;
    if (baseUrl && !isOfficialOpenAI(baseUrl)) {
      result.mode = 'relay';
      result.baseUrl = baseUrl;
      result.apiKey = key;
      if (!key) notes.push({ level: 'warn', key: 'note.noAuth', params: { agent: 'Codex' } });
      return result;
    }
  } else if (LOCAL_PROVIDERS.has(providerId)) {
    return result;
  } else if (providerId === 'openai') {
    const baseUrl = env.OPENAI_BASE_URL || config.openai_base_url;
    if (baseUrl && !isOfficialOpenAI(baseUrl)) {
      result.mode = 'relay';
      result.baseUrl = baseUrl;
      result.apiKey = apiKeyFromAuth ?? env.OPENAI_API_KEY;
      if (!result.apiKey) notes.push({ level: 'warn', key: 'note.noAuth', params: { agent: 'Codex' } });
      return result;
    }
  }

  // Official OpenAI endpoint: ChatGPT sign-in has quota windows, API keys are pay as you go.
  const preferChatGPT = auth?.auth_mode === 'chatgpt' || (!apiKeyFromAuth && chatgpt);
  if (chatgpt && preferChatGPT) {
    result.mode = 'official-chatgpt';
    result.chatgpt = chatgpt;
  } else if (apiKeyFromAuth || env.OPENAI_API_KEY) {
    result.mode = 'official-api';
    result.apiKey = apiKeyFromAuth ?? env.OPENAI_API_KEY;
  }
  return result;
}
