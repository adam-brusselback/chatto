import { describe, expect, it } from 'vitest';
import { ANNOTATION_PALETTE, colorForIndex, identityColorIndex } from './palette';

describe('identityColorIndex', () => {
  it('is deterministic for the same identity', () => {
    expect(identityColorIndex('user_ABC')).toBe(identityColorIndex('user_ABC'));
  });

  it('stays within the palette bounds for arbitrary identities', () => {
    for (const identity of ['', 'a', 'user_1234567890', 'ключ-🔑', 'x'.repeat(200)]) {
      const index = identityColorIndex(identity);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(ANNOTATION_PALETTE.length);
    }
  });

  it('distributes across more than one color', () => {
    const indices = new Set(Array.from({ length: 32 }, (_, i) => identityColorIndex(`user_${i}`)));
    expect(indices.size).toBeGreaterThan(1);
  });
});

describe('colorForIndex', () => {
  it('wraps out-of-range indices into the palette', () => {
    expect(colorForIndex(ANNOTATION_PALETTE.length)).toBe(ANNOTATION_PALETTE[0]);
    expect(colorForIndex(-1)).toBe(ANNOTATION_PALETTE[ANNOTATION_PALETTE.length - 1]);
  });
});
