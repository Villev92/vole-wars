import type { PlayerInput } from "@vole-wars/shared";

export class InputTracker {
  private left = false;
  private right = false;
  private jump = false;
  // Which of jump's several keys are currently held — see handleKey. Tracked as a set (rather than
  // one shared boolean toggled by whichever key's event fires last) so releasing one jump key while
  // another is still held doesn't clear `jump` out from under it.
  private jumpKeysHeld = new Set<string>();
  private up = false;
  private down = false;
  private dash = false;
  private burrow = false;
  private grapple = false;
  private aimAngle = 0;
  private firePending = false;
  private fireHeld = false;
  private suppressFire = false;

  private onFire: () => void;
  // Dig ability (see net.ts sendDig / GameRoom.handleDig). Fired when a horizontal move key is
  // freshly pressed while the OPPOSITE horizontal key is already held — the "hold into the wall, tap
  // the other way" gesture. The arg is the direction held INTO the wall (-1 left, +1 right).
  private onDig: (dir: -1 | 1) => void = () => {};

  constructor(
    canvas: HTMLCanvasElement,
    getVolePosition: () => { x: number; y: number } | null,
    getCamera: () => { scale: number; offsetX: number; offsetY: number }
  ) {
    window.addEventListener("keydown", (e) => {
      // Space is a jump key (see handleKey) — without this the browser's own default (scroll the
      // page / activate whatever element happens to have focus, e.g. a button) fires alongside it.
      if (e.code === "Space") e.preventDefault();
      this.handleKey(e.code, true);
    });
    window.addEventListener("keyup", (e) => this.handleKey(e.code, false));

    canvas.addEventListener("mousemove", (e) => {
      const pos = getVolePosition();
      if (!pos) return;
      const rect = canvas.getBoundingClientRect();
      const { scale, offsetX, offsetY } = getCamera();
      const mouseX = (e.clientX - rect.left - offsetX) / scale;
      const mouseY = (e.clientY - rect.top - offsetY) / scale;
      this.aimAngle = Math.atan2(mouseY - pos.y, mouseX - pos.x);
    });

    // Right-click drives the grapple rope (held for as long as the button is down) rather than the
    // browser's native "Save image as.../Inspect" menu, so that menu is suppressed outright here —
    // the one place that already owns every other canvas input listener.
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    canvas.addEventListener("mousedown", (e) => {
      if (e.button === 0) {
        // A click that just selected a weapon slot (Pixi HUD, drawn on this same canvas) also
        // reaches here as a plain left-press — suppressNextFire() flags it so it doesn't shoot.
        if (this.suppressFire) this.suppressFire = false;
        else this.firePending = true;
        // Separate from the firePending edge: the flamethrower streams for as long as this stays
        // true (see main.ts). Set even on a suppressed slot-click — the release still clears it.
        this.fireHeld = true;
      }
      if (e.button === 2) this.grapple = true;
    });
    canvas.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.fireHeld = false;
      if (e.button === 2) this.grapple = false;
    });
    // Releasing a button outside the canvas (e.g. dragged off-window) would otherwise leave grapple
    // (or the flamethrower stream) stuck on forever, since that mouseup never reaches the canvas.
    window.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.fireHeld = false;
      if (e.button === 2) this.grapple = false;
    });

    this.onFire = () => {};
  }

  setFireHandler(handler: () => void): void {
    this.onFire = handler;
  }

  setDigHandler(handler: (dir: -1 | 1) => void): void {
    this.onDig = handler;
  }

  /** Cancels the very next left-press so a weapon-slot click doesn't also fire (see the mousedown
   * listener). Safe to call unconditionally on every slot click — the flag is consumed by the one
   * canvas press that immediately follows. */
  suppressNextFire(): void {
    this.suppressFire = true;
  }

  /** Whether the left mouse button is currently held down — drives the flamethrower's continuous
   *  stream (every other weapon uses the one-shot fire handler / firePending edge instead). */
  isFireHeld(): boolean {
    return this.fireHeld;
  }

  private handleKey(code: string, down: boolean): void {
    const isLeftKey = code === "ArrowLeft" || code === "KeyA";
    const isRightKey = code === "ArrowRight" || code === "KeyD";
    // Dig gesture: a fresh press of one horizontal key while the OPPOSITE one is already held. The
    // `!this.right` / `!this.left` guard (checked before the assignments below) is also what makes
    // holding both keys dig only ONCE — a key-repeat keydown finds the opposite key already flagged.
    if (down && isRightKey && this.left && !this.right) this.onDig(-1);
    if (down && isLeftKey && this.right && !this.left) this.onDig(1);
    if (isLeftKey) this.left = down;
    if (isRightKey) this.right = down;
    if (code === "ArrowUp" || code === "KeyW") this.up = down;
    if (code === "ArrowDown" || code === "KeyS") this.down = down;
    // Jump is 'W', ArrowUp, or Space — W/ArrowUp also feed "up" / rope reel-in above. While on the
    // rope the jump code never runs (stepSwing returns first), and jump needs a release + fresh press
    // to re-fire, so holding W to reel in doesn't leak a jump on rope release or landing. `jump` tracks
    // "is ANY of these three currently held" via jumpKeysHeld, so e.g. holding W and tapping Space
    // doesn't drop the flag the instant Space is released.
    if (code === "KeyW" || code === "ArrowUp" || code === "Space") {
      if (down) this.jumpKeysHeld.add(code);
      else this.jumpKeysHeld.delete(code);
      this.jump = this.jumpKeysHeld.size > 0;
    }
    // Left Shift triggers the Dash superpower. Only the left key specifically (ShiftLeft, not
    // ShiftRight) — matches Zoom below using Left Ctrl specifically, so a hand resting near either
    // modifier key can't misfire the other one's ability. Server-side dashHeld edge-triggers off
    // this, so it's just "is Left Shift down" here.
    if (code === "ShiftLeft") this.dash = down;
    // 'C' triggers the Burrow superpower. Server-side burrowHeld edge-triggers off this (a fresh
    // press starts it, or cancels it mid-animation), so it's just "is C down" here.
    if (code === "KeyC") this.burrow = down;
  }

  /** Call once per frame: returns current input state and flushes the fire edge-trigger. */
  poll(): PlayerInput {
    if (this.firePending) {
      this.firePending = false;
      this.onFire();
    }
    return {
      left: this.left,
      right: this.right,
      jump: this.jump,
      aimAngle: this.aimAngle,
      fire: false,
      grapple: this.grapple,
      up: this.up,
      down: this.down,
      dash: this.dash,
      burrow: this.burrow,
    };
  }
}
