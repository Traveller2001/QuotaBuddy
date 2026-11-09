import { formatClock, formatCount, formatDuration, formatMoney, hostOf } from '../../shared/format';
import { windowViews, type WindowView } from '../../shared/hud';
import { hasKey, t } from '../../shared/i18n';
import { moodFor } from '../../shared/mood';
import type { AgentId, AppState, BuddySnapshot, HudMode, Locale, Mood, Settings, Thresholds, UsageWindow } from '../../shared/types';
import { qb } from '../common/api';
import { SpriteAnimator } from '../common/sprites';
import { AGENT_COLORS, esc, kindLabel, MOOD_COLORS, sourceLabel, windowLabel } from '../common/view';

type View = 'login' | 'overview' | 'settings';

const REPO_URL = 'https://github.com/Traveller2001/QuotaBuddy';
const OFFLINE = '#8d8a9e';
const BAR = 24;
/** Notes that belong to the login flow rather than the overview. */
const LOGIN_NOTES = new Set(['note.loginForPool', 'note.sessionExpired', 'note.noSecureStorage']);

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const root = $('root');
const views = $('views');
const tabs = $('tabs');
const ink = tabs.querySelector<HTMLElement>('.ink')!;
let state: AppState | null = null;
let view: View = 'overview';
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const L = () => state?.locale ?? 'en';
const short = (locale: Locale, id: string) => (hasKey(`short.${id}`) ? t(locale, `short.${id}`) : id);
const label = (locale: Locale, w: Pick<WindowView, 'id' | 'label'>) => windowLabel(locale, w as UsageWindow);

// ------------------------------------------------------------------ small helpers

const frames = new WeakMap<HTMLElement, number>();
/** Rolls a number to its new value instead of jumping. */
function tween(el: HTMLElement, to: number, fmt: (v: number) => string): void {
  const from = el.dataset.v === undefined ? to : Number(el.dataset.v);
  el.dataset.v = String(to);
  cancelAnimationFrame(frames.get(el) ?? 0);
  if (reduceMotion || Math.abs(from - to) < 0.5) {
    el.textContent = fmt(to);
    return;
  }
  const start = performance.now();
  const step = (now: number) => {
    const p = Math.min(1, (now - start) / 520);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt(from + (to - from) * eased);
    if (p < 1) frames.set(el, requestAnimationFrame(step));
  };
  frames.set(el, requestAnimationFrame(step));
}

