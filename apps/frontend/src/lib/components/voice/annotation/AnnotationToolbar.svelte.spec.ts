import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../../../app.css';
import type { AnnotationTool } from './types';
import AnnotationToolbar from './AnnotationToolbar.svelte';

function makeProps(overrides: Record<string, unknown> = {}) {
  return {
    annotating: false,
    tool: 'pen' as AnnotationTool,
    colorIndex: 0,
    onToggleAnnotate: vi.fn(),
    onSelectTool: vi.fn(),
    onSelectColor: vi.fn(),
    onSelectBrushSize: vi.fn(),
    onClear: vi.fn(),
    onToggleDrawTogether: vi.fn(),
    ...overrides
  };
}

function q(container: HTMLElement, testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

describe('AnnotationToolbar', () => {
  it('shows only the draw toggle until drawing is armed', () => {
    const props = makeProps();
    const { container } = render(AnnotationToolbar, props);

    expect(q(container, 'call-annotate-toggle')).toBeTruthy();
    expect(q(container, 'call-annotation-pen')).toBeFalsy();
    expect(q(container, 'call-annotation-laser')).toBeFalsy();
    expect(q(container, 'call-annotation-clear')).toBeFalsy();

    q(container, 'call-annotate-toggle')!.click();
    expect(props.onToggleAnnotate).toHaveBeenCalledOnce();
  });

  it('exposes tools, color, and clear while annotating', () => {
    const props = makeProps({ annotating: true, tool: 'pen' });
    const { container } = render(AnnotationToolbar, props);

    expect(q(container, 'call-annotation-pen')?.className).toContain('bg-surface-200');
    q(container, 'call-annotation-laser')!.click();
    expect(props.onSelectTool).toHaveBeenCalledWith('laser');

    q(container, 'call-annotation-clear')!.click();
    expect(props.onClear).toHaveBeenCalledOnce();
  });

  it('cycles the brush size through the offered widths', () => {
    const props = makeProps({ annotating: true, brushSize: 4, onSelectBrushSize: vi.fn() });
    const { container } = render(AnnotationToolbar, props);

    q(container, 'call-annotation-size')!.click();
    expect(props.onSelectBrushSize).toHaveBeenCalledWith(7);
  });

  it('wraps the brush size cycle back to the smallest width', () => {
    const props = makeProps({ annotating: true, brushSize: 12, onSelectBrushSize: vi.fn() });
    const { container } = render(AnnotationToolbar, props);

    q(container, 'call-annotation-size')!.click();
    expect(props.onSelectBrushSize).toHaveBeenCalledWith(4);
  });

  it('opens the color menu and reports the picked palette index', async () => {
    const props = makeProps({ annotating: true });
    const { container } = render(AnnotationToolbar, props);

    q(container, 'call-annotation-color')!.click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="call-annotation-color-menu"]')).toBeTruthy();
    });

    (document.querySelector('[data-testid="call-annotation-color-3"]') as HTMLElement).click();
    expect(props.onSelectColor).toHaveBeenCalledWith(3);
  });

  it('shows the draw-together kill-switch only on the sharer’s own board', () => {
    const withoutOwnBoard = render(AnnotationToolbar, makeProps());
    expect(q(withoutOwnBoard.container, 'call-annotation-draw-together')).toBeFalsy();

    const props = makeProps({ isSharerBoard: true, drawTogether: true });
    const { container } = render(AnnotationToolbar, props);
    const killSwitch = q(container, 'call-annotation-draw-together');
    expect(killSwitch).toBeTruthy();
    killSwitch!.click();
    expect(props.onToggleDrawTogether).toHaveBeenCalledOnce();
  });
});
