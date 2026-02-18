import { test, expect, takeDebugScreenshot } from "./fixtures";

test.describe("Extension Integration", () => {
  test("should add and display a case", async ({ popupPage }) => {
    await popupPage.locator("#addCaseBtn").click();

    const modal = popupPage.locator("#caseModal");
    await expect(modal).toBeVisible();

    const modalTitle = await popupPage.locator("#modalTitle").innerText();
    expect(modalTitle).toBe("Add Case");

    const bogusCaseId = "3AN-24-09999CR";
    const testDefendantName = "Doe, Jane";

    await popupPage.locator("#caseIdInput").fill(bogusCaseId);
    await popupPage.locator("#defendantNameInput").fill(testDefendantName);
    await popupPage.locator("#notesInput").fill("Test case added by Playwright");

    await takeDebugScreenshot(popupPage, "06-add-case-filled");

    await popupPage.locator("#saveBtn").click();
    await expect(modal).toBeHidden({ timeout: 5_000 });

    const tableBody = popupPage.locator("#casesBody");
    const rows = tableBody.locator("tr");
    await expect(rows.first()).toBeAttached({ timeout: 5_000 });

    const rowCount = await rows.count();
    expect(rowCount).toEqual(1);

    const tableHtml = await tableBody.innerHTML();
    expect(tableHtml).toContain(bogusCaseId);
    expect(tableHtml).toContain(testDefendantName);
    // Should say that we haven't scraped yet
    expect(tableHtml).toContain("Never");

    await takeDebugScreenshot(popupPage, "06-add-case-result");
  });
});