function tickCountdowns(): void {
  const now = Date.now();
  for (const el of document.querySelectorAll<HTMLElement>('[data-at]')) {
    const left = Date.parse(el.dataset.at!) - now;
    el.textContent = left > 0 ? formatDuration(left) : '';
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (html) node.innerHTML = html;
  return node;
}

function sprite(agent: AgentId, mood: Mood): { canvas: HTMLCanvasElement; anim: SpriteAnimator } {
  const canvas = document.createElement('canvas');
  const anim = new SpriteAnimator(canvas, agent, 1);
  anim.setMood(mood);
  return { canvas, anim };
}

// ------------------------------------------------------------------ overview: one card per buddy

class WinRow {
  readonly el = el('div', 'win');
  private name: HTMLElement;
  private scope: HTMLElement;
  private pct: HTMLElement;
  private segs: HTMLElement[];
  private when: HTMLElement;
  private foot: HTMLElement;

  constructor() {
    this.el.innerHTML = `
      <div class="win-head"><span><span class="win-name"></span> <span class="win-scope"></span></span><span class="win-pct"></span></div>
      <div class="bar">${'<i></i>'.repeat(BAR)}</div>
      <div class="win-foot"><span class="win-when"></span></div>`;
    this.name = this.el.querySelector('.win-name')!;
    this.scope = this.el.querySelector('.win-scope')!;
    this.pct = this.el.querySelector('.win-pct')!;
    this.segs = [...this.el.querySelectorAll<HTMLElement>('.bar i')];
    this.segs.forEach((s, i) => (s.style.transitionDelay = `${i * 12}ms`));
    this.when = this.el.querySelector('.win-when')!;
    this.foot = this.el.querySelector('.win-foot')!;
  }

  update(w: WindowView, locale: Locale, th: Thresholds): void {
    this.el.classList.toggle('informational', w.informational);
    this.name.textContent = label(locale, w);
    this.scope.textContent = `· ${t(locale, `scope.${w.scope}`)}`;
    this.el.style.setProperty('--c', MOOD_COLORS[moodFor(w.remaining, th)]);
    tween(this.pct, w.remaining, (v) => `${Math.round(v)}%`);
    const lit = w.remaining <= 0 ? 0 : Math.max(1, Math.round((w.remaining / 100) * BAR));
    const soon = w.refill ? Math.min(BAR - lit, Math.round((Math.min(100 - w.remaining, w.refill) / 100) * BAR)) : 0;
    this.segs.forEach((s, i) => {
      s.classList.toggle('on', i < lit);
      s.classList.toggle('soon', i >= lit && i < lit + soon);
    });
    // refill timing lives in the timeline; the row only keeps extra detail such as "$1.20 / $5.00"
    const bound = w.boundBy ? t(locale, 'ui.boundBy', { label: windowLabel(locale, { id: w.boundBy, label: w.boundBy } as UsageWindow) }) : '';
    // the gateway's web UI shows the pool figure over every account: say so when it differs
    const pool =
      w.poolRemaining !== undefined && w.poolRemaining - w.remaining >= 1 ? t(locale, 'ui.poolFigure', { pct: Math.round(w.poolRemaining) }) : '';
    this.when.textContent = [w.detail, bound, pool].filter(Boolean).join(' · ');
    this.foot.hidden = !this.when.textContent;
  }
}

interface RefillItem {
  at: string;
  what: string;
  plus?: number;
  back?: boolean;
}

/** Taller screens get a taller panel before it starts scrolling. */
const maxViewsHeight = () => Math.max(320, window.screen.availHeight - 170);

function refillItems(b: BuddySnapshot, locale: Locale): RefillItem[] {
  const now = Date.now();
  let items: RefillItem[] = b.refreshes
    .filter((r) => Date.parse(r.at) > now)
    .map((r) =>
      r.kind === 'account'
        ? { at: r.at, what: t(locale, 'refill.accounts', { n: r.accounts ?? 1 }), back: true }
        : { at: r.at, what: kindLabel(locale, r.kind), plus: r.restorePercent || undefined },
    );
  if (!items.length) {
    items = windowViews(b)
      .filter((w) => !w.informational && w.refillAt)
      .map((w) => ({ at: w.refillAt!, what: kindLabel(locale, w.id), plus: w.refill || undefined }));
  }
  return items.sort((a, c) => Date.parse(a.at) - Date.parse(c.at)).slice(0, 4);
}

function pickNote(b: BuddySnapshot): BuddySnapshot['notes'][number] | undefined {
  const order = { error: 0, warn: 1, info: 2 } as const;
  return b.notes.filter((n) => !LOGIN_NOTES.has(n.key)).sort((a, c) => order[a.level] - order[c.level])[0];
}

class Card {
  readonly el = el('article', 'card');
  private anim: SpriteAnimator;
  private name: HTMLElement;
  private chip: HTMLElement;
  private source: HTMLElement;
  private hero: HTMLElement;
  private heroNum: HTMLElement;
  private heroLabel: HTMLElement;
  private error: HTMLElement;
  private wins: HTMLElement;
  private rows = new Map<string, WinRow>();
  private refills: HTMLElement;
  private refillsTitle: HTMLElement;
  private timeline: HTMLElement;
  private stats: HTMLElement;
  private note: HTMLElement;

  constructor(readonly agent: AgentId) {
    this.el.style.setProperty('--accent', AGENT_COLORS[agent]);
    this.el.innerHTML = `
      <div class="card-top">
        <div class="avatar"></div>
        <div class="who"><div class="name-row"><span class="name"></span><span class="chip"></span></div><div class="source"></div></div>
        <div class="hero"><span class="hero-num"></span><span class="hero-label"></span></div>
      </div>
      <div class="note error" hidden></div>
      <div class="wins"></div>
      <div class="refills" hidden><div class="sec-title"></div><ol class="timeline"></ol></div>
      <div class="stats"></div>
      <div class="note" hidden></div>`;
    const s = sprite(agent, 'relaxed');
    this.anim = s.anim;
    this.el.querySelector('.avatar')!.appendChild(s.canvas);
    this.name = this.el.querySelector('.name')!;
    this.chip = this.el.querySelector('.chip')!;
    this.source = this.el.querySelector('.source')!;
    this.hero = this.el.querySelector('.hero')!;
    this.heroNum = this.el.querySelector('.hero-num')!;
    this.heroLabel = this.el.querySelector('.hero-label')!;
    this.error = this.el.querySelector('.note.error')!;
    this.wins = this.el.querySelector('.wins')!;
    this.refills = this.el.querySelector('.refills')!;
    this.refillsTitle = this.el.querySelector('.refills .sec-title')!;
    this.timeline = this.el.querySelector('.timeline')!;
    this.stats = this.el.querySelector('.stats')!;
    this.note = this.el.querySelector('.note:not(.error)')!;
  }

  update(b: BuddySnapshot, locale: Locale, th: Thresholds): void {
    const ok = b.status === 'ok';
    this.el.classList.toggle('offline', !ok);
    this.anim.setMood(b.mood);
    const color = ok ? MOOD_COLORS[b.mood] : OFFLINE;
    this.name.textContent = t(locale, `agent.${b.agent}`);
    this.chip.textContent = ok ? t(locale, `mood.${b.mood}`) : t(locale, 'ui.error');
    this.chip.style.setProperty('--c', color);
    this.source.textContent = sourceLabel(locale, b) + (b.plan ? ` · ${b.plan}` : '');
    this.source.title = b.source.baseUrl ?? '';

    // hero: the number that matters, and what it means
    const all = windowViews(b);
    const lead = all.find((w) => !w.informational);
    this.hero.style.setProperty('--c', ok && lead ? MOOD_COLORS[moodFor(lead.remaining, th)] : color);
    if (!ok) {
      delete this.heroNum.dataset.v;
      this.heroNum.textContent = '?';
      this.heroLabel.textContent = t(locale, 'hero.error');
    } else if (lead) {
      tween(this.heroNum, lead.remaining, (v) => `${Math.round(v)}%`);
      this.heroLabel.textContent = t(locale, 'hero.left', { label: short(locale, lead.id) });
    } else {
      delete this.heroNum.dataset.v;
      this.heroNum.textContent = '∞';
      this.heroLabel.textContent = t(locale, 'hero.noLimit');
    }

    this.error.hidden = !b.error;
    this.error.textContent = b.error ?? '';

    // windows, keyed so bars animate in place
    const seen = new Set<string>();
    for (const w of all) {
      seen.add(w.id);
      let row = this.rows.get(w.id);
      if (!row) {
        row = new WinRow();
        this.rows.set(w.id, row);
      }
      this.wins.appendChild(row.el);
      row.update(w, locale, th);
    }
    for (const [id, row] of this.rows) {
      if (!seen.has(id)) {
        row.el.remove();
        this.rows.delete(id);
      }
    }

    const items = ok ? refillItems(b, locale) : [];
    this.refills.hidden = !items.length;
    this.refillsTitle.textContent = t(locale, 'sec.refills');
    this.timeline.innerHTML = items
      .map(
        (r, i) => `<li class="${i === 0 ? 'next' : ''}"><span class="dot"></span><span class="when">${esc(formatClock(r.at, locale))}</span>
          <span>${esc(r.what)}</span><span class="plus">${r.plus ? `+${Math.round(r.plus)}%` : ''}</span>
          <span class="cd" data-at="${esc(r.at)}">${esc(formatDuration(Date.parse(r.at) - Date.now()))}</span></li>`,
      )
      .join('');

    const stats: string[] = [];
    if (b.today && (b.today.requests || b.today.costUsd)) {
      stats.push(t(locale, 'stat.today', { requests: b.today.requests ?? 0, cost: formatMoney(b.today.costUsd ?? 0), tokens: formatCount(b.today.tokens ?? 0) }));
    }
    if (b.accounts) stats.push(t(locale, 'stat.accounts', { a: b.accounts.available, t: b.accounts.total }));
    if (b.balance) stats.push(t(locale, 'stat.balance', { amount: formatMoney(b.balance.amount, b.balance.unit) }));
    this.stats.textContent = stats.join(' · ');

    const note = pickNote(b);
    this.note.hidden = !note || !!b.error;
    this.note.className = `note ${note?.level ?? ''}`;
    this.note.textContent = note ? t(locale, note.key, note.params) : '';
  }
}

class Overview {
  private cards = new Map<AgentId, Card>();
  private empty = el('div', 'empty');

  constructor(private host: HTMLElement) {}

  update(s: AppState): void {
    const list = s.buddies.filter((b) => b.status !== 'unconfigured');
    this.empty.innerHTML = `<b>${esc(t(s.locale, 'empty.title'))}</b>${esc(t(s.locale, 'empty.body'))}`;
    if (!list.length) this.host.appendChild(this.empty);
    else this.empty.remove();
    const seen = new Set<AgentId>();
    for (const b of list) {
      seen.add(b.agent);
      let card = this.cards.get(b.agent);
      if (!card) {
        card = new Card(b.agent);
        this.cards.set(b.agent, card);
      }
      this.host.appendChild(card.el);
      card.update(b, s.locale, s.settings.thresholds);
    }
    for (const [agent, card] of this.cards) {
      if (!seen.has(agent)) {
        card.el.remove();
        this.cards.delete(agent);
      }
    }
  }
}

// ------------------------------------------------------------------ login: shown on its own, only when needed

interface Target {
  origin: string;
  host: string;
  agents: string[];
  expired: boolean;
}

function pendingTargets(s: AppState, done: Set<string>): Target[] {
  const skipped = new Set(s.settings.loginSkipped);
  const map = new Map<string, Target>();
  if (s.demo) return [];
  for (const b of s.buddies) {
    const login = b.login;
    if (!login || login.loggedIn || skipped.has(login.origin) || done.has(login.origin)) continue;
    const target = map.get(login.origin) ?? { origin: login.origin, host: hostOf(login.origin), agents: [], expired: false };
    target.agents.push(t(s.locale, `agent.${b.agent}`));
    target.expired ||= b.notes.some((n) => n.key === 'note.sessionExpired');
    map.set(login.origin, target);
  }
  return [...map.values()];
}

class LoginView {
  private done = new Set<string>();
  private completed = 0;
  private target: Target | null = null;
  private tempToken: string | undefined;
  private busy = false;
  private form: HTMLFormElement;
  private email: HTMLInputElement;
  private password: HTMLInputElement;
  private totp: HTMLInputElement;
  private err: HTMLElement;
  private submit: HTMLButtonElement;

  constructor(private host: HTMLElement) {
    host.innerHTML = `
      <div class="login">
        <div class="login-art"></div>
        <h2 class="title"></h2>
        <p class="lead"></p>
        <div class="target px"><span class="host"></span><span class="for"></span><span class="step"></span></div>
        <p class="expired" hidden></p>
        <form novalidate>
          <input name="email" type="email" autocomplete="username" spellcheck="false">
          <input name="password" type="password" autocomplete="current-password">
          <input name="totp" inputmode="numeric" maxlength="6" autocomplete="one-time-code" hidden>
          <div class="err"></div>
          <div class="row"><button type="button" class="btn ghost" data-act="skip"></button><button type="submit" class="btn"></button></div>
        </form>
        <p class="later"></p>
      </div>`;
    const art = host.querySelector('.login-art')!;
    art.appendChild(sprite('claude', 'energetic').canvas);
    art.appendChild(sprite('codex', 'energetic').canvas);
    this.form = host.querySelector('form')!;
    this.email = host.querySelector('input[name=email]')!;
    this.password = host.querySelector('input[name=password]')!;
    this.totp = host.querySelector('input[name=totp]')!;
    this.err = host.querySelector('.err')!;
    this.submit = host.querySelector('button[type=submit]')!;
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.login();
    });
    host.querySelector('[data-act=skip]')!.addEventListener('click', () => void this.skip());
  }

  /** Targets still waiting for this flow. */
  pending(s: AppState): Target[] {
    return pendingTargets(s, this.done);
  }

  /** Puts an origin back into the flow (from Settings → Accounts). */
  reopen(origin: string): void {
    this.done.delete(origin);
    this.completed = 0;
    this.target = null;
  }

  update(s: AppState): void {
    const locale = s.locale;
    const targets = this.pending(s);
    if (!targets.length) return;
    if (!this.target || !targets.some((x) => x.origin === this.target!.origin)) {
      this.target = targets[0];
      this.tempToken = undefined;
      this.totp.value = '';
      this.err.textContent = '';
    }
    const target = targets.find((x) => x.origin === this.target!.origin)!;
    const q = (sel: string) => this.host.querySelector<HTMLElement>(sel)!;
    q('.title').textContent = t(locale, 'login.title');
    q('.lead').textContent = t(locale, 'login.body');
    q('.target .host').textContent = target.host;
    q('.target .for').textContent = t(locale, 'login.for', { agents: target.agents.join(' / ') });
    const total = this.completed + targets.length;
    q('.target .step').textContent = total > 1 ? t(locale, 'login.step', { i: this.completed + 1, n: total }) : '';
    const expired = q('.expired');
    expired.hidden = !target.expired;
    expired.textContent = t(locale, 'login.expired', { host: target.host });
    this.email.placeholder = t(locale, 'ui.email');
    this.password.placeholder = t(locale, 'ui.password');
    this.totp.placeholder = t(locale, 'ui.totp');
    this.email.hidden = this.password.hidden = !!this.tempToken;
    this.totp.hidden = !this.tempToken;
    q('[data-act=skip]').textContent = t(locale, 'login.skip');
    this.submit.textContent = t(locale, this.busy ? 'login.busy' : 'login.submit');
    this.submit.disabled = this.busy;
    q('.later').textContent = t(locale, 'login.later');
  }

  focus(): void {
    (this.tempToken ? this.totp : this.email.value ? this.password : this.email).focus();
  }

  private advance(): void {
    this.done.add(this.target!.origin);
    this.completed++;
    this.target = null;
    this.password.value = '';
    this.tempToken = undefined;
    if (!state || !this.pending(state).length) {
      this.completed = 0;
      setView('overview');
    } else {
      this.update(state);
      this.focus();
    }
  }

  private fail(message: string): void {
    this.err.textContent = message;
    this.form.classList.remove('shake');
    void this.form.offsetWidth;
    this.form.classList.add('shake');
  }

  private async login(): Promise<void> {
    if (!this.target || this.busy || !state) return;
    if (!this.tempToken && (!this.email.value.trim() || !this.password.value)) return this.fail(t(state.locale, 'ui.email') + ' / ' + t(state.locale, 'ui.password'));
    this.busy = true;
    this.err.textContent = '';
    this.update(state);
    const res = await qb().login({
      origin: this.target.origin,
      email: this.email.value.trim(),
      password: this.password.value,
      tempToken: this.tempToken,
      totpCode: this.tempToken ? this.totp.value.trim() : undefined,
    });
    this.busy = false;
    if (res.ok) {
      this.advance();
      return;
    }
    if (res.needsTotp) {
      this.tempToken = res.tempToken;
      this.update(state);
      this.totp.focus();
      return;
    }
    this.update(state);
    this.fail(res.error);
  }

  private async skip(): Promise<void> {
    if (!this.target || !state) return;
    const origin = this.target.origin;
    this.advance();
    await qb().updateSettings({ loginSkipped: [...state.settings.loginSkipped, origin] });
  }
}

