import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { detectClaude } from '../src/main/detect/claude';
import { detectCodex } from '../src/main/detect/codex';
import { parseRegQuery, parseShellEnv } from '../src/main/env';

function home(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'qb-home-'));
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return dir;
}

const jwt = (payload: object) => `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;

// ------------------------------------------------------------------ Claude Code

test('claude: relay from environment variables', async () => {
  const d = await detectClaude({
    env: { ANTHROPIC_BASE_URL: 'https://relay.example.com:8443', ANTHROPIC_AUTH_TOKEN: 'sk-abc' },
    home: home({}),
    platform: 'linux',
  });
  assert.equal(d.mode, 'relay');
  assert.equal(d.baseUrl, 'https://relay.example.com:8443');
  assert.equal(d.token, 'sk-abc');
});

test('claude: settings.json env overrides the process environment', async () => {
  const h = home({
    '.claude/settings.json': JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://from-settings.example', ANTHROPIC_API_KEY: 'sk-settings' } }),
  });
  const d = await detectClaude({ env: { ANTHROPIC_BASE_URL: 'https://from-env.example', ANTHROPIC_AUTH_TOKEN: 'sk-env' }, home: h, platform: 'linux' });
  assert.equal(d.baseUrl, 'https://from-settings.example');
  assert.equal(d.token, 'sk-env', 'AUTH_TOKEN wins over API_KEY');
});

test('claude: apiKeyHelper supplies the token when no env token exists', async () => {
  const h = home({ '.claude/settings.json': JSON.stringify({ apiKeyHelper: 'print-key', env: { ANTHROPIC_BASE_URL: 'https://r.example' } }) });
  const d = await detectClaude({ env: {}, home: h, platform: 'linux', runHelper: async (cmd) => (cmd === 'print-key' ? 'sk-helper' : null) });
  assert.equal(d.mode, 'relay');
  assert.equal(d.token, 'sk-helper');
});

test('claude: subscription OAuth from .credentials.json', async () => {
  const h = home({
    '.claude/.credentials.json': JSON.stringify({ claudeAiOauth: { accessToken: 'oat-1', expiresAt: 1_900_000_000_000, subscriptionType: 'max' } }),
  });
  const d = await detectClaude({ env: {}, home: h, platform: 'win32' });
  assert.equal(d.mode, 'official-oauth');
  assert.equal(d.oauth?.subscriptionType, 'max');
});

test('claude: subscription OAuth from the macOS keychain', async () => {
  let asked = '';
  const d = await detectClaude({
    env: {},
    home: home({}),
    platform: 'darwin',
    readKeychain: async (service) => {
      asked = service;
      return JSON.stringify({ claudeAiOauth: { accessToken: 'oat-mac' } });
    },
  });
  assert.equal(asked, 'Claude Code-credentials');
  assert.equal(d.mode, 'official-oauth');
  assert.equal(d.oauth?.accessToken, 'oat-mac');
});

test('claude: CLAUDE_CONFIG_DIR, official API key, bedrock and nothing', async () => {
  const custom = home({ 'cfg/.credentials.json': JSON.stringify({ claudeAiOauth: { accessToken: 'oat-custom' } }) });
  const viaDir = await detectClaude({ env: { CLAUDE_CONFIG_DIR: path.join(custom, 'cfg') }, home: home({}), platform: 'linux' });
  assert.equal(viaDir.mode, 'official-oauth');
  assert.equal((await detectClaude({ env: { ANTHROPIC_API_KEY: 'sk-ant' }, home: home({}), platform: 'linux' })).mode, 'official-api');
  const bedrock = await detectClaude({ env: { CLAUDE_CODE_USE_BEDROCK: '1' }, home: home({}), platform: 'linux' });
  assert.equal(bedrock.mode, 'official-api');
  assert.equal(bedrock.cloud, 'bedrock');
  assert.equal((await detectClaude({ env: {}, home: home({}), platform: 'linux' })).mode, 'none');
});

// ------------------------------------------------------------------ Codex

test('codex: custom provider with requires_openai_auth (a typical relay setup)', async () => {
  const h = home({
    '.codex/config.toml': `model_provider = "OpenAI"
model = "gpt-6"

[model_providers.OpenAI]
name = "OpenAI"
base_url = "http://43.0.0.1:8080"
wire_api = "responses"
requires_openai_auth = true

[projects.'C:\\Users\\me\\code']
trust_level = "trusted"
`,
    '.codex/auth.json': JSON.stringify({ OPENAI_API_KEY: 'sk-relay' }),
  });
  const d = await detectCodex({ env: {}, home: h });
  assert.equal(d.mode, 'relay');
  assert.equal(d.providerId, 'OpenAI');
  assert.equal(d.baseUrl, 'http://43.0.0.1:8080');
  assert.equal(d.apiKey, 'sk-relay');
});

test('codex: profile selects a provider whose key comes from env_key', async () => {
  const h = home({
    '.codex/config.toml': `profile = "work"
[profiles.work]
model_provider = "corp"
[model_providers.corp]
base_url = "https://llm.corp.example/v1"
env_key = "CORP_KEY"
`,
  });
  const d = await detectCodex({ env: { CORP_KEY: 'sk-corp' }, home: h });
  assert.equal(d.mode, 'relay');
  assert.equal(d.apiKey, 'sk-corp');
});

test('codex: ChatGPT sign-in gives the official plan, account id from the id token', async () => {
  const h = home({
    '.codex/auth.json': JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: {
        access_token: jwt({ exp: 1_900_000_000 }),
        id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-42' } }),
        refresh_token: 'r',
      },
    }),
  });
  const d = await detectCodex({ env: {}, home: h });
  assert.equal(d.mode, 'official-chatgpt');
  assert.equal(d.chatgpt?.accountId, 'acct-42');
  assert.equal(d.chatgpt?.expiresAt, 1_900_000_000_000);
});

test('codex: OPENAI_BASE_URL turns the built-in provider into a relay; CODEX_HOME is honoured', async () => {
  const h = home({ 'elsewhere/auth.json': JSON.stringify({ OPENAI_API_KEY: 'sk-x' }) });
  const d = await detectCodex({ env: { CODEX_HOME: path.join(h, 'elsewhere'), OPENAI_BASE_URL: 'https://proxy.example/v1' }, home: home({}) });
  assert.equal(d.mode, 'relay');
  assert.equal(d.apiKey, 'sk-x');
  const official = await detectCodex({ env: { CODEX_HOME: path.join(h, 'elsewhere') }, home: home({}) });
  assert.equal(official.mode, 'official-api');
  assert.equal((await detectCodex({ env: {}, home: home({ '.codex/config.toml': 'model_provider = "ollama"' }) })).mode, 'none');
});

// ------------------------------------------------------------------ environment helpers

test('registry and login-shell environment parsing', () => {
  const reg = `
HKEY_CURRENT_USER\\Environment
    ANTHROPIC_BASE_URL    REG_SZ    https://r.example
    OPENAI_HOME    REG_EXPAND_SZ    %USERPROFILE%\\x
    Path    REG_EXPAND_SZ    C:\\bin
`;
  const env = parseRegQuery(reg, { USERPROFILE: 'C:\\Users\\me' });
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://r.example');
  assert.equal(env.OPENAI_HOME, 'C:\\Users\\me\\x');
  const shell = parseShellEnv('motd junk\n__QUOTA_BUDDIES_ENV__\nA=1\nANTHROPIC_BASE_URL=https://x=y\n__QUOTA_BUDDIES_ENV__\n');
  assert.deepEqual(shell, { A: '1', ANTHROPIC_BASE_URL: 'https://x=y' });
});
