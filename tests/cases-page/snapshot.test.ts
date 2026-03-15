import { chromium, expect, test } from "@playwright/test";
import fs from "fs/promises";
import path from "path";

type ExpectedScrapeData = {
    nextCourtDateTime: string | null;
    prosecutor: string | null;
    defendant: string | null;
    judge: string | null;
};

export type CasePageSnapshot = {
    name: string;
    filePath: string;
    caseId: string;
    now: string;
    expected: ExpectedScrapeData;
};

export const CASE_PAGE_SNAPSHOTS: CasePageSnapshot[] = [
    {
        name: "when the timeline is (event A with a result), (now), (event B with no result), we should detect B as the next court date",
        filePath: "case1.html",
        caseId: "3KO-25-00060CR",
        now: "2026-03-14T00:00:00",
        expected: {
            nextCourtDateTime: "2026-03-24T13:30:00",
            prosecutor: "State of Alaska",
            defendant: "Posey, Lisa Ann",
            judge: "Williams, Dawson A",
        },
    },
    {
        name: "when the timeline is (event A with a result), (now) [no other events], we should detect no next court date",
        filePath: "case1.html",
        caseId: "3KO-25-00060CR",
        now: "2027-03-14T00:00:00", // A year after all events
        expected: {
            nextCourtDateTime: null,
            prosecutor: "State of Alaska",
            defendant: "Posey, Lisa Ann",
            judge: "Williams, Dawson A",
        },
    },
    {
        name: "when the timeline is (event A with a result), (now), (event B with result), (event C with no result) we should detect C as the next court date",
        filePath: "case2.html",
        caseId: "3KO-25-00060CR",
        now: "2026-03-14T00:00:00",
        expected: {
            nextCourtDateTime: "2026-03-24T13:30:00",
            prosecutor: "State of Alaska",
            defendant: "Posey, Lisa Ann",
            judge: "Williams, Dawson A",
        },
    },
];

for (const snapshot of CASE_PAGE_SNAPSHOTS) {
    test(snapshot.name, async () => {
        const browser = await chromium.launch({ channel: "chromium" });
        const context = await browser.newContext();
        const page = await context.newPage();

        const htmlPath = path.resolve(__dirname, snapshot.filePath);
        const html = await fs.readFile(htmlPath, "utf8");
        await page.setContent(html, { waitUntil: "domcontentloaded" });

        const scraperPath = path.resolve(__dirname, "..", "..", "dist", "content", "scraper.js");
        await page.addScriptTag({ path: scraperPath });

        const result = await page.evaluate(async ({ caseId, now }) => {
            const api = (window as Window & {
                __COURTVIEWER_TEST_API__?: {
                    runScrapeStep: (
                        state: { caseId: string; state: "running" },
                        options?: { now?: string },
                    ) => Promise<unknown>;
                };
            }).__COURTVIEWER_TEST_API__;

            if (!api?.runScrapeStep) {
                throw new Error("Missing __COURTVIEWER_TEST_API__.runScrapeStep");
            }

            return api.runScrapeStep({ caseId, state: "running" }, { now });
        }, { caseId: snapshot.caseId, now: snapshot.now });

        expect(result).toEqual({
            caseId: snapshot.caseId,
            state: "succeeded",
            data: snapshot.expected,
        });

        await context.close();
        await browser.close();
    });
}