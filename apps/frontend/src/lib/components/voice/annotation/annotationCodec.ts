/**
 * Wire codec for the ephemeral screen-share annotation data channel.
 *
 * Frames are hand-packed binary (not protobuf) because the stroke/laser stream
 * is the 30-60 Hz hot path where compactness matters and each lossy datagram
 * must stay under the network MTU. Keeping the codec on the client also means
 * the annotation feature adds no protobuf/backend surface — it rides LiveKit
 * data channels only.
 *
 * Every frame begins with a one-byte format version. Purely additive changes
 * (for example a timestamp appended to a commit for saved/recorded annotations)
 * are appended to a frame's tail and do NOT bump the version: older decoders
 * parse the fields they know and ignore trailing bytes. The version byte is
 * reserved for breaking layout changes, which older decoders drop.
 *
 * Coordinates are normalized [0,1] over the shared video content box (see
 * coords.ts) and quantized to unsigned 16-bit integers, keeping sub-pixel
 * accuracy (1/65535) at half the byte cost of float32.
 */

import type { NormalizedPoint } from './types';

/** Current wire format version. Bumped only for breaking layout changes. */
export const ANNOTATION_FORMAT_VERSION = 1;

/** LiveKit lossy datagrams should stay under the network MTU (~1400 bytes). */
export const MAX_LOSSY_BYTES = 1300;

/** LiveKit reliable messages should stay well under the SCTP message limit. */
export const MAX_RELIABLE_BYTES = 16 * 1024;

/** Data-channel topic for the high-frequency lossy stroke/laser stream. */
export const ANNOTATION_TOPIC_LOSSY = 'chatto/anno/lossy';

/** Data-channel topic for reliable control frames (commit, clear, control). */
export const ANNOTATION_TOPIC_RELIABLE = 'chatto/anno/ctrl';

/** Discriminator tag for each annotation frame. */
export enum AnnotationFrameType {
  StrokeDelta = 1,
  StrokeCommit = 2,
  Clear = 3,
  Laser = 4,
  Control = 5,
  Hello = 6
}

/** Scope of a CLEAR frame. */
export enum ClearScope {
  /** Clear all annotations on the board (a participant's shared screen). */
  Board = 0,
  /** Clear only the requesting sender's own strokes. */
  Own = 1
}

/** Incremental batch of new points for an in-progress stroke (lossy). */
export interface StrokeDeltaFrame {
  type: AnnotationFrameType.StrokeDelta;
  boardId: string;
  strokeId: number;
  color: number;
  size: number;
  /** Index of the first point in this batch within the stroke (for ordering). */
  startIndex: number;
  points: NormalizedPoint[];
}

/** Authoritative full stroke sent on pointerup (reliable); self-heals loss. */
export interface StrokeCommitFrame {
  type: AnnotationFrameType.StrokeCommit;
  boardId: string;
  strokeId: number;
  color: number;
  size: number;
  points: NormalizedPoint[];
}

/** Erase request, scoped to the whole board or the sender's own strokes. */
export interface ClearFrame {
  type: AnnotationFrameType.Clear;
  boardId: string;
  scope: ClearScope;
}

/** Live pointer/laser position (lossy); latest wins, then fades on clients. */
export interface LaserFrame {
  type: AnnotationFrameType.Laser;
  boardId: string;
  x: number;
  y: number;
  /** Palette index the sender points with. */
  color: number;
  active: boolean;
}

/** Sharer's "draw together" state; broadcast on change and on a heartbeat. */
export interface ControlFrame {
  type: AnnotationFrameType.Control;
  boardId: string;
  drawTogetherEnabled: boolean;
}

/** Late-joiner request asking current sharers to re-emit their state. */
export interface HelloFrame {
  type: AnnotationFrameType.Hello;
  boardId?: string;
}

export type AnnotationFrame =
  | StrokeDeltaFrame
  | StrokeCommitFrame
  | ClearFrame
  | LaserFrame
  | ControlFrame
  | HelloFrame;

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/** Quantize a normalized [0,1] value to an unsigned 16-bit integer. */
export function quantizeUnit(value: number): number {
  const clamped = value < 0 ? 0 : value > 1 ? 1 : value;
  return Math.round(clamped * 0xffff);
}

/** Inverse of {@link quantizeUnit}. */
export function dequantizeUnit(value: number): number {
  return value / 0xffff;
}

/** Encode a frame to its binary wire representation. */
export function encodeAnnotationFrame(frame: AnnotationFrame): Uint8Array {
  const writer = new ByteWriter();
  writer.u8(ANNOTATION_FORMAT_VERSION);
  writer.u8(frame.type);
  switch (frame.type) {
    case AnnotationFrameType.StrokeDelta:
      writer.string(frame.boardId);
      writer.u32(frame.strokeId);
      writer.u8(frame.color);
      writer.u8(frame.size);
      writer.u16(frame.startIndex);
      writer.points(frame.points);
      break;
    case AnnotationFrameType.StrokeCommit:
      writer.string(frame.boardId);
      writer.u32(frame.strokeId);
      writer.u8(frame.color);
      writer.u8(frame.size);
      writer.points(frame.points);
      break;
    case AnnotationFrameType.Clear:
      writer.string(frame.boardId);
      writer.u8(frame.scope);
      break;
    case AnnotationFrameType.Laser:
      writer.string(frame.boardId);
      writer.u16(quantizeUnit(frame.x));
      writer.u16(quantizeUnit(frame.y));
      writer.u8(frame.color);
      writer.u8(frame.active ? 1 : 0);
      break;
    case AnnotationFrameType.Control:
      writer.string(frame.boardId);
      writer.u8(frame.drawTogetherEnabled ? 1 : 0);
      break;
    case AnnotationFrameType.Hello:
      if (frame.boardId === undefined) {
        writer.u8(0);
      } else {
        writer.u8(1);
        writer.string(frame.boardId);
      }
      break;
  }
  return writer.take();
}

