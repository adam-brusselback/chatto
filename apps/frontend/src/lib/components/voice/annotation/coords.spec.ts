import { describe, expect, it } from 'vitest';
import { clampToUnit, contentRect, fromNormalized, isInsideUnit, toNormalized } from './coords';

describe('contentRect', () => {
  it('letterboxes wide content inside a tall element (bars top and bottom)', () => {
    const rect = contentRect(100, 200, 1920, 1080);
    expect(rect.x).toBe(0);
    expect(rect.width).toBe(100);
    expect(rect.height).toBeCloseTo(56.25, 6); // 100 * (1080 / 1920)
    expect(rect.y).toBeCloseTo(71.875, 6); // (200 - 56.25) / 2
  });

  it('pillarboxes tall content inside a wide element (bars left and right)', () => {
    const rect = contentRect(200, 100, 1080, 1920);
    expect(rect.y).toBe(0);
    expect(rect.height).toBe(100);
    expect(rect.width).toBeCloseTo(56.25, 6);
    expect(rect.x).toBeCloseTo(71.875, 6);
  });

  it('fills the element when the aspect ratios match', () => {
    const rect = contentRect(160, 90, 1920, 1080);
    expect(rect.x).toBe(0);
    expect(rect.y).toBeCloseTo(0, 6);
    expect(rect.width).toBe(160);
    expect(rect.height).toBeCloseTo(90, 6);
  });

  it('returns a degenerate rect when the element or source is unmeasured', () => {
    expect(contentRect(0, 0, 1920, 1080)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(contentRect(160, 90, 0, 0)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe('toNormalized / fromNormalized', () => {
  const elementRect = { x: 30, y: 50, width: 800, height: 600 };
  const intrinsic = { width: 1920, height: 1080 };

  it('recovers normalized coordinates through a full round trip', () => {
    const content = contentRect(
      elementRect.width,
      elementRect.height,
      intrinsic.width,
      intrinsic.height
    );
    const originals = [
      { x: 0, y: 0 },
      { x: 0.25, y: 0.75 },
      { x: 1, y: 1 },
      { x: 0.5, y: 0.5 }
    ];
    for (const original of originals) {
      const local = fromNormalized(original, content);
      const back = toNormalized(
        local.x + elementRect.x,
        local.y + elementRect.y,
        elementRect,
        intrinsic
      );
      expect(back).not.toBeNull();
      expect(back?.x).toBeCloseTo(original.x, 6);
      expect(back?.y).toBeCloseTo(original.y, 6);
    }
  });

  it('is invariant to source resolution at the same aspect ratio', () => {
    // Cross-viewer parity relies on this: two viewers decoding the same share at
    // different resolutions (adaptive stream) must map a pointer to the same
    // normalized point. The mapping is CSS-pixel based and DPR-independent.
    const hd = toNormalized(400, 300, elementRect, { width: 1920, height: 1080 });
    const uhd = toNormalized(400, 300, elementRect, { width: 3840, height: 2160 });
    expect(hd).not.toBeNull();
    expect(uhd).not.toBeNull();
    expect(hd?.x).toBeCloseTo(uhd?.x ?? NaN, 6);
    expect(hd?.y).toBeCloseTo(uhd?.y ?? NaN, 6);
  });
});

describe('toNormalized letterbox handling', () => {
  // Tall element with wide (16:9) content: the video is letterboxed with ~71.875
  // px bars top and bottom and a 56.25 px content band centered vertically.
  const elementRect = { x: 0, y: 0, width: 100, height: 200 };
  const intrinsic = { width: 1920, height: 1080 };

  it('maps the content-box center to (0.5, 0.5)', () => {
    const point = toNormalized(50, 100, elementRect, intrinsic);
    expect(point).not.toBeNull();
    expect(point?.x).toBeCloseTo(0.5, 6);
    expect(point?.y).toBeCloseTo(0.5, 6);
  });

  it('maps a point on the top letterbox bar outside the unit square', () => {
    const point = toNormalized(50, 5, elementRect, intrinsic);
    expect(point).not.toBeNull();
    expect(isInsideUnit(point!)).toBe(false);
    expect(point?.y).toBeLessThan(0);
  });

  it('returns null when the content box is degenerate', () => {
    expect(toNormalized(10, 10, { x: 0, y: 0, width: 0, height: 0 }, intrinsic)).toBeNull();
  });
});

describe('clampToUnit', () => {
  it('clamps out-of-range coordinates into [0,1]', () => {
    expect(clampToUnit({ x: -0.2, y: 1.5 })).toEqual({ x: 0, y: 1 });
    expect(clampToUnit({ x: 0.3, y: 0.7 })).toEqual({ x: 0.3, y: 0.7 });
  });
});