// ------------------------------------------------------------------ settings

class SettingsView {
  private accounts: HTMLElement;
  private tiles = new Map<AgentId, HTMLElement>();

  constructor(private host: HTMLElement) {
    host.innerHTML = `
      <div class="group">
        <div class="group-title" data-i18n="set.display"></div>
        <div class="pets"></div>
        <div class="hint" data-i18n="set.displayHint"></div>
      </div>
      <div class="group">
        <div class="set-row"><span data-i18n="set.size"></span><div class="seg" data-set="scale">
          <button data-val="1" data-i18n="set.size.1"></button><button data-val="2" data-i18n="set.size.2"></button><button data-val="3" data-i18n="set.size.3"></button></div></div>
        <div class="set-row"><span data-i18n="set.hudMode.claude"></span><div class="seg" data-set="hudMode" data-agent="claude">
          <button data-val="both" data-i18n="set.hudMode.both"></button><button data-val="5h" data-i18n="set.hudMode.5h"></button><button data-val="7d" data-i18n="set.hudMode.7d"></button><button data-val="auto" data-i18n="set.hudMode.auto"></button></div></div>
        <div class="set-row"><span data-i18n="set.hudMode.codex"></span><div class="seg" data-set="hudMode" data-agent="codex">
          <button data-val="both" data-i18n="set.hudMode.both"></button><button data-val="5h" data-i18n="set.hudMode.5h"></button><button data-val="7d" data-i18n="set.hudMode.7d"></button><button data-val="auto" data-i18n="set.hudMode.auto"></button></div></div>
        <div class="hint" data-i18n="set.hudModeHint"></div>
        <div class="set-row"><span data-i18n="set.language"></span><div class="seg" data-set="locale">
          <button data-val="auto" data-i18n="ui.lang.auto"></button><button data-val="zh-CN">中文</button><button data-val="en">EN</button></div></div>
        <div class="set-row"><span data-i18n="set.interval"></span><div class="seg" data-set="refreshSeconds">
          <button data-val="30">30s</button><button data-val="60">1m</button><button data-val="120">2m</button><button data-val="300">5m</button></div></div>
        <div class="set-row"><span data-i18n="set.launch"></span><button class="switch" data-toggle="launchAtLogin"></button></div>
        <div class="set-row"><span data-i18n="set.demo"></span><button class="switch" data-toggle="demo"></button></div>
      </div>
      <div class="group">
        <div class="group-title" data-i18n="set.accounts"></div>
        <div class="accounts"></div>
      </div>`;
    this.accounts = host.querySelector('.accounts')!;
    const pets = host.querySelector('.pets')!;
    for (const agent of ['claude', 'codex'] as AgentId[]) {
      const tile = el('button', 'pet-tile');
      tile.dataset.toggle = agent === 'claude' ? 'showClaude' : 'showCodex';
      tile.innerHTML = `<span class="check"></span><span class="art"></span><span class="label"></span>`;
      tile.querySelector('.art')!.appendChild(sprite(agent, 'relaxed').canvas);
      pets.appendChild(tile);
      this.tiles.set(agent, tile);
    }
  }

