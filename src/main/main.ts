import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  net,
  powerMonitor,
  safeStorage,
  screen,
  session,
  shell,
  Tray,
  type MenuItemConstructorOptions,
} from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { formatPercent } from '../shared/format';
import { resolveLocale, t } from '../shared/i18n';
import type { AgentId, AppState, BuddySnapshot, LoginRequest, LoginResult, Settings } from '../shared/types';
import { collectClaude, collectCodex, type CollectContext } from './collect';
import { demoSnapshots, parseDemoArg } from './demo';
import { detectClaude } from './detect/claude';
import { detectCodex } from './detect/codex';
import { loadEnv, type Env } from './env';
import { errorText, type FetchFn } from './providers/http';
import { login as sub2apiLogin } from './providers/sub2api';
import { SessionStore } from './sessions';
import { selfTest } from './selftest';
import { SettingsStore } from './settings';

const ROOT = path.join(__dirname, '..', '..');
const asset = (...p: string[]) => path.join(ROOT, 'assets', ...p);
const page = (name: string) => path.join(ROOT, 'dist', 'renderer', `${name}.html`);
const preload = path.join(ROOT, 'dist', 'preload', 'preload.js');
const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';
const PANEL_WIDTH = 360;
const CAPTURE_DIR = process.env.QB_CAPTURE;

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let pet: BrowserWindow | null = null;
let panel: BrowserWindow | null = null;
let tray: Tray | null = null;
let settings: SettingsStore;
let sessions: SessionStore;
let petsVisible = true;
let panelHiddenAt = 0;
let pollTimer: NodeJS.Timeout | null = null;
let envCache: { at: number; env: Env } | null = null;
const insecureHosts = new Set<string>();
const demoArg = parseDemoArg(process.argv, process.env);
let demo = demoArg.on;
const startedAt = Date.now();
let savedPosition: { x: number; y: number } | undefined;

const state: AppState = {
  buddies: [],
  settings: undefined as unknown as Settings,
  locale: 'en',
  platform: process.platform,
  refreshing: false,
  demo,
  version: app.getVersion(),
};

// ------------------------------------------------------------------ state & polling

function broadcast(): void {
  state.settings = settings.get();
  state.locale = resolveLocale(state.settings.locale, app.getLocale());
  state.demo = demo;
  for (const w of [pet, panel]) if (w && !w.isDestroyed()) w.webContents.send('state', state);
  updateTray();
}

async function getEnv(): Promise<Env> {
  if (envCache && Date.now() - envCache.at < 5 * 60_000) return envCache.env;
  const env = await loadEnv();
  envCache = { at: Date.now(), env };
  return env;
}

function errorSnapshot(agent: AgentId, err: unknown): BuddySnapshot {
  return {
    agent,
    status: 'error',
    source: { kind: 'none', label: '' },
    windows: [],
    refreshes: [],
    notes: [],
    error: errorText(err),
    remainingPercent: null,
    mood: 'relaxed',
    fetchedAt: new Date().toISOString(),
  };
}

const netFetch: FetchFn = (url, init) => net.fetch(url, init as any) as unknown as Promise<Response>;

async function refreshAll(): Promise<void> {
  if (state.refreshing) return;
  state.refreshing = true;
  broadcast();
  try {
    const s = settings.get();
    if (demo) {
      state.buddies = demoSnapshots(Date.now(), startedAt, s.thresholds, demoArg.fixed);
    } else {
      const env = await getEnv();
      const [claudeDet, codexDet] = await Promise.all([detectClaude({ env }), detectCodex({ env })]);
      insecureHosts.clear();
      if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
        // Mirror Node-based CLIs: the user explicitly allowed untrusted certificates.
        for (const url of [claudeDet.baseUrl, codexDet.baseUrl]) {
          try {
            if (url) insecureHosts.add(new URL(url).hostname);
          } catch {
            // ignore invalid URLs
          }
        }
      }
      const ctx: CollectContext = { fetch: netFetch, sessions, thresholds: s.thresholds };
      const results = await Promise.allSettled([collectClaude(claudeDet, ctx), collectCodex(codexDet, ctx)]);
      state.buddies = results.map((r, i) => (r.status === 'fulfilled' ? r.value : errorSnapshot(i ? 'codex' : 'claude', r.reason)));
      if (!sessions.persistent) {
        for (const b of state.buddies) if (b.login) b.notes.push({ level: 'info', key: 'note.noSecureStorage' });
      }
    }
  } catch (e) {
    console.error('refresh failed', e);
  } finally {
    state.refreshing = false;
    broadcast();
  }
}

