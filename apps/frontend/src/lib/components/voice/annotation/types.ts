/**
 * Shared domain types for ephemeral screen-share annotations.
 *
 * These describe annotation geometry independent of the wire codec (see
 * annotationCodec.ts) and the LiveKit transport, so the same shapes can be
 * reused by the live overlay renderer and, later, by a saved/recorded
 * annotation player.
 */

/** A point in normalized [0,1] coordinates over the shared video content box. */
export interface NormalizedPoint {
  x: number;
  y: number;
}

/** Annotation input tools available in v1. */
export type AnnotationTool = 'pen' | 'laser';

/**
 * A committed freehand stroke on a board (one participant's shared screen).
 *
 * Coordinates are normalized so a stroke lands on the same shared-content pixel
 * for every viewer regardless of their rendered size or letterboxing.
 *
 * `tStart`/`tEnd` are reserved for the future saved/recorded-annotation feature
 * (call-relative milliseconds) and are unset for ephemeral v1 strokes. Carrying
 * them on the canonical type keeps that feature an additive change rather than a
 * re-model.
 */
export interface Stroke {
  /** Identity of the participant whose shared screen this stroke is drawn on. */
  boardId: string;
  /** Sender-local id; globally unique when combined with {@link author}. */
  strokeId: number;
  /** LiveKit-authenticated identity of the participant who drew the stroke. */
  author: string;
  /** Palette index selected by the author. */
  color: number;
  /** Brush size selected by the author. */
  size: number;
  points: NormalizedPoint[];
  /** Reserved for saved/recorded annotations (call-relative ms); unset in v1. */
  tStart?: number;
  /** Reserved for saved/recorded annotations (call-relative ms); unset in v1. */
  tEnd?: number;
}