  update(s: AppState): void {
    const locale = s.locale;
    for (const node of this.host.querySelectorAll<HTMLElement>('[data-i18n]')) node.textContent = t(locale, node.dataset.i18n!);
    for (const seg of this.host.querySelectorAll<HTMLElement>('.seg[data-set]')) {
      const agent = seg.dataset.agent as AgentId | undefined;
      const current = String(agent ? s.settings.hudMode[agent] : (s.settings as any)[seg.dataset.set!]);
      for (const b of seg.querySelectorAll<HTMLElement>('button')) b.classList.toggle('on', b.dataset.val === current);
    }
    for (const sw of this.host.querySelectorAll<HTMLElement>('.switch')) {
      const key = sw.dataset.toggle!;
      sw.classList.toggle('on', key === 'demo' ? s.demo : !!(s.settings as any)[key]);
    }
    for (const [agent, tile] of this.tiles) {
      tile.classList.toggle('on', agent === 'claude' ? s.settings.showClaude : s.settings.showCodex);
      tile.querySelector('.label')!.textContent = t(locale, `agent.${agent}`);
    }
    const origins = new Map<string, { loggedIn: boolean; email?: string }>();
    for (const b of s.buddies) if (b.login) origins.set(b.login.origin, { loggedIn: b.login.loggedIn, email: b.login.email });
    this.accounts.innerHTML = origins.size
      ? [...origins]
          .map(
            ([origin, a]) => `<div class="acct"><span class="host">${esc(hostOf(origin))}</span>
              <span class="state">${esc(a.loggedIn ? t(locale, 'set.loggedIn', { email: a.email ?? '' }) : t(locale, 'set.notLoggedIn'))}</span>
              <button class="btn small ${a.loggedIn ? 'ghost' : ''}" data-act="${a.loggedIn ? 'logout' : 'login'}" data-origin="${esc(origin)}">${esc(
                t(locale, a.loggedIn ? 'ui.logout' : 'ui.login'),
              )}</button></div>`,
          )
          .join('')
      : `<div class="hint">${esc(t(locale, 'set.noAccounts'))}</div>`;
  }
}

