import { formatDuration, formatPercent } from '../../shared/format';
import { hudRows, type WindowView } from '../../shared/hud';
import { bubbleLines, hasKey, t } from '../../shared/i18n';
import { moodFor } from '../../shared/mood';
import type { AgentId, AppState, BuddySnapshot, Locale, Mood, Thresholds } from '../../shared/types';
import { qb } from '../common/api';
import { maxFrame, spriteMeta, SpriteAnimator } from '../common/sprites';
import { MOOD_COLORS, windowLabel } from '../common/view';

const SEGMENTS = 8;
const stage = document.getElementById('stage')!;
let state: AppState | null = null;

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];
const shortLabel = (L: Locale, id: string) => (hasKey(`short.${id}`) ? t(L, `short.${id}`) : id);

/** One meter row: [5h] ▮▮▮▮▯▯▯▯ 40% 3h29m */
class MeterRow {
  readonly el: HTMLDivElement;
  private tag: HTMLSpanElement;
  private segs: HTMLElement[];
  private pct: HTMLSpanElement;
  private cd: HTMLSpanElement;
  refillAt?: string;

  constructor(readonly id: string) {
    this.el = document.createElement('div');
    this.el.className = 'row enter';
    this.el.innerHTML = `<span class="tag"></span><div class="meter">${'<i></i>'.repeat(SEGMENTS)}</div><span class="pct"></span><span class="cd"></span>`;
    this.tag = this.el.querySelector('.tag')!;
    this.segs = [...this.el.querySelectorAll<HTMLElement>('.meter i')];
    this.pct = this.el.querySelector('.pct')!;
    this.cd = this.el.querySelector('.cd')!;
    this.el.addEventListener('animationend', () => this.el.classList.remove('enter'), { once: true });
  }

  set(tag: string, remaining: number | null, color: string, refill: number | undefined, text: string, refillAt?: string): void {
    this.tag.textContent = tag;
    this.tag.hidden = !tag;
    this.el.style.setProperty('--fill', color);
    const value = remaining === null ? 100 : remaining;
    const lit = value <= 0 ? 0 : Math.max(1, Math.round((value / 100) * SEGMENTS));
    // Segments the next refill brings back blink: the refresh schedule is part of the meter.
    const soon = refill ? Math.min(SEGMENTS - lit, Math.round((Math.min(100, value + refill) - value) / (100 / SEGMENTS))) : 0;
    this.segs.forEach((seg, i) => {
      seg.classList.toggle('on', i < lit);
      seg.classList.toggle('soon', i >= lit && i < lit + soon);
    });
    this.pct.textContent = text;
    this.refillAt = refillAt;
  }

  tick(now: number, showCountdown: boolean): void {
    const left = this.refillAt ? Date.parse(this.refillAt) - now : 0;
    this.cd.textContent = showCountdown && left > 0 ? formatDuration(left) : '';
    this.cd.hidden = !this.cd.textContent;
  }
}

