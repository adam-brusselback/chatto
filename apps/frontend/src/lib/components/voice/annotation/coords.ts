/**
 * Coordinate mapping between pointer input and normalized annotation space.
 *
 * Screen-share tiles render the <video> with `object-fit: contain`, so the video
 * is centered inside its element with letterbox (top/bottom) or pillarbox
 * (left/right) bars. Annotations are authored and transmitted in normalized
 * [0,1] coordinates over the video *content box* — not the element box — so a
 * stroke lands on the same shared-content pixel for every viewer regardless of
 * their element size, device pixel ratio, or letterboxing.
 *
 * These helpers are pure and framework-agnostic so the same math serves live
 * pointer input, live rendering, and (later) a saved-annotation player.
 */

import type { NormalizedPoint } from './types';

/** A pixel-space rectangle (CSS pixels); matches DOMRect's x/y/width/height. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Intrinsic pixel size of a source, e.g. a video's videoWidth/videoHeight. */
export interface Size {
  width: number;
  height: number;
}

/**
 * Compute the rectangle actually covered by an `object-fit: contain` source
 * inside an element box, in the element's local CSS-pixel space.
 *
 * Returns a zero-size rect when either the element or the source is unmeasured
 * (any non-positive dimension), so callers can detect "not ready yet".
 */
export function contentRect(
  elementWidth: number,
  elementHeight: number,
  intrinsicWidth: number,
  intrinsicHeight: number
): Rect {
  if (elementWidth <= 0 || elementHeight <= 0 || intrinsicWidth <= 0 || intrinsicHeight <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  const elementAspect = elementWidth / elementHeight;
  const contentAspect = intrinsicWidth / intrinsicHeight;

  if (elementAspect > contentAspect) {
    // Element is wider than the content: pillarbox with bars left and right.
    const width = elementHeight * contentAspect;
    return { x: (elementWidth - width) / 2, y: 0, width, height: elementHeight };
  }

  // Element is taller than (or equal to) the content: letterbox bars top/bottom.
  const height = elementWidth / contentAspect;
  return { x: 0, y: (elementHeight - height) / 2, width: elementWidth, height };
}

/**
 * Map a viewport pointer coordinate (a PointerEvent's clientX/clientY) to
 * normalized [0,1] coordinates over the shared video content box.
 *
 * `elementRect` is the overlay element's bounding rect in viewport space (from
 * `getBoundingClientRect()`); `intrinsic` is the source's intrinsic size.
 *
 * The returned point may fall outside [0,1] when the pointer is over the
 * letterbox bars; callers decide whether to reject it (pointerdown) or clamp it
 * (pointermove) via {@link isInsideUnit} / {@link clampToUnit}. Returns null
 * only when the content box is degenerate (nothing measured yet).
 */
export function toNormalized(
  clientX: number,
  clientY: number,
  elementRect: Rect,
  intrinsic: Size
): NormalizedPoint | null {
  const content = contentRect(
    elementRect.width,
    elementRect.height,
    intrinsic.width,
    intrinsic.height
  );
  if (content.width <= 0 || content.height <= 0) return null;

  const localX = clientX - elementRect.x - content.x;
  const localY = clientY - elementRect.y - content.y;
  return { x: localX / content.width, y: localY / content.height };
}

/**
 * Map a normalized [0,1] point to a pixel position within an element, given the
 * content box from {@link contentRect}. The result is in the same local
 * CSS-pixel space as the content rect; draw into a canvas whose context is
 * scaled by devicePixelRatio for crisp output.
 */
export function fromNormalized(point: NormalizedPoint, content: Rect): { x: number; y: number } {
  return {
    x: content.x + point.x * content.width,
    y: content.y + point.y * content.height
  };
}

/** True when a normalized point lies within the [0,1] content box. */
export function isInsideUnit(point: NormalizedPoint): boolean {
  return point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1;
}

/** Clamp a normalized point into the [0,1] content box. */
export function clampToUnit(point: NormalizedPoint): NormalizedPoint {
  return { x: clamp01(point.x), y: clamp01(point.y) };
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
