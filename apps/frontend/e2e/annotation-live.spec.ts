/**
 * MANUAL two-session annotation test against a REAL LiveKit server.
 *
 * Skipped unless ANNOTATION_LIVE=1 — it needs `livekit-server --dev`
 * running on localhost:7880, which CI does not have. Run it locally with:
 *
 *   livekit-server --dev &
 *   ANNOTATION_LIVE=1 mise x -- pnpm exec playwright test e2e/annotation-live.spec.ts --retries=0
 *
 * Optional env: ANNOTATION_SHOTS_DIR (screenshot output directory) and
 * ANNOTATION_CHROMIUM (Chromium executable override for sandboxed hosts).
 *
 * Drives two full browser sessions through a real call: user A shares a
 * screen, both users draw with the pen, A uses the laser pointer and the
 * "let others draw" kill-switch, and the test asserts strokes arrive as
 * painted pixels on the other side. Takes screenshots along the way.
 */

import { test, expect, type Page } from '@playwright/test';
import { test as base } from './setup';
import { loginAndEnterRoom, withServerUser } from './fixtures/serverUser';
import { TIMEOUTS } from './constants';

const LIVE = process.env.ANNOTATION_LIVE === '1';
const SHOTS = process.env.ANNOTATION_SHOTS_DIR ?? 'annotation-shots';

// The maximized call pane shows the shared screen as the featured stage tile.
const CARD = '[data-testid="call-featured-stage-card"]';

base.use({
  serverOptions: {
    env: {
      CHATTO_LIVEKIT_ENABLED: 'true',
      CHATTO_LIVEKIT_URL: 'ws://localhost:7880',
      CHATTO_LIVEKIT_API_KEY: 'devkey',
      CHATTO_LIVEKIT_API_SECRET: 'secret'
    }
  },
  launchOptions: {
    ...(process.env.ANNOTATION_CHROMIUM ? { executablePath: process.env.ANNOTATION_CHROMIUM } : {}),
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-fake-ui-for-media-capture',
      '--use-fake-device-for-media-capture',
      '--autoplay-policy=no-user-gesture-required'
    ]
  },
  permissions: ['microphone', 'camera'],
  viewport: { width: 1600, height: 1000 }
});

/**
 * Headless Chromium in this environment cannot open the OS screen picker, so
 * getDisplayMedia is replaced with an animated canvas captureStream. Everything
 * downstream — LiveKit publish, SFU routing, subscription, E2EE, the <video>
 * element, and the annotation overlay — runs for real; only the captured
 * pixels are synthetic.
 */
const FAKE_SCREEN_INIT = `
  navigator.mediaDevices.getDisplayMedia = async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 800;
    const ctx = canvas.getContext('2d');
    let t = 0;
    setInterval(() => {
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, 1280, 800);
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(24, 24, 1232, 752);
      ctx.fillStyle = '#334155';
      ctx.fillRect(24, 24, 1232, 44);
      ctx.fillStyle = '#38bdf8';
      ctx.beginPath();
      ctx.arc(640 + 220 * Math.cos(t / 40), 420 + 140 * Math.sin(t / 40), 26, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#e2e8f0';
      ctx.font = 'bold 34px sans-serif';
      ctx.fillText('Shared screen (synthetic desktop)', 60, 140);
      ctx.font = '24px sans-serif';
      ctx.fillStyle = '#94a3b8';
      ctx.fillText('frame ' + t, 60, 190);
      t += 1;
    }, 33);
    return canvas.captureStream(30);
  };
`;

async function openCallTab(page: Page): Promise<void> {
  await page.locator('[data-testid="room-sidebar-toggle"]:visible').getByLabel('Show call').click();
}

async function countPaintedPixels(page: Page, canvasIndex: number): Promise<number> {
  return page.evaluate(
    ({ card, index }) => {
      const root = document.querySelector(card);
      if (!root) return -1;
      const canvas = root.querySelectorAll('canvas')[index] as HTMLCanvasElement | undefined;
      if (!canvas || canvas.width === 0) return -1;
      const ctx = canvas.getContext('2d');
      if (!ctx) return -1;
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let painted = 0;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] > 0) painted += 1;
      }
      return painted;
    },
    { card: CARD, index: canvasIndex }
  );
}

async function armDrawing(page: Page): Promise<void> {
  const card = page.locator(CARD);
  await card.hover();
  await card.getByTestId('call-annotate-toggle').click();
}

async function drawStroke(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number }
): Promise<void> {
  const video = page.locator(`${CARD} video`);
  const box = (await video.boundingBox())!;
  const start = { x: box.x + box.width * from.x, y: box.y + box.height * from.y };
  const end = { x: box.x + box.width * to.x, y: box.y + box.height * to.y };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  const steps = 12;
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(
      start.x + ((end.x - start.x) * i) / steps,
      start.y + ((end.y - start.y) * i) / steps
    );
  }
  await page.mouse.up();
}

