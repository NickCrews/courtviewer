import { test, expect, type Page, chromium } from "@playwright/test";
import * as path from "path";
import * as fs from "fs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COURT_URL =
  "https://records.courts.alaska.gov/eaccess/search.page.3";

/** Example case number for exploratory search tests. */
const EXAMPLE_CASE_NUMBER = "3AN-24-00001CR";

/** Generous timeout for court website operations (external site). */
const COURT_TIMEOUT = 30_000;

/** Path to the built extension directory. */
const EXTENSION_DIR = path.resolve(__dirname, "../dist");

// ---------------------------------------------------------------------------
// Helper Utilities
// ---------------------------------------------------------------------------

/**
 * Save a debug screenshot with a descriptive name into test-results/.
 * Safe to call at any point; failures are logged but never thrown.
 */
async function takeDebugScreenshot(page: Page, name: string): Promise<void> {
  const dir = path.resolve(__dirname, "../test-results");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const filePath = path.join(dir, `${name}-${Date.now()}.png`);
  try {
    await page.screenshot({ path: filePath, fullPage: true });
    console.log(`  [screenshot] saved: ${filePath}`);
  } catch (err) {
    console.warn(`  [screenshot] failed to save ${filePath}:`, err);
  }
}

/**
 * Log the current page state (URL, title, key elements) for debugging.
 */
async function logPageState(page: Page): Promise<void> {
  const url = page.url();
  const title = await page.title();
  console.log(`  [page-state] url   = ${url}`);
  console.log(`  [page-state] title = ${title}`);

  // Log whether common landmarks exist.
  const landmarks: Record<string, string> = {
    mainContent: "#mainContent",
    searchForm: 'input[name="caseDscr"]',
    searchCasesLink: 'a:has-text("Search Cases")',
    resultsTable: "table.results, table.gridview, #caseSearchResults",
  };
  for (const [label, selector] of Object.entries(landmarks)) {
    const count = await page.locator(selector).count();
    console.log(`  [page-state] ${label} (${selector}): ${count} match(es)`);
  }
}

/**
 * Navigate from the court URL all the way to the search form.
 *
 * The Alaska courts site performs browser fingerprinting and one or more
 * redirects before landing on a welcome page with a "Search Cases" link.
 * This helper handles the full sequence, retrying if necessary.
 */
async function navigateToSearchForm(page: Page): Promise<void> {
  console.log("  [nav] Loading court URL...");
  await page.goto(COURT_URL, {
    waitUntil: "domcontentloaded",
    timeout: COURT_TIMEOUT,
  });

  // Wait for any fingerprinting / auto-redirect to settle.
  try {
    await page.waitForLoadState("networkidle", { timeout: COURT_TIMEOUT });
  } catch {
    console.log("  [nav] networkidle timed out; continuing anyway");
  }

  await logPageState(page);

  // Check if we already landed on the search form (some sessions skip the
  // welcome page).
  const searchInput = page.locator('input[name="caseDscr"]');
  if ((await searchInput.count()) > 0) {
    console.log("  [nav] Already on search form; skipping welcome page step.");
    return;
  }

  // Try several selectors for the "Search Cases" link/button.
  const searchCasesSelectors = [
    'a:has-text("Search Cases")',
    'a:has-text("SEARCH CASES")',
    'button:has-text("Search Cases")',
    'a[href*="search.page"]',
    'a.menu-item:has-text("Search")',
    '#leftMenu a:has-text("Search")',
    'a:has-text("Case Search")',
  ];

  let clicked = false;
  for (const selector of searchCasesSelectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0) {
      console.log(`  [nav] Found "Search Cases" via: ${selector}`);
      await locator.click({ timeout: COURT_TIMEOUT });
      clicked = true;
      break;
    }
  }

  if (!clicked) {
    // Last resort: look for any link whose text contains "search" (case-insensitive).
    const fallback = page.locator("a").filter({ hasText: /search/i }).first();
    if ((await fallback.count()) > 0) {
      console.log('  [nav] Clicking fallback link matching /search/i');
      await fallback.click({ timeout: COURT_TIMEOUT });
      clicked = true;
    }
  }

  if (!clicked) {
    await takeDebugScreenshot(page, "nav-no-search-link");
    throw new Error(
      "Could not find a 'Search Cases' link or button on the welcome page."
    );
  }

  // Wait for the search form page to load.
  try {
    await page.waitForLoadState("networkidle", { timeout: COURT_TIMEOUT });
  } catch {
    console.log("  [nav] networkidle after click timed out; continuing");
  }

  // Verify the search form appeared.
  await page.waitForSelector('input[name="caseDscr"]', {
    state: "attached",
    timeout: COURT_TIMEOUT,
  });

  console.log("  [nav] Search form loaded successfully.");
}

