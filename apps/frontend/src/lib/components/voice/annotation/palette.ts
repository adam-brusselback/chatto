/**
 * Fixed annotation color palette.
 *
 * The wire protocol sends a stroke color as a small integer index into this
 * palette (see annotationCodec.ts) rather than a color string, so every client
 * resolves the same index to the same CSS color. Colors are saturated to stay
 * visible over arbitrary shared-screen content.
 */

export const ANNOTATION_PALETTE = [
  '#f59e0b', // amber
  '#ef4444', // red
  '#22c55e', // green
  '#3b82f6', // blue
  '#a855f7', // violet
  '#ec4899', // pink
  '#06b6d4', // cyan
  '#eab308' // yellow
] as const;

/** Default palette index for a new drawer. */
export const DEFAULT_COLOR_INDEX = 0;

/** Default brush diameter in CSS pixels. */
export const DEFAULT_BRUSH_SIZE = 4;

/** Resolve a palette index to a CSS color, wrapping out-of-range indices. */
export function colorForIndex(index: number): string {
  const size = ANNOTATION_PALETTE.length;
  return ANNOTATION_PALETTE[((index % size) + size) % size];
}
