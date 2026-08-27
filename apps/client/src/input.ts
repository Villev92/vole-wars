import type { PlayerInput } from "@vole-wars/shared";

export class InputTracker {
  private left = false;
  private right = false;
  private jump = false;
  private up = false;
  private down = false;
  private grapple = false;
  private aimAngle = 0;
  private firePending = false;
  private fireHeld = false;
  private suppressFire = false;

  private onFire: () => void;

  constructor(
    canvas: HTMLCanvasElement,
    getVolePosition: () => { x: number; y: number } | null,
    getCamera: () => { scale: number; offsetX: number; offsetY: number }
  ) {
    window.addEventListener("keydown", (e) => this.handleKey(e.code, true));
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
    if (code === "ArrowLeft" || code === "KeyA") this.left = down;
    if (code === "ArrowRight" || code === "KeyD") this.right = down;
    if (code === "ArrowUp" || code === "KeyW") this.up = down;
    if (code === "ArrowDown" || code === "KeyS") this.down = down;
    // Space only — ArrowUp/KeyW used to double as jump too, but they're also "up" (rope reel-in),
    // so holding W to reel in a grapple was silently also arming a jump the instant you landed.
    if (code === "Space" && down && !this.jump) {
      this.jump = true;
    }
    if (code === "Space" && !down) {
      this.jump = false;
    }
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
    };
  }
}