// ===========================================================================
// Test Group 1: Court Website Navigation
// ===========================================================================

test.describe.serial("Court Website Navigation", () => {
  /**
   * Shared page instance for this serial group.  Each test picks up where
   * the previous one left off (i.e. it reuses the browser state).
   */
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });

  test.afterAll(async () => {
    await page?.close();
  });

  // -----------------------------------------------------------------------

  test("should load the initial page and auto-redirect through fingerprinting", async () => {
    test.setTimeout(COURT_TIMEOUT * 2);
    console.log("[test] Navigating to court URL...");

    try {
      await page.goto(COURT_URL, {
        waitUntil: "domcontentloaded",
        timeout: COURT_TIMEOUT,
      });

      // Allow fingerprinting redirects to settle.
      try {
        await page.waitForLoadState("networkidle", { timeout: COURT_TIMEOUT });
      } catch {
        console.log("[test] networkidle timed out after initial load; continuing");
      }

      const finalUrl = page.url();
      const title = await page.title();
      console.log(`[test] Final URL : ${finalUrl}`);
      console.log(`[test] Page title: ${title}`);

      // We should have ended up on *some* page (welcome or search).
      expect(finalUrl).toBeTruthy();
      expect(title).toBeTruthy();

      await takeDebugScreenshot(page, "01-initial-load");
    } catch (err) {
      await takeDebugScreenshot(page, "01-initial-load-error");
      console.error("[test] Court website may be down or blocking:", err);
      throw err;
    }
  });

  // -----------------------------------------------------------------------

  test("should find and click Search Cases on welcome page", async () => {
    test.setTimeout(COURT_TIMEOUT * 2);
    console.log("[test] Looking for Search Cases link/button...");

    try {
      await logPageState(page);

      // If the page already has the search form, we're done (some sessions
      // skip the welcome page entirely).
      const alreadyOnSearch = await page.locator('input[name="caseDscr"]').count();
      if (alreadyOnSearch > 0) {
        console.log("[test] Already on search form; test passes trivially.");
        await takeDebugScreenshot(page, "02-already-on-search");
        return;
      }

      // Try selectors for the "Search Cases" link/button.
      const searchCasesSelectors = [
        'a:has-text("Search Cases")',
        'a:has-text("SEARCH CASES")',
        'button:has-text("Search Cases")',
        'a[href*="search.page"]',
        'a.menu-item:has-text("Search")',
        '#leftMenu a:has-text("Search")',
        'a:has-text("Case Search")',
      ];

      let clicked = false;
      for (const selector of searchCasesSelectors) {
        const locator = page.locator(selector).first();
        if ((await locator.count()) > 0) {
          console.log(`[test] Found element via: ${selector}`);
          await locator.click({ timeout: COURT_TIMEOUT });
          clicked = true;
          break;
        }
      }

      if (!clicked) {
        // Fallback: any anchor containing "search".
        const fallback = page.locator("a").filter({ hasText: /search/i }).first();
        if ((await fallback.count()) > 0) {
          console.log("[test] Clicking fallback /search/i link");
          await fallback.click({ timeout: COURT_TIMEOUT });
          clicked = true;
        }
      }

      if (!clicked) {
        await takeDebugScreenshot(page, "02-no-search-link");
        // Log all visible links so a developer can debug.
        const links = await page.locator("a").evaluateAll((els) =>
          els.map((a) => ({
            text: a.textContent?.trim().substring(0, 80),
            href: a.getAttribute("href"),
          }))
        );
        console.log("[test] All links on page:", JSON.stringify(links, null, 2));
        throw new Error(
          "Could not find a 'Search Cases' link or button on the welcome page."
        );
      }

      // Wait for the search form.
      try {
        await page.waitForLoadState("networkidle", { timeout: COURT_TIMEOUT });
      } catch {
        console.log("[test] networkidle after click timed out; continuing");
      }

      await page.waitForSelector('input[name="caseDscr"]', {
        state: "attached",
        timeout: COURT_TIMEOUT,
      });

      console.log("[test] Search form loaded.");
      const caseInput = page.locator('input[name="caseDscr"]');
      await expect(caseInput).toBeAttached();

      await takeDebugScreenshot(page, "02-search-form");
    } catch (err) {
      await takeDebugScreenshot(page, "02-search-cases-error");
      console.error("[test] Failed to navigate to search form:", err);
      throw err;
    }
  });

  // -----------------------------------------------------------------------

  test("should fill in case number and submit search", async () => {
    test.setTimeout(COURT_TIMEOUT * 2);
    console.log(`[test] Filling case number: ${EXAMPLE_CASE_NUMBER}`);

    try {
      // Make sure we're on the search form. If the serial sequence broke,
      // the input won't exist and we'll get a clear error.
      const caseInput = page.locator('input[name="caseDscr"]');
      await expect(caseInput).toBeAttached({ timeout: 5_000 });

      await caseInput.fill(EXAMPLE_CASE_NUMBER);
      console.log("[test] Case number filled.");

      // Find the submit button. Try several approaches.
      const submitSelectors = [
        'input[type="submit"]',
        'button[type="submit"]',
        'input[value="Search"]',
        'button:has-text("Search")',
        '#submitCase',
        'a:has-text("Search"):near(input[name="caseDscr"])',
      ];

      let submitted = false;
      for (const selector of submitSelectors) {
        const loc = page.locator(selector).first();
        if ((await loc.count()) > 0) {
          console.log(`[test] Clicking submit via: ${selector}`);
          await loc.click({ timeout: COURT_TIMEOUT });
          submitted = true;
          break;
        }
      }

      if (!submitted) {
        // Fallback: press Enter in the input.
        console.log("[test] No submit button found; pressing Enter.");
        await caseInput.press("Enter");
        submitted = true;
      }

      // Wait for some response.
      try {
        await page.waitForLoadState("networkidle", { timeout: COURT_TIMEOUT });
      } catch {
        console.log("[test] networkidle after submit timed out; continuing");
      }

      await takeDebugScreenshot(page, "03-search-results");

      // Log what we got back.
      const mainContent = page.locator("#mainContent, #content, main, body");
      const html = await mainContent.first().innerHTML().catch(() => "(could not read)");
      console.log(
        `[test] Response HTML (first 2000 chars):\n${html.substring(0, 2000)}`
      );

      // Classify the response.
      const bodyText = await page.innerText("body").catch(() => "");
      if (/no (cases|results|records) found/i.test(bodyText)) {
        console.log("[test] Response type: NO RESULTS FOUND");
      } else if (/error|exception|unavailable/i.test(bodyText)) {
        console.log("[test] Response type: ERROR / UNAVAILABLE");
      } else if (
        (await page.locator("table.results, table.gridview, #caseSearchResults").count()) > 0
      ) {
        console.log("[test] Response type: RESULTS TABLE FOUND");
      } else {
        console.log("[test] Response type: UNKNOWN (see screenshot)");
      }

      // This test is exploratory; it should not fail on "no results".
      // We only fail if the page appears completely broken.
    } catch (err) {
      await takeDebugScreenshot(page, "03-search-error");
      console.error("[test] Search submission failed:", err);
      throw err;
    }
  });

  // -----------------------------------------------------------------------

  test("should identify page elements for scraping", async () => {
    test.setTimeout(COURT_TIMEOUT * 2);
    console.log("[test] Diagnosing page elements for scraping...");

    // Navigate fresh so we can inspect the search form in a clean state.
    const diagPage = await page.context().newPage();
    try {
      await navigateToSearchForm(diagPage);

      // Enumerate all form elements.
      const formElements = await diagPage.evaluate(() => {
        const els = document.querySelectorAll("input, select, textarea, button");
        return Array.from(els).map((el) => ({
          tag: el.tagName.toLowerCase(),
          type: (el as HTMLInputElement).type || null,
          name: (el as HTMLInputElement).name || null,
          id: el.id || null,
          value: (el as HTMLInputElement).value?.substring(0, 50) || null,
          placeholder: (el as HTMLInputElement).placeholder || null,
          className: el.className?.substring(0, 80) || null,
        }));
      });
      console.log(
        "[test] Form elements found:\n" +
          JSON.stringify(formElements, null, 2)
      );

      // Enumerate all tables.
      const tables = await diagPage.evaluate(() => {
        const tbls = document.querySelectorAll("table");
        return Array.from(tbls).map((tbl, idx) => ({
          index: idx,
          id: tbl.id || null,
          className: tbl.className?.substring(0, 80) || null,
          rows: tbl.rows.length,
          headers: Array.from(tbl.querySelectorAll("th")).map(
            (th) => th.textContent?.trim().substring(0, 40)
          ),
        }));
      });
      console.log(
        "[test] Table structures found:\n" +
          JSON.stringify(tables, null, 2)
      );

      // Enumerate links in any navigation/sidebar.
      const navLinks = await diagPage.evaluate(() => {
        const links = document.querySelectorAll(
          "nav a, #leftMenu a, .menu a, .sidebar a"
        );
        return Array.from(links).map((a) => ({
          text: a.textContent?.trim().substring(0, 60),
          href: a.getAttribute("href"),
        }));
      });
      console.log(
        "[test] Navigation/sidebar links:\n" +
          JSON.stringify(navLinks, null, 2)
      );

      await takeDebugScreenshot(diagPage, "04-page-elements");
    } catch (err) {
      await takeDebugScreenshot(diagPage, "04-page-elements-error");
      console.error("[test] Diagnostic failed:", err);
      throw err;
    } finally {
      await diagPage.close();
    }
  });
});

