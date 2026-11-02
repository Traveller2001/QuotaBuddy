import { formatClock, formatCount, formatDuration, formatMoney, formatPercent, hostOf } from '../../shared/format';
import { t } from '../../shared/i18n';
import { moodFor } from '../../shared/mood';
import type { AgentId, AppState, BuddySnapshot, Locale, Settings } from '../../shared/types';
import { qb } from '../common/api';
import { SpriteAnimator } from '../common/sprites';
import {
  AGENT_COLORS,
  esc,
  kindLabel,
  MOOD_COLORS,
  refreshRestore,
  remainingText,
  sourceLabel,
  windowLabel,
  windowResetText,
} from '../common/view';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const root = $('root');
const cards = $('cards');
const settingsEl = $('settings');
const footer = $('footer');
let state: AppState | null = null;
let showSettings = false;

interface LoginDraft {
  open: boolean;
  email: string;
  password: string;
  totp: string;
  tempToken?: string;
  busy: boolean;
  error: string;
}
const drafts = new Map<string, LoginDraft>();
const draftFor = (origin: string): LoginDraft => {
  let d = drafts.get(origin);
  if (!d) {
    d = { open: false, email: '', password: '', totp: '', busy: false, error: '' };
    drafts.set(origin, d);
  }
  return d;
};

const minis = new Map<AgentId, { canvas: HTMLCanvasElement; anim: SpriteAnimator }>();
function mini(agent: AgentId): { canvas: HTMLCanvasElement; anim: SpriteAnimator } {
  let m = minis.get(agent);
  if (!m) {
    const canvas = document.createElement('canvas');
    m = { canvas, anim: new SpriteAnimator(canvas, agent, 1) };
    minis.set(agent, m);
  }
  return m;
}

// ------------------------------------------------------------------ cards

function windowRows(L: Locale, b: BuddySnapshot): string {
  if (!b.windows.length) {
    if (b.status !== 'ok') return '';
    return `<div class="meta">${esc(b.balance ? t(L, 'ui.balance', { amount: formatMoney(b.balance.amount, b.balance.unit) }) : t(L, 'ui.noLimit'))}</div>`;
  }
  const s = state!.settings;
  return `<div class="windows">${b.windows
    .map((w) => {
      const remaining = Math.max(0, 100 - w.usedPercent);
      const color = MOOD_COLORS[moodFor(remaining, s.thresholds)];
      return `<div class="win${w.informational ? ' informational' : ''}">
        <div class="win-top"><span>${esc(windowLabel(L, w))}<em class="scope ${w.scope}">${esc(t(L, `scope.${w.scope}`))}</em></span>
          <span>${esc(t(L, 'ui.used', { pct: formatPercent(w.usedPercent) }))}</span></div>
        <div class="bar"><i style="width:${remaining.toFixed(1)}%;background:${color}"></i></div>
        <div class="win-sub"><span data-win="${esc(JSON.stringify(w))}">${esc(windowResetText(L, w))}</span><span>${esc(w.detail ?? '')}</span></div>
      </div>`;
    })
    .join('')}</div>`;
}

function nextBlock(L: Locale, b: BuddySnapshot): string {
  const r = b.nextRefresh;
  if (!r || b.status !== 'ok') return '';
  const pct = refreshRestore(r);
  const accounts = r.accounts ? ` · ${t(L, 'ui.accountsN', { n: r.accounts })}` : '';
  return `<div class="next">${esc(t(L, 'ui.nextRefresh'))} <b data-at="${esc(r.at)}">${esc(formatDuration(Date.parse(r.at) - Date.now()))}</b>${
    pct ? ` <b>+${pct}%</b>` : ''
  } · ${esc(kindLabel(L, r.kind))}${esc(accounts)}</div>`;
}

function schedule(L: Locale, b: BuddySnapshot): string {
  const upcoming = b.refreshes.filter((r) => Date.parse(r.at) > Date.now()).slice(1, 6);
  if (!upcoming.length) return '';
  return `<ul class="sched">${upcoming
    .map((r) => {
      const pct = refreshRestore(r);
      return `<li><span class="when">${esc(formatClock(r.at, L))}</span><span>${esc(kindLabel(L, r.kind))}${
        r.accounts ? ` · ${esc(t(L, 'ui.accountsN', { n: r.accounts }))}` : ''
      }</span><span class="plus">${pct ? `+${pct}%` : ''}</span></li>`;
    })
    .join('')}</ul>`;
}

