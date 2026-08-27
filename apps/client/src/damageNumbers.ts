import { Container, Text } from "pixi.js";

// The number is authored at this font size and scaled down into world units — rendering big then
// shrinking keeps it crisp when the camera zooms in, the same reason voleArt parts are oversized.
const FONT_SIZE = 40;
const WORLD_SCALE = 0.135; // FONT_SIZE px -> ~5.5 world units tall
const LIFETIME = 0.9; // seconds on screen
const RISE_SPEED = 16; // world units/sec, drifting up
// Spawned just above the head and a touch to the right of the character's origin (server sends the
// blood/damage event at vole.x/y, which sits at the neck — see voleArt.ts).
const OFFSET_X = 7;
const OFFSET_Y = -16;

interface FloatingNumber {
  text: Text;
  x: number;
  y: number;
  age: number;
  done: boolean;
}

/**
 * Short-lived "-5" style damage numbers that pop above a vole and drift up as they fade, one per
 * `blood` event the server broadcasts (i.e. every time any vole actually takes damage). Purely
 * cosmetic. Lives in its own container that's kept on top while any number is visible.
 */
export class DamageNumberLayer {
  private readonly container = new Container();
  private nums: FloatingNumber[] = [];

  constructor(private readonly world: Container) {
    this.world.addChild(this.container);
  }

  spawn(x: number, y: number, amount: number): void {
    const dmg = Math.round(amount);
    if (dmg <= 0) return;

    const text = new Text({
      text: `-${dmg}`,
      style: {
        fontFamily: "Arial, sans-serif",
        fontSize: FONT_SIZE,
        fontWeight: "800",
        fill: 0xff5545,
        stroke: { color: 0x230a05, width: 6 },
      },
    });
    text.anchor.set(0.5, 1);
    text.scale.set(WORLD_SCALE);

    // A little horizontal jitter so several hits landing at once don't stack into an unreadable pile.
    const nx = x + OFFSET_X + (Math.random() - 0.5) * 5;
    const ny = y + OFFSET_Y + (Math.random() - 0.5) * 3;
    text.position.set(nx, ny);
    this.container.addChild(text);
    this.nums.push({ text, x: nx, y: ny, age: 0, done: false });
  }

  update(dt: number): void {
    if (this.nums.length > 0) {
      const kids = this.world.children;
      if (kids[kids.length - 1] !== this.container) this.world.addChild(this.container);
    }

    for (const n of this.nums) {
      n.age += dt;
      const t = n.age / LIFETIME;
      if (t >= 1) {
        n.text.destroy();
        n.done = true;
        continue;
      }
      // Decelerating drift upward.
      n.y -= RISE_SPEED * dt * (1 - t * 0.6);
      n.text.position.set(n.x, n.y);
      // Quick pop-in, hold, then fade out over the last third.
      const pop = t < 0.14 ? 0.55 + (t / 0.14) * 0.45 : 1;
      n.text.scale.set(WORLD_SCALE * pop);
      n.text.alpha = t < 0.66 ? 1 : 1 - (t - 0.66) / 0.34;
    }

    if (this.nums.some((n) => n.done)) this.nums = this.nums.filter((n) => !n.done);
  }
}