/**
 * Decode a frame from its binary wire representation. Returns null for an
 * unknown format version, an unknown frame type, or a truncated/corrupt buffer,
 * so callers can simply drop bad frames. Trailing bytes beyond the known fields
 * are ignored (additive forward compatibility).
 */
export function decodeAnnotationFrame(bytes: Uint8Array): AnnotationFrame | null {
  try {
    const reader = new ByteReader(bytes);
    if (reader.u8() !== ANNOTATION_FORMAT_VERSION) return null;
    const type = reader.u8();
    switch (type) {
      case AnnotationFrameType.StrokeDelta:
        return {
          type: AnnotationFrameType.StrokeDelta,
          boardId: reader.string(),
          strokeId: reader.u32(),
          color: reader.u8(),
          size: reader.u8(),
          startIndex: reader.u16(),
          points: reader.points()
        };
      case AnnotationFrameType.StrokeCommit:
        return {
          type: AnnotationFrameType.StrokeCommit,
          boardId: reader.string(),
          strokeId: reader.u32(),
          color: reader.u8(),
          size: reader.u8(),
          points: reader.points()
        };
      case AnnotationFrameType.Clear:
        return {
          type: AnnotationFrameType.Clear,
          boardId: reader.string(),
          scope: reader.u8() as ClearScope
        };
      case AnnotationFrameType.Laser:
        return {
          type: AnnotationFrameType.Laser,
          boardId: reader.string(),
          x: dequantizeUnit(reader.u16()),
          y: dequantizeUnit(reader.u16()),
          color: reader.u8(),
          active: reader.u8() !== 0
        };
      case AnnotationFrameType.Control:
        return {
          type: AnnotationFrameType.Control,
          boardId: reader.string(),
          drawTogetherEnabled: reader.u8() !== 0
        };
      case AnnotationFrameType.Hello: {
        const hasBoard = reader.u8() !== 0;
        return hasBoard
          ? { type: AnnotationFrameType.Hello, boardId: reader.string() }
          : { type: AnnotationFrameType.Hello };
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** Growable little-endian-agnostic (big-endian) binary writer. */
class ByteWriter {
  #bytes = new Uint8Array(64);
  #view = new DataView(this.#bytes.buffer);
  #offset = 0;

  #ensure(extra: number): void {
    const needed = this.#offset + extra;
    if (needed <= this.#bytes.length) return;
    let capacity = this.#bytes.length;
    while (capacity < needed) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.#bytes);
    this.#bytes = grown;
    this.#view = new DataView(grown.buffer);
  }

  u8(value: number): void {
    this.#ensure(1);
    this.#view.setUint8(this.#offset, value);
    this.#offset += 1;
  }

  u16(value: number): void {
    this.#ensure(2);
    this.#view.setUint16(this.#offset, value);
    this.#offset += 2;
  }

  u32(value: number): void {
    this.#ensure(4);
    this.#view.setUint32(this.#offset, value);
    this.#offset += 4;
  }

  raw(value: Uint8Array): void {
    this.#ensure(value.length);
    this.#bytes.set(value, this.#offset);
    this.#offset += value.length;
  }

  string(value: string): void {
    const encoded = TEXT_ENCODER.encode(value);
    this.u16(encoded.length);
    this.raw(encoded);
  }

  points(value: NormalizedPoint[]): void {
    this.u16(value.length);
    for (const point of value) {
      this.u16(quantizeUnit(point.x));
      this.u16(quantizeUnit(point.y));
    }
  }

  take(): Uint8Array {
    return this.#bytes.slice(0, this.#offset);
  }
}

/** Reader matching {@link ByteWriter}; throws RangeError past the buffer end. */
class ByteReader {
  #bytes: Uint8Array;
  #view: DataView;
  #offset = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  u8(): number {
    const value = this.#view.getUint8(this.#offset);
    this.#offset += 1;
    return value;
  }

  u16(): number {
    const value = this.#view.getUint16(this.#offset);
    this.#offset += 2;
    return value;
  }

  u32(): number {
    const value = this.#view.getUint32(this.#offset);
    this.#offset += 4;
    return value;
  }

  raw(length: number): Uint8Array {
    const value = this.#bytes.subarray(this.#offset, this.#offset + length);
    if (value.length !== length) throw new RangeError('annotation frame truncated');
    this.#offset += length;
    return value;
  }

  string(): string {
    return TEXT_DECODER.decode(this.raw(this.u16()));
  }

  points(): NormalizedPoint[] {
    const count = this.u16();
    const result: NormalizedPoint[] = [];
    for (let i = 0; i < count; i += 1) {
      result.push({ x: dequantizeUnit(this.u16()), y: dequantizeUnit(this.u16()) });
    }
    return result;
  }
}
