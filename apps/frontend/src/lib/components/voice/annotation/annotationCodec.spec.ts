import { describe, expect, it } from 'vitest';
import {
  ANNOTATION_FORMAT_VERSION,
  AnnotationFrameType,
  ClearScope,
  MAX_LOSSY_BYTES,
  decodeAnnotationFrame,
  dequantizeUnit,
  encodeAnnotationFrame,
  quantizeUnit,
  type AnnotationFrame
} from './annotationCodec';

function requantize(value: number): number {
  return dequantizeUnit(quantizeUnit(value));
}

// Encoding quantizes coordinates to 16 bits, so a decoded frame equals the
// original only after the same quantization is applied to its coordinates.
function quantized(frame: AnnotationFrame): AnnotationFrame {
  switch (frame.type) {
    case AnnotationFrameType.StrokeDelta:
    case AnnotationFrameType.StrokeCommit:
      return {
        ...frame,
        points: frame.points.map((point) => ({ x: requantize(point.x), y: requantize(point.y) }))
      };
    case AnnotationFrameType.Laser:
      return { ...frame, x: requantize(frame.x), y: requantize(frame.y) };
    default:
      return frame;
  }
}

const sampleFrames: AnnotationFrame[] = [
  {
    type: AnnotationFrameType.StrokeDelta,
    boardId: 'user_ABC',
    strokeId: 42,
    color: 3,
    size: 6,
    startIndex: 12,
    points: [
      { x: 0.1, y: 0.2 },
      { x: 0.3, y: 0.4 }
    ]
  },
  {
    type: AnnotationFrameType.StrokeCommit,
    boardId: 'user_ABC',
    strokeId: 42,
    color: 3,
    size: 6,
    points: [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 0.5, y: 0.5 }
    ]
  },
  { type: AnnotationFrameType.Clear, boardId: 'user_ABC', scope: ClearScope.Board },
  { type: AnnotationFrameType.Clear, boardId: 'user_ABC', scope: ClearScope.Own },
  { type: AnnotationFrameType.Laser, boardId: 'user_ABC', x: 0.25, y: 0.9, active: true },
  { type: AnnotationFrameType.Laser, boardId: 'user_ABC', x: 0.4, y: 0.1, active: false },
  { type: AnnotationFrameType.Control, boardId: 'user_ABC', drawTogetherEnabled: false },
  { type: AnnotationFrameType.Control, boardId: 'user_ABC', drawTogetherEnabled: true },
  { type: AnnotationFrameType.Hello, boardId: 'user_ABC' },
  { type: AnnotationFrameType.Hello }
];

describe('annotationCodec round trip', () => {
  it.each(sampleFrames)('round-trips frame %#', (frame) => {
    const decoded = decodeAnnotationFrame(encodeAnnotationFrame(frame));
    expect(decoded).toEqual(quantized(frame));
  });

  it('preserves non-ASCII board identities', () => {
    const frame: AnnotationFrame = {
      type: AnnotationFrameType.Control,
      boardId: 'user_ключ_🔑',
      drawTogetherEnabled: true
    };
    expect(decodeAnnotationFrame(encodeAnnotationFrame(frame))).toEqual(frame);
  });
});

describe('quantization', () => {
  it('stays within 1/65535 of the original value', () => {
    for (const value of [0, 0.1, 0.333333, 0.5, 0.9999, 1]) {
      expect(Math.abs(dequantizeUnit(quantizeUnit(value)) - value)).toBeLessThanOrEqual(1 / 0xffff);
    }
  });

  it('clamps out-of-range coordinates', () => {
    expect(quantizeUnit(-1)).toBe(0);
    expect(quantizeUnit(2)).toBe(0xffff);
  });
});

describe('frame size', () => {
  it('encodes each stroke point in four bytes', () => {
    const base = encodeAnnotationFrame({
      type: AnnotationFrameType.StrokeDelta,
      boardId: 'board',
      strokeId: 1,
      color: 0,
      size: 1,
      startIndex: 0,
      points: []
    });
    const hundred = encodeAnnotationFrame({
      type: AnnotationFrameType.StrokeDelta,
      boardId: 'board',
      strokeId: 1,
      color: 0,
      size: 1,
      startIndex: 0,
      points: Array.from({ length: 100 }, () => ({ x: 0.5, y: 0.5 }))
    });
    expect(hundred.length - base.length).toBe(400);
  });

  it('keeps a large per-frame delta batch under the lossy MTU', () => {
    const points = Array.from({ length: 128 }, (_, index) => ({ x: index / 128, y: 0.5 }));
    const frame = encodeAnnotationFrame({
      type: AnnotationFrameType.StrokeDelta,
      boardId: 'user_1234567890',
      strokeId: 7,
      color: 2,
      size: 4,
      startIndex: 0,
      points
    });
    expect(frame.length).toBeLessThan(MAX_LOSSY_BYTES);
  });
});

describe('decode robustness', () => {
  it('returns null for an empty buffer', () => {
    expect(decodeAnnotationFrame(new Uint8Array(0))).toBeNull();
  });

  it('returns null for an unknown format version', () => {
    const bytes = encodeAnnotationFrame({
      type: AnnotationFrameType.Control,
      boardId: 'board',
      drawTogetherEnabled: true
    });
    bytes[0] = ANNOTATION_FORMAT_VERSION + 1;
    expect(decodeAnnotationFrame(bytes)).toBeNull();
  });

  it('returns null for an unknown frame type', () => {
    expect(decodeAnnotationFrame(new Uint8Array([ANNOTATION_FORMAT_VERSION, 99]))).toBeNull();
  });

  it('returns null for a truncated frame', () => {
    const bytes = encodeAnnotationFrame({
      type: AnnotationFrameType.StrokeCommit,
      boardId: 'board',
      strokeId: 1,
      color: 0,
      size: 1,
      points: [{ x: 0.1, y: 0.2 }]
    });
    expect(decodeAnnotationFrame(bytes.subarray(0, 3))).toBeNull();
  });

  it('ignores trailing bytes for additive forward compatibility', () => {
    const frame: AnnotationFrame = {
      type: AnnotationFrameType.Control,
      boardId: 'board',
      drawTogetherEnabled: true
    };
    const bytes = encodeAnnotationFrame(frame);
    const extended = new Uint8Array(bytes.length + 4);
    extended.set(bytes);
    extended.set([1, 2, 3, 4], bytes.length);
    expect(decodeAnnotationFrame(extended)).toEqual(frame);
  });

  it('decodes a frame carried in a larger backing buffer', () => {
    const frame: AnnotationFrame = {
      type: AnnotationFrameType.Laser,
      boardId: 'board',
      x: 0.5,
      y: 0.5,
      active: true
    };
    const bytes = encodeAnnotationFrame(frame);
    const backing = new Uint8Array(bytes.length + 8);
    backing.set(bytes, 4);
    const view = backing.subarray(4, 4 + bytes.length);
    expect(decodeAnnotationFrame(view)).toEqual(quantized(frame));
  });
});