function metaLine(L: Locale, b: BuddySnapshot): string {
  const bits: string[] = [];
  if (b.today && (b.today.requests || b.today.costUsd)) {
    bits.push(
      `${t(L, 'ui.today')} ${t(L, 'ui.todayLine', {
        requests: b.today.requests ?? 0,
        cost: formatMoney(b.today.costUsd ?? 0),
        tokens: formatCount(b.today.tokens ?? 0),
      })}`,
    );
  }
  if (b.balance && b.windows.length) bits.push(t(L, 'ui.balance', { amount: formatMoney(b.balance.amount, b.balance.unit) }));
  if (b.accounts) bits.push(`${t(L, 'win.accounts')} ${b.accounts.available}/${b.accounts.total}`);
  return bits.length ? `<div class="meta">${bits.map(esc).join('<br>')}</div>` : '';
}

function notes(L: Locale, b: BuddySnapshot): string {
  const visible = b.notes.filter((n) => !(n.key === 'note.loginForPool' && drafts.get(b.login?.origin ?? '')?.open));
  if (!visible.length) return '';
  return `<ul class="notes">${visible.map((n) => `<li class="${n.level}">${esc(t(L, n.key, n.params))}</li>`).join('')}</ul>`;
}

function loginBlock(L: Locale, b: BuddySnapshot): string {
  const login = b.login;
  if (!login || state!.demo) return '';
  const host = hostOf(login.origin);
  if (login.loggedIn) {
    return `<div class="login loggedin"><span>${esc(t(L, 'ui.loggedInAs', { email: login.email ?? '' }))}</span>
      <button class="link" data-act="logout" data-origin="${esc(login.origin)}">${esc(t(L, 'ui.logout'))}</button></div>`;
  }
  const d = draftFor(login.origin);
  if (!d.open) {
    return `<div class="login"><button class="btn" data-act="login-open" data-origin="${esc(login.origin)}">${esc(t(L, 'ui.loginTitle', { host }))}</button></div>`;
  }
  const o = esc(login.origin);
  return `<div class="login"><form data-origin="${o}">
    <div class="hint">${esc(t(L, 'ui.loginHint'))}</div>
    ${
      d.tempToken
        ? `<input id="totp-${o}" data-field="totp" inputmode="numeric" maxlength="6" placeholder="${esc(t(L, 'ui.totp'))}" value="${esc(d.totp)}">`
        : `<input id="email-${o}" data-field="email" type="email" placeholder="${esc(t(L, 'ui.email'))}" value="${esc(d.email)}" autocomplete="username">
           <input id="password-${o}" data-field="password" type="password" placeholder="${esc(t(L, 'ui.password'))}" value="${esc(d.password)}" autocomplete="current-password">`
    }
    ${d.error ? `<div class="errline">${esc(d.error)}</div>` : ''}
    <div class="row"><button type="button" class="btn ghost" data-act="login-cancel" data-origin="${o}">${esc(t(L, 'ui.cancel'))}</button>
    <button type="submit" class="btn" ${d.busy ? 'disabled' : ''}>${esc(t(L, 'ui.login'))}</button></div>
  </form></div>`;
}

function card(L: Locale, b: BuddySnapshot): string {
  const moodColor = b.status === 'ok' ? MOOD_COLORS[b.mood] : '#8d8a9e';
  const chip = b.status === 'ok' ? t(L, `mood.${b.mood}`) : b.status === 'error' ? t(L, 'ui.error') : t(L, 'ui.unconfigured');
  const plan = b.plan ? ` · ${b.plan}` : '';
  return `<section class="card ${b.status}" style="--accent:${AGENT_COLORS[b.agent]}">
    <div class="card-head">
      <div class="mini" data-agent="${b.agent}"></div>
      <div class="head-text">
        <div class="name">${esc(t(L, `agent.${b.agent}`))} <span class="chip" style="--c:${moodColor}">${esc(chip)}</span></div>
        <div class="source" title="${esc(b.source.baseUrl ?? '')}">${esc(sourceLabel(L, b) + plan)}</div>
      </div>
      <div class="big" style="color:${moodColor}">${esc(remainingText(b))}<small>${esc(t(L, 'ui.remaining'))}</small></div>
    </div>
    ${b.error ? `<div class="errline">${esc(b.error)}</div>` : ''}
    ${windowRows(L, b)}
    ${nextBlock(L, b)}
    ${schedule(L, b)}
    ${metaLine(L, b)}
    ${notes(L, b)}
    ${loginBlock(L, b)}
  </section>`;
}

