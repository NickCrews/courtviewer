/**
 * From https://playwright.dev/docs/chrome-extensions
 */

import { test as base, chromium, type BrowserContext, type Page } from '@playwright/test';
import path from 'path';
import * as fs from "fs";

const EXTENSION_DIR = path.resolve(__dirname, "../dist");

export const test = base.extend<{
    context: BrowserContext;
    extensionId: string;
    popupPage: Page;
}>({
    context: async ({ }, use) => {
        const context = await chromium.launchPersistentContext('', {
            channel: 'chromium',
            args: [
                `--disable-extensions-except=${EXTENSION_DIR}`,
                `--load-extension=${EXTENSION_DIR}`,
            ],
        });
        await use(context);
        await context.close();
    },
    extensionId: async ({ context }, use) => {
        // for manifest v3:
        let [serviceWorker] = context.serviceWorkers();
        if (!serviceWorker)
            serviceWorker = await context.waitForEvent('serviceworker');

        const extensionId = serviceWorker.url().split('/')[2];
        await use(extensionId);
    },
    popupPage: async ({ context, extensionId }, use) => {
        const popupUrl = `chrome-extension://${extensionId}/popup/popup.html`;
        const page = await context.newPage();
        await page.goto(popupUrl, { waitUntil: "domcontentloaded" });
        await use(page);
    },
});
export const expect = test.expect;


/**
 * Save a debug screenshot with a descriptive name into test-results/.
 * Safe to call at any point; failures are logged but never thrown.
 */
export async function takeDebugScreenshot(page: Page, name: string): Promise<void> {
    const dir = path.resolve(__dirname, "../test-results");
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const filePath = path.join(dir, `${name}-${Date.now()}.png`);
    try {
        await page.screenshot({ path: filePath, fullPage: true });
        console.debug(`  [screenshot] saved: ${filePath}`);
    } catch (err) {
        console.warn(`  [screenshot] failed to save ${filePath}:`, err);
    }
}