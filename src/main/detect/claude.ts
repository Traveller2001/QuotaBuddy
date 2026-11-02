import { exec, execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Note } from '../../shared/types';
import type { Env } from '../env';

const execP = promisify(exec);
const execFileP = promisify(execFile);

export interface ClaudeOAuth {
  accessToken: string;
  expiresAt?: number;
  subscriptionType?: string;
}

export interface ClaudeDetection {
  configDir: string;
  mode: 'relay' | 'official-oauth' | 'official-api' | 'none';
  baseUrl?: string;
  token?: string;
  oauth?: ClaudeOAuth;
  /** Bedrock / Vertex / Foundry deployments are pay as you go. */
  cloud?: string;
  notes: Note[];
}

export interface ClaudeDetectOptions {
  env: Env;
  home?: string;
  platform?: NodeJS.Platform;
  /** macOS keychain reader (injectable for tests). */
  readKeychain?: (service: string) => Promise<string | null>;
  /** Runs settings.apiKeyHelper (injectable for tests). */
  runHelper?: (command: string) => Promise<string | null>;
}

async function readJson(file: string): Promise<any | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

export function managedSettingsPath(platform: NodeJS.Platform): string {
  if (platform === 'win32') return 'C:\\ProgramData\\ClaudeCode\\managed-settings.json';
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json';
  return '/etc/claude-code/managed-settings.json';
}

export function isOfficialAnthropic(url: string): boolean {
  try {
    return new URL(url).hostname === 'api.anthropic.com';
  } catch {
    return false;
  }
}

async function defaultKeychain(service: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('security', ['find-generic-password', '-s', service, '-w'], { timeout: 5000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function defaultHelper(command: string): Promise<string | null> {
  try {
    const { stdout } = await execP(command, { timeout: 10000, windowsHide: true });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function parseOAuth(raw: any): ClaudeOAuth | undefined {
  const o = raw?.claudeAiOauth;
  if (!o || typeof o.accessToken !== 'string' || !o.accessToken) return undefined;
  return {
    accessToken: o.accessToken,
    expiresAt: typeof o.expiresAt === 'number' ? o.expiresAt : undefined,
    subscriptionType: typeof o.subscriptionType === 'string' ? o.subscriptionType : undefined,
  };
}

/**
 * Resolves how Claude Code talks to its upstream, mirroring Claude Code's own precedence:
 * managed settings env > user settings env > process / shell environment.
 */
export async function detectClaude(opts: ClaudeDetectOptions): Promise<ClaudeDetection> {
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? os.homedir();
  const configDir = opts.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const notes: Note[] = [];

  const userSettings = (await readJson(path.join(configDir, 'settings.json'))) ?? {};
  const managed = (await readJson(managedSettingsPath(platform))) ?? {};
  const env: Env = { ...opts.env, ...(userSettings.env ?? {}), ...(managed.env ?? {}) };

  const result: ClaudeDetection = { configDir, mode: 'none', notes };

  const cloud = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].find(
    (k) => env[k] && env[k] !== '0' && env[k].toLowerCase() !== 'false',
  );
  if (cloud) {
    result.mode = 'official-api';
    result.cloud = cloud.replace('CLAUDE_CODE_USE_', '').toLowerCase();
    return result;
  }

  result.baseUrl = env.ANTHROPIC_BASE_URL?.trim() || undefined;
  result.token = env.ANTHROPIC_AUTH_TOKEN?.trim() || env.ANTHROPIC_API_KEY?.trim() || undefined;
  const helper = managed.apiKeyHelper ?? userSettings.apiKeyHelper;
  if (!result.token && typeof helper === 'string' && helper.trim()) {
    result.token = (await (opts.runHelper ?? defaultHelper)(helper)) ?? undefined;
  }

  let oauth = parseOAuth(await readJson(path.join(configDir, '.credentials.json')));
  if (!oauth && platform === 'darwin') {
    const raw = await (opts.readKeychain ?? defaultKeychain)('Claude Code-credentials');
    if (raw) {
      try {
        oauth = parseOAuth(JSON.parse(raw));
      } catch {
        // not JSON: ignore
      }
    }
  }
  result.oauth = oauth;

  if (result.baseUrl && !isOfficialAnthropic(result.baseUrl)) {
    result.mode = 'relay';
    if (!result.token) notes.push({ level: 'warn', key: 'note.noAuth', params: { agent: 'Claude Code' } });
  } else if (result.token) {
    result.mode = 'official-api';
  } else if (oauth) {
    result.mode = 'official-oauth';
  }
  return result;
}