// ------------------------------------------------------------------ settings

function seg<T extends string | number>(key: keyof Settings | 'demo', options: [T, string][], current: T): string {
  return `<div class="seg">${options
    .map(([v, label]) => `<button data-set="${String(key)}" data-val="${esc(v)}" class="${v === current ? 'on' : ''}">${esc(label)}</button>`)
    .join('')}</div>`;
}

function renderSettings(): void {
  if (!state) return;
  const L = state.locale;
  const s = state.settings;
  settingsEl.hidden = !showSettings;
  if (!showSettings) return;
  settingsEl.innerHTML = `
    <div class="set-row"><span>${esc(t(L, 'ui.size'))}</span>${seg('scale', [[1, '1x'], [2, '2x'], [3, '3x']], s.scale)}</div>
    <div class="set-row"><span>${esc(t(L, 'ui.show'))}</span><div class="seg">
      <button data-toggle="showClaude" class="${s.showClaude ? 'on' : ''}">Claude</button>
      <button data-toggle="showCodex" class="${s.showCodex ? 'on' : ''}">Codex</button></div></div>
    <div class="set-row"><span>${esc(t(L, 'ui.language'))}</span>${seg('locale', [['auto', t(L, 'ui.lang.auto')], ['zh-CN', '中文'], ['en', 'English']], s.locale)}</div>
    <div class="set-row"><span>${esc(t(L, 'ui.interval'))}</span>${seg(
      'refreshSeconds',
      [
        [30, t(L, 'ui.seconds', { n: 30 })],
        [60, t(L, 'ui.minutes', { n: 1 })],
        [120, t(L, 'ui.minutes', { n: 2 })],
        [300, t(L, 'ui.minutes', { n: 5 })],
      ],
      s.refreshSeconds,
    )}</div>
    <div class="set-row"><span>${esc(t(L, 'ui.launchAtLogin'))}</span><div class="seg">
      <button data-toggle="launchAtLogin" class="${s.launchAtLogin ? 'on' : ''}">${s.launchAtLogin ? 'ON' : 'OFF'}</button></div></div>
    <div class="set-row"><span>${esc(t(L, 'ui.demo'))}</span><div class="seg">
      <button data-toggle="demo" class="${state.demo ? 'on' : ''}">${state.demo ? 'ON' : 'OFF'}</button></div></div>`;
}

// ------------------------------------------------------------------ render

function captureFocus(): { id: string; start: number | null; end: number | null } | null {
  const el = document.activeElement as HTMLInputElement | null;
  if (!el || el.tagName !== 'INPUT' || !el.id) return null;
  return { id: el.id, start: el.selectionStart, end: el.selectionEnd };
}

function restoreFocus(f: ReturnType<typeof captureFocus>): void {
  if (!f) return;
  const el = document.getElementById(f.id) as HTMLInputElement | null;
  if (!el) return;
  el.focus();
  try {
    if (f.start !== null) el.setSelectionRange(f.start, f.end);
  } catch {
    // inputs like email do not support selection ranges
  }
}

