import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests for the things a type check cannot see.
 *
 * These exist because of a specific bug. Hiding the file view's redundant
 * vertical scrollbar with Mantine's `scrollbars="x"` also set `overflow-y:
 * hidden`, so source files could not be scrolled at all. Types passed, lint
 * passed, 110 unit tests passed, and the screenshot of the first forty lines
 * looked perfect. Only moving the wheel showed it.
 *
 * So the suite drives a real browser against a real instance. The instance
 * serves *this repository* rather than anything remote: no network, no clone, a
 * few dozen files, and a history that is always present in a checkout.
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: "http://127.0.0.1:8099",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    // Every UI change here has to work on a phone as well, and hover does not
    // exist there — so the same assertions run on both, and the ones that
    // differ say why. Pixel 5 rather than an iPhone because it is Chromium:
    // one browser to download in CI, and what is being tested is a viewport
    // and a touch input, not a rendering engine.
    { name: "mobile", use: { ...devices["Pixel 5"] } },
  ],
  webServer: {
    // Built binary and built frontend, serving the checkout it was built from.
    command:
      "../quanticode -addr :8099 -web dist -index=false -repo self=..",
    url: "http://127.0.0.1:8099/healthz",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
