import { Container, Graphics } from "pixi.js";

const DEBRIS_GRAVITY = 500;
const INK = 0x1c130c;

interface Particle {
  graphic: Graphics;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rotationSpeed: number;
  age: number;
  lifetime: number;
  done: boolean;
  /** Smoke puffs rise + drift + swell + fade instead of falling under gravity like debris chunks. */
  smoke?: boolean;
  /** Smoke only — multiple of its start size it swells to over its lifetime. */
  growth?: number;
}

function clamp255(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function shadeToHex(color: [number, number, number], factor: number): number {
  return (clamp255(color[0] * factor) << 16) | (clamp255(color[1] * factor) << 8) | clamp255(color[2] * factor);
}

function drawChunk(g: Graphics, size: number, color: number): void {
  const sides = 4 + Math.floor(Math.random() * 2);
  const points: number[] = [];
  for (let i = 0; i < sides; i++) {
    const angle = (i / sides) * Math.PI * 2 + (Math.random() - 0.5) * 0.6;
    const r = size * (0.7 + Math.random() * 0.6);
    points.push(Math.cos(angle) * r, Math.sin(angle) * r);
  }
  g.poly(points).fill(color).stroke({ width: 0.4, color: INK });
}

/** Small debris chunks that pop outward and fall when terrain is destroyed — purely cosmetic. */
export class ParticleLayer {
  private particles: Particle[] = [];

  constructor(private readonly world: Container) {}

  burst(x: number, y: number, baseColor: [number, number, number], count = 16): void {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 20 + Math.random() * 65;
      const vx = Math.cos(angle) * speed;
      // Upward bias so debris "pops" outward instead of just spraying sideways/down.
      const vy = Math.sin(angle) * speed - 25 - Math.random() * 35;

      const size = 1.1 + Math.random() * 2;
      const color = shadeToHex(baseColor, 0.75 + Math.random() * 0.5);

      const graphic = new Graphics();
      drawChunk(graphic, size, color);
      graphic.position.set(x, y);
      this.world.addChild(graphic);

      this.particles.push({
        graphic,
        x,
        y,
        vx,
        vy,
        rotationSpeed: (Math.random() - 0.5) * 10,
        age: 0,
        lifetime: 0.45 + Math.random() * 0.4,
        done: false,
      });
    }
  }

  /** Dirt spray for the Dig ability (see main.ts's "dig-carve" handler) — chunks thrown in a tight
   *  fan along `angle` (the dig direction), so it reads as material kicked out of the fresh tunnel
   *  mouth rather than an omnidirectional pop like `burst`. */
  digBurst(x: number, y: number, angle: number): void {
    const dirt: [number, number, number] = [150, 110, 70];
    for (let i = 0; i < 12; i++) {
      const spread = (Math.random() - 0.5) * 1.1;
      const a = angle + spread;
      const speed = 30 + Math.random() * 70;
      const size = 1 + Math.random() * 2.2;
      const color = shadeToHex(dirt, 0.7 + Math.random() * 0.55);

      const graphic = new Graphics();
      drawChunk(graphic, size, color);
      graphic.position.set(x, y);
      this.world.addChild(graphic);

      this.particles.push({
        graphic,
        x,
        y,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed - 15 - Math.random() * 20,
        rotationSpeed: (Math.random() - 0.5) * 12,
        age: 0,
        lifetime: 0.4 + Math.random() * 0.35,
        done: false,
      });
    }
  }

  /** A single grey smoke puff at (x, y) in world units — rises, drifts, swells and fades. Used for
   *  the minigun's overheat smoke (see main.ts). */
  smoke(x: number, y: number): void {
    const shade = 0x42 + Math.floor(Math.random() * 0x36); // mid grey, 0x42..0x77
    const color = (shade << 16) | (shade << 8) | shade;
    const startRadius = 1.6 + Math.random() * 1.4;

    const graphic = new Graphics();
    graphic.circle(0, 0, startRadius).fill(color);
    graphic.position.set(x, y);
    this.world.addChild(graphic);

    this.particles.push({
      graphic,
      x,
      y,
      vx: (Math.random() - 0.5) * 16,
      vy: -20 - Math.random() * 16,
      rotationSpeed: (Math.random() - 0.5) * 2,
      age: 0,
      lifetime: 0.9 + Math.random() * 0.8,
      done: false,
      smoke: true,
      growth: 2.4 + Math.random() * 1.6,
    });
  }

  /** A puff of grey dust kicked up by a dash, at world point (x, y). `dirX,dirY` is the dash's
   *  direction (unit-ish); the puff is thrown roughly backward along it and settles fast, so a line
   *  of these along the blink path reads as "something shot through here" rather than the slow,
   *  lingering rise of the overheat smoke above. Reuses the same `smoke` update branch. */
  dashPuff(x: number, y: number, dirX: number, dirY: number): void {
    const shade = 0x4a + Math.floor(Math.random() * 0x30); // grey, 0x4a..0x79
    const color = (shade << 16) | (shade << 8) | shade;
    const startRadius = 1.3 + Math.random() * 1.7;
    // A gentle wake — thrown lightly opposite the dash with a narrow perpendicular fan — so a long
    // line of these holds its shape as a tight visible streak for a beat instead of dispersing wide.
    const back = -30 - Math.random() * 34;
    const sideways = (Math.random() - 0.5) * 18;

    const graphic = new Graphics();
    graphic.circle(0, 0, startRadius).fill(color);
    graphic.position.set(x, y);
    this.world.addChild(graphic);

    this.particles.push({
      graphic,
      x,
      y,
      vx: dirX * back - dirY * sideways,
      vy: dirY * back + dirX * sideways - 8,
      rotationSpeed: (Math.random() - 0.5) * 3,
      age: 0,
      lifetime: 0.6 + Math.random() * 0.5,
      done: false,
      smoke: true,
      growth: 1.7 + Math.random() * 1,
    });
  }

  /** A single dust mote picked up by a burrowing vole at (x, y) — spawned repeatedly while burrowing
   *  (see main.ts's renderVole). `angle` places it somewhere around the vole; the mote then swirls
   *  tangentially but mostly RISES, so the accumulated motes read as debris spiralling up the tornado
   *  funnel drawn over the character (drawTornado) rather than a flat ring flung outward. Reuses the
   *  smoke update branch, same as dashPuff. */
  burrowSwirl(x: number, y: number, angle: number): void {
    const shade = 0x3c + Math.floor(Math.random() * 0x24); // dirt-brown grey, darker than dash's smoke
    const color = (shade << 16) | (Math.floor(shade * 0.82) << 8) | Math.floor(shade * 0.6);
    const orbitR = 2 + Math.random() * 3;
    const px = x + Math.cos(angle) * orbitR;
    const py = y + Math.sin(angle) * orbitR;
    const tangentX = -Math.sin(angle);
    const tangentY = Math.cos(angle);
    const swirl = 16 + Math.random() * 16;
    const rise = 44 + Math.random() * 46; // strong upward bias — the funnel updraft
    const startRadius = 0.8 + Math.random() * 1.1;

    const graphic = new Graphics();
    graphic.circle(0, 0, startRadius).fill(color);
    graphic.position.set(px, py);
    this.world.addChild(graphic);

    this.particles.push({
      graphic,
      x: px,
      y: py,
      vx: tangentX * swirl + Math.cos(angle) * 5,
      vy: tangentY * swirl * 0.4 - rise,
      rotationSpeed: (Math.random() - 0.5) * 4,
      age: 0,
      lifetime: 0.5 + Math.random() * 0.4,
      done: false,
      smoke: true,
      growth: 1.2 + Math.random() * 0.5,
    });
  }

  update(dt: number, entityScale: number): void {
    for (const p of this.particles) {
      if (p.smoke) {
        // Drag + a little continued buoyancy — the puff shoots off the muzzle then loiters and lifts.
        p.vx *= Math.max(0, 1 - 1.8 * dt);
        p.vy *= Math.max(0, 1 - 1.2 * dt);
        p.vy -= 5 * dt;
      } else {
        p.vy += DEBRIS_GRAVITY * dt;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.age += dt;

      const t = p.age / p.lifetime;
      if (t >= 1) {
        this.world.removeChild(p.graphic);
        p.done = true;
        continue;
      }
      p.graphic.position.set(p.x, p.y);
      p.graphic.rotation += p.rotationSpeed * dt;
      if (p.smoke) {
        p.graphic.scale.set(entityScale * (1 + (p.growth! - 1) * t));
        p.graphic.alpha = Math.sin(t * Math.PI) * 0.3; // fade in, fade out
      } else {
        p.graphic.scale.set(entityScale);
        p.graphic.alpha = 1 - t;
      }
    }

    if (this.particles.some((p) => p.done)) {
      this.particles = this.particles.filter((p) => !p.done);
    }
  }
}
