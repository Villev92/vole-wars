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
      if (e.button === 0) this.firePending = true;
      if (e.button === 2) this.grapple = true;
    });
    canvas.addEventListener("mouseup", (e) => {
      if (e.button === 2) this.grapple = false;
    });
    // Releasing right-click outside the canvas (e.g. dragged off-window) would otherwise leave
    // grapple stuck on forever, since that mouseup never reaches the canvas listener above.
    window.addEventListener("mouseup", (e) => {
      if (e.button === 2) this.grapple = false;
    });

    this.onFire = () => {};
  }

  setFireHandler(handler: () => void): void {
    this.onFire = handler;
  }

  private handleKey(code: string, down: boolean): void {
    if (code === "ArrowLeft" || code === "KeyA") this.left = down;
    if (code === "ArrowRight" || code === "KeyD") this.right = down;
    if (code === "ArrowUp" || code === "KeyW") this.up = down;
    if (code === "ArrowDown" || code === "KeyS") this.down = down;
    if ((code === "Space" || code === "ArrowUp" || code === "KeyW") && down && !this.jump) {
      this.jump = true;
    }
    if ((code === "Space" || code === "ArrowUp" || code === "KeyW") && !down) {
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