base('two participants draw on a live shared screen', async ({ page, browser, serverURL }) => {
  test.skip(!LIVE, 'manual test: set ANNOTATION_LIVE=1 with livekit-server --dev on :7880');
  test.setTimeout(180_000);
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(`A: ${message.text()}`);
  });

  // --- User A: create account, enter room, start the call, share screen.
  await page.addInitScript(FAKE_SCREEN_INIT);
  await loginAndEnterRoom(page, 'general', { displayName: 'Annie Drawer' });
  await openCallTab(page);
  await page.getByTestId('call-join-button').click();
  await expect(page.getByTestId('call-controls-bar')).toBeVisible({
    timeout: TIMEOUTS.UI_STANDARD
  });
  await page.getByTestId('call-screen-share-toggle').click();
  await expect(page.locator('[data-testid="call-screen-share-card"] video')).toBeVisible({
    timeout: TIMEOUTS.UI_STANDARD
  });
  // Maximize the call pane so the shared screen gets the big stage layout.
  await page.getByLabel('Maximize call').click();
  await expect(page.locator(`${CARD} video`)).toBeVisible({ timeout: TIMEOUTS.UI_STANDARD });

  await withServerUser(
    browser,
    serverURL,
    async ({ page: pageB }) => {
      pageB.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(`B: ${message.text()}`);
      });

      // --- User B: join the same call, see A's shared screen on the big stage.
      await pageB.goto(page.url());
      await openCallTab(pageB);
      await pageB.getByTestId('call-join-button').click();
      await expect(pageB.getByTestId('call-controls-bar')).toBeVisible({
        timeout: TIMEOUTS.UI_STANDARD
      });
      await expect(pageB.locator('[data-testid="call-screen-share-card"] video')).toBeVisible({
        timeout: TIMEOUTS.UI_STANDARD
      });
      await pageB.getByLabel('Maximize call').click();
      await expect(pageB.locator(`${CARD} video`)).toBeVisible({ timeout: TIMEOUTS.UI_STANDARD });
      // Wait for actual video frames to arrive so the overlay has an intrinsic size.
      await expect
        .poll(
          () =>
            pageB.locator(`${CARD} video`).evaluate((el) => (el as HTMLVideoElement).videoWidth),
          { timeout: 30_000 }
        )
        .toBeGreaterThan(0);

      // --- A arms drawing and draws a pen stroke across the shared screen.
      await armDrawing(page);
      await drawStroke(page, { x: 0.3, y: 0.35 }, { x: 0.68, y: 0.62 });

      // The stroke must arrive on B's committed canvas as real pixels.
      await expect
        .poll(() => countPaintedPixels(pageB, 0), { timeout: 15_000 })
        .toBeGreaterThan(50);
      await page.screenshot({ path: `${SHOTS}/1-user-a-drew-pen-stroke.png` });
      await pageB.screenshot({ path: `${SHOTS}/2-user-b-sees-a-stroke.png` });

      // --- B draws back in a different color.
      await armDrawing(pageB);
      await pageB.locator(CARD).getByTestId('call-annotation-color').click();
      await pageB.getByTestId('call-annotation-color-3').click();
      await drawStroke(pageB, { x: 0.35, y: 0.65 }, { x: 0.62, y: 0.3 });

      await expect.poll(() => countPaintedPixels(page, 0), { timeout: 15_000 }).toBeGreaterThan(50);
      await pageB.screenshot({ path: `${SHOTS}/3-user-b-drew-back.png` });
      await page.screenshot({ path: `${SHOTS}/4-user-a-sees-both-strokes.png` });

      // --- A switches to the laser pointer and holds it over the screen.
      const cardA = page.locator(CARD);
      await cardA.hover();
      await cardA.getByTestId('call-annotation-laser').click();
      const boxA = (await page.locator(`${CARD} video`).boundingBox())!;
      await page.mouse.move(boxA.x + boxA.width * 0.5, boxA.y + boxA.height * 0.5);
      await page.mouse.down();
      // Wiggle so laser frames keep flowing while we assert on B.
      const wigglePromise = (async () => {
        for (let i = 0; i < 40; i += 1) {
          await page.mouse.move(
            boxA.x + boxA.width * (0.5 + 0.12 * Math.sin(i / 4)),
            boxA.y + boxA.height * (0.5 + 0.12 * Math.cos(i / 4))
          );
          await new Promise((r) => setTimeout(r, 50));
        }
      })();
      // The laser dot paints on B's LIVE canvas (index 1) while held.
      await expect
        .poll(() => countPaintedPixels(pageB, 1), { timeout: 10_000 })
        .toBeGreaterThan(20);
      await pageB.screenshot({ path: `${SHOTS}/5-user-b-sees-a-laser.png` });
      await wigglePromise;
      await page.mouse.up();

      // --- Sharer kill-switch: A turns off "let others draw"; B's surface disarms.
      await cardA.hover();
      await cardA.getByTestId('call-annotation-draw-together').click();
      await expect
        .poll(
          () =>
            pageB
              .locator(`${CARD} canvas`)
              .nth(1)
              .evaluate((el) => el.className.includes('pointer-events-none')),
          { timeout: 10_000 }
        )
        .toBe(true);
      await pageB.screenshot({ path: `${SHOTS}/6-user-b-draw-disabled-by-killswitch.png` });
    },
    { permissions: ['microphone', 'camera'], viewport: { width: 1600, height: 1000 } }
  );

  const fatalErrors = consoleErrors.filter(
    (line) => !line.includes('favicon') && !line.includes('manifest')
  );
  console.log(`console errors observed: ${fatalErrors.length}`);
  for (const line of fatalErrors.slice(0, 10)) console.log(line);
});
