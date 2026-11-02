import { formatPercent } from '../../shared/format';
import { bubbleLines, t } from '../../shared/i18n';
import type { AgentId, AppState, BuddySnapshot, Locale, Mood } from '../../shared/types';
import { qb } from '../common/api';
import { maxFrame, spriteMeta, SpriteAnimator } from '../common/sprites';
import { compactRefill, hudWindow, MOOD_COLORS, refillSentence, remainingText, windowLabel } from '../common/view';

const SEGMENTS = 10;
const stage = document.getElementById('stage')!;
let state: AppState | null = null;

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];

class BuddyView {
  readonly root: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private stand: HTMLDivElement;
  private anim: SpriteAnimator;
  private bubble: HTMLDivElement;
  private meter: HTMLDivElement;
  private pct: HTMLSpanElement;
  private refill: HTMLDivElement;
  private snap: BuddySnapshot | null = null;
  private locale: Locale = 'en';
  private mood: Mood | null = null;
  private hovered = false;
  private bubbleUntil = 0;
  private nextChat = Date.now() + rand(8000, 20000);

  constructor(readonly agent: AgentId, scale: number) {
    this.root = document.createElement('div');
    this.root.className = 'buddy';
    this.root.dataset.agent = agent;
    this.root.innerHTML = `
      <div class="stand"><div class="bubble"></div><canvas class="sprite hit"></canvas></div>
      <div class="hud hit">
        <div class="hud-row"><div class="meter">${'<i></i>'.repeat(SEGMENTS)}</div><span class="pct"></span></div>
        <div class="refill"></div>
      </div>`;
    this.stand = this.root.querySelector('.stand')!;
    this.canvas = this.root.querySelector('canvas')!;
    this.bubble = this.root.querySelector('.bubble')!;
    this.meter = this.root.querySelector('.meter')!;
    this.pct = this.root.querySelector('.pct')!;
    this.refill = this.root.querySelector('.refill')!;
    this.anim = new SpriteAnimator(this.canvas, agent, scale);
    this.layout(scale);

    for (const el of this.root.querySelectorAll<HTMLElement>('.hit')) {
      el.addEventListener('pointerenter', () => this.hover(true));
      el.addEventListener('pointerleave', () => this.hover(false));
    }
  }

  /** Align every character's feet on the same ground line regardless of sprite size. */
  layout(scale: number): void {
    this.anim.setScale(scale);
    const m = spriteMeta(this.agent);
    const max = maxFrame();
    this.stand.style.height = `${(max.height + max.below) * scale}px`;
    this.canvas.style.marginBottom = `${(max.below - (m.frameHeight - m.groundY)) * scale}px`;
  }

  update(b: BuddySnapshot, locale: Locale): void {
    const first = this.snap === null;
    this.snap = b;
    this.locale = locale;
    this.root.classList.toggle('error', b.status === 'error');
    this.root.classList.toggle('unconfigured', b.status === 'unconfigured');
    const mood: Mood = b.status === 'unconfigured' ? 'exhausted' : b.mood;
    this.root.classList.toggle('anxious', mood === 'anxious' && b.status === 'ok');
    this.anim.setMood(mood);

    const color = b.status === 'ok' ? MOOD_COLORS[mood] : '#8d8a9e';
    this.root.style.setProperty('--fill', color);
    const remaining = b.status !== 'ok' ? 0 : b.remainingPercent === null ? 100 : b.remainingPercent;
    const lit = remaining <= 0 ? 0 : Math.max(1, Math.round((remaining / 100) * SEGMENTS));
    // Segments the next refill will bring back blink, so the refresh schedule is part of the meter.
    const restore = b.status === 'ok' && b.remainingPercent !== null ? b.nextRefresh?.restorePercent ?? 0 : 0;
    const soon = Math.min(SEGMENTS - lit, Math.round(((Math.min(100, remaining + restore) - remaining) / 100) * SEGMENTS));
    this.meter.querySelectorAll('i').forEach((seg, i) => {
      seg.classList.toggle('on', i < lit);
      seg.classList.toggle('soon', i >= lit && i < lit + soon);
    });
    this.pct.textContent = remainingText(b);
    this.tick(Date.now());

    if (!first && this.mood !== mood && b.status === 'ok') {
      this.root.classList.remove('pop');
      void this.root.offsetWidth;
      this.root.classList.add('pop');
      this.say(this.chatLine(), 5000);
    }
    this.mood = mood;
    if (this.hovered) this.showHoverLine();
  }

  private hoverLine(): string {
    const b = this.snap;
    const L = this.locale;
    if (!b) return '';
    const name = t(L, `agent.${b.agent}`);
    if (b.status === 'unconfigured') return `${name}: ${t(L, 'ui.unconfigured')}`;
    if (b.status === 'error') return `${name}: ${b.error ?? t(L, 'ui.error')}`;
    const w = hudWindow(b);
    const head = w
      ? `${windowLabel(L, w)} ${t(L, 'ui.remaining')} ${formatPercent(100 - w.usedPercent)}%`
      : t(L, 'ui.noLimit');
    const refill = refillSentence(L, b.nextRefresh);
    const login = b.login && !b.login.loggedIn && b.windows.length === 0 ? ` · ${t(L, 'ui.login')}?` : '';
    return `${name} · ${t(L, `mood.${b.mood}`)}\n${head}${refill ? ` · ${refill}` : ''}${login}`;
  }

