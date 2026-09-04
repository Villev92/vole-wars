import { Container, Graphics, Sprite, type Texture } from "pixi.js";

// The mine art (weapon_mine.png, the same icon the selector uses) is drawn small on the ground.
// Roughly matches the size of the mine held in hand before it's dropped (HELD_WEAPON_VISUALS.mine
// scale 0.041 * ENTITY_SCALE 0.225).
const MINE_SCALE = 0.0085;

export interface MineView {
  id: string;
  x: number;
  y: number;
  armed: boolean;
}

interface Rendered {
  sprite: Sprite;
  blink: Graphics;
}

/**
 * Renders dropped proximity mines (see GameRoom's mine handling + state.ts MineSchema): the weapon
 * icon sitting on the terrain, plus a small blinking red light once the mine has armed. Position is
 * read from the synced schema every frame (mines fall for a moment before landing). Cosmetic — the
 * trigger, arm timer and blast are all the server's.
 */
export class MineLayer {
  private readonly container = new Container();
  private readonly views = new Map<string, Rendered>();

  constructor(
    world: Container,
    private readonly texture: Texture
  ) {
    // Just above the terrain/blood layers, under the characters — like the corpses.
    world.addChildAt(this.container, 3);
  }

  add(id: string, x: number, y: number): void {
    if (this.views.has(id)) return;
    const sprite = new Sprite(this.texture);
    sprite.anchor.set(0.5, 0.62);
    sprite.scale.set(MINE_SCALE);
    sprite.position.set(x, y);
    const blink = new Graphics();
    blink.position.set(x, y);
    this.container.addChild(sprite, blink);
    this.views.set(id, { sprite, blink });
  }

  remove(id: string): void {
    const r = this.views.get(id);
    if (!r) return;
    r.sprite.destroy();
    r.blink.destroy();
    this.views.delete(id);
  }

  update(time: number, mines: MineView[]): void {
    for (const m of mines) {
      const r = this.views.get(m.id);
      if (!r) continue;
      r.sprite.position.set(m.x, m.y);
      r.blink.position.set(m.x, m.y);
      r.blink.clear();
      // Blinks red for the ~5s it's arming; the blink STOPS once it's live (armed) — a still,
      // silent mine is the dangerous one.
      if (!m.armed && Math.sin(time * 8) > 0.2) {
        r.blink.circle(0, -1.4, 1).fill({ color: 0xff2a1a, alpha: 0.95 });
        r.blink.circle(0, -1.4, 2.2).fill({ color: 0xff5a3a, alpha: 0.28 });
      }
    }
  }
}
