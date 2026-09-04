import { Container, Graphics } from "pixi.js";

// Fire (flash + fireball + ring + jets) is spent in the first FIRE_FRAC of the run; the rest is
// drifting smoke and settling embers.
const GRENADE_DUR = 1.0;
const MINE_DUR = 1.15;
const FIRE_FRAC = 0.55;

interface Blast {
  g: Graphics;
  age: number;
  dur: number;
  /** Blast radius in terrain units — the carve radius the server sent, so the flash matches the
   *  crater it leaves. */
  r: number;
  kind: "grenade" | "mine";
  seed: number;
}

/** Ease-out — fast start, settling finish. */
function easeOut(x: number): number {
  return 1 - Math.pow(1 - x, 2.2);
}

/**
 * Standalone explosion animations for detonations that aren't tied to a flying bullet's own impact
 * flash: grenades and dropped proximity mines. Both are announced only by the server's
 * `terrain-carve` broadcast (a mine's timed/proximity trigger has no projectile at all), so main.ts
 * calls {@link spawn} from that handler. Each blast is a fully stateless per-frame redraw — a brief
 * white-hot flash, a billowing lobed fireball, an expanding shockwave ring, radial jets, then
 * rising smoke and settling embers — sized off the carve radius so it reads at the same scale as
 * the hole in the ground. Purely cosmetic; damage and terrain destruction are the server's.
 */
export class ExplosionLayer {
  private readonly container = new Container();
  private readonly blasts: Blast[] = [];

  constructor(private readonly world: Container) {
    world.addChild(this.container);
  }

  spawn(x: number, y: number, radius: number, kind: "grenade" | "mine"): void {
    const g = new Graphics();
    g.position.set(x, y);
    this.container.addChild(g);
    this.blasts.push({
      g,
      age: 0,
      dur: kind === "mine" ? MINE_DUR : GRENADE_DUR,
      r: Math.max(6, radius),
      kind,
      seed: Math.random() * 1000,
    });
  }

  update(dt: number): void {
    if (this.blasts.length === 0) return;
    // A blast belongs on top of whoever's caught in it — keep the layer last in the world while any
    // are alive (other layers, e.g. the flame cones, also re-assert themselves each frame).
    const kids = this.world.children;
    if (kids[kids.length - 1] !== this.container) this.world.addChild(this.container);

    for (let i = this.blasts.length - 1; i >= 0; i--) {
      const b = this.blasts[i];
      b.age += dt;
      const t = b.age / b.dur;
      if (t >= 1) {
        b.g.destroy();
        this.blasts.splice(i, 1);
        continue;
      }
      drawBlast(b.g, t, b.r, b.kind, b.seed);
    }
  }
}

function drawBlast(g: Graphics, t: number, R: number, kind: "grenade" | "mine", seed: number): void {
  g.clear();
  const mine = kind === "mine";

  // Fire-phase progress (0..1 across the first FIRE_FRAC of the run) and its fade.
  const ft = Math.min(1, t / FIRE_FRAC);
  const fFade = 1 - ft;
  const grow = easeOut(ft);
  const rise = ft * R * 0.35; // the whole fireball lifts a little as it burns

  const coreCol = 0xfff3d0;
  const midCol = mine ? 0xff6a24 : 0xff8a2e;
  const outCol = mine ? 0x9c2a12 : 0xc0392a;
  const smokeCol = mine ? 0x2c2320 : 0x322a24;

  // Radial jets — bright tapered spikes shooting out, gone almost immediately.
  if (ft < 0.55) {
    const jf = 1 - ft / 0.55;
    const n = mine ? 13 : 10;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + seed * 0.7 + i * 0.31;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const inner = R * 0.2;
      const outer = R * (0.7 + grow * (mine ? 2.0 : 1.7));
      const w = R * 0.14 * jf;
      g.poly(
        [ca * inner - sa * w, sa * inner + ca * w, ca * inner + sa * w, sa * inner - ca * w, ca * outer, sa * outer],
        true
      ).fill({ color: i % 2 ? coreCol : midCol, alpha: 0.7 * jf });
    }
  }

  // Shockwave ring — expands well past the crater, thinning and fading.
  const ringW = R * 0.16 * fFade;
  if (ringW > 0.05) {
    const ringR = R * (0.5 + grow * (mine ? 2.6 : 2.2));
    g.circle(0, 0, ringR).stroke({ width: ringW, color: midCol, alpha: 0.5 * fFade });
    g.circle(0, 0, ringR + ringW).stroke({ width: ringW * 0.5, color: coreCol, alpha: 0.35 * fFade });
  }

  // Billowing fireball — several seeded lobes so it isn't a plain disc.
  const ballR = R * (0.35 + grow * (mine ? 1.15 : 1.0));
  const lobes = 7;
  for (let i = 0; i < lobes; i++) {
    const a = (i / lobes) * Math.PI * 2 + seed;
    const d = ballR * (0.3 + 0.45 * Math.abs(Math.sin(seed * 1.7 + i)));
    const lr = ballR * (0.55 + 0.35 * Math.abs(Math.sin(seed * 2.3 + i * 1.4)));
    g.circle(Math.cos(a) * d, Math.sin(a) * d - rise, lr).fill({ color: outCol, alpha: 0.42 * fFade });
  }
  g.circle(0, -rise, ballR * 0.72).fill({ color: midCol, alpha: 0.5 * fFade });

  // White-hot flash core — brightest, briefest.
  const cf = Math.max(0, 1 - ft / 0.4);
  if (cf > 0) {
    const cr = R * (0.28 + easeOut(Math.min(1, ft / 0.4)) * 0.55);
    g.circle(0, 0, cr).fill({ color: midCol, alpha: 0.55 * cf });
    g.circle(0, 0, cr * 0.58).fill({ color: coreCol, alpha: 0.9 * cf });
  }

  // Embers flung outward, drooping under a little gravity as they go.
  const eN = mine ? 14 : 11;
  const et = Math.min(1, t / 0.8);
  if (et < 1) {
    for (let i = 0; i < eN; i++) {
      const a = seed * 2.1 + i * 2.399;
      const spd = R * (1.3 + 1.7 * Math.abs(Math.sin(seed + i * 3.1)));
      const dist = spd * easeOut(et);
      const px = Math.cos(a) * dist;
      const py = Math.sin(a) * dist + et * et * R * 0.7;
      const er = 0.9 * (1 - et);
      if (er > 0.05) g.circle(px, py, er).fill({ color: coreCol, alpha: 0.8 * (1 - et) });
    }
  }

  // Rising smoke aftermath — fades in as the fire dies, then thins out as it climbs and spreads.
  const st = (t - 0.18) / 0.82;
  if (st > 0) {
    const puffs = mine ? 7 : 6;
    const sFade = Math.sin(Math.min(1, st) * Math.PI); // in then out
    for (let i = 0; i < puffs; i++) {
      const a = (i / puffs) * Math.PI * 2 + seed * 1.3;
      const spread = R * (0.4 + st * (mine ? 1.5 : 1.3));
      const px = Math.cos(a) * spread;
      const py = Math.sin(a) * spread * 0.6 - st * R * (mine ? 1.9 : 1.6);
      const pr = R * (0.3 + st * 0.55) * (0.7 + 0.5 * Math.abs(Math.sin(seed + i)));
      g.circle(px, py, pr).fill({ color: smokeCol, alpha: 0.32 * sFade });
    }
  }
}