function schedule(): void {
  if (pollTimer) clearTimeout(pollTimer);
  const seconds = demo ? 7 : settings.get().refreshSeconds;
  pollTimer = setTimeout(async () => {
    await refreshAll();
    schedule();
  }, seconds * 1000);
}

// ------------------------------------------------------------------ windows

function webPreferences(): Electron.WebPreferences {
  return { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false };
}

function defaultPetPosition(width: number, height: number): { x: number; y: number } {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - width - 24, y: wa.y + wa.height - height - 4 };
}

function onSomeDisplay(x: number, y: number, w: number, h: number): boolean {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return x + w > a.x + 20 && x < a.x + a.width - 20 && y + h > a.y + 20 && y < a.y + a.height - 20;
  });
}

function createPet(): void {
  const width = 320;
  const height = 230;
  const saved = settings.get().petPosition;
  const pos = saved && onSomeDisplay(saved.x, saved.y, width, height) ? saved : defaultPetPosition(width, height);
  pet = new BrowserWindow({
    ...pos,
    width,
    height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    focusable: !isLinux ? false : true,
    show: false,
    backgroundColor: '#00000000',
    title: 'Quota Buddies',
    webPreferences: webPreferences(),
  });
  pet.setAlwaysOnTop(true, 'floating');
  if (isMac) pet.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (!isLinux) pet.setIgnoreMouseEvents(true, { forward: true });
  pet.loadFile(page('pet'));
  pet.once('ready-to-show', () => {
    if (petsVisible) pet?.showInactive();
  });
  pet.on('closed', () => (pet = null));
}

function createPanel(): void {
  panel = new BrowserWindow({
    width: PANEL_WIDTH,
    height: 520,
    minHeight: 120,
    transparent: true,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    title: 'Quota Buddies',
    webPreferences: webPreferences(),
  });
  panel.setAlwaysOnTop(true, 'floating');
  if (isMac) panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  panel.loadFile(page('panel'));
  panel.on('blur', () => {
    if (CAPTURE_DIR) return;
    panel?.hide();
    panelHiddenAt = Date.now();
  });
  panel.on('closed', () => (panel = null));
}

/** Content height reported by the panel renderer. Windows ignores setSize on hidden windows, so
 *  the size is applied right before showing (and live while visible). */
let panelHeight = 520;
function applyPanelSize(): void {
  if (!panel) return;
  const wa = screen.getDisplayMatching(panel.getBounds()).workArea;
  const h = Math.round(Math.min(Math.max(panelHeight, 160), wa.height - 24));
  const [w, current] = panel.getSize();
  if (w !== PANEL_WIDTH || Math.abs(current - h) >= 2) panel.setSize(PANEL_WIDTH, h);
}

type Anchor = 'pet' | 'tray';
let lastAnchor: Anchor = 'pet';

function positionPanel(anchor: Anchor = lastAnchor): void {
  if (!panel) return;
  const [w, h] = panel.getSize();
  let ref: Electron.Rectangle | null = null;
  if (anchor === 'tray' && tray) ref = tray.getBounds();
  if ((!ref || ref.width === 0) && pet && petsVisible) ref = pet.getBounds();
  const display = ref ? screen.getDisplayMatching(ref) : screen.getPrimaryDisplay();
  const wa = display.workArea;
  let x: number;
  let y: number;
  if (!ref) {
    x = wa.x + wa.width - w - 16;
    y = wa.y + wa.height - h - 16;
  } else if (anchor === 'tray') {
    x = Math.round(ref.x + ref.width / 2 - w / 2);
    y = ref.y < wa.y + wa.height / 2 ? ref.y + ref.height + 4 : ref.y - h - 4;
  } else {
    x = ref.x + ref.width - w;
    y = ref.y - h + 24;
    if (y < wa.y) y = ref.y + ref.height + 4;
  }
  x = Math.min(Math.max(x, wa.x + 4), wa.x + wa.width - w - 4);
  y = Math.min(Math.max(y, wa.y + 4), wa.y + wa.height - h - 4);
  panel.setPosition(x, y);
}

function togglePanel(anchor: Anchor = 'pet'): void {
  if (!panel) return;
  if (panel.isVisible()) {
    panel.hide();
    return;
  }
  if (Date.now() - panelHiddenAt < 300) return; // the click that blurred the panel
  lastAnchor = anchor;
  panel.show();
  applyPanelSize();
  positionPanel(anchor);
  panel.focus();
}

function setPetsVisible(visible: boolean): void {
  petsVisible = visible;
  if (!pet) return;
  if (visible) pet.showInactive();
  else pet.hide();
  updateTray();
}

// ------------------------------------------------------------------ tray & menus

