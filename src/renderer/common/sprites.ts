import claudeMeta from '../../../assets/sprites/claude/sprite.json';
import gptMeta from '../../../assets/sprites/gpt/sprite.json';
import type { AgentId, Mood } from '../../shared/types';

interface SpriteMeta {
  frameWidth: number;
  frameHeight: number;
  groundY: number;
  moods: Record<string, { file: string; frames: number }>;
}

const SHEETS: Record<AgentId, { dir: string; meta: SpriteMeta }> = {
  claude: { dir: 'claude', meta: claudeMeta as SpriteMeta },
  codex: { dir: 'gpt', meta: gptMeta as SpriteMeta },
};

/** [frame index, duration ms] — hand-tuned so each mood has its own rhythm. */
const SEQUENCES: Record<Mood, [number, number][]> = {
  energetic: [
    [0, 190],
    [1, 140],
    [2, 220],
    [3, 170],
  ],
  relaxed: [
    [0, 800],
    [1, 700],
    [0, 800],
    [1, 700],
    [2, 150],
    [0, 600],
    [1, 700],
    [3, 1100],
  ],
  tired: [
    [0, 900],
    [1, 900],
    [2, 1300],
    [3, 900],
  ],
  anxious: [
    [0, 120],
    [1, 110],
    [2, 110],
    [1, 110],
    [2, 110],
    [3, 220],
  ],
  exhausted: [
    [0, 1000],
    [1, 900],
    [2, 900],
    [3, 1300],
  ],
};

export function spriteMeta(agent: AgentId): SpriteMeta {
  return SHEETS[agent].meta;
}

/** Largest frame among all characters, so buddies of different sizes share one ground line. */
export function maxFrame(): { width: number; height: number; below: number } {
  const metas = Object.values(SHEETS).map((s) => s.meta);
  return {
    width: Math.max(...metas.map((m) => m.frameWidth)),
    height: Math.max(...metas.map((m) => m.groundY)),
    below: Math.max(...metas.map((m) => m.frameHeight - m.groundY)),
  };
}

const images = new Map<string, HTMLImageElement>();
function sheet(agent: AgentId, mood: Mood): HTMLImageElement {
  const url = `../../assets/sprites/${SHEETS[agent].dir}/${mood}.png`;
  let img = images.get(url);
  if (!img) {
    img = new Image();
    img.src = url;
    images.set(url, img);
  }
  return img;
}

const animators = new Set<SpriteAnimator>();
let rafStarted = false;
function loop(now: number): void {
  for (const a of animators) a.tick(now);
  requestAnimationFrame(loop);
}

export class SpriteAnimator {
  private mood: Mood = 'relaxed';
  private step = 0;
  private stepStarted = 0;
  private ctx: CanvasRenderingContext2D;
  private lastDrawn = '';

  constructor(
    private canvas: HTMLCanvasElement,
    private agent: AgentId,
    private scale: number,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.resize();
    animators.add(this);
    if (!rafStarted) {
      rafStarted = true;
      requestAnimationFrame(loop);
    }
  }

  private resize(): void {
    const m = spriteMeta(this.agent);
    this.canvas.width = m.frameWidth * this.scale;
    this.canvas.height = m.frameHeight * this.scale;
    this.canvas.style.width = `${m.frameWidth * this.scale}px`;
    this.canvas.style.height = `${m.frameHeight * this.scale}px`;
    this.lastDrawn = '';
  }

  setScale(scale: number): void {
    if (scale === this.scale) return;
    this.scale = scale;
    this.resize();
  }

  setMood(mood: Mood): void {
    if (mood === this.mood) return;
    this.mood = mood;
    this.step = 0;
    this.stepStarted = performance.now();
    sheet(this.agent, mood);
  }

  destroy(): void {
    animators.delete(this);
  }

  tick(now: number): void {
    const seq = SEQUENCES[this.mood];
    if (!this.stepStarted) this.stepStarted = now;
    while (now - this.stepStarted >= seq[this.step % seq.length][1]) {
      this.stepStarted += seq[this.step % seq.length][1];
      this.step = (this.step + 1) % seq.length;
      if (now - this.stepStarted > 5000) this.stepStarted = now; // tab was asleep
    }
    const frame = seq[this.step % seq.length][0];
    const img = sheet(this.agent, this.mood);
    if (!img.complete || !img.naturalWidth) return;
    const key = `${this.mood}:${frame}:${this.scale}`;
    if (key === this.lastDrawn) return;
    this.lastDrawn = key;
    const m = spriteMeta(this.agent);
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.drawImage(img, frame * m.frameWidth, 0, m.frameWidth, m.frameHeight, 0, 0, m.frameWidth * this.scale, m.frameHeight * this.scale);
  }
}
