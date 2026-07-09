<!--
@component

A drawing surface that overlays a screen-share `<video>`. It stacks two
canvases sized to the letterboxed video content box:

- a **committed** layer, repainted only when finished strokes change or the
  geometry resizes, and
- a **live** layer, repainted per animation frame with in-progress strokes.

When given a `CallAnnotations` controller and a `boardId`, the overlay is fully
synchronized: local strokes are published through the controller (lossy deltas
per frame while drawing, a reliable commit on pointer up) and remote strokes are
painted from the controller's non-reactive stroke state, repainting only when
the controller signals a change. Without a controller it draws locally only.

All high-frequency drawing state is kept in plain, non-reactive variables and
painted imperatively on demand, the same discipline as the call's audio-level
loop — 30-60 Hz pointer data never flows through `$state`/`$derived`.

Coordinates are normalized [0,1] over the video content box (see coords.ts) so a
stroke lands on the same shared-content pixel for every viewer.
-->
<script lang="ts">
  import type { CallAnnotations } from './callAnnotations';
  import { clampToUnit, contentRect, fromNormalized, isInsideUnit, toNormalized } from './coords';
  import { colorForIndex, DEFAULT_BRUSH_SIZE, DEFAULT_COLOR_INDEX } from './palette';
  import { renderStroke, type RenderableStroke } from './renderStrokes';
  import type { AnnotationCommit, AnnotationTool, NormalizedPoint } from './types';

  // Largest point batch for one lossy delta frame; keeps the sealed datagram
  // comfortably under the ~1300 byte MTU budget (4 bytes per point + header).
  const MAX_DELTA_POINTS = 120;

  // How long a laser dot keeps glowing after its last update before fading out.
  const LASER_FADE_MS = 900;

  let {
    videoEl,
    annotations = null,
    boardId = '',
    canDraw = true,
    tool = 'pen',
    colorIndex = DEFAULT_COLOR_INDEX,
    size = DEFAULT_BRUSH_SIZE,
    oncommit
  }: {
    /** The screen-share video to overlay; provides intrinsic size for mapping. */
    videoEl: HTMLVideoElement | null;
    /** Transport controller; when set with `boardId`, strokes sync to the call. */
    annotations?: CallAnnotations | null;
    /** Identity of the participant whose shared screen this overlay covers. */
    boardId?: string;
    /** When false the surface ignores pointer input (view-only). */
    canDraw?: boolean;
    tool?: AnnotationTool;
    /** Palette index for new strokes (see palette.ts). */
    colorIndex?: number;
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
  let localCommitted: RenderableStroke[] = [];
  let currentPoints: NormalizedPoint[] | null = null;
  let currentStrokeId = 0;
  let sentPointCount = 0;
  let activePointerId: number | null = null;
  let committedDirty = false;
  let renderedRevision = -1;
  let rafId: number | null = null;
  // Laser pointer: the local dot being shown, and the latest not-yet-published
  // position (flushed once per frame; only the newest position matters).
  let localLaser: { x: number; y: number; active: boolean; updatedAt: number } | null = null;
  let pendingLaser: { x: number; y: number; active: boolean } | null = null;

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

  function committedStrokes(): RenderableStroke[] {
    return annotations && boardId ? annotations.committedStrokes(boardId) : localCommitted;
  }

  function pendingRemoteStrokes(): RenderableStroke[] {
    return annotations && boardId ? annotations.pendingStrokes(boardId) : [];
  }

  function flushStrokeDelta(): void {
    if (!annotations || !boardId || !currentPoints || currentPoints.length <= sentPointCount) {
      return;
    }
    const batch = currentPoints.slice(sentPointCount, sentPointCount + MAX_DELTA_POINTS);
    void annotations.publishStrokeDelta(
      boardId,
      currentStrokeId,
      colorIndex,
      size,
      sentPointCount,
      batch
    );
    sentPointCount += batch.length;
  }

  function flushLaser(): void {
    if (!annotations || !boardId || !pendingLaser) return;
    void annotations.publishLaser(
      boardId,
      pendingLaser.x,
      pendingLaser.y,
      colorIndex,
      pendingLaser.active
    );
    pendingLaser = null;
  }

  function laserAlpha(active: boolean, ageMs: number): number {
    if (active) return 1;
    return Math.max(0, 1 - ageMs / LASER_FADE_MS);
  }

  function drawLaserDot(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    color: string,
    alpha: number
  ): void {
    ctx.save();
    ctx.globalAlpha = alpha * 0.35;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(x, y, 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function renderFrame(): void {
    rafId = null;
    if (!committedContext || !liveContext) return;
    const content = contentRect(elementWidth, elementHeight, intrinsicWidth, intrinsicHeight);

    // Publish this frame's batch of local input (stroke points, laser position).
    flushStrokeDelta();
    flushLaser();

    if (annotations && annotations.revision !== renderedRevision) {
      renderedRevision = annotations.revision;
      committedDirty = true;
    }

    if (committedDirty) {
      committedContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      committedContext.clearRect(0, 0, elementWidth, elementHeight);
      if (content.width > 0) {
        for (const stroke of committedStrokes()) renderStroke(committedContext, stroke, content);
      }
      committedDirty = false;
    }

    liveContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    liveContext.clearRect(0, 0, elementWidth, elementHeight);
    let lasersVisible = false;
    if (content.width > 0) {
      for (const stroke of pendingRemoteStrokes()) renderStroke(liveContext, stroke, content);
      if (currentPoints && currentPoints.length > 0) {
        renderStroke(
          liveContext,
          { color: colorForIndex(colorIndex), size, points: currentPoints },
          content
        );
      }

      // Laser dots: remote pointers from the controller plus the local echo,
      // fading out after their last update.
      if (annotations && boardId) {
        for (const laser of annotations.lasers(boardId)) {
          const alpha = laserAlpha(laser.active, laser.ageMs);
          if (alpha <= 0) continue;
          lasersVisible = true;
          const at = fromNormalized({ x: laser.x, y: laser.y }, content);
          drawLaserDot(liveContext, at.x, at.y, colorForIndex(laser.colorIndex), alpha);
        }
      }
      if (localLaser) {
        const alpha = laserAlpha(localLaser.active, Date.now() - localLaser.updatedAt);
        if (alpha > 0) {
          lasersVisible = true;
          const at = fromNormalized(localLaser, content);
          drawLaserDot(liveContext, at.x, at.y, colorForIndex(colorIndex), alpha);
        } else if (!localLaser.active) {
          localLaser = null;
        }
      }
    }

    // Keep animating while any laser dot is visible so fade-outs complete.
    if (lasersVisible) scheduleFrame();
  }

  function setup(root: HTMLElement) {
    committedContext = committedCanvas?.getContext('2d') ?? null;
    liveContext = liveCanvas?.getContext('2d') ?? null;

    measure();
    committedDirty = true;
    renderedRevision = -1;
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

    // Repaint when remote annotation state changes (event-driven, no idle loop).
    const unsubscribe = annotations?.subscribe(scheduleFrame);

    return () => {
      observer.disconnect();
      unsubscribe?.();
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
    if (tool === 'laser') {
      localLaser = { ...point, active: true, updatedAt: Date.now() };
      pendingLaser = { ...point, active: true };
    } else {
      currentPoints = [point];
      currentStrokeId = annotations?.nextStrokeId() ?? 0;
      sentPointCount = 0;
    }
    try {
      liveCanvas?.setPointerCapture(event.pointerId);
    } catch {
      // setPointerCapture can throw for synthetic pointers (e.g. in tests).
    }
    scheduleFrame();
  }

  function handlePointerMove(event: PointerEvent): void {
    if (activePointerId !== event.pointerId) return;

    if (localLaser?.active) {
      // Only the newest laser position matters; no need for coalesced samples.
      const point = pointerToNormalized(event);
      if (point) {
        const clamped = clampToUnit(point);
        localLaser = { ...clamped, active: true, updatedAt: Date.now() };
        pendingLaser = { ...clamped, active: true };
      }
      scheduleFrame();
      return;
    }

    if (!currentPoints) return;
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
    const strokeId = currentStrokeId;
    activePointerId = null;
    currentPoints = null;
    sentPointCount = 0;
    try {
      liveCanvas?.releasePointerCapture(event.pointerId);
    } catch {
      // releasePointerCapture can throw if capture was never established.
    }

    if (localLaser?.active) {
      localLaser = { ...localLaser, active: false, updatedAt: Date.now() };
      pendingLaser = { x: localLaser.x, y: localLaser.y, active: false };
    }

    if (points && points.length > 0) {
      if (annotations && boardId) {
        // The controller records the stroke locally (bumping its revision) and
        // publishes the authoritative commit to the call.
        void annotations.publishStrokeCommit(boardId, strokeId, colorIndex, size, points);
      } else {
        localCommitted.push({ color: colorForIndex(colorIndex), size, points });
        committedDirty = true;
      }
      oncommit?.({ tool, color: colorForIndex(colorIndex), size, points });
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