function lowestRemaining(): number | null {
  const vals = state.buddies.filter((b) => b.status === 'ok' && b.remainingPercent !== null).map((b) => b.remainingPercent!);
  return vals.length ? Math.min(...vals) : null;
}

function menuTemplate(): MenuItemConstructorOptions[] {
  const L = state.locale;
  return [
    { label: t(L, 'tray.openPanel'), click: () => togglePanel(lastAnchor) },
    { label: t(L, 'tray.refresh'), click: () => void refreshAll() },
    { type: 'separator' },
    { label: t(L, petsVisible ? 'tray.hidePets' : 'tray.showPets'), click: () => setPetsVisible(!petsVisible) },
    {
      label: t(L, 'tray.launchAtLogin'),
      type: 'checkbox',
      checked: settings.get().launchAtLogin,
      click: (item) => applySettings({ launchAtLogin: item.checked }),
    },
    { type: 'separator' },
    { label: t(L, 'tray.quit'), click: () => app.quit() },
  ];
}

function createTray(): void {
  const image = isMac
    ? nativeImage.createFromPath(asset('icons', 'trayTemplate.png'))
    : nativeImage.createFromPath(asset('icons', 'tray.png'));
  if (isMac) image.setTemplateImage(true);
  tray = new Tray(image);
  tray.on('click', () => togglePanel('tray'));
  tray.on('right-click', () => tray?.popUpContextMenu(Menu.buildFromTemplate(menuTemplate())));
  updateTray();
}

function updateTray(): void {
  if (!tray || !settings) return;
  const L = state.locale;
  const parts = state.buddies
    .filter((b) => b.status !== 'unconfigured')
    .map((b) => {
      const name = t(L, `agent.${b.agent}`);
      if (b.status === 'error') return `${name}: ${t(L, 'ui.error')}`;
      return `${name}: ${b.remainingPercent === null ? '∞' : `${formatPercent(b.remainingPercent)}%`} · ${t(L, `mood.${b.mood}`)}`;
    });
  tray.setToolTip([t(L, 'app.name'), ...parts].join('\n'));
  if (isMac) {
    const low = lowestRemaining();
    tray.setTitle(low === null ? '' : ` ${formatPercent(low)}%`, { fontType: 'monospacedDigit' });
  }
  // Linux tray icons (AppIndicator) do not emit click events, so they need a context menu.
  if (isLinux) tray.setContextMenu(Menu.buildFromTemplate(menuTemplate()));
}

function applySettings(patch: Partial<Settings>): Settings {
  const before = settings.get();
  const next = settings.update(patch);
  if (patch.launchAtLogin !== undefined && app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: next.launchAtLogin });
  }
  if (patch.refreshSeconds !== undefined && patch.refreshSeconds !== before.refreshSeconds) schedule();
  if (patch.thresholds) void refreshAll();
  broadcast();
  return next;
}

// ------------------------------------------------------------------ IPC

function knownOrigin(origin: string): boolean {
  return state.buddies.some((b) => b.login?.origin === origin);
}