// ------------------------------------------------------------------ shell: views, tabs, enter / leave

const overview = new Overview($('view-overview'));
const loginView = new LoginView($('view-login'));
const settingsView = new SettingsView($('view-settings'));

function moveInk(): void {
  const on = tabs.querySelector<HTMLElement>('button.on');
  if (!on) return;
  ink.style.left = `${on.offsetLeft}px`;
  ink.style.width = `${on.offsetWidth}px`;
}

function setView(next: View): void {
  if (next === 'login' && state && !loginView.pending(state).length) next = 'overview';
  const changed = next !== view;
  const previous = view;
  view = next;
  const animate = changed && root.classList.contains('shown') && !reduceMotion;
  for (const section of views.querySelectorAll<HTMLElement>('.view')) {
    const active = section.dataset.view === view;
    section.classList.toggle('active', active);
    section.toggleAttribute('inert', !active);
    if (active) section.classList.remove('outgoing');
    if (animate && section.dataset.view === previous) {
      // the old page fades out on top while the new one fades in and the height glides
      section.classList.add('outgoing');
      setTimeout(() => section.classList.remove('outgoing'), 200);
    }
  }
  if (changed) views.scrollTop = 0;
  tabs.hidden = view === 'login';
  for (const b of tabs.querySelectorAll<HTMLElement>('button')) b.classList.toggle('on', b.dataset.view === view);
  moveInk();
  if (view === 'login') {
    if (state) loginView.update(state);
    loginView.focus();
  }
  syncHeight(changed);
}

