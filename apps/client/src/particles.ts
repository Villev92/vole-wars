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

  update(dt: number, entityScale: number): void {
    for (const p of this.particles) {
      p.vy += DEBRIS_GRAVITY * dt;
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
      p.graphic.scale.set(entityScale);
      p.graphic.alpha = 1 - t;
    }

    if (this.particles.some((p) => p.done)) {
      this.particles = this.particles.filter((p) => !p.done);
    }
  }
}