function registerIpc(): void {
  ipcMain.handle('state:get', () => {
    state.settings = settings.get();
    state.locale = resolveLocale(state.settings.locale, app.getLocale());
    return state;
  });
  ipcMain.on('refresh', () => void refreshAll());
  ipcMain.handle('settings:update', (_e, patch: Partial<Settings>) => applySettings(patch));
  ipcMain.handle('demo:set', async (_e, on: boolean) => {
    demo = !!on;
    await refreshAll();
    schedule();
  });

  ipcMain.handle('login', async (_e, req: LoginRequest): Promise<LoginResult> => {
    if (!knownOrigin(req.origin)) return { ok: false, error: 'Unknown server' };
    try {
      const totp = req.tempToken && req.totpCode ? { tempToken: req.tempToken, code: req.totpCode } : undefined;
      const r = await sub2apiLogin(netFetch, req.origin, req.email, req.password, totp);
      if (r.kind === 'totp') return { ok: false, error: '', needsTotp: true, tempToken: r.tempToken };
      sessions.set(req.origin, { email: r.email, ...r.tokens, keyIds: {} });
      void refreshAll();
      return { ok: true, email: r.email };
    } catch (e) {
      return { ok: false, error: errorText(e) };
    }
  });
  ipcMain.handle('logout', async (_e, origin: string) => {
    sessions.delete(origin);
    await refreshAll();
  });

  ipcMain.on('panel:toggle', () => togglePanel('pet'));
  ipcMain.on('panel:hide', () => panel?.hide());
  ipcMain.on('panel:resize', (_e, height: number) => {
    panelHeight = height;
    if (panel?.isVisible()) {
      applyPanelSize();
      positionPanel();
    }
  });

  ipcMain.on('pet:resize', (_e, width: number, height: number) => {
    if (!pet) return;
    const b = pet.getBounds();
    const w = Math.round(width);
    const h = Math.round(height);
    if (w === b.width && h === b.height) return;
    // keep the bottom-right corner fixed so the buddies stay "on the ground"
    pet.setBounds({ x: b.x + b.width - w, y: b.y + b.height - h, width: w, height: h });
  });
  ipcMain.on('pet:ignore-mouse', (_e, ignore: boolean) => {
    if (!pet || isLinux) return;
    pet.setIgnoreMouseEvents(!!ignore, { forward: true });
  });
  let drag: { mx: number; my: number; wx: number; wy: number } | null = null;
  ipcMain.on('pet:drag', (_e, phase: string, x: number, y: number) => {
    if (!pet) return;
    if (phase === 'start') {
      const [wx, wy] = pet.getPosition();
      drag = { mx: x, my: y, wx, wy };
    } else if (phase === 'move' && drag) {
      pet.setPosition(Math.round(drag.wx + x - drag.mx), Math.round(drag.wy + y - drag.my));
    } else if (phase === 'end' && drag) {
      drag = null;
      const [px, py] = pet.getPosition();
      settings.update({ petPosition: { x: px, y: py } });
    }
  });
  ipcMain.on('pet:menu', () => {
    if (pet) Menu.buildFromTemplate(menuTemplate()).popup({ window: pet });
  });
  ipcMain.on('open-external', (_e, url: string) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
  });
}

// ------------------------------------------------------------------ capture (screenshots for docs / checks)

async function capture(): Promise<void> {
  if (!CAPTURE_DIR || !pet || !panel) return;
  mkdirSync(CAPTURE_DIR, { recursive: true });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await wait(2500);
  const frames = Number(process.env.QB_CAPTURE_FRAMES || 1);
  for (let i = 0; i < frames; i++) {
    const img = await pet.webContents.capturePage();
    writeFileSync(path.join(CAPTURE_DIR, frames > 1 ? `pet-${String(i).padStart(3, '0')}.png` : 'pet.png'), img.toPNG());
    if (frames > 1) await wait(Number(process.env.QB_CAPTURE_INTERVAL || 120));
  }
  lastAnchor = 'pet';
  panel.showInactive();
  applyPanelSize();
  positionPanel('pet');
  await wait(1500);
  const shot = await panel.webContents.capturePage();
  writeFileSync(path.join(CAPTURE_DIR, 'panel.png'), shot.toPNG());
  writeFileSync(path.join(CAPTURE_DIR, 'state.json'), JSON.stringify(state, null, 2));
  app.quit();
}

// ------------------------------------------------------------------ lifecycle

app.on('second-instance', () => togglePanel(lastAnchor));
app.on('window-all-closed', () => {
  // keep running in the tray
});

app.whenReady().then(async () => {
  if (isMac) app.dock?.hide();
  if (process.platform === 'win32') app.setAppUserModelId('io.github.quotabuddies.app');
  const userData = app.getPath('userData');
  settings = new SettingsStore(path.join(userData, 'settings.json'));
  savedPosition = settings.get().petPosition;
  sessions = new SessionStore(path.join(userData, 'sessions.json'), {
    // Linux without a keyring falls back to "basic_text", which is not real protection: keep
    // logins in memory there instead of writing them to disk.
    available: async () =>
      (await safeStorage.isAsyncEncryptionAvailable()) && !(isLinux && safeStorage.getSelectedStorageBackend() === 'basic_text'),
    encrypt: async (s) => (await safeStorage.encryptStringAsync(s)).toString('base64'),
    decrypt: async (b) => (await safeStorage.decryptStringAsync(Buffer.from(b, 'base64'))).result,
  });
  await sessions.load();
  state.settings = settings.get();
  state.locale = resolveLocale(state.settings.locale, app.getLocale());

  session.defaultSession.setCertificateVerifyProc((req, cb) => cb(insecureHosts.has(req.hostname) ? 0 : -3));

  registerIpc();
  createPet();
  createPanel();
  createTray();
  powerMonitor.on('resume', () => void refreshAll());
  await refreshAll();
  schedule();
  void capture();
  if (process.env.QB_SELFTEST && pet && panel) {
    void selfTest(pet, panel, (code) => {
      // keep the user's real settings untouched by the synthetic drag
      if (savedPosition) settings.update({ petPosition: savedPosition });
      app.exit(code);
    });
  }
});