function render(): void {
  if (!state) return;
  const L = state.locale;
  document.documentElement.lang = L;
  $('title').textContent = t(L, 'app.name');
  $('btn-refresh').title = t(L, 'ui.refresh');
  $('btn-refresh').classList.toggle('spin', state.refreshing);
  $('btn-settings').title = t(L, 'ui.settings');

  const focus = captureFocus();
  const list = state.buddies.filter((b) => (b.agent === 'claude' ? state!.settings.showClaude : state!.settings.showCodex) || b.status !== 'unconfigured');
  cards.innerHTML = list.map((b) => card(L, b)).join('');
  for (const holder of cards.querySelectorAll<HTMLElement>('.mini')) {
    const agent = holder.dataset.agent as AgentId;
    const b = list.find((x) => x.agent === agent)!;
    const m = mini(agent);
    m.anim.setMood(b.status === 'unconfigured' ? 'exhausted' : b.mood);
    holder.appendChild(m.canvas);
  }
  restoreFocus(focus);
  renderSettings();
  footer.innerHTML = `<span>v${esc(state.version)}${state.demo ? ' · demo' : ''}</span><span data-updated></span>`;
  tick();
  reportHeight();
}

let lastHeight = 0;
function reportHeight(): void {
  // measure synchronously: rAF does not run while the panel window is hidden
  const h = Math.ceil(root.getBoundingClientRect().height) + 12;
  if (h === lastHeight) return;
  lastHeight = h;
  qb().resizePanel(h);
}
new ResizeObserver(reportHeight).observe(root);

function tick(): void {
  if (!state) return;
  const L = state.locale;
  const now = Date.now();
  for (const el of document.querySelectorAll<HTMLElement>('[data-at]')) {
    el.textContent = formatDuration(Date.parse(el.dataset.at!) - now);
  }
  for (const el of document.querySelectorAll<HTMLElement>('[data-win]')) {
    el.textContent = windowResetText(L, JSON.parse(el.dataset.win!), now);
  }
  const updated = document.querySelector<HTMLElement>('[data-updated]');
  const fetched = state.buddies.map((b) => Date.parse(b.fetchedAt)).filter(Number.isFinite);
  if (updated && fetched.length) {
    const age = now - Math.min(...fetched);
    updated.textContent = age < 60000 ? t(L, 'ui.justNow') : t(L, 'ui.updated', { time: formatDuration(age) });
  }
}

// ------------------------------------------------------------------ events

root.addEventListener('click', async (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('button');
  if (!el || !state) return;
  if (el.id === 'btn-refresh') return qb().refresh();
  if (el.id === 'btn-close') return qb().hidePanel();
  if (el.id === 'btn-settings') {
    showSettings = !showSettings;
    return render();
  }
  const origin = el.dataset.origin;
  switch (el.dataset.act) {
    case 'login-open':
      draftFor(origin!).open = true;
      render();
      (document.getElementById(`email-${origin}`) as HTMLInputElement | null)?.focus();
      return;
    case 'login-cancel':
      drafts.delete(origin!);
      return render();
    case 'logout':
      await qb().logout(origin!);
      return;
  }
  if (el.dataset.set) {
    const key = el.dataset.set as keyof Settings;
    const raw = el.dataset.val!;
    const value = key === 'locale' ? raw : Number(raw);
    await qb().updateSettings({ [key]: value } as Partial<Settings>);
    return;
  }
  if (el.dataset.toggle) {
    const key = el.dataset.toggle;
    if (key === 'demo') return qb().setDemo(!state.demo);
    await qb().updateSettings({ [key]: !(state.settings as any)[key] } as Partial<Settings>);
  }
});

root.addEventListener('input', (e) => {
  const input = e.target as HTMLInputElement;
  const form = input.closest('form');
  if (!form) return;
  const d = draftFor(form.dataset.origin!);
  (d as any)[input.dataset.field!] = input.value;
});

root.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target as HTMLFormElement;
  const origin = form.dataset.origin!;
  const d = draftFor(origin);
  d.busy = true;
  d.error = '';
  render();
  const res = await qb().login({ origin, email: d.email.trim(), password: d.password, totpCode: d.totp.trim() || undefined, tempToken: d.tempToken });
  d.busy = false;
  if (res.ok) {
    drafts.delete(origin);
  } else if (res.needsTotp) {
    d.tempToken = res.tempToken;
    d.error = '';
  } else {
    d.error = res.error;
  }
  render();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') qb().hidePanel();
});

setInterval(tick, 1000);
qb().onState((s) => {
  state = s;
  render();
});
qb()
  .getState()
  .then((s) => {
    state = s;
    render();
  });
