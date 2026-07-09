<script lang="ts">
  import AnnotationOverlay from './AnnotationOverlay.svelte';
  import type { CallAnnotations } from './callAnnotations';
  import type { AnnotationCommit } from './types';

  let {
    canDraw = true,
    annotations = null,
    boardId = '',
    oncommit
  }: {
    canDraw?: boolean;
    annotations?: CallAnnotations | null;
    boardId?: string;
    oncommit?: (stroke: AnnotationCommit) => void;
  } = $props();

  // Stub video: the overlay only reads intrinsic size and (un)subscribes to
  // resize/loadedmetadata. 16:9 content in the 4:3 box exercises letterboxing.
  const videoEl = {
    videoWidth: 1920,
    videoHeight: 1080,
    addEventListener() {},
    removeEventListener() {}
  } as unknown as HTMLVideoElement;
</script>

<div style="position: relative; width: 800px; height: 600px;">
  <AnnotationOverlay {videoEl} {canDraw} {annotations} {boardId} {oncommit} />
</div>
