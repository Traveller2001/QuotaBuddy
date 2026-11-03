export type AgentId = 'claude' | 'codex';

/** Sprite rows, from "quota is plentiful" to "quota is gone". */
export type Mood = 'energetic' | 'relaxed' | 'tired' | 'anxious' | 'exhausted';
export const MOODS: Mood[] = ['energetic', 'relaxed', 'tired', 'anxious', 'exhausted'];

export type SourceKind =
  | 'sub2api' // Sub2API gateway (key usage via API key, pool usage via account login)
  | 'relay' // other OpenAI-compatible relays (new-api / one-api billing endpoints)
  | 'anthropic-oauth' // official Claude Pro / Max subscription
  | 'anthropic-api' // official Anthropic API key, pay as you go
  | 'chatgpt' // official ChatGPT sign-in for Codex
  | 'openai-api' // official OpenAI API key, pay as you go
  | 'none';

export interface UsageWindow {
  /** Stable id: 5h, 7d, 1d, quota, daily, weekly, monthly, 7d-opus, accounts... */
  id: string;
  /** Short label shown in the UI (already human friendly, e.g. "5h", "7d·Opus"). */
  label: string;
  /** 0..100 */
  usedPercent: number;
  /** ISO time at which this window resets / frees capacity. */
  resetsAt?: string;
  /** Percentage points that come back at resetsAt (pool windows); defaults to usedPercent. */
  restorePercent?: number;
  /** Free-form detail such as "$1.20 / $5.00". */
  detail?: string;
  /** pool: shared upstream pool, key: this API key's own limits, account: official subscription. */
  scope: 'pool' | 'key' | 'account';
  /** Shown in the panel but ignored for the mood (e.g. model-specific weekly caps). */
  informational?: boolean;
}

export interface RefreshEvent {
  at: string;
  kind: string; // five_hour | seven_day | account | 5h | 7d | ...
  restorePercent?: number;
  accounts?: number;
}

export interface UsageStats {
  requests?: number;
  costUsd?: number;
  tokens?: number;
}

export interface Note {
  level: 'info' | 'warn' | 'error';
  /** i18n key, see src/shared/i18n.ts */
  key: string;
  params?: Record<string, string | number>;
}

export interface BuddySnapshot {
  agent: AgentId;
  status: 'ok' | 'error' | 'unconfigured' | 'loading';
  source: { kind: SourceKind; label: string; baseUrl?: string; origin?: string };
  windows: UsageWindow[];
  refreshes: RefreshEvent[];
  balance?: { amount: number; unit: string };
  today?: UsageStats;
  accounts?: { total: number; available: number };
  plan?: string;
  notes: Note[];
  error?: string;
  /** Lowest remaining percentage across windows (null = no percentage based limit known). */
  remainingPercent: number | null;
  mood: Mood;
  nextRefresh?: RefreshEvent;
  /** Sub2API: logging in unlocks pool usage (5h / 7d windows and refresh schedule). */
  login?: { origin: string; loggedIn: boolean; email?: string };
  fetchedAt: string;
}

export type Locale = 'zh-CN' | 'en';

export interface Thresholds {
  /** remaining% at or above which the buddy is energetic */
  energetic: number;
  relaxed: number;
  tired: number;
  /** remaining% above which the buddy is merely anxious (at or below: exhausted) */
  anxious: number;
}

/** Which windows the meter under a buddy shows: 5h and 7d, one of them first, or the tightest. */
export type HudMode = 'both' | '5h' | '7d' | 'auto';
export const HUD_MODES: HudMode[] = ['both', '5h', '7d', 'auto'];

export interface Settings {
  scale: 1 | 2 | 3;
  showClaude: boolean;
  showCodex: boolean;
  locale: 'auto' | Locale;
  refreshSeconds: number;
  hudMode: HudMode;
  launchAtLogin: boolean;
  petPosition?: { x: number; y: number };
  thresholds: Thresholds;
  /** Sub2API origins the user chose not to log in to (no onboarding prompt for them). */
  loginSkipped: string[];
  /** Set once the first-run login screen has been offered. */
  onboarded: boolean;
}

export interface AppState {
  buddies: BuddySnapshot[];
  settings: Settings;
  locale: Locale;
  platform: string;
  refreshing: boolean;
  demo: boolean;
  version: string;
}

export interface LoginRequest {
  origin: string;
  email: string;
  password: string;
  totpCode?: string;
  tempToken?: string;
}

export type LoginResult =
  | { ok: true; email: string }
  | { ok: false; error: string; needsTotp?: boolean; tempToken?: string };