function render(): void {
  if (!state) return;
  const locale = state.locale;
  document.documentElement.lang = locale;
  $('title').textContent = t(locale, 'app.name');
  for (const b of tabs.querySelectorAll<HTMLElement>('button')) b.textContent = t(locale, `tab.${b.dataset.view}`);
  $('btn-refresh').title = t(locale, 'ui.refresh');
  $('btn-refresh').classList.toggle('busy', state.refreshing);
  $('version').textContent = `v${state.version}${state.demo ? ' · demo' : ''}`;
  overview.update(state);
  loginView.update(state);
  settingsView.update(state);
  if (view === 'login' && !loginView.pending(state).length) setView('overview');
  else moveInk();
  tickFooter();
}

function tickFooter(): void {
  if (!state) return;
  const fetched = state.buddies.map((b) => Date.parse(b.fetchedAt)).filter(Number.isFinite);
  const age = fetched.length ? Date.now() - Math.min(...fetched) : 0;
  $('updated').textContent = !fetched.length ? '' : age < 60000 ? t(L(), 'ui.justNow') : t(L(), 'ui.updated', { time: formatDuration(age) });
}

// ------------------------------------------------------------------ height: follow the active page, smoothly

const ROOT_MARGINS = 16; // #root margin top + bottom
const VIEWS_PADDING = 4; // #views padding top + bottom
let lastWindowHeight = 0;
let pendingShrink = 0;

