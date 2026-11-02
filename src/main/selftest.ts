import type { BrowserWindow } from 'electron';

/**
 * QB_SELFTEST=1: drives the pet window with synthetic mouse events and prints a JSON report
 * (click opens the panel, a drag moves the window), then exits. Used for headless checks.
 */
export async function selfTest(pet: BrowserWindow, panel: BrowserWindow, quit: (code: number) => void): Promise<void> {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const report: Record<string, unknown> = {};
  try {
    await wait(2500);
    const rect = await pet.webContents.executeJavaScript(
      `(() => { const r = document.querySelector('canvas.sprite').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    );
    const at = (dx = 0, dy = 0) => {
      const [wx, wy] = pet.getPosition();
      const x = Math.round(rect.x + dx);
      const y = Math.round(rect.y + dy);
      return { x, y, globalX: wx + x, globalY: wy + y };
    };
    const send = (type: 'mouseMove' | 'mouseDown' | 'mouseUp', p: ReturnType<typeof at>) =>
      pet.webContents.sendInputEvent({ type, ...p, button: 'left', clickCount: 1 } as Electron.MouseInputEvent);

    // click -> panel opens
    send('mouseMove', at());
    send('mouseDown', at());
    await wait(60);
    send('mouseUp', at());
    await wait(700);
    report.clickOpensPanel = panel.isVisible();
    panel.hide();
    await wait(400);

    // drag -> window follows the pointer, panel stays closed
    const before = pet.getPosition();
    const start = at();
    send('mouseDown', start);
    for (let i = 1; i <= 6; i++) {
      // the window moves under the pointer, so keep the pointer at the same spot in window coords
      send('mouseMove', { ...start, globalX: start.globalX + i * 8, globalY: start.globalY + i * 4 });
      await wait(40);
    }
    send('mouseUp', { ...start, globalX: start.globalX + 48, globalY: start.globalY + 24 });
    await wait(500);
    const after = pet.getPosition();
    report.dragDelta = [after[0] - before[0], after[1] - before[1]];
    report.dragDidNotOpenPanel = !panel.isVisible();
    report.ok = report.clickOpensPanel === true && report.dragDidNotOpenPanel === true && after[0] - before[0] === 48 && after[1] - before[1] === 24;
  } catch (e) {
    report.error = String(e);
    report.ok = false;
  }
  console.log(`SELFTEST ${JSON.stringify(report)}`);
  quit(report.ok ? 0 : 1);
}
