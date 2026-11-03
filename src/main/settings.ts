import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_THRESHOLDS } from '../shared/mood';
import { HUD_MODES, type Settings } from '../shared/types';

export const DEFAULT_SETTINGS: Settings = {
  scale: 2,
  showClaude: true,
  showCodex: true,
  locale: 'auto',
  refreshSeconds: 60,
  hudMode: 'both',
  launchAtLogin: false,
  thresholds: DEFAULT_THRESHOLDS,
  loginSkipped: [],
  onboarded: false,
};

export function sanitize(input: any, base: Settings = DEFAULT_SETTINGS): Settings {
  const s: Settings = { ...base, thresholds: { ...base.thresholds }, loginSkipped: [...base.loginSkipped] };
  if (!input || typeof input !== 'object') return s;
  if ([1, 2, 3].includes(input.scale)) s.scale = input.scale;
  if (typeof input.showClaude === 'boolean') s.showClaude = input.showClaude;
  if (typeof input.showCodex === 'boolean') s.showCodex = input.showCodex;
  if (['auto', 'zh-CN', 'en'].includes(input.locale)) s.locale = input.locale;
  if (Number.isFinite(input.refreshSeconds)) s.refreshSeconds = Math.min(3600, Math.max(15, Math.round(input.refreshSeconds)));
  if (HUD_MODES.includes(input.hudMode)) s.hudMode = input.hudMode;
  if (typeof input.launchAtLogin === 'boolean') s.launchAtLogin = input.launchAtLogin;
  if (input.petPosition && Number.isFinite(input.petPosition.x) && Number.isFinite(input.petPosition.y)) {
    s.petPosition = { x: Math.round(input.petPosition.x), y: Math.round(input.petPosition.y) };
  }
  if (Array.isArray(input.loginSkipped)) {
    const origins: string[] = input.loginSkipped.filter((o: unknown): o is string => typeof o === 'string');
    s.loginSkipped = [...new Set(origins)].slice(0, 20);
  }
  if (typeof input.onboarded === 'boolean') s.onboarded = input.onboarded;
  const t = input.thresholds;
  if (t && typeof t === 'object') {
    for (const k of ['energetic', 'relaxed', 'tired', 'anxious'] as const) {
      if (Number.isFinite(t[k])) s.thresholds[k] = Math.min(100, Math.max(0, t[k]));
    }
  }
  return s;
}

export class SettingsStore {
  private value: Settings;

  constructor(private file: string) {
    let raw: any = null;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      raw = null;
    }
    this.value = sanitize(raw);
  }

  get(): Settings {
    return this.value;
  }

  /** Forget a saved pet position (back to the default corner). */
  clearPetPosition(): void {
    const { petPosition: _drop, ...rest } = this.value;
    this.value = sanitize(rest);
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.value, null, 2));
  }

  update(patch: Partial<Settings>): Settings {
    this.value = sanitize({ ...this.value, ...patch, thresholds: { ...this.value.thresholds, ...(patch.thresholds ?? {}) } });
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.value, null, 2));
    return this.value;
  }
}