function sendWindowHeight(h: number): void {
  if (h === lastWindowHeight) return;
  lastWindowHeight = h;
  qb().resizePanel(h);
}

/**
 * The panel is as tall as the page being shown. Growing: the window grows first (the extra part is
 * transparent) and the panel slides into it. Shrinking: the panel shrinks first and the window
 * follows once the transition ends. The panel hugs the anchored edge, so nothing jumps.
 */
function syncHeight(animate = true): void {
  const active = views.querySelector<HTMLElement>('.view.active');
  if (!active) return;
  const natural = active.offsetHeight + VIEWS_PADDING;
  const target = Math.min(natural, maxViewsHeight());
  views.classList.toggle('scroll', natural > target + 1);
  const current = views.offsetHeight;
  const windowHeight = root.offsetHeight - current + target + ROOT_MARGINS;
  const visible = document.visibilityState === 'visible' && root.classList.contains('shown');
  if (!animate || !visible || reduceMotion || Math.abs(target - current) < 1) {
    views.style.transition = 'none';
    views.style.height = `${target}px`;
    void views.offsetHeight;
    views.style.transition = '';
    pendingShrink = 0;
    sendWindowHeight(windowHeight);
    return;
  }
  if (target > current) {
    pendingShrink = 0;
    sendWindowHeight(windowHeight);
  } else {
    pendingShrink = windowHeight;
  }
  views.style.height = `${target}px`;
}

