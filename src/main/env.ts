import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/** Variables we care about; everything else from the login shell is ignored. */
const INTERESTING = /^(ANTHROPIC_|CLAUDE_|OPENAI_|CODEX_|AZURE_OPENAI)/i;

export type Env = Record<string, string>;

/**
 * GUI apps do not see variables exported in shell profiles (macOS Finder / Dock launches) and on
 * Windows only see the environment Explorer had when it started. So besides process.env we read
 * the login shell environment (macOS / Linux) or the registry (Windows). process.env wins.
 */
export async function loadEnv(): Promise<Env> {
  const env: Env = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
  let extra: Env = {};
  try {
    extra = process.platform === 'win32' ? await windowsRegistryEnv() : await loginShellEnv();
  } catch {
    // best effort: fall back to process.env only
  }
  for (const [k, v] of Object.entries(extra)) {
    if (!(k in env) && INTERESTING.test(k)) env[k] = v;
  }
  return env;
}

export function parseRegQuery(stdout: string, expandFrom: Env): Env {
  const out: Env = {};
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s+(\S+)\s+(REG_SZ|REG_EXPAND_SZ)\s+(.*)$/.exec(line);
    if (!m) continue;
    let value = m[3];
    if (m[2] === 'REG_EXPAND_SZ') value = value.replace(/%([^%]+)%/g, (all, name: string) => expandFrom[name] ?? all);
    out[m[1]] = value;
  }
  return out;
}

async function regQuery(key: string): Promise<Env> {
  const { stdout } = await execFileP('reg', ['query', key], { windowsHide: true, timeout: 4000 });
  return parseRegQuery(stdout, process.env as Env);
}

async function windowsRegistryEnv(): Promise<Env> {
  const [machine, user] = await Promise.all([
    regQuery('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment').catch(() => ({})),
    regQuery('HKCU\\Environment').catch(() => ({})),
  ]);
  return { ...machine, ...user };
}

const MARKER = '__QUOTA_BUDDIES_ENV__';

export function parseShellEnv(stdout: string): Env {
  const start = stdout.indexOf(MARKER);
  const end = stdout.lastIndexOf(MARKER);
  if (start < 0 || end <= start) return {};
  const out: Env = {};
  for (const line of stdout.slice(start + MARKER.length, end).split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

async function loginShellEnv(): Promise<Env> {
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  const { stdout } = await execFileP(shell, ['-ilc', `echo ${MARKER}; env; echo ${MARKER}`], {
    timeout: 6000,
    env: { ...process.env, DISABLE_AUTO_UPDATE: 'true', ZSH_TMUX_AUTOSTART: 'false' },
    maxBuffer: 4 * 1024 * 1024,
  });
  return parseShellEnv(stdout);
}
