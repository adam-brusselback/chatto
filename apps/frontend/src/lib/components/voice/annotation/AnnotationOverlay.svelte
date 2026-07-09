<!--
@component

A drawing surface that overlays a screen-share `<video>`. It stacks two
canvases sized to the letterboxed video content box:

- a **committed** layer, repainted only when finished strokes change or the
  geometry resizes, and
- a **live** layer, repainted each animation frame with the in-progress stroke.

All high-frequency drawing state (in-flight points, committed strokes, geometry)
is kept in plain, non-reactive variables and painted imperatively on demand, the
same discipline as the call's audio-level loop — 30-60 Hz pointer data never
flows through `$state`/`$derived`.

Coordinates are normalized [0,1] over the video content box (see coords.ts) so a
stroke lands on the same shared-content pixel for every viewer. This milestone
draws locally and reports finished strokes via `oncommit`; the transport that
mirrors strokes to other participants is wired separately.
-->
<script lang="ts">
  import { clampToUnit, contentRect, isInsideUnit, toNormalized } from './coords';
  import { renderStroke, type RenderableStroke } from './renderStrokes';
  import type { AnnotationCommit, AnnotationTool, NormalizedPoint } from './types';

  let {
    videoEl,
    canDraw = true,
    tool = 'pen',
    color = '#f59e0b',
    size = 4,
    oncommit
  }: {
    /** The screen-share video to overlay; provides intrinsic size for mapping. */
    videoEl: HTMLVideoElement | null;
    /** When false the surface ignores pointer input (view-only). */
    canDraw?: boolean;
    tool?: AnnotationTool;
    /** Resolved CSS color for new strokes. */
    color?: string;
    /** Brush diameter in CSS pixels. */
    size?: number;
    /** Called with the finished stroke when the pointer lifts. */
    oncommit?: (stroke: AnnotationCommit) => void;
  } = $props();

  // Element refs (bind:this targets must be reactive).
  let rootEl = $state<HTMLDivElement | null>(null);
  let committedCanvas = $state<HTMLCanvasElement | null>(null);
  let liveCanvas = $state<HTMLCanvasElement | null>(null);

  // Non-reactive drawing state: deliberately plain `let`s so mutating them never
  // touches Svelte's reactive graph. Painted imperatively via requestAnimationFrame.
  let committedContext: CanvasRenderingContext2D | null = null;
  let liveContext: CanvasRenderingContext2D | null = null;
  let committed: RenderableStroke[] = [];
  let currentPoints: NormalizedPoint[] | null = null;
  let activePointerId: number | null = null;
  let committedDirty = false;
  let rafId: number | null = null;

  // Cached geometry (CSS pixels + intrinsic source size), refreshed on resize.
  let elementWidth = 0;
  let elementHeight = 0;
  let intrinsicWidth = 0;
  let intrinsicHeight = 0;
  let pixelRatio = 1;

  function measure(): void {
    if (!rootEl || !videoEl || !committedCanvas || !liveCanvas) return;
    const rect = rootEl.getBoundingClientRect();
    elementWidth = rect.width;
    elementHeight = rect.height;
    intrinsicWidth = videoEl.videoWidth;
    intrinsicHeight = videoEl.videoHeight;
    pixelRatio = window.devicePixelRatio || 1;

    const backingWidth = Math.max(1, Math.round(elementWidth * pixelRatio));
    const backingHeight = Math.max(1, Math.round(elementHeight * pixelRatio));
    for (const canvas of [committedCanvas, liveCanvas]) {
      if (canvas.width !== backingWidth) canvas.width = backingWidth;
      if (canvas.height !== backingHeight) canvas.height = backingHeight;
    }
  }

  function scheduleFrame(): void {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(renderFrame);
  }

  function renderFrame(): void {
    rafId = null;
    if (!committedContext || !liveContext) return;
    const content = contentRect(elementWidth, elementHeight, intrinsicWidth, intrinsicHeight);

    if (committedDirty) {
      committedContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      committedContext.clearRect(0, 0, elementWidth, elementHeight);
      if (content.width > 0) {
        for (const stroke of committed) renderStroke(committedContext, stroke, content);
      }
      committedDirty = false;
    }

    liveContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    liveContext.clearRect(0, 0, elementWidth, elementHeight);
    if (content.width > 0 && currentPoints && currentPoints.length > 0) {
      renderStroke(liveContext, { color, size, points: currentPoints }, content);
    }
  }

  function setup(root: HTMLElement) {
    committedContext = committedCanvas?.getContext('2d') ?? null;
    liveContext = liveCanvas?.getContext('2d') ?? null;

    measure();
    committedDirty = true;
    scheduleFrame();

    const onGeometryChange = () => {
      measure();
      committedDirty = true;
      scheduleFrame();
    };

    const observer = new ResizeObserver(onGeometryChange);
    observer.observe(root);

    // Intrinsic size changes when the shared window/tab is resized.
    const video = videoEl;
    video?.addEventListener('resize', onGeometryChange);
    video?.addEventListener('loadedmetadata', onGeometryChange);

    return () => {
      observer.disconnect();
      video?.removeEventListener('resize', onGeometryChange);
      video?.removeEventListener('loadedmetadata', onGeometryChange);
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
    };
  }

  function pointerToNormalized(event: PointerEvent): NormalizedPoint | null {
    if (!rootEl || !videoEl) return null;
    const rect = rootEl.getBoundingClientRect();
    return toNormalized(event.clientX, event.clientY, rect, {
      width: videoEl.videoWidth,
      height: videoEl.videoHeight
    });
  }

  function handlePointerDown(event: PointerEvent): void {
    if (!canDraw) return;
    const point = pointerToNormalized(event);
    if (!point || !isInsideUnit(point)) return; // ignore starts on the letterbox bars

    event.preventDefault();
    event.stopPropagation();
    activePointerId = event.pointerId;
    currentPoints = [point];
    try {
      liveCanvas?.setPointerCapture(event.pointerId);
    } catch {
      // setPointerCapture can throw for synthetic pointers (e.g. in tests).
    }
    scheduleFrame();
  }

  function handlePointerMove(event: PointerEvent): void {
    if (activePointerId !== event.pointerId || !currentPoints) return;

    const coalesced =
      typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
    for (const sample of coalesced.length > 0 ? coalesced : [event]) {
      const point = pointerToNormalized(sample);
      if (point) currentPoints.push(clampToUnit(point));
    }
    scheduleFrame();
  }

  function handlePointerUp(event: PointerEvent): void {
    if (activePointerId !== event.pointerId) return;

    const points = currentPoints;
    activePointerId = null;
    currentPoints = null;
    try {
      liveCanvas?.releasePointerCapture(event.pointerId);
    } catch {
      // releasePointerCapture can throw if capture was never established.
    }

    if (points && points.length > 0) {
      committed.push({ color, size, points });
      committedDirty = true;
      oncommit?.({ tool, color, size, points });
    }
    scheduleFrame();
  }
</script>

<div bind:this={rootEl} class="absolute inset-0" {@attach setup}>
  <canvas bind:this={committedCanvas} class="pointer-events-none absolute inset-0 h-full w-full"
  ></canvas>
  <canvas
    bind:this={liveCanvas}
    class={[
      'absolute inset-0 h-full w-full touch-none',
      canDraw ? 'cursor-crosshair' : 'pointer-events-none'
    ]}
    onpointerdown={handlePointerDown}
    onpointermove={handlePointerMove}
    onpointerup={handlePointerUp}
    onpointercancel={handlePointerUp}
  ></canvas>
</div>
