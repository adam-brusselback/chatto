<!--
@component

Annotation controls for a screen-share tile, rendered inside the tile's
`CallTileActionToolbar`. Presentational: state comes in via props and every
action is a callback, so the voice-call panel owns the store wiring.

- Draw toggle arms/disarms this viewer's drawing mode.
- While drawing: pen/laser tool switch, color swatch (popover picker), clear.
- On the viewer's own shared screen: the "let others draw" kill-switch.
-->
<script lang="ts">
  import * as m from '$lib/i18n/messages';
  import FloatingPopover from '$lib/ui/FloatingPopover.svelte';
  import CallTileActionButton from '../CallTileActionButton.svelte';
  import { ANNOTATION_PALETTE, colorForIndex } from './palette';
  import type { AnnotationTool } from './types';

  let {
    annotating,
    tool,
    colorIndex,
    isSharerBoard = false,
    drawTogether = true,
    onToggleAnnotate,
    onSelectTool,
    onSelectColor,
    onClear,
    onToggleDrawTogether
  }: {
    annotating: boolean;
    tool: AnnotationTool;
    colorIndex: number;
    /** True when this tile shows the viewer's own shared screen. */
    isSharerBoard?: boolean;
    /** The sharer's kill-switch state (only meaningful on the sharer's board). */
    drawTogether?: boolean;
    onToggleAnnotate: () => void;
    onSelectTool: (tool: AnnotationTool) => void;
    onSelectColor: (index: number) => void;
    onClear: () => void;
    onToggleDrawTogether?: () => void;
  } = $props();

  let colorMenuAnchor = $state<{ top: number; bottom: number; left: number } | null>(null);

  function openColorMenu(event: MouseEvent): void {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    colorMenuAnchor = { top: rect.top, bottom: rect.bottom, left: rect.left };
  }
</script>

<CallTileActionButton
  icon="mdi--draw"
  label={annotating ? m['voice.stop_annotate']() : m['voice.annotate']()}
  active={annotating}
  testId="call-annotate-toggle"
  onclick={onToggleAnnotate}
/>
{#if annotating}
  <CallTileActionButton
    icon="uil--pen"
    label={m['voice.annotation_pen']()}
    active={tool === 'pen'}
    testId="call-annotation-pen"
    onclick={() => onSelectTool('pen')}
  />
  <CallTileActionButton
    icon="mdi--laser-pointer"
    label={m['voice.annotation_laser']()}
    active={tool === 'laser'}
    testId="call-annotation-laser"
    onclick={() => onSelectTool('laser')}
  />
  <button
    type="button"
    class="pointer-events-auto flex h-10 w-10 cursor-pointer items-center justify-center rounded text-muted transition-[background-color,color,scale] hover:bg-surface-200 hover:text-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary active:scale-[0.96]"
    title={m['voice.annotation_color']()}
    aria-label={m['voice.annotation_color']()}
    data-testid="call-annotation-color"
    onclick={openColorMenu}
  >
    <span
      class="h-4 w-4 rounded-full shadow-[inset_0_0_0_1px_rgb(0_0_0_/_0.2)]"
      style="background-color: {colorForIndex(colorIndex)}"
      aria-hidden="true"
    ></span>
  </button>
  <CallTileActionButton
    icon="uil--trash-alt"
    label={isSharerBoard ? m['voice.clear_all_annotations']() : m['voice.clear_my_annotations']()}
    testId="call-annotation-clear"
    onclick={onClear}
  />
{/if}
{#if isSharerBoard && onToggleDrawTogether}
  <CallTileActionButton
    icon="mdi--account-edit"
    label={m['voice.draw_together']()}
    active={drawTogether}
    testId="call-annotation-draw-together"
    onclick={onToggleDrawTogether}
  />
{/if}

{#if colorMenuAnchor}
  <FloatingPopover
    anchor={colorMenuAnchor}
    role="menu"
    ariaLabel={m['voice.annotation_color']()}
    class="rounded-md border border-text/10 bg-surface-100 p-2 shadow-md"
    onclose={() => (colorMenuAnchor = null)}
  >
    <div class="grid grid-cols-4 gap-1.5" data-testid="call-annotation-color-menu">
      {#each ANNOTATION_PALETTE as color, index (color)}
        <button
          type="button"
          class={[
            'flex h-8 w-8 cursor-pointer items-center justify-center rounded transition-[background-color,scale] hover:bg-surface-200 active:scale-[0.96]',
            index === colorIndex && 'bg-surface-200'
          ]}
          aria-label={m['voice.annotation_color_option']({ number: index + 1 })}
          data-testid={`call-annotation-color-${index}`}
          onclick={() => {
            onSelectColor(index);
            colorMenuAnchor = null;
          }}
        >
          <span
            class={[
              'h-5 w-5 rounded-full shadow-[inset_0_0_0_1px_rgb(0_0_0_/_0.2)]',
              index === colorIndex && 'ring-2 ring-primary ring-offset-1'
            ]}
            style="background-color: {color}"
            aria-hidden="true"
          ></span>
        </button>
      {/each}
    </div>
  </FloatingPopover>
{/if}
