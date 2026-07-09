import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../../../app.css';
import { deriveAnnotationKey } from './annotationCrypto';
import { CallAnnotations } from './callAnnotations';
import type { AnnotationCommit } from './types';
import AnnotationOverlayTestHarness from './AnnotationOverlayTestHarness.svelte';

function pointer(type: string, x: number, y: number): PointerEvent {
  return new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, bubbles: true });
}

function hasPaintedPixels(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext('2d');
  if (!ctx || canvas.width === 0 || canvas.height === 0) return false;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 0) return true;
  }
  return false;
}

describe('AnnotationOverlay', () => {
  it('sizes both canvas backing stores by devicePixelRatio', async () => {
    const { container } = render(AnnotationOverlayTestHarness, {});
    const canvases = container.querySelectorAll('canvas');
    expect(canvases).toHaveLength(2);

    const dpr = window.devicePixelRatio || 1;
    await vi.waitFor(() => {
      for (const canvas of canvases) {
        expect(canvas.width).toBe(Math.round(800 * dpr));
        expect(canvas.height).toBe(Math.round(600 * dpr));
      }
    });
  });

  it('marks the drawing surface touch-none and drawable when canDraw', () => {
    const { container } = render(AnnotationOverlayTestHarness, { canDraw: true });
    const live = container.querySelectorAll('canvas')[1];
    expect(live.className).toContain('touch-none');
    expect(live.className).toContain('cursor-crosshair');
    expect(live.className).not.toContain('pointer-events-none');
  });

  it('disables pointer input when canDraw is false', () => {
    const captured: AnnotationCommit[] = [];
    const { container } = render(AnnotationOverlayTestHarness, {
      canDraw: false,
      oncommit: (stroke) => captured.push(stroke)
    });
    const live = container.querySelectorAll('canvas')[1];
    expect(live.className).toContain('pointer-events-none');

    const rect = live.getBoundingClientRect();
    live.dispatchEvent(pointer('pointerdown', rect.left + 400, rect.top + 300));
    live.dispatchEvent(pointer('pointerup', rect.left + 400, rect.top + 300));
    expect(captured).toHaveLength(0);
  });

  it('commits a stroke with normalized points on pointer up', () => {
    const captured: AnnotationCommit[] = [];
    const { container } = render(AnnotationOverlayTestHarness, {
      oncommit: (stroke) => captured.push(stroke)
    });
    const live = container.querySelectorAll('canvas')[1];
    const rect = live.getBoundingClientRect();
    // The 800x600 box letterboxes 16:9 content into an 800x450 band centered
    // vertically, so the box center is also the content-box center → (0.5, 0.5).
    const cx = rect.left + 400;
    const cy = rect.top + 300;

    live.dispatchEvent(pointer('pointerdown', cx, cy));
    live.dispatchEvent(pointer('pointermove', cx + 40, cy));
    live.dispatchEvent(pointer('pointerup', cx + 40, cy));

    expect(captured).toHaveLength(1);
    const stroke = captured[0];
    expect(stroke.tool).toBe('pen');
    expect(stroke.points.length).toBeGreaterThanOrEqual(2);
    expect(stroke.points[0].x).toBeCloseTo(0.5, 2);
    expect(stroke.points[0].y).toBeCloseTo(0.5, 2);
    // A rightward move maps to a larger normalized x within the content box.
    expect(stroke.points[stroke.points.length - 1].x).toBeGreaterThan(stroke.points[0].x);
  });

  it('ignores strokes started on the letterbox bars', () => {
    const captured: AnnotationCommit[] = [];
    const { container } = render(AnnotationOverlayTestHarness, {
      oncommit: (stroke) => captured.push(stroke)
    });
    const live = container.querySelectorAll('canvas')[1];
    const rect = live.getBoundingClientRect();
    // y near the very top sits inside the letterbox bar (content starts ~75px down).
    live.dispatchEvent(pointer('pointerdown', rect.left + 400, rect.top + 5));
    live.dispatchEvent(pointer('pointerup', rect.left + 400, rect.top + 5));
    expect(captured).toHaveLength(0);
  });
});

