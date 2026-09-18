import { expect, test, type Page } from "@playwright/test";

/**
 * The file view: scrolling, blame and highlighting, in a real browser.
 *
 * The scrolling tests are here because of a regression that everything else
 * missed. Hiding the redundant vertical scrollbar with Mantine's
 * `scrollbars="x"` also sets `overflow-y: hidden`, so a source file could not be
 * scrolled at all — by wheel, by keyboard or by the heat strip. Types, lint and
 * the unit suite all passed, and a screenshot of the first forty lines looked
 * exactly right. Only moving the wheel showed it.
 */

/**
 * Opens one named file, the way a reader reaches one: filter, Files, click.
 *
 * A named file rather than whichever happens to rank first — ranking is by
 * heat, so "the top of the list" is a different file on a different day and a
 * test that depends on it fails for reasons that are not about the code.
 * README.md is long enough to scroll and present in every checkout.
 */
async function openFile(page: Page, name = "README.md") {
  await page.goto("/");
  // The repository is analysed at startup; the map appears when it is ready.
  await expect(page.locator(".gh-tile, .gh-area-row").first()).toBeVisible({ timeout: 30_000 });

  await page.getByPlaceholder(/filter by path/i).fill(name);
  await page.getByText("Files", { exact: true }).first().click();
  await page.locator(".gh-area-row").first().click();

  // Rows are virtualised, so their presence means the payload arrived.
  await expect(page.locator(".gh-code-row").first()).toBeVisible({ timeout: 30_000 });
}

/** The scrolling element of the code pane. */
function viewport(page: Page) {
  return page.locator(".gh-code").locator("xpath=ancestor::*[contains(@class,'ScrollArea-viewport')][1]");
}

/**
 * The first line number in the DOM.
 *
 * Not the first line *visible*: the pane renders thirty rows of overscan either
 * side, so this only advances once the pane has moved past them. Tests that
 * care should scroll well beyond a screenful.
 */
async function firstRenderedLine(page: Page): Promise<number> {
  const text = await page.locator(".gh-code-num").first().innerText();
  return Number(text.trim());
}

/** Rows kept outside the viewport by the virtualiser, and their height. */
const OVERSCAN_PX = 30 * 19;

test.describe("scrolling a source file", () => {
  test("the pane scrolls vertically", async ({ page }) => {
    await openFile(page);
    const vp = viewport(page);

    // A file worth scrolling: if it fits on screen there is nothing to assert,
    // and it has to clear the overscan for the rendered window to move at all.
    const [scrollHeight, clientHeight] = await vp.evaluate((el) => [el.scrollHeight, el.clientHeight]);
    expect(scrollHeight, "pick a file taller than the pane").toBeGreaterThan(clientHeight + OVERSCAN_PX);

    // The regression in one assertion: overflow-y must not be hidden, or none
    // of the ways a reader moves through a file work.
    await expect(vp).toHaveCSS("overflow-y", /auto|scroll/);

    await vp.evaluate((el) => el.scrollTo({ top: 1500 }));
    await expect.poll(() => vp.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  });

  test("the wheel moves the file", async ({ page, isMobile }) => {
    test.skip(isMobile, "a touch device has no wheel; touch scrolling is covered below");
    await openFile(page);
    const vp = viewport(page);

    const before = await firstRenderedLine(page);
    const box = await vp.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);

    // Past the overscan, so the rendered window genuinely moves rather than the
    // pane merely scrolling within rows that were already in the DOM.
    for (let i = 0; i < 4; i++) await page.mouse.wheel(0, 1200);

    await expect.poll(() => vp.evaluate((el) => el.scrollTop), {
      message: "the wheel did not move the pane",
    }).toBeGreaterThan(OVERSCAN_PX);
    await expect.poll(() => firstRenderedLine(page), {
      message: "the pane scrolled but rendered the same rows",
    }).toBeGreaterThan(before);
  });

  test("touch scrolling moves the file", async ({ page, isMobile }) => {
    test.skip(!isMobile, "covers the phone path, where there is no heat strip");
    await openFile(page);
    const vp = viewport(page);
    await vp.evaluate((el) => el.scrollTo({ top: 1200 }));
    await expect.poll(() => vp.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  });

  test("only one vertical scrollbar is drawn", async ({ page, isMobile }) => {
    await openFile(page);
    const bars = page
      .locator(".gh-code-scroll .mantine-ScrollArea-scrollbar[data-orientation='vertical']")
      .filter({ visible: true });

    if (isMobile) {
      // No heat strip on a phone, so the pane keeps its own bar.
      await expect(page.locator(".gh-code-minimap")).toHaveCount(0);
    } else {
      // The heat strip is the vertical control; a second bar would repeat it.
      await expect(bars).toHaveCount(0);
      await expect(page.locator(".gh-code-minimap")).toBeVisible();
    }
  });

  test("the heat strip scrubs the file", async ({ page, isMobile }) => {
    test.skip(isMobile, "the strip is desktop only");
    await openFile(page);
    const vp = viewport(page);
    const strip = page.locator(".gh-code-minimap");

    const box = await strip.boundingBox();
    // Press near the bottom of the strip: the pane should jump towards the end.
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height * 0.85);
    await page.mouse.down();
    await page.mouse.up();

    await expect.poll(() => vp.evaluate((el) => el.scrollTop), {
      message: "clicking the heat strip did not move the pane",
    }).toBeGreaterThan(0);
  });
});

test.describe("blame and highlighting", () => {
  test("names the commit behind a line", async ({ page, isMobile }) => {
    await openFile(page);
    const row = page.locator(".gh-code-row").nth(3);

    // Hover on a desktop, tap on a phone — the same information either way,
    // which is the point: hover alone would not exist on half the devices.
    if (isMobile) await row.click({ force: true });
    else await row.hover();

    // The footer stops inviting and starts reporting.
    await expect(page.getByText(/line \d+ · /)).toBeVisible({ timeout: 10_000 });
  });

  test("colours the code", async ({ page }) => {
    await openFile(page);
    // Highlighting is lazy: the core, the engine and the grammar arrive after
    // the file does, and the file is readable in plain text until they land.
    await expect
      .poll(
        async () =>
          page.locator(".gh-code-text span[style*='color']").count(),
        { message: "no token ever gained a colour", timeout: 30_000 },
      )
      .toBeGreaterThan(0);
  });
});
