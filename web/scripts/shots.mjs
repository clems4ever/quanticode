// Screenshots of the running app at a desktop and a phone viewport.
//
// This exists because "works on mobile" is not something you can tell from a
// type check. Every UI change here has to be looked at on both, and this makes
// looking cheap: `npm run shots` against a running instance drops a handful of
// PNGs in /tmp and reports any console error it saw on the way.
//
//   go run ./cmd/quanticode -addr :8099 -web web/dist -cache /tmp/qc-cache
//   cd web && npm run shots -- http://127.0.0.1:8099/github.com/gin-gonic/gin
//
// It is not a test and it asserts nothing about pixels: screenshot assertions
// on a heat map whose colours depend on the current date would fail every day
// for no reason. It puts the two viewports in front of a human (or an agent
// that can read images), and it fails loudly on a console error, which is the
// part a person genuinely cannot be trusted to notice.

import { chromium, devices } from "playwright";
import { mkdirSync } from "node:fs";

const url = process.argv[2] ?? "http://127.0.0.1:8099/";
const outDir = process.argv[3] ?? "/tmp/quanticode-shots";
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
let failed = false;

async function shot(name, contextOptions, steps = async () => {}) {
  const ctx = await browser.newContext(contextOptions);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  await page.goto(url, { waitUntil: "networkidle" });
  // The repo payload arrives before the first paint of the map; give the
  // treemap and the calibration a moment to settle.
  await page.waitForTimeout(2500);
  try {
    await steps(page);
  } catch (e) {
    console.log(`  ${name}: step failed — ${String(e).split("\n")[0]}`);
  }
  await page.screenshot({ path: `${outDir}/${name}.png` });

  if (errors.length > 0) {
    failed = true;
    console.log(`  ${name}: ${errors.length} console error(s)`);
    for (const e of errors.slice(0, 3)) console.log(`      ${e}`);
  } else {
    console.log(`  ${name}: clean -> ${outDir}/${name}.png`);
  }
  await ctx.close();
}

/** Opens the first file in the Files ranking, which is how a reader gets there. */
async function openFirstFile(page) {
  await page.getByText("Files", { exact: true }).first().click();
  await page.waitForTimeout(1000);
  await page.locator(".gh-area-row").first().click();
  // Highlighting loads after the file; wait for the grammar chunk too.
  await page.waitForTimeout(4500);
}

const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = devices["iPhone 13"];

console.log(`shots of ${url}`);

await shot("desktop-map", DESKTOP, async (page) => {
  await page.mouse.move(700, 520); // raise the treemap hover card
  await page.waitForTimeout(700);
});
await shot("desktop-file", DESKTOP, async (page) => {
  await openFirstFile(page);
  const row = await page.locator(".gh-code-row").nth(14).boundingBox().catch(() => null);
  if (row) {
    await page.mouse.move(row.x + 200, row.y + 5);
    await page.waitForTimeout(700);
  }
});
await shot("desktop-light", { ...DESKTOP, colorScheme: "light" });

await shot("mobile-map", PHONE);
await shot("mobile-areas", PHONE, async (page) => {
  await page.getByText("Areas", { exact: true }).first().click();
  await page.waitForTimeout(1000);
});
await shot("mobile-file", PHONE, async (page) => {
  await openFirstFile(page);
  await page.locator(".gh-code-row").nth(8).click({ force: true }).catch(() => {});
  await page.waitForTimeout(700);
});

await browser.close();

if (failed) {
  console.error("\nconsole errors were reported above");
  process.exit(1);
}
console.log("\nno console errors on either viewport");