views.addEventListener('transitionend', (e) => {
  if (e.target !== views || e.propertyName !== 'height' || !pendingShrink) return;
  sendWindowHeight(pendingShrink);
  pendingShrink = 0;
});

const contentWatcher = new ResizeObserver(() => syncHeight(true));
for (const section of views.querySelectorAll('.view')) contentWatcher.observe(section);
document.fonts?.ready.then(() => syncHeight(false));
qb().onPanelEdge((edge) => (document.body.dataset.edge = edge));

function enter(): void {
  if (state && loginView.pending(state).length) setView('login');
  else if (view === 'login') setView('overview');
  syncHeight(false);
  root.classList.remove('leaving');
  root.classList.add('shown');
  root.classList.remove('entering');
  void root.offsetWidth;
  root.classList.add('entering');
  requestAnimationFrame(moveInk);
}

root.addEventListener('animationend', (e) => {
  if (e.target !== root) return;
  if (root.classList.contains('leaving')) {
    root.classList.remove('leaving', 'shown');
    qb().panelLeft();
  } else {
    root.classList.remove('entering');
  }
});

qb().onPanelEnter(() => enter());
qb().onDebugView((v) => setView(v as View));
qb().onPanelLeave(() => {
  root.classList.remove('entering');
  if (reduceMotion) {
    root.classList.remove('shown');
    qb().panelLeft();
    return;
  }
  root.classList.add('leaving');
});
document.addEventListener('visibilitychange', () => {
  // safety net: never stay invisible if the window was shown before we were ready
  if (document.visibilityState === 'visible' && !root.classList.contains('shown')) enter();
});

// ------------------------------------------------------------------ events

root.addEventListener('click', async (e) => {
  const target = (e.target as HTMLElement).closest<HTMLElement>('button');
  if (!target || !state) return;
  if (target.id === 'btn-refresh') return qb().refresh();
  if (target.id === 'btn-close') return qb().hidePanel();
  if (target.id === 'btn-github') return qb().openExternal(REPO_URL);
  if (target.parentElement === tabs && target.dataset.view) return setView(target.dataset.view as View);

  const seg = target.closest<HTMLElement>('.seg[data-set]');
  if (seg && target.dataset.val) {
    const key = seg.dataset.set as keyof Settings;
    const agent = seg.dataset.agent as AgentId | undefined;
    if (key === 'hudMode' && agent) {
      await qb().updateSettings({ hudMode: { ...state.settings.hudMode, [agent]: target.dataset.val as HudMode } });
      return;
    }
    const value = key === 'locale' ? target.dataset.val : Number(target.dataset.val);
    await qb().updateSettings({ [key]: value } as Partial<Settings>);
    return;
  }
  const toggle = target.dataset.toggle;
  if (toggle === 'demo') return qb().setDemo(!state.demo);
  if (toggle) {
    await qb().updateSettings({ [toggle]: !(state.settings as any)[toggle] } as Partial<Settings>);
    return;
  }
  const origin = target.dataset.origin;
  if (target.dataset.act === 'logout' && origin) return qb().logout(origin);
  if (target.dataset.act === 'login' && origin) {
    loginView.reopen(origin);
    if (state.settings.loginSkipped.includes(origin)) {
      await qb().updateSettings({ loginSkipped: state.settings.loginSkipped.filter((o) => o !== origin) });
    }
    setView('login');
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') qb().hidePanel();
});

setInterval(() => {
  tickCountdowns();
  tickFooter();
}, 1000);

qb().onState((s) => {
  state = s;
  render();
});
qb()
  .getState()
  .then((s) => {
    state = s;
    render();
    setView(loginView.pending(s).length ? 'login' : 'overview');
    if (document.visibilityState === 'visible' && !root.classList.contains('shown')) enter();
  });