describe('AnnotationOverlay two-participant sync', () => {
  const BOARD = 'sharer-1';

  /**
   * Two participants with controllers cross-wired as a loopback transport:
   * everything Alice publishes is delivered (still sealed) to Bob and vice
   * versa, exactly as LiveKit data channels would, minus the network.
   */
  async function makeLinkedControllers() {
    const key = await deriveAnnotationKey('two-participant-secret');
    // The publish closures run only after both controllers exist.
    const alice: CallAnnotations = new CallAnnotations(key, 'alice', (data, _reliable, topic) => {
      void bob.handleData(data, 'alice', topic);
    });
    const bob: CallAnnotations = new CallAnnotations(key, 'bob', (data, _reliable, topic) => {
      void alice.handleData(data, 'bob', topic);
    });
    return { alice, bob };
  }

  it('paints a stroke drawn by one participant onto the other participant’s canvas', async () => {
    const { alice, bob } = await makeLinkedControllers();

    // Alice can draw; Bob is a view-only observer of the same board.
    const drawer = render(AnnotationOverlayTestHarness, {
      canDraw: true,
      annotations: alice,
      boardId: BOARD
    });
    const viewer = render(AnnotationOverlayTestHarness, {
      canDraw: false,
      annotations: bob,
      boardId: BOARD
    });

    const drawerLive = drawer.container.querySelectorAll('canvas')[1];
    const rect = drawerLive.getBoundingClientRect();
    const cx = rect.left + 400;
    const cy = rect.top + 300;

    drawerLive.dispatchEvent(pointer('pointerdown', cx, cy));
    drawerLive.dispatchEvent(pointer('pointermove', cx + 60, cy + 20));
    drawerLive.dispatchEvent(pointer('pointermove', cx + 120, cy - 10));
    drawerLive.dispatchEvent(pointer('pointerup', cx + 120, cy - 10));

    // The sealed commit crosses the loopback, decrypts, and lands in Bob's state…
    await vi.waitFor(() => {
      expect(bob.committedStrokes(BOARD)).toHaveLength(1);
    });
    const stroke = bob.committedStrokes(BOARD)[0];
    expect(stroke.points.length).toBeGreaterThanOrEqual(3);
    expect(stroke.points[0].x).toBeCloseTo(0.5, 2);
    expect(stroke.points[0].y).toBeCloseTo(0.5, 2);

    // …and Bob's committed canvas actually paints it.
    const viewerCommitted = viewer.container.querySelectorAll('canvas')[0];
    await vi.waitFor(() => {
      expect(hasPaintedPixels(viewerCommitted)).toBe(true);
    });
  });

  it('streams in-progress stroke deltas to the other participant before pointer up', async () => {
    const { alice, bob } = await makeLinkedControllers();

    const drawer = render(AnnotationOverlayTestHarness, {
      canDraw: true,
      annotations: alice,
      boardId: BOARD
    });
    render(AnnotationOverlayTestHarness, {
      canDraw: false,
      annotations: bob,
      boardId: BOARD
    });

    const drawerLive = drawer.container.querySelectorAll('canvas')[1];
    const rect = drawerLive.getBoundingClientRect();
    const cx = rect.left + 400;
    const cy = rect.top + 300;

    drawerLive.dispatchEvent(pointer('pointerdown', cx, cy));
    drawerLive.dispatchEvent(pointer('pointermove', cx + 40, cy + 10));

    // Deltas flush on the drawer's next animation frame; the stroke must reach
    // Bob as pending (not committed) while the pointer is still down.
    await vi.waitFor(() => {
      expect(bob.pendingStrokes(BOARD)).toHaveLength(1);
    });
    expect(bob.committedStrokes(BOARD)).toHaveLength(0);

    drawerLive.dispatchEvent(pointer('pointerup', cx + 40, cy + 10));
    await vi.waitFor(() => {
      expect(bob.committedStrokes(BOARD)).toHaveLength(1);
      expect(bob.pendingStrokes(BOARD)).toHaveLength(0);
    });
  });
});
