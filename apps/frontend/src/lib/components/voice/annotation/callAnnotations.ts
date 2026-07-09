/**
 * Controller for ephemeral screen-share annotations over LiveKit data channels.
 *
 * It owns the annotation protocol — encoding and sealing outbound frames, and
 * opening, decoding, and routing inbound ones — but not the LiveKit Room. It is
 * constructed with a `publish` callback (wired to the room's data channel) and
 * fed inbound packets via {@link CallAnnotations.handleData}, which keeps all
 * LiveKit knowledge in the voice-call store and makes the protocol unit-testable
 * in isolation.
 *
 * Stroke state lives in a plain, non-reactive Map read imperatively by the
 * overlay's animation-frame loop; high-frequency data never enters Svelte's
 * reactive graph. Strokes are keyed by `${author}:${strokeId}`, where the author
 * is the LiveKit-authenticated sender identity.
 */

import {
  ANNOTATION_TOPIC_LOSSY,
  ANNOTATION_TOPIC_RELIABLE,
  AnnotationFrameType,
  ClearScope,
  decodeAnnotationFrame,
  encodeAnnotationFrame,
  type AnnotationFrame
} from './annotationCodec';
import { open, seal } from './annotationCrypto';
import { colorForIndex } from './palette';
import type { RenderableStroke } from './renderStrokes';
import type { NormalizedPoint } from './types';

/** Publishes an encrypted frame on a data-channel topic. */
export type AnnotationPublish = (data: Uint8Array, reliable: boolean, topic: string) => void;

interface BoardStroke {
  author: string;
  strokeId: number;
  colorIndex: number;
  size: number;
  points: NormalizedPoint[];
  committed: boolean;
}

export class CallAnnotations {
  readonly #key: CryptoKey;
  readonly #localIdentity: string;
  readonly #publish: AnnotationPublish;

  // boardId -> `${author}:${strokeId}` -> stroke. Deliberately non-reactive.
  readonly #boards = new Map<string, Map<string, BoardStroke>>();
  #revision = 0;

  constructor(key: CryptoKey, localIdentity: string, publish: AnnotationPublish) {
    this.#key = key;
    this.#localIdentity = localIdentity;
    this.#publish = publish;
  }

  /**
   * Increments whenever the committed stroke set changes, so the overlay can
   * repaint its committed layer only when needed.
   */
  get revision(): number {
    return this.#revision;
  }

  /** Finalized strokes to paint for a board, in receive order. */
  committedStrokes(boardId: string): RenderableStroke[] {
    return this.#collect(boardId, true);
  }

  /** In-progress remote strokes for a board (repainted every frame). */
  pendingStrokes(boardId: string): RenderableStroke[] {
    return this.#collect(boardId, false);
  }

