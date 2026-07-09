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

/** Latest laser-pointer position for one sender on one board. */
export interface LaserPointerState {
  sender: string;
  x: number;
  y: number;
  colorIndex: number;
  /** False once the sender lifted the pointer; clients fade the dot out. */
  active: boolean;
  /** Milliseconds since the last update, for fade-out rendering. */
  ageMs: number;
}

interface LaserRecord {
  x: number;
  y: number;
  colorIndex: number;
  active: boolean;
  updatedAt: number;
}

export class CallAnnotations {
  readonly #key: CryptoKey;
  readonly #localIdentity: string;
  readonly #publish: AnnotationPublish;

  // boardId -> `${author}:${strokeId}` -> stroke. Deliberately non-reactive.
  readonly #boards = new Map<string, Map<string, BoardStroke>>();
  // boardId -> sender identity -> latest laser position.
  readonly #lasers = new Map<string, Map<string, LaserRecord>>();
  // boardId -> sharer's "draw together" flag. Absent means enabled (default).
  readonly #drawTogether = new Map<string, boolean>();
  #revision = 0;
  #nextStrokeId = 1;
  readonly #listeners = new Set<() => void>();

  /**
   * Invoked when a remote sharer changes their board's "draw together" flag.
   * The voice-call store mirrors this into reactive state so templates can gate
   * drawing affordances; stroke/laser state itself stays non-reactive.
   */
  onControlChange: ((boardId: string, drawTogetherEnabled: boolean) => void) | null = null;

  constructor(key: CryptoKey, localIdentity: string, publish: AnnotationPublish) {
    this.#key = key;
    this.#localIdentity = localIdentity;
    this.#publish = publish;
  }

  /**
   * Allocate a stroke id for a new local stroke. Instance-scoped (one controller
   * per call) so ids stay unique for this sender even when several overlay tiles
   * of the same board draw concurrently.
   */
  nextStrokeId(): number {
    return this.#nextStrokeId++;
  }

  /**
   * Register a plain (non-reactive) callback invoked whenever stroke state
   * changes, so overlays can schedule a repaint frame. Returns an unsubscribe
   * function.
   */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
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
    this.#notify();
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
    this.#notify();
    await this.#send({ type: AnnotationFrameType.Clear, boardId, scope }, true);
  }

  /** Publish this participant's laser-pointer position (lossy, latest wins). */
  async publishLaser(
    boardId: string,
    x: number,
    y: number,
    colorIndex: number,
    active: boolean
  ): Promise<void> {
    await this.#send(
      { type: AnnotationFrameType.Laser, boardId, x, y, color: colorIndex, active },
      false
    );
  }

  /** Latest remote laser pointers for a board, with age for fade-out. */
  lasers(boardId: string): LaserPointerState[] {
    const board = this.#lasers.get(boardId);
    if (!board) return [];
    const now = Date.now();
    const result: LaserPointerState[] = [];
    for (const [sender, laser] of board) {
      result.push({
        sender,
        x: laser.x,
        y: laser.y,
        colorIndex: laser.colorIndex,
        active: laser.active,
        ageMs: now - laser.updatedAt
      });
    }
    return result;
  }

  /** Whether the sharer of a board currently allows others to draw on it. */
  isDrawTogetherEnabled(boardId: string): boolean {
    return this.#drawTogether.get(boardId) ?? true;
  }

  /**
   * Set the "draw together" flag for this participant's own board and announce
   * it to the call (reliable).
   */
  async setLocalDrawTogether(boardId: string, enabled: boolean): Promise<void> {
    this.#drawTogether.set(boardId, enabled);
    this.#notify();
    await this.#send(
      { type: AnnotationFrameType.Control, boardId, drawTogetherEnabled: enabled },
      true
    );
  }

  /**
   * Re-announce this participant's own board flag (e.g. when someone joins the
   * call after the sharer disabled drawing; the default everywhere is enabled).
   */
  async rebroadcastDrawTogether(boardId: string): Promise<void> {
    const enabled = this.#drawTogether.get(boardId);
    if (enabled === undefined) return;
    await this.#send(
      { type: AnnotationFrameType.Control, boardId, drawTogetherEnabled: enabled },
      true
    );
  }

  /**
   * Drop all local state for one board without publishing (used when a screen
   * share ends; each client observes the track unpublish itself).
   */
  dropBoard(boardId: string): void {
    const board = this.#boards.get(boardId);
    const hadCommitted = board ? [...board.values()].some((stroke) => stroke.committed) : false;
    this.#boards.delete(boardId);
    this.#lasers.delete(boardId);
    this.#drawTogether.delete(boardId);
    if (hadCommitted) this.#revision += 1;
    this.#notify();
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
    if (frame) {
      this.#apply(frame, senderIdentity);
      this.#notify();
    }
  }

  /** Drop all stroke state (call end). */
  clear(): void {
    if (this.#boards.size === 0 && this.#lasers.size === 0 && this.#drawTogether.size === 0) {
      return;
    }
    this.#boards.clear();
    this.#lasers.clear();
    this.#drawTogether.clear();
    this.#revision += 1;
    this.#notify();
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
      case AnnotationFrameType.Laser: {
        let board = this.#lasers.get(frame.boardId);
        if (!board) {
          board = new Map();
          this.#lasers.set(frame.boardId, board);
        }
        board.set(sender, {
          x: frame.x,
          y: frame.y,
          colorIndex: frame.color,
          active: frame.active,
          updatedAt: Date.now()
        });
        break;
      }
      case AnnotationFrameType.Control:
        this.#drawTogether.set(frame.boardId, frame.drawTogetherEnabled);
        this.onControlChange?.(frame.boardId, frame.drawTogetherEnabled);
        break;
      default:
        // Hello (late-joiner replay) is handled in a later milestone.
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
