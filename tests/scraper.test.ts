import { test, expect, takeDebugScreenshot } from "./fixtures";

test.describe("Extension Integration", () => {
  test("should add and display a case", async ({ extensionId, page: popupPage }) => {
    const popupUrl = `chrome-extension://${extensionId}/popup/popup.html`;
    await popupPage.goto(popupUrl, { waitUntil: "domcontentloaded" });
    await popupPage.waitForSelector("#addCaseBtn", { state: "visible" });

    console.log("[test] Clicking Add Case...");
    await popupPage.locator("#addCaseBtn").click();

    const modal = popupPage.locator("#caseModal");
    await expect(modal).toBeVisible();

    const modalTitle = await popupPage.locator("#modalTitle").innerText();
    expect(modalTitle).toBe("Add Case");

    const testCaseId = "3AN-24-09999CR";
    const testDefendantName = "Doe, Jane";
    console.log(`[test] Filling case: ${testCaseId}, defendant: ${testDefendantName}`);

    await popupPage.locator("#caseIdInput").fill(testCaseId);
    await popupPage.locator("#defendantNameInput").fill(testDefendantName);
    await popupPage.locator("#notesInput").fill("Test case added by Playwright");

    await takeDebugScreenshot(popupPage, "06-add-case-filled");

    console.log("[test] Clicking Save...");
    await popupPage.locator("#saveBtn").click();
    await expect(modal).toBeHidden({ timeout: 5_000 });

    const tableBody = popupPage.locator("#casesBody");
    const rows = tableBody.locator("tr");
    await expect(rows.first()).toBeAttached({ timeout: 5_000 });

    const rowCount = await rows.count();
    console.log(`[test] Table rows after adding case: ${rowCount}`);
    expect(rowCount).toBeGreaterThanOrEqual(1);

    const tableHtml = await tableBody.innerHTML();
    expect(tableHtml).toContain(testCaseId);
    expect(tableHtml).toContain(testDefendantName);

    console.log("[test] Case successfully added and displayed.");
    await takeDebugScreenshot(popupPage, "06-add-case-result");
  });
});