  /** Publish an incremental batch of new points for an in-progress stroke. */
  async publishStrokeDelta(
    boardId: string,
    strokeId: number,
    colorIndex: number,
    size: number,
    startIndex: number,
    points: NormalizedPoint[]
  ): Promise<void> {
    await this.#send(
      {
        type: AnnotationFrameType.StrokeDelta,
        boardId,
        strokeId,
        color: colorIndex,
        size,
        startIndex,
        points
      },
      false
    );
  }

  /** Publish the authoritative finished stroke and record it locally. */
  async publishStrokeCommit(
    boardId: string,
    strokeId: number,
    colorIndex: number,
    size: number,
    points: NormalizedPoint[]
  ): Promise<void> {
    this.#record(boardId, this.#localIdentity, strokeId, colorIndex, size, 0, points, true);
    await this.#send(
      {
        type: AnnotationFrameType.StrokeCommit,
        boardId,
        strokeId,
        color: colorIndex,
        size,
        points
      },
      true
    );
  }

  /** Clear the whole board or just this participant's own strokes. */
  async publishClear(boardId: string, scope: ClearScope): Promise<void> {
    this.#applyClear(boardId, scope, this.#localIdentity);
    await this.#send({ type: AnnotationFrameType.Clear, boardId, scope }, true);
  }

  /** Decrypt, decode, and apply an inbound data-channel packet. */
  async handleData(
    payload: Uint8Array,
    senderIdentity: string,
    topic: string | undefined
  ): Promise<void> {
    if (topic !== ANNOTATION_TOPIC_LOSSY && topic !== ANNOTATION_TOPIC_RELIABLE) return;
    const plaintext = await open(this.#key, payload);
    if (!plaintext) return;
    const frame = decodeAnnotationFrame(plaintext);
    if (frame) this.#apply(frame, senderIdentity);
  }

  /** Drop all stroke state (call end). */
  clear(): void {
    if (this.#boards.size === 0) return;
    this.#boards.clear();
    this.#revision += 1;
  }

  #apply(frame: AnnotationFrame, sender: string): void {
    switch (frame.type) {
      case AnnotationFrameType.StrokeDelta:
        this.#record(
          frame.boardId,
          sender,
          frame.strokeId,
          frame.color,
          frame.size,
          frame.startIndex,
          frame.points,
          false
        );
        break;
      case AnnotationFrameType.StrokeCommit:
        this.#record(
          frame.boardId,
          sender,
          frame.strokeId,
          frame.color,
          frame.size,
          0,
          frame.points,
          true
        );
        break;
      case AnnotationFrameType.Clear:
        this.#applyClear(frame.boardId, frame.scope, sender);
        break;
      default:
        // Laser, Control, and Hello frames are handled in later milestones.
        break;
    }
  }

  async #send(frame: AnnotationFrame, reliable: boolean): Promise<void> {
    const sealed = await seal(this.#key, encodeAnnotationFrame(frame));
    this.#publish(sealed, reliable, reliable ? ANNOTATION_TOPIC_RELIABLE : ANNOTATION_TOPIC_LOSSY);
  }

  #record(
    boardId: string,
    author: string,
    strokeId: number,
    colorIndex: number,
    size: number,
    startIndex: number,
    points: NormalizedPoint[],
    committed: boolean
  ): void {
    const board = this.#ensureBoard(boardId);
    const key = `${author}:${strokeId}`;
    let stroke = board.get(key);
    if (!stroke) {
      stroke = { author, strokeId, colorIndex, size, points: [], committed: false };
      board.set(key, stroke);
    }
    stroke.colorIndex = colorIndex;
    stroke.size = size;

    if (committed) {
      stroke.points = points.slice();
      stroke.committed = true;
      this.#revision += 1;
      return;
    }

    // Delta: place new points at startIndex. Overlapping deltas overwrite the
    // tail; a gap (a dropped lossy delta) just appends until the reliable commit
    // rewrites the whole stroke.
    if (startIndex <= stroke.points.length) {
      stroke.points.length = startIndex;
    }
    for (const point of points) stroke.points.push(point);
  }

  #applyClear(boardId: string, scope: ClearScope, sender: string): void {
    const board = this.#boards.get(boardId);
    if (!board) return;
    let changedCommitted = false;
    if (scope === ClearScope.Own) {
      for (const [key, stroke] of board) {
        if (stroke.author === sender) {
          if (stroke.committed) changedCommitted = true;
          board.delete(key);
        }
      }
    } else {
      for (const stroke of board.values()) {
        if (stroke.committed) changedCommitted = true;
      }
      board.clear();
    }
    if (changedCommitted) this.#revision += 1;
  }

  #collect(boardId: string, committed: boolean): RenderableStroke[] {
    const board = this.#boards.get(boardId);
    if (!board) return [];
    const result: RenderableStroke[] = [];
    for (const stroke of board.values()) {
      if (stroke.committed === committed && stroke.points.length > 0) {
        result.push({
          color: colorForIndex(stroke.colorIndex),
          size: stroke.size,
          points: stroke.points
        });
      }
    }
    return result;
  }

  #ensureBoard(boardId: string): Map<string, BoardStroke> {
    let board = this.#boards.get(boardId);
    if (!board) {
      board = new Map();
      this.#boards.set(boardId, board);
    }
    return board;
  }
}