// ===========================================================================
// Test Group 2: Extension Integration
// ===========================================================================

test.describe("Extension Integration", () => {
  // Skip the entire group if the dist/ directory doesn't exist.
  const extensionExists = fs.existsSync(EXTENSION_DIR);
  if (!extensionExists) {
    test.skip(true, `Extension dist/ not found at ${EXTENSION_DIR}. Run "npm run build" first.`);
  }

  // -----------------------------------------------------------------------

  test("should load extension popup", async () => {
    test.skip(
      !fs.existsSync(EXTENSION_DIR),
      `Skipping: dist/ directory not found at ${EXTENSION_DIR}`
    );
    test.setTimeout(COURT_TIMEOUT * 2);

    console.log("[test] Launching browser with extension...");

    const context = await chromium.launchPersistentContext("", {
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_DIR}`,
        `--load-extension=${EXTENSION_DIR}`,
        "--no-first-run",
        "--disable-gpu",
      ],
    });

    try {
      // The extension's service worker URL reveals the extension ID.
      // Wait briefly for the service worker to register.
      let extensionId: string | undefined;

      // In Manifest V3, service workers are registered as background scripts.
      // We can find them via the service workers API or by inspecting
      // chrome-extension:// pages.
      let retries = 10;
      while (retries-- > 0 && !extensionId) {
        // Look for a background/service-worker page.
        const workers = context.serviceWorkers();
        for (const worker of workers) {
          const url = worker.url();
          if (url.startsWith("chrome-extension://")) {
            extensionId = url.split("/")[2];
            console.log(`[test] Detected extension ID: ${extensionId}`);
            break;
          }
        }
        if (!extensionId) {
          await new Promise((r) => setTimeout(r, 500));
        }
      }

      if (!extensionId) {
        // Fallback: try opening a blank page and checking for extension pages.
        console.warn("[test] Could not detect extension ID from service workers.");
        console.warn("[test] Attempting fallback detection...");

        // List all open pages.
        for (const p of context.pages()) {
          console.log(`  [page] ${p.url()}`);
          if (p.url().startsWith("chrome-extension://")) {
            extensionId = p.url().split("/")[2];
            break;
          }
        }
      }

      expect(extensionId).toBeTruthy();
      console.log(`[test] Extension ID: ${extensionId}`);

      const popupUrl = `chrome-extension://${extensionId}/popup/popup.html`;
      console.log(`[test] Opening popup: ${popupUrl}`);

      const popupPage = await context.newPage();
      await popupPage.goto(popupUrl, { waitUntil: "domcontentloaded" });

      // Verify the popup loaded with the expected title.
      const title = await popupPage.title();
      console.log(`[test] Popup title: ${title}`);
      expect(title).toBe("Alaska Court Viewer");

      // Verify the header text.
      const h1Text = await popupPage.locator("h1").innerText();
      expect(h1Text).toBe("Alaska Court Viewer");

      // Verify the cases table structure.
      const casesTable = popupPage.locator("#casesTable");
      await expect(casesTable).toBeAttached();

      const headers = await popupPage
        .locator("#casesTable thead th")
        .allInnerTexts();
      console.log(`[test] Table headers: ${JSON.stringify(headers)}`);
      expect(headers.length).toBeGreaterThanOrEqual(4);

      // Verify the "Add Case" button exists.
      const addCaseBtn = popupPage.locator("#addCaseBtn");
      await expect(addCaseBtn).toBeVisible();
      const btnText = await addCaseBtn.innerText();
      expect(btnText).toContain("Add Case");

      await takeDebugScreenshot(popupPage, "05-extension-popup");
    } finally {
      await context.close();
    }
  });

  // -----------------------------------------------------------------------

  test("should add and display a case", async () => {
    test.skip(
      !fs.existsSync(EXTENSION_DIR),
      `Skipping: dist/ directory not found at ${EXTENSION_DIR}`
    );
    test.setTimeout(COURT_TIMEOUT * 2);

    console.log("[test] Launching browser with extension for add-case test...");

    const context = await chromium.launchPersistentContext("", {
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_DIR}`,
        `--load-extension=${EXTENSION_DIR}`,
        "--no-first-run",
        "--disable-gpu",
      ],
    });

    try {
      // Detect extension ID.
      let extensionId: string | undefined;
      let retries = 10;
      while (retries-- > 0 && !extensionId) {
        for (const worker of context.serviceWorkers()) {
          const url = worker.url();
          if (url.startsWith("chrome-extension://")) {
            extensionId = url.split("/")[2];
            break;
          }
        }
        if (!extensionId) {
          await new Promise((r) => setTimeout(r, 500));
        }
      }

      expect(extensionId).toBeTruthy();
      const popupUrl = `chrome-extension://${extensionId}/popup/popup.html`;

      const popupPage = await context.newPage();
      await popupPage.goto(popupUrl, { waitUntil: "domcontentloaded" });

      // Wait for the popup to fully initialize.
      await popupPage.waitForSelector("#addCaseBtn", { state: "visible" });

      // Step 1: Click "Add Case" to open the modal.
      console.log("[test] Clicking Add Case...");
      await popupPage.locator("#addCaseBtn").click();

      // The modal should become visible.
      const modal = popupPage.locator("#caseModal");
      await expect(modal).toBeVisible();

      // Verify the modal title says "Add Case".
      const modalTitle = await popupPage.locator("#modalTitle").innerText();
      expect(modalTitle).toBe("Add Case");

      // Step 2: Fill in the case number.
      const testCaseId = "3AN-24-09999CR";
      const testClientName = "Doe, Jane";
      console.log(`[test] Filling case: ${testCaseId}, client: ${testClientName}`);

      await popupPage.locator("#caseIdInput").fill(testCaseId);
      await popupPage.locator("#clientNameInput").fill(testClientName);
      await popupPage.locator("#notesInput").fill("Test case added by Playwright");

      await takeDebugScreenshot(popupPage, "06-add-case-filled");

      // Step 3: Click Save.
      console.log("[test] Clicking Save...");
      await popupPage.locator("#saveBtn").click();

      // The modal should close.
      await expect(modal).toBeHidden({ timeout: 5_000 });

      // Step 4: Verify the case appears in the table.
      const tableBody = popupPage.locator("#casesBody");
      const rows = tableBody.locator("tr");

      // Wait for at least one row to appear.
      await expect(rows.first()).toBeAttached({ timeout: 5_000 });

      const rowCount = await rows.count();
      console.log(`[test] Table rows after adding case: ${rowCount}`);
      expect(rowCount).toBeGreaterThanOrEqual(1);

      // Check that our case ID and client name appear in the table.
      const tableHtml = await tableBody.innerHTML();
      expect(tableHtml).toContain(testCaseId);
      expect(tableHtml).toContain(testClientName);

      console.log("[test] Case successfully added and displayed.");
      await takeDebugScreenshot(popupPage, "06-add-case-result");
    } finally {
      await context.close();
    }
  });
});

