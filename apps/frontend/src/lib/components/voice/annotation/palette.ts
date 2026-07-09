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

/** Brush diameters (CSS pixels) offered by the toolbar's size control. */
export const BRUSH_SIZES = [4, 7, 12] as const;

/** Default brush diameter in CSS pixels. */
export const DEFAULT_BRUSH_SIZE = BRUSH_SIZES[0];

/** Resolve a palette index to a CSS color, wrapping out-of-range indices. */
export function colorForIndex(index: number): string {
  const size = ANNOTATION_PALETTE.length;
  return ANNOTATION_PALETTE[((index % size) + size) % size];
}

/**
 * Stable per-user palette index derived from a participant identity.
 *
 * Every client computes the same index for the same identity (FNV-1a over the
 * UTF-16 code units, 32-bit), so strokes and laser dots can be attributed to
 * their author — via the identity-colored halo — without any wire protocol
 * support. It also seeds each user's default drawing color so participants are
 * visually distinct before anyone opens the color picker.
 */
export function identityColorIndex(identity: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < identity.length; i += 1) {
    hash ^= identity.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % ANNOTATION_PALETTE.length;
}
