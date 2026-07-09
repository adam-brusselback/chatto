import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../../../app.css';
import type { AnnotationCommit } from './types';
import AnnotationOverlayTestHarness from './AnnotationOverlayTestHarness.svelte';

function pointer(type: string, x: number, y: number): PointerEvent {
  return new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, bubbles: true });
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