// ===========================================================================
// Test Group 3: HTML Parsing Validation
// ===========================================================================

test.describe("HTML Parsing Validation", () => {
  test("should parse dates from various formats", async ({ page }) => {
    console.log("[test] Testing date parsing from mock HTML...");

    // Build mock HTML that mimics court result tables containing dates in
    // several common formats.
    const mockHtml = `
      <!DOCTYPE html>
      <html>
      <body>
        <div id="mainContent">
          <h2>Case Details</h2>

          <!-- Format 1: MM/DD/YYYY -->
          <table id="eventsTable1" class="results">
            <thead><tr><th>Event Date</th><th>Event</th><th>Location</th></tr></thead>
            <tbody>
              <tr><td>01/15/2025</td><td>Hearing</td><td>Anchorage</td></tr>
              <tr><td>03/22/2025</td><td>Trial</td><td>Anchorage</td></tr>
            </tbody>
          </table>

          <!-- Format 2: Month DD, YYYY -->
          <table id="eventsTable2" class="court-events">
            <thead><tr><th>Date</th><th>Description</th></tr></thead>
            <tbody>
              <tr><td>January 15, 2025</td><td>Arraignment</td></tr>
              <tr><td>February 28, 2025</td><td>Status Hearing</td></tr>
              <tr><td>December 1, 2025</td><td>Sentencing</td></tr>
            </tbody>
          </table>

          <!-- Format 3: YYYY-MM-DD (ISO) -->
          <table id="eventsTable3">
            <thead><tr><th>Scheduled</th><th>Type</th></tr></thead>
            <tbody>
              <tr><td>2025-01-15</td><td>Motion Hearing</td></tr>
              <tr><td>2025-06-30</td><td>Pre-Trial Conference</td></tr>
            </tbody>
          </table>

          <!-- Inline dates in paragraphs (edge case) -->
          <p>Next hearing scheduled for 04/10/2025 at 9:00 AM.</p>
          <p>Continued to May 5, 2025.</p>
        </div>
      </body>
      </html>
    `;

    await page.setContent(mockHtml);

    // -----------------------------------------------------------------------
    // Extract dates using the same approach a scraper would use:
    // scan table cells and text for date patterns.
    // -----------------------------------------------------------------------
    const extractedDates = await page.evaluate(() => {
      const datePatterns = [
        // MM/DD/YYYY
        /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g,
        // Month DD, YYYY
        /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b/g,
        // YYYY-MM-DD
        /\b(\d{4})-(\d{2})-(\d{2})\b/g,
      ];

      const monthMap: Record<string, string> = {
        January: "01",
        February: "02",
        March: "03",
        April: "04",
        May: "05",
        June: "06",
        July: "07",
        August: "08",
        September: "09",
        October: "10",
        November: "11",
        December: "12",
      };

      const dates: { raw: string; iso: string; source: string }[] = [];
      const seen = new Set<string>();

      function normalizeToIso(raw: string): string | null {
        // MM/DD/YYYY
        let m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (m) {
          return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
        }
        // Month DD, YYYY
        m = raw.match(
          /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})$/
        );
        if (m) {
          return `${m[3]}-${monthMap[m[1]]}-${m[2].padStart(2, "0")}`;
        }
        // YYYY-MM-DD
        m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (m) {
          return raw;
        }
        return null;
      }

      // Scan all table cells.
      const cells = document.querySelectorAll("td");
      for (const cell of cells) {
        const text = cell.textContent?.trim() || "";
        for (const pattern of datePatterns) {
          pattern.lastIndex = 0;
          let match: RegExpExecArray | null;
          while ((match = pattern.exec(text)) !== null) {
            const raw = match[0];
            const iso = normalizeToIso(raw);
            if (iso && !seen.has(iso)) {
              seen.add(iso);
              dates.push({ raw, iso, source: "table-cell" });
            }
          }
        }
      }

      // Scan paragraphs for inline dates.
      const paragraphs = document.querySelectorAll("p");
      for (const p of paragraphs) {
        const text = p.textContent || "";
        for (const pattern of datePatterns) {
          pattern.lastIndex = 0;
          let match: RegExpExecArray | null;
          while ((match = pattern.exec(text)) !== null) {
            const raw = match[0];
            const iso = normalizeToIso(raw);
            if (iso && !seen.has(iso)) {
              seen.add(iso);
              dates.push({ raw, iso, source: "paragraph" });
            }
          }
        }
      }

      return dates;
    });

    console.log(
      "[test] Extracted dates:\n" +
        JSON.stringify(extractedDates, null, 2)
    );

    // -----------------------------------------------------------------------
    // Assertions
    // -----------------------------------------------------------------------

    // We should have found dates from all three table formats plus the
    // inline paragraph dates.
    expect(extractedDates.length).toBeGreaterThanOrEqual(7);

    // Verify specific expected dates (ISO normalized).
    const isoSet = new Set(extractedDates.map((d) => d.iso));

    // From table 1 (MM/DD/YYYY)
    expect(isoSet.has("2025-01-15")).toBe(true);
    expect(isoSet.has("2025-03-22")).toBe(true);

    // From table 2 (Month DD, YYYY)
    expect(isoSet.has("2025-02-28")).toBe(true);
    expect(isoSet.has("2025-12-01")).toBe(true);

    // From table 3 (YYYY-MM-DD)
    expect(isoSet.has("2025-06-30")).toBe(true);

    // From paragraphs
    expect(isoSet.has("2025-04-10")).toBe(true);
    expect(isoSet.has("2025-05-05")).toBe(true);

    // Verify source attribution.
    const tableDates = extractedDates.filter((d) => d.source === "table-cell");
    const paraDates = extractedDates.filter((d) => d.source === "paragraph");
    expect(tableDates.length).toBeGreaterThanOrEqual(5);
    expect(paraDates.length).toBeGreaterThanOrEqual(2);

    console.log("[test] All date parsing assertions passed.");
  });
});
