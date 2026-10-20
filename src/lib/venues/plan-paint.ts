import type { PlanPoint, VenuePlanShape } from './plan';
import {
  courtFrame,
  markingsFor,
  placeMarkings,
  toScreen,
  type CourtFrame,
  type Fit,
  type Mark,
  type View,
} from './plan-geometry';

/**
 * Painting a venue plan on a 2D canvas (#625, #626): the player's plan and the
 * club's editor draw courts the same way, so a club sees what players will.
 * Browser-only (Path2D), and never called before the canvas has a size.
 */

/** A court ready to paint: its outline, the frame its name sits on, its lines. */
export interface PaintedCourt {
  id: string;
  name: string;
  outline: PlanPoint[];
  frame: CourtFrame;
  marks: Mark[];
}

export function paintedCourt(c: {
  resourceId: string;
  name: string;
  sport: string;
  outline: PlanPoint[];
}): PaintedCourt {
  const frame = courtFrame(c.outline);
  const markings = markingsFor(c.sport);
  return {
    id: c.resourceId,
    name: c.name,
    outline: c.outline,
    frame,
    marks: markings ? placeMarkings(markings, frame) : [],
  };
}

/**
 * How a court looks: free, taken (hatched, so not told by colour alone), the
 * player's pick, still loading, or `plain` (a court, as the club's editor
 * shows every one).
 */
export type CourtLook = 'free' | 'taken' | 'picked' | 'unknown' | 'plain';

/** The theme's colours, as the canvas needs them. */
export interface PlanColors {
  grounds: string;
  building: string;
  entrance: string;
  edge: string;
  free: string;
  taken: string;
  hatch: string;
  picked: string;
  pickedEdge: string;
  lit: string;
  markOn: string;
  markOff: string;
  labelBg: string;
  label: string;
  font: string;
}

/** The colours from the theme's tokens, as they are under `el` right now. */
export function readPlanColors(el: Element): PlanColors {
  const css = getComputedStyle(el);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    grounds: v('--bg-muted'),
    building: v('--border-default'),
    entrance: v('--accent-default'),
    edge: v('--border-strong'),
    free: v('--bg-success-emphasis'),
    taken: v('--bg-muted'),
    hatch: v('--border-strong'),
    picked: v('--brand-default'),
    pickedEdge: v('--brand-emphasis'),
    lit: v('--content-emphasis'),
    markOn: v('--content-inverted'),
    markOff: v('--border-strong'),
    labelBg: v('--bg-default'),
    label: v('--content-default'),
    font: css.fontFamily || 'sans-serif',
  };
}

/** A polygon on the screen, as a path. */
export function screenPath(points: PlanPoint[], fit: Fit, view: View, close = true): Path2D {
  const p = new Path2D();
  points.forEach((pt, i) => {
    const [x, y] = toScreen(pt, fit, view);
    if (i === 0) p.moveTo(x, y);
    else p.lineTo(x, y);
  });
  if (close) p.closePath();
  return p;
}

export interface PlanPicture {
  /** CSS pixels. */
  width: number;
  height: number;
  fit: Fit;
  view: View;
  colors: PlanColors;
  features: Pick<VenuePlanShape, 'kind' | 'outline'>[];
  courts: PaintedCourt[];
  look: (courtId: string) => CourtLook;
  /** The court drawn with a heavy edge and always named: hovered, or selected. */
  lit: string | null;
}

/** Clear the canvas and paint the plan: the grounds, the courts, their names. */
export function paintPlan(ctx: CanvasRenderingContext2D, dpr: number, pic: PlanPicture) {
  const { fit, view, colors: c } = pic;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, pic.width, pic.height);
  // A metre on the screen, for line weights that grow with the zoom.
  const metre = fit.scale * view.k;

  for (const f of pic.features) {
    const p = screenPath(f.outline, fit, view);
    ctx.fillStyle =
      f.kind === 'GROUNDS' ? c.grounds : f.kind === 'BUILDING' ? c.building : c.entrance;
    ctx.fill(p);
    if (f.kind !== 'ENTRANCE') {
      ctx.lineWidth = 1;
      ctx.strokeStyle = c.edge;
      ctx.stroke(p);
    }
  }

  for (const court of pic.courts) {
    const look = pic.look(court.id);
    const p = screenPath(court.outline, fit, view);
    ctx.fillStyle =
      look === 'picked' ? c.picked : look === 'free' || look === 'plain' ? c.free : c.taken;
    ctx.fill(p);
    if (look === 'taken') {
      hatch(
        ctx,
        p,
        court.outline.map((pt) => toScreen(pt, fit, view)),
        c.hatch,
      );
    }

    ctx.strokeStyle = look === 'taken' || look === 'unknown' ? c.markOff : c.markOn;
    ctx.globalAlpha = 0.85;
    for (const mark of court.marks) {
      ctx.lineWidth = Math.max(
        1,
        Math.min(mark.style === 'line' ? 2 : 4, metre * (mark.style === 'line' ? 0.08 : 0.2)),
      );
      ctx.stroke(screenPath(mark.points, fit, view, false));
    }
    ctx.globalAlpha = 1;

    const lit = court.id === pic.lit;
    ctx.lineWidth = lit || look === 'picked' ? 3 : 1.5;
    ctx.strokeStyle = lit ? c.lit : look === 'picked' ? c.pickedEdge : c.edge;
    ctx.stroke(p);
  }

  // The names last, on a pill of the page's colour, so they read on any fill.
  ctx.font = `600 12px ${c.font}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const court of pic.courts) {
    const [x, y] = toScreen([court.frame.cx, court.frame.cy], fit, view);
    const w = ctx.measureText(court.name).width + 12;
    // Across the court's short side, or it would run into its neighbours; the
    // text alternative and a zoom still give every name.
    if (w > court.frame.width * metre && court.id !== pic.lit) continue;
    ctx.fillStyle = c.labelBg;
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - 10, w, 20, 10);
    ctx.fill();
    ctx.fillStyle = c.label;
    ctx.fillText(court.name, x, y + 0.5);
  }
}

/** Diagonal lines across a taken court: taken is not told by colour alone. */
function hatch(ctx: CanvasRenderingContext2D, p: Path2D, screen: PlanPoint[], color: string) {
  const xs = screen.map((s) => s[0]);
  const ys = screen.map((s) => s[1]);
  const [left, right, top, bottom] = [
    Math.min(...xs),
    Math.max(...xs),
    Math.min(...ys),
    Math.max(...ys),
  ];
  const h = bottom - top;
  ctx.save();
  ctx.clip(p);
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.45;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = left - h; x < right; x += 7) {
    ctx.moveTo(x, bottom);
    ctx.lineTo(x + h, top);
  }
  ctx.stroke();
  ctx.restore();
}
