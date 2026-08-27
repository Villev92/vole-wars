import { Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import { WEAPON_IDS, WEAPON_LABELS, type TexturedWeaponId, type WeaponId } from "./weaponIcons.js";

const BOX_SIZE = 84;
const BOX_GAP = 8;
const ICON_PADDING = 4; // screen px of margin kept between the icon and the box edge (was 8 — icons read small)
const BOTTOM_MARGIN = 16; // screen px between the bar and the bottom of the window

// Per-weapon size multiplier applied on top of the fit-to-box scale. grenade and mine are drawn as
// small centred objects (not a full-width gun) with a lot of empty canvas around them, so they came
// out noticeably tinier than the rifles even at the same box fit — bump them up to match.
const ICON_BOOST: Partial<Record<WeaponId, number>> = {
  grenade: 1.3,
  mine: 1.3,
};

// Was near-black (0x101418, matching the page background) — indistinguishable from the icons' own
// dark ink outlines and shadowed metal tones, so weapons read as floating fragments rather than
// silhouettes against a panel. Lightened twice since (0x2c2925, then 0x59524a) and still asked for
// more — pushed to a proper mid-tone warm grey this time so the icons' near-black (0x1c130c)
// outlines read as unambiguously the darkest thing in the box, not just a shade darker than the fill.
const BG_COLOR = 0x7c7365;
const BG_ALPHA = 0.92;
const BORDER_COLOR = 0x938a7a;
// Slot bar background lightened one step further than the preview panel's BG_COLOR — the slots are
// small enough that the extra contrast matters more here for telling icons apart at a glance.
const SLOT_BG_COLOR = 0x9c9384;
const SLOT_BG_ALPHA = 0.9;
const HIGHLIGHT_COLOR = 0x8fe38f; // matches the FPS counter / respawn button's accent green

// Large "what am I holding" panel, separate from the slot bar — mid-left of the screen, always
// showing the currently selected weapon much bigger than a 64px slot can, since the slot icons are
// still small enough at a glance to be hard to tell apart.
const PREVIEW_SIZE = 128;
const PREVIEW_ICON_PADDING = 14;
const PREVIEW_LEFT_MARGIN = 20;
const PREVIEW_LABEL_MARGIN = 10; // gap kept between the icon and the label above the bottom edge

interface Slot {
  root: Container;
  bg: Graphics;
}

/** Scales+centers a Sprite to fit (preserving aspect ratio) within a boxSize x boxSize square,
 *  times an optional `boost` (>1 lets a small-content icon overflow the padding to read larger). */
function fitSpriteInBox(sprite: Sprite, boxSize: number, padding: number, boost = 1): void {
  const available = boxSize - padding * 2;
  const scale = Math.min(available / sprite.texture.width, available / sprite.texture.height) * boost;
  sprite.anchor.set(0.5, 0.5);
  sprite.scale.set(scale);
  sprite.position.set(boxSize / 2, boxSize / 2);
}

/**
 * Bottom-center weapon bar: ten fixed slots (see weaponIcons.ts's WEAPON_IDS), selectable with the
 * 1-9/0 keys or the scroll wheel. Only tracks the current selection — main.ts reads `selectedId`
 * to decide what's held/fired.
 */
export class WeaponSelector {
  readonly container: Container;
  readonly preview: Container;
  private readonly slots: Slot[] = [];
  private readonly previewBg: Graphics;
  private readonly previewIconSprite: Sprite;
  private readonly cooldownOverlay: Graphics;
  private readonly previewLabel: Text;
  private readonly iconTextures: Record<TexturedWeaponId, Texture>;
  private selectedIndex = 0;

  /**
   * Called when a slot is chosen by *clicking* it (not by key or scroll). The same click also lands
   * on the game canvas underneath as a left-press, which would otherwise fire the weapon — main.ts
   * hooks this to swallow that one canvas press. A slot's Pixi pointerdown runs before the canvas's
   * DOM mousedown (pointer events precede mouse events), so the flag is set in time.
   */
  onSlotPointerDown: (() => void) | null = null;

  constructor(iconTextures: Record<TexturedWeaponId, Texture>) {
    this.iconTextures = iconTextures;
    this.container = new Container();

    this.preview = new Container();
    this.previewBg = new Graphics();
    this.preview.addChild(this.previewBg);
    this.previewIconSprite = new Sprite();
    this.preview.addChild(this.previewIconSprite);
    // Round "on cooldown" wipe drawn over the preview icon — see setCooldown/drawCooldown. Sits
    // above the icon but below the label so the weapon name stays legible while it's up.
    this.cooldownOverlay = new Graphics();
    this.preview.addChild(this.cooldownOverlay);
    this.previewLabel = new Text({
      text: "",
      style: { fill: 0xd7e0e8, fontFamily: "monospace", fontSize: 13, fontWeight: "600" },
    });
    this.previewLabel.anchor.set(0.5, 1);
    this.previewLabel.position.set(PREVIEW_SIZE / 2, PREVIEW_SIZE - PREVIEW_LABEL_MARGIN);
    this.preview.addChild(this.previewLabel);

    WEAPON_IDS.forEach((id, index) => {
      const root = new Container();
      root.position.set(index * (BOX_SIZE + BOX_GAP), 0);

      const bg = new Graphics();
      root.addChild(bg);

      const sprite = new Sprite(this.iconTextures[id]);
      fitSpriteInBox(sprite, BOX_SIZE, ICON_PADDING, ICON_BOOST[id] ?? 1);
      root.addChild(sprite);

      const keyLabel = new Text({
        text: String((index + 1) % 10),
        style: { fill: 0x9aa4ad, fontFamily: "monospace", fontSize: 10 },
      });
      keyLabel.position.set(4, 2);
      root.addChild(keyLabel);

      root.eventMode = "static";
      root.cursor = "pointer";
      root.on("pointerdown", () => {
        this.onSlotPointerDown?.();
        this.setSelected(index);
      });

      this.container.addChild(root);
      this.slots.push({ root, bg });
    });

    this.redraw();
  }

  private redraw(): void {
    this.slots.forEach((slot, i) => {
      const selected = i === this.selectedIndex;
      slot.bg.clear();
      slot.bg.roundRect(0, 0, BOX_SIZE, BOX_SIZE, 6).fill({ color: SLOT_BG_COLOR, alpha: SLOT_BG_ALPHA });
      slot.bg.roundRect(0, 0, BOX_SIZE, BOX_SIZE, 6).stroke({
        width: selected ? 2.5 : 1,
        color: selected ? HIGHLIGHT_COLOR : BORDER_COLOR,
      });
      slot.root.alpha = selected ? 1 : 0.78;
    });

    this.previewBg.clear();
    this.previewBg.roundRect(0, 0, PREVIEW_SIZE, PREVIEW_SIZE, 10).fill({ color: BG_COLOR, alpha: BG_ALPHA });
    this.previewBg.roundRect(0, 0, PREVIEW_SIZE, PREVIEW_SIZE, 10).stroke({ width: 2, color: HIGHLIGHT_COLOR });

    this.previewIconSprite.texture = this.iconTextures[this.selectedId];
    fitSpriteInBox(this.previewIconSprite, PREVIEW_SIZE, PREVIEW_ICON_PADDING, ICON_BOOST[this.selectedId] ?? 1);

    this.previewLabel.text = this.selectedLabel;
  }

  /**
   * Draws (or clears) a round cooldown wipe over the preview icon — `ratio` is the fraction of the
   * currently selected weapon's fireCooldown still remaining, 1 right after firing down to 0 once
   * it's fireable again. Most noticeable on slow weapons (sniper, bazooka) where the wait is long
   * enough to actually see; on fast ones it just flickers, which is correct — there's really nothing
   * to wait for. Redrawn every frame from main.ts's ticker, driven by its own client-side prediction
   * of the same fireCooldown the server enforces (see main.ts's lastFireAt).
   */
  setCooldown(ratio: number): void {
    const clamped = Math.max(0, Math.min(1, ratio));
    this.cooldownOverlay.clear();
    if (clamped <= 0) return;

    const cx = PREVIEW_SIZE / 2;
    const cy = PREVIEW_SIZE / 2;
    const r = PREVIEW_SIZE / 2 - 3;
    const start = -Math.PI / 2;
    const end = start + clamped * Math.PI * 2;
    // Dark pie wedge sweeping clockwise from the top, shrinking away as the cooldown finishes —
    // the same "clock wipe" every ability-cooldown icon uses.
    this.cooldownOverlay.moveTo(cx, cy).arc(cx, cy, r, start, end).lineTo(cx, cy).fill({ color: 0x0a0a0a, alpha: 0.62 });
    // Ring traces the full circle so "not fireable yet" reads clearly even at a glance, before the
    // wedge shape itself registers.
    this.cooldownOverlay.circle(cx, cy, r).stroke({ width: 1.5, color: HIGHLIGHT_COLOR, alpha: 0.5 });
  }

  setSelected(index: number): void {
    const wrapped = ((index % WEAPON_IDS.length) + WEAPON_IDS.length) % WEAPON_IDS.length;
    if (wrapped === this.selectedIndex) return;
    this.selectedIndex = wrapped;
    this.redraw();
  }

  /** Moves the selection by `delta` slots, wrapping around both ends — used for scroll-wheel input. */
  step(delta: number): void {
    this.setSelected(this.selectedIndex + delta);
  }

  get selectedId(): WeaponId {
    return WEAPON_IDS[this.selectedIndex];
  }

  get selectedLabel(): string {
    return WEAPON_LABELS[this.selectedId];
  }

  /**
   * Repositions the slot bar (centered horizontally near the bottom) and the preview panel
   * (mid-left, vertically centered) for the given screen size.
   */
  layout(screenWidth: number, screenHeight: number): void {
    const totalWidth = WEAPON_IDS.length * BOX_SIZE + (WEAPON_IDS.length - 1) * BOX_GAP;
    this.container.position.set(Math.round((screenWidth - totalWidth) / 2), Math.round(screenHeight - BOX_SIZE - BOTTOM_MARGIN));
    this.preview.position.set(PREVIEW_LEFT_MARGIN, Math.round((screenHeight - PREVIEW_SIZE) / 2));
  }
}