  private chatLine(): string {
    const b = this.snap!;
    const L = this.locale;
    const refill = refillSentence(L, b.nextRefresh);
    const pct = b.remainingPercent === null ? '100' : formatPercent(b.remainingPercent);
    const lines = bubbleLines(L, b.mood).filter((l) => refill || !l.includes('{refill}'));
    return pick(lines).replace('{pct}', pct).replace('{refill}', refill ?? '');
  }

  private showHoverLine(): void {
    this.bubble.innerText = this.hoverLine();
    this.bubble.classList.add('show');
  }

  private hover(on: boolean): void {
    this.hovered = on;
    if (on) this.showHoverLine();
    else if (Date.now() > this.bubbleUntil) this.bubble.classList.remove('show');
  }

  say(text: string, ms: number): void {
    if (!text) return;
    this.bubble.innerText = text;
    this.bubble.classList.add('show');
    this.bubbleUntil = Date.now() + ms;
  }

  tick(now: number): void {
    const b = this.snap;
    if (!b) return;
    this.refill.textContent = b.status === 'ok' ? compactRefill(b.nextRefresh, now) : '';
    if (!this.hovered && this.bubbleUntil && now > this.bubbleUntil) {
      this.bubble.classList.remove('show');
      this.bubbleUntil = 0;
    }
    if (!this.hovered && now > this.nextChat && b.status === 'ok') {
      this.nextChat = now + rand(35000, 90000);
      this.say(this.chatLine(), 5500);
    }
  }

  destroy(): void {
    this.anim.destroy();
    this.root.remove();
  }
}

const views = new Map<AgentId, BuddyView>();

function visibleBuddies(s: AppState): BuddySnapshot[] {
  const allowed = s.buddies.filter((b) => (b.agent === 'claude' ? s.settings.showClaude : s.settings.showCodex));
  const configured = allowed.filter((b) => b.status !== 'unconfigured');
  return configured.length ? configured : allowed;
}

function render(): void {
  if (!state) return;
  const scale = state.settings.scale;
  document.body.classList.toggle('scale-1', scale === 1);
  const list = visibleBuddies(state);
  const keep = new Set(list.map((b) => b.agent));
  for (const [agent, view] of views) {
    if (!keep.has(agent)) {
      view.destroy();
      views.delete(agent);
    }
  }
  for (const b of list) {
    let view = views.get(b.agent);
    if (!view) {
      view = new BuddyView(b.agent, scale);
      views.set(b.agent, view);
    }
    stage.appendChild(view.root); // keeps DOM order == list order
    view.layout(scale);
    view.update(b, state.locale);
  }
  reportSize();
}

let lastSize = '';
function reportSize(): void {
  const r = stage.getBoundingClientRect();
  const key = `${Math.ceil(r.width)}x${Math.ceil(r.height)}`;
  if (key === lastSize) return;
  lastSize = key;
  qb().resizePet(Math.ceil(r.width), Math.ceil(r.height));
}
new ResizeObserver(reportSize).observe(stage);

// ------------------------------------------------------------------ mouse: click-through, drag, click

let interactive = false;
function setInteractive(on: boolean): void {
  if (on === interactive) return;
  interactive = on;
  qb().setIgnoreMouse(!on);
}

let drag: { x: number; y: number; moved: boolean; id: number; el: Element } | null = null;

document.addEventListener('mousemove', (e) => {
  if (drag) return;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  setInteractive(!!el?.closest('.hit'));
});
document.addEventListener('mouseleave', () => {
  if (!drag) setInteractive(false);
});

stage.addEventListener('pointerdown', (e) => {
  const target = (e.target as Element).closest('.hit');
  if (!target || e.button !== 0) return;
  drag = { x: e.screenX, y: e.screenY, moved: false, id: e.pointerId, el: target };
  target.setPointerCapture(e.pointerId);
  target.classList.add('dragging');
  qb().drag('start', e.screenX, e.screenY);
});
stage.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  if (!drag.moved && Math.hypot(e.screenX - drag.x, e.screenY - drag.y) > 4) drag.moved = true;
  if (drag.moved) qb().drag('move', e.screenX, e.screenY);
});
stage.addEventListener('pointerup', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const { moved, el } = drag;
  el.classList.remove('dragging');
  drag = null;
  qb().drag('end', e.screenX, e.screenY);
  if (!moved) qb().togglePanel();
});
stage.addEventListener('dblclick', () => qb().refresh());
stage.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  qb().petMenu();
});

setInterval(() => {
  const now = Date.now();
  for (const v of views.values()) v.tick(now);
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
  });
