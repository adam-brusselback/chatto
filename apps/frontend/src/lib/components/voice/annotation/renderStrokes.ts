/**
 * Canvas painter for annotation strokes, decoupled from LiveKit and pointer
 * input so the same code renders live drawing and (later) a saved-annotation
 * player or a recording-egress template.
 *
 * Strokes are stored in normalized [0,1] coordinates; the painter maps them into
 * the shared video content box (see coords.ts) and fills a `perfect-freehand`
 * outline, which is the de-facto standard for pressure/velocity-aware freehand
 * geometry.
 */

import { getStroke } from 'perfect-freehand';
import { fromNormalized, type Rect } from './coords';
import type { NormalizedPoint } from './types';

/** A stroke ready to paint: resolved CSS color, brush diameter, and points. */
export interface RenderableStroke {
  /** Resolved CSS color string (palette resolution happens before rendering). */
  color: string;
  /** Brush diameter in CSS pixels. */
  size: number;
  points: NormalizedPoint[];
}

const STROKE_OPTIONS = {
  thinning: 0.6,
  smoothing: 0.5,
  streamline: 0.5,
  simulatePressure: true
};

/**
 * Paint a single stroke into the 2D context. The context is expected to be
 * pre-scaled by devicePixelRatio, so `content` and the resulting geometry are in
 * CSS pixels.
 */
export function renderStroke(
  ctx: CanvasRenderingContext2D,
  stroke: RenderableStroke,
  content: Rect
): void {
  if (stroke.points.length === 0) return;

  const inputPoints = stroke.points.map((point) => {
    const { x, y } = fromNormalized(point, content);
    return [x, y];
  });
  const outline = getStroke(inputPoints, { ...STROKE_OPTIONS, size: stroke.size });
  if (outline.length < 3) return;

  const path = new Path2D();
  const [startX, startY] = outline[0];
  path.moveTo(startX, startY);
  for (let i = 1; i < outline.length; i += 1) {
    const [x0, y0] = outline[i - 1];
    const [x1, y1] = outline[i];
    path.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  path.closePath();

  ctx.fillStyle = stroke.color;
  ctx.fill(path);
}
