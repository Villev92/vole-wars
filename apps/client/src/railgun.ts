import { Container, Graphics } from "pixi.js";
import { raycastTerrain, VOLE_RADIUS, type TerrainField } from "@vole-wars/shared";

// Beam origin, matches the server's RAIL_MUZZLE_DIST (GameRoom).
const MUZZLE_DIST = VOLE_RADIUS + 4;

/** A vole firing a railgun beam. Pose comes from the client's smoothed render state (not raw server
 *  x/y) so the beam tracks the rig; length/halfWidth are the server's, re-clipped here against this
 *  client's own terrain mirror so the beam stops at the terrain front exactly like the server's. */
export interface RailBeamView {
  id: string;
  x: number;
  y: number;
  aimAngle: number;
  length: number;
  halfWidth: number;
}

/** A vole winding up a railgun charge — `charge` is 0..1. Drives a growing muzzle orb. */
export interface RailChargeView {
  id: string;
  x: number;
  y: number;
  aimAngle: number;
  charge: number;
}

/** One soft additive blob = three stacked circles, same trick flame.ts uses to fake a blur. */
function softBlob(g: Graphics, x: number, y: number, size: number, color: number, alpha: number): void {
  if (size < 0.05 || alpha < 0.01) return;
  g.circle(x, y, size * 2).fill({ color, alpha: alpha * 0.22 });
  g.circle(x, y, size * 1.35).fill({ color, alpha: alpha * 0.45 });
  g.circle(x, y, size).fill({ color, alpha: alpha * 0.9 });
}

/**
 * Renders the railgun's purely-visual bits — a constant blue beam from the muzzle for any vole with
 * an active beam, plus a charge-up orb for any vole holding a charge. All cosmetic: damage, terrain
 * carving and beam lifetime are the server's (see GameRoom.updateRailgun). Both layers draw
 * additively (no filters) so overlapping strokes/blobs stack into a bright core on their own.
 */
export class RailgunLayer {
  private readonly beamLayer = new Container();
  private readonly chargeLayer = new Container();
  private readonly beams = new Map<string, Graphics>();
  private readonly charges = new Map<string, Graphics>();

  constructor(
    private readonly world: Container,
    private readonly terrain: TerrainField
  ) {
    for (const layer of [this.chargeLayer, this.beamLayer]) {
      layer.blendMode = "add";
      this.world.addChild(layer);
    }
  }

  update(time: number, beams: RailBeamView[], charges: RailChargeView[]): void {
    // Keep both layers on top of the characters producing them.
    const kids = this.world.children;
    if (kids[kids.length - 1] !== this.beamLayer || kids[kids.length - 2] !== this.chargeLayer) {
      this.world.addChild(this.chargeLayer);
      this.world.addChild(this.beamLayer);
    }

    const liveBeams = new Set<string>();
    for (const beam of beams) {
      liveBeams.add(beam.id);
      let g = this.beams.get(beam.id);
      if (!g) {
        g = new Graphics();
        this.beamLayer.addChild(g);
        this.beams.set(beam.id, g);
      }
      this.drawBeam(g, beam, time);
    }
    for (const [id, g] of this.beams) {
      if (liveBeams.has(id)) continue;
      g.destroy();
      this.beams.delete(id);
    }

    const liveCharges = new Set<string>();
    for (const chg of charges) {
      if (chg.charge <= 0) continue;
      liveCharges.add(chg.id);
      let g = this.charges.get(chg.id);
      if (!g) {
        g = new Graphics();
        this.chargeLayer.addChild(g);
        this.charges.set(chg.id, g);
      }
      this.drawCharge(g, chg, time);
    }
    for (const [id, g] of this.charges) {
      if (liveCharges.has(id)) continue;
      g.destroy();
      this.charges.delete(id);
    }
  }

  private drawBeam(g: Graphics, beam: RailBeamView, time: number): void {
    g.clear();
    const dx = Math.cos(beam.aimAngle);
    const dy = Math.sin(beam.aimAngle);
    const mx = beam.x + dx * MUZZLE_DIST;
    const my = beam.y + dy * MUZZLE_DIST;

    // Re-clip to the terrain front along this client's mirror (terrain blocks the beam now). Keep a
    // short stub visible even when it's dug right up against a wall / into the ground.
    let len = Math.max(beam.length, 0.5);
    const front = raycastTerrain(this.terrain, mx, my, beam.aimAngle, len);
    if (front) len = Math.min(len, Math.hypot(front.x - mx, front.y - my));
    len = Math.max(len, 2);
    const ex = mx + dx * len;
    const ey = my + dy * len;

    const flick = 0.85 + 0.15 * Math.sin(time * 47) + 0.06 * Math.sin(time * 113);
    const w = beam.halfWidth * 2;

    // Wide dim halo → mid → bright core → white-hot centreline.
    g.moveTo(mx, my).lineTo(ex, ey).stroke({ width: w * 3.4 * flick, color: 0x1f5cff, alpha: 0.1, cap: "round" });
    g.moveTo(mx, my).lineTo(ex, ey).stroke({ width: w * 1.9 * flick, color: 0x3f82ff, alpha: 0.24, cap: "round" });
    g.moveTo(mx, my).lineTo(ex, ey).stroke({ width: Math.max(0.6, w) * flick, color: 0x9cc2ff, alpha: 0.62, cap: "round" });
    g.moveTo(mx, my).lineTo(ex, ey).stroke({ width: Math.max(0.35, w * 0.34), color: 0xffffff, alpha: 0.9, cap: "round" });

    // Muzzle flare + impact bloom at the far end (where it's melting terrain / hitting rock).
    softBlob(g, mx, my, w * 0.9 + 1.1, 0xbcd6ff, 0.5);
    softBlob(g, ex, ey, w * 0.8 + 0.9 + 0.4 * Math.sin(time * 30), 0xdfebff, 0.5);
  }

  private drawCharge(g: Graphics, chg: RailChargeView, time: number): void {
    g.clear();
    const dx = Math.cos(chg.aimAngle);
    const dy = Math.sin(chg.aimAngle);
    const mx = chg.x + dx * MUZZLE_DIST;
    const my = chg.y + dy * MUZZLE_DIST;

    const pulse = 0.8 + 0.2 * Math.sin(time * 18);
    const r = (0.8 + chg.charge * 3.2) * pulse;
    softBlob(g, mx, my, r, 0x6ea8ff, 0.35 + 0.4 * chg.charge);
    // Thin ring that tightens as the charge fills.
    g.circle(mx, my, r * (1.7 - chg.charge * 0.5)).stroke({ width: 0.4, color: 0xbcd6ff, alpha: 0.25 + 0.4 * chg.charge });
    // At full charge the orb flares white and throws a fast expanding ring — an unmistakable "ready"
    // tell that lands with (not after) the "MAX CHARGE" prompt.
    if (chg.charge >= 1) {
      softBlob(g, mx, my, r * 1.25, 0xffffff, 0.5 + 0.3 * Math.sin(time * 22));
      const ringR = r * (1.6 + 1.4 * ((time * 2.2) % 1));
      g.circle(mx, my, ringR).stroke({ width: 0.5, color: 0xffffff, alpha: 0.5 * (1 - ((time * 2.2) % 1)) });
    }
  }
}