class BuddyView {
  readonly root: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private stand: HTMLDivElement;
  private anim: SpriteAnimator;
  private bubble: HTMLDivElement;
  private rowsEl: HTMLDivElement;
  private sub: HTMLDivElement;
  private rows = new Map<string, MeterRow>();
  private urgent = false;
  private lead: WindowView | undefined;
  private snap: BuddySnapshot | null = null;
  private locale: Locale = 'en';
  private thresholds: Thresholds | null = null;
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
      <div class="hud hit"><div class="rows"></div><div class="sub"></div></div>`;
    this.stand = this.root.querySelector('.stand')!;
    this.canvas = this.root.querySelector('canvas')!;
    this.bubble = this.root.querySelector('.bubble')!;
    this.rowsEl = this.root.querySelector('.rows')!;
    this.sub = this.root.querySelector('.sub')!;
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

  private row(id: string): MeterRow {
    let r = this.rows.get(id);
    if (!r) {
      r = new MeterRow(id);
      this.rows.set(id, r);
    }
    return r;
  }

  update(b: BuddySnapshot, locale: Locale, thresholds: Thresholds): void {
    const first = this.snap === null;
    this.snap = b;
    this.locale = locale;
    this.thresholds = thresholds;
    this.root.classList.toggle('error', b.status === 'error');
    this.root.classList.toggle('unconfigured', b.status === 'unconfigured');
    const mood: Mood = b.status === 'unconfigured' ? 'exhausted' : b.mood;
    this.root.classList.toggle('anxious', mood === 'anxious' && b.status === 'ok');
    this.anim.setMood(mood);

    // Which rows: the tightest window normally, every limiting window when things get tight.
    const wanted: MeterRow[] = [];
    if (b.status !== 'ok') {
      wanted.push(this.row('status'));
      wanted[0].set('', 0, '#8d8a9e', undefined, b.status === 'error' ? '?' : '-');
      this.urgent = false;
      this.lead = undefined;
    } else {
      const { urgent, rows } = hudRows(b, thresholds);
      this.urgent = urgent;
      this.lead = rows[0];
      if (!rows.length) {
        const r = this.row('none');
        r.set('', null, MOOD_COLORS[mood], undefined, '∞');
        wanted.push(r);
      }
      for (const w of rows) {
        const r = this.row(w.id);
        r.set(shortLabel(locale, w.id), w.remaining, MOOD_COLORS[moodFor(w.remaining, thresholds)], w.refill, `${formatPercent(w.remaining)}%`, w.refillAt);
        wanted.push(r);
      }
    }
    const keep = new Set(wanted);
    for (const [id, r] of this.rows) {
      if (!keep.has(r)) {
        r.el.remove();
        this.rows.delete(id);
      }
    }
    wanted.forEach((r) => this.rowsEl.appendChild(r.el));
    this.root.classList.toggle('urgent', this.urgent);
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

  private refillText(w: WindowView | undefined, now = Date.now()): string | null {
    if (!w?.refillAt) return null;
    const left = Date.parse(w.refillAt) - now;
    if (left <= 0) return null;
    const pct = w.refill ? Math.round(w.refill) : 0;
    return pct ? t(this.locale, 'ui.restoreIn', { time: formatDuration(left), pct }) : t(this.locale, 'ui.resetsIn', { time: formatDuration(left) });
  }

  private hoverLine(): string {
    const b = this.snap;
    const L = this.locale;
    if (!b) return '';
    const name = t(L, `agent.${b.agent}`);
    if (b.status === 'unconfigured') return `${name}: ${t(L, 'ui.unconfigured')}`;
    if (b.status === 'error') return `${name}: ${b.error ?? t(L, 'ui.error')}`;
    const { rows } = hudRows(b, this.thresholds!);
    const lines = rows.length ? [] : [t(L, 'ui.noLimit')];
    // the hover shows every window, not just the ones in the compact meter
    const all = hudRows(b, { ...this.thresholds!, relaxed: 101 }).rows;
    for (const w of all) {
      const refill = this.refillText(w);
      lines.push(`${windowLabel(L, { id: w.id, label: w.label } as any)} ${formatPercent(w.remaining)}%${refill ? ` · ${refill}` : ''}`);
    }
    return `${name} · ${t(L, `mood.${b.mood}`)}\n${lines.join('\n')}`;
  }

  private chatLine(): string {
    const b = this.snap!;
    const L = this.locale;
    const refill = this.refillText(this.lead);
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
    for (const r of this.rows.values()) r.tick(now, this.urgent);
    // calm: one line under the meter says when the tightest window refills
    const sub = !this.urgent && b.status === 'ok' && this.lead?.refillAt ? Date.parse(this.lead.refillAt) - now : 0;
    this.sub.textContent = sub > 0 ? `↻${formatDuration(sub)}${this.lead?.refill ? ` +${Math.round(this.lead.refill)}%` : ''}` : '';
    this.sub.hidden = !this.sub.textContent;
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
    view.update(b, state.locale, state.settings.thresholds);
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
