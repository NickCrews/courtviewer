/**
 * Content script for the Alaska Court Viewer Chrome extension.
 *
 * Runs on every page under records.courts.alaska.gov/eaccess/*.
 * Detects the current page type, reports readiness to the background service
 * worker, and executes scraping commands it receives back.
 *
 * IMPORTANT: This file MUST be self-contained with NO imports. Chrome
 * extension content scripts cannot use ES modules. All type definitions
 * needed are inlined below.
 */

(function () {
  // -----------------------------------------------------------------------
  // Inline type definitions (mirrors src/types.ts -- no imports allowed)
  // -----------------------------------------------------------------------

  type PageType = "welcome" | "search" | "results" | "unknown";

  interface ScraperReadyMessage {
    type: "SCRAPER_READY";
    pageType: PageType;
    url: string;
  }

  interface ScrapeResultMessage {
    type: "SCRAPE_RESULT";
    caseId: string;
    nextCourtDate: string | null;
    html: string;
  }

  interface ScrapeErrorMessage {
    type: "SCRAPE_ERROR";
    caseId: string;
    error: string;
  }

  interface ClickSearchCasesCommand {
    type: "CLICK_SEARCH_CASES";
  }

  interface FillAndSearchCommand {
    type: "FILL_AND_SEARCH";
    caseId: string;
  }

  interface ParseResultsCommand {
    type: "PARSE_RESULTS";
    caseId: string;
  }

  type BackgroundCommand =
    | ClickSearchCasesCommand
    | FillAndSearchCommand
    | ParseResultsCommand;

  interface BackgroundResponse {
    command: BackgroundCommand | null;
  }

  // -----------------------------------------------------------------------
  // Constants
  // -----------------------------------------------------------------------

  const PREFIX = "[CourtViewer]";

  /** Timeout for waiting for results after submitting the search form. */
  const RESULTS_TIMEOUT_MS = 30_000;

  /** Polling interval when waiting for results. */
  const POLL_INTERVAL_MS = 500;

  // -----------------------------------------------------------------------
  // Logging helpers
  // -----------------------------------------------------------------------

  function log(...args: unknown[]): void {
    console.log(PREFIX, ...args);
  }

  function warn(...args: unknown[]): void {
    console.warn(PREFIX, ...args);
  }

  // -----------------------------------------------------------------------
  // Page-type detection
  // -----------------------------------------------------------------------

  /**
   * Examine the DOM to determine which step of the court website we're on.
   *
   * Detection order matters: check "search" before "welcome" because the
   * search form page also has navigation links that might match welcome
   * heuristics.
   */
  function detectPageType(): PageType {
    // 1. Search form page: has the case number input field.
    if (document.querySelector('input[name="caseDscr"]')) {
      log("Detected page type: search");
      return "search";
    }

    // 2. Results page: look for result tables or case-detail content.
    if (hasResultsContent()) {
      log("Detected page type: results");
      return "results";
    }

    // 3. Welcome / landing page: a prominent "Search Cases" link or button.
    if (hasSearchCasesLink()) {
      log("Detected page type: welcome");
      return "welcome";
    }

    log("Detected page type: unknown");
    return "unknown";
  }

  /**
   * Returns true if there is a link or button whose visible text matches
   * "Search Cases" (case-insensitive).
   */
  function hasSearchCasesLink(): boolean {
    // Check anchor tags.
    const anchors = document.querySelectorAll("a");
    for (const a of anchors) {
      if (/search\s*cases/i.test(a.textContent || "")) {
        return true;
      }
      // Also match href patterns like "search.page".
      if (a.href && /search\.page/i.test(a.href)) {
        return true;
      }
    }

    // Check buttons and submit inputs.
    const buttons = document.querySelectorAll(
      'input[type="submit"], input[type="button"], button',
    );
    for (const btn of buttons) {
      const text =
        (btn as HTMLInputElement).value ||
        btn.textContent ||
        "";
      if (/search\s*cases/i.test(text)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Heuristically detect whether the current page contains search results
   * or case-detail information.
   */
  function hasResultsContent(): boolean {
    // Explicit result containers.
    if (document.querySelector(".searchResults, table.results")) {
      return true;
    }

    // A table inside #mainContent with multiple rows containing links is a
    // strong signal of a results listing.
    const mainContent = document.querySelector("#mainContent");
    if (mainContent) {
      const tables = mainContent.querySelectorAll("table");
      for (const table of tables) {
        const rowsWithLinks = table.querySelectorAll("tr a");
        if (rowsWithLinks.length >= 2) {
          return true;
        }
      }
    }

    // Case detail pages often have sections with headings about events /
    // hearings.
    const headings = document.querySelectorAll("h1, h2, h3, h4, h5, h6, .sectionHeader, legend");
    for (const h of headings) {
      if (/event|hearing|calendar|schedule|case\s*detail/i.test(h.textContent || "")) {
        return true;
      }
    }

    return false;
  }

  // -----------------------------------------------------------------------
  // Command handlers
  // -----------------------------------------------------------------------

  /**
   * Find and click the "Search Cases" link or button on the welcome page.
   */
  function handleClickSearchCases(): boolean {
    // Strategy 1: anchor whose text contains "Search Cases".
    const anchors = document.querySelectorAll("a");
    for (const a of anchors) {
      if (/search\s*cases/i.test(a.textContent || "")) {
        log("Clicking 'Search Cases' anchor:", a.href);
        a.click();
        return true;
      }
    }

    // Strategy 2: anchor with href matching search.page.
    for (const a of anchors) {
      if (a.href && /search\.page/i.test(a.href)) {
        log("Clicking anchor with search.page href:", a.href);
        a.click();
        return true;
      }
    }

    // Strategy 3: submit/button with value/text "Search Cases".
    const buttons = document.querySelectorAll(
      'input[type="submit"], input[type="button"], button',
    );
    for (const btn of buttons) {
      const text =
        (btn as HTMLInputElement).value ||
        btn.textContent ||
        "";
      if (/search\s*cases/i.test(text)) {
        log("Clicking 'Search Cases' button.");
        (btn as HTMLElement).click();
        return true;
      }
    }

    warn("Could not find 'Search Cases' link or button.");
    return false;
  }

  /**
   * Fill in the case number on the search form and submit it.
   * After submission, begin polling for results.
   */
  function handleFillAndSearch(caseId: string): boolean {
    const input = document.querySelector(
      'input[name="caseDscr"]',
    ) as HTMLInputElement | null;
    if (!input) {
      warn("Could not find case number input (name='caseDscr').");
      return false;
    }

    // Set the value and fire events so that Wicket's JS picks up the change.
    input.value = caseId;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    log(`Filled case number input with "${caseId}".`);

    // Locate the submit button.
    const submitBtn =
      (document.querySelector(
        'input[name="submitLink"][value="Search"]',
      ) as HTMLElement | null) ||
      (document.querySelector(
        'div.formButtons input[type="submit"]',
      ) as HTMLElement | null);

    if (!submitBtn) {
      warn("Could not find the search submit button.");
      return false;
    }

    log("Clicking search submit button.");
    submitBtn.click();

    // Start waiting for results to appear (AJAX or page navigation).
    waitForResults(caseId);
    return true;
  }

  /**
   * Parse the current page immediately for results.
   */
  function handleParseResults(caseId: string): void {
    parseResults(caseId);
  }

  // -----------------------------------------------------------------------
  // Results waiting & parsing
  // -----------------------------------------------------------------------

  /**
   * After form submission, poll the DOM until results, an error message,
   * or a timeout occurs. If the form submission triggers a full navigation,
   * a new instance of the content script will handle the new page instead.
   */
  function waitForResults(caseId: string): void {
    const startTime = Date.now();

    const intervalId = setInterval(() => {
      const elapsed = Date.now() - startTime;

      // Timeout guard.
      if (elapsed > RESULTS_TIMEOUT_MS) {
        clearInterval(intervalId);
        warn("Timed out waiting for results.");
        sendScrapeError(caseId, "Timed out waiting for results after form submission.");
        return;
      }

      // Check if the processing dialog is still visible (jQuery UI dialog).
      const processingDialog = document.querySelector(
        "#processingDialog",
      ) as HTMLElement | null;
      if (processingDialog) {
        const style = window.getComputedStyle(processingDialog);
        // If the dialog (or its parent) is still visible, keep waiting.
        const parent = processingDialog.closest(".ui-dialog") as HTMLElement | null;
        if (
          (style.display !== "none" && style.visibility !== "hidden") ||
          (parent &&
            window.getComputedStyle(parent).display !== "none")
        ) {
          return; // Still processing; continue polling.
        }
      }

      // Check for error feedback.
      const errorEl = document.querySelector(
        ".feedback .feedbackPanelERROR, .feedbackPanelERROR, .feedbackPanelWARNING",
      );
      if (errorEl) {
        clearInterval(intervalId);
        const errorText =
          errorEl.textContent?.trim() || "Unknown error from court site.";
        log("Error feedback detected:", errorText);
        sendScrapeError(caseId, errorText);
        return;
      }

      // Check if results content has appeared.
      if (hasResultsContent()) {
        clearInterval(intervalId);
        log("Results content detected after form submission.");
        parseResults(caseId);
        return;
      }

      // Check if the case number input is gone (page may have changed to
      // a results view within the same document).
      if (!document.querySelector('input[name="caseDscr"]') && hasResultsContent()) {
        clearInterval(intervalId);
        parseResults(caseId);
        return;
      }
    }, POLL_INTERVAL_MS);
  }

  /**
   * Parse the current page for case detail information and send the result
   * back to the background service worker.
   */
  function parseResults(caseId: string): void {
    try {
      // Check for error messages first.
      const errorEl = document.querySelector(
        ".feedback .feedbackPanelERROR, .feedbackPanelERROR, .feedbackPanelWARNING",
      );
      if (errorEl) {
        const errorText =
          errorEl.textContent?.trim() || "Unknown error from court site.";
        sendScrapeError(caseId, errorText);
        return;
      }

      // Attempt to detect whether we're on a results listing or a case
      // detail page. If on a listing, try to click through to the detail.
      const detailLink = findCaseDetailLink(caseId);
      if (detailLink) {
        // Clicking the detail link will cause navigation; the new page
        // will trigger a fresh content script instance that will detect
        // "results" (case detail) and send SCRAPER_READY again.
        log("Found case detail link; clicking through to detail page.");
        detailLink.click();
        return;
      }

      // We're either already on the detail page or there's only one result
      // and details are shown inline. Parse for the next court date.
      const nextCourtDate = findNextCourtDate();
      const html = captureHtml();

      log(`Parsed results: nextCourtDate=${nextCourtDate}`);

      sendScrapeResult(caseId, nextCourtDate, html);
    } catch (err) {
      warn("Error during parseResults:", err);
      sendScrapeError(
        caseId,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * On a results listing page, try to find a link that leads to the detail
   * page for the given case.
   *
   * Returns the anchor element if found, or null if we appear to already be
   * on a detail page (or if there's no identifiable detail link).
   */
  function findCaseDetailLink(caseId: string): HTMLAnchorElement | null {
    // Normalise the case ID for comparison (strip whitespace, lowercase).
    const normalisedCaseId = caseId.replace(/\s+/g, "").toLowerCase();

    const mainContent = document.querySelector("#mainContent");
    const searchRoot = mainContent || document.body;

    const links = searchRoot.querySelectorAll("a");
    for (const link of links) {
      const linkText = (link.textContent || "").replace(/\s+/g, "").toLowerCase();
      if (linkText.includes(normalisedCaseId)) {
        // Heuristic: if the link looks like it leads to a case detail, return it.
        // Avoid returning links that are just anchors on the current page or
        // unrelated navigational links.
        if (
          link.href &&
          link.href !== "#" &&
          !link.href.endsWith("#") &&
          link.closest("table, .searchResults, .results")
        ) {
          return link;
        }
      }
    }

    return null;
  }

  /**
   * Scan the page for court event/hearing dates and return the earliest
   * future date as an ISO string (YYYY-MM-DD), or null if none found.
   */
  function findNextCourtDate(): string | null {
    const now = new Date();
    // Reset to start of today for comparison.
    now.setHours(0, 0, 0, 0);

    const futureDates: Date[] = [];

    // Strategy 1: Look for tables that are near headings mentioning events,
    // hearings, calendar, or schedule.
    const headings = document.querySelectorAll(
      "h1, h2, h3, h4, h5, h6, .sectionHeader, legend, th, caption",
    );
    for (const heading of headings) {
      const text = heading.textContent || "";
      if (/event|hearing|calendar|schedule/i.test(text)) {
        // Find the nearest table relative to this heading.
        const table = findNearestTable(heading);
        if (table) {
          extractDatesFromTable(table, futureDates, now);
        }
      }
    }

    // Strategy 2: If strategy 1 found nothing, scan ALL tables in
    // #mainContent for date-like cells.
    if (futureDates.length === 0) {
      const mainContent = document.querySelector("#mainContent");
      const tables = (mainContent || document.body).querySelectorAll("table");
      for (const table of tables) {
        extractDatesFromTable(table, futureDates, now);
      }
    }

    // Strategy 3: Scan all text nodes for date patterns (last resort).
    if (futureDates.length === 0) {
      const mainContent = document.querySelector("#mainContent");
      const bodyText = (mainContent || document.body).textContent || "";
      const dateMatches = bodyText.match(
        /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g,
      );
      if (dateMatches) {
        for (const match of dateMatches) {
          const parsed = parseUSDate(match);
          if (parsed && parsed >= now) {
            futureDates.push(parsed);
          }
        }
      }
    }

    if (futureDates.length === 0) {
      log("No future court dates found on page.");
      return null;
    }

    // Sort ascending and return the earliest.
    futureDates.sort((a, b) => a.getTime() - b.getTime());
    return formatISODate(futureDates[0]);
  }

  /**
   * Walk upward / forward from a heading element to find the closest table.
   */
  function findNearestTable(el: Element): HTMLTableElement | null {
    // Check next siblings.
    let sibling = el.nextElementSibling;
    let depth = 0;
    while (sibling && depth < 5) {
      if (sibling.tagName === "TABLE") {
        return sibling as HTMLTableElement;
      }
      const nested = sibling.querySelector("table");
      if (nested) {
        return nested as HTMLTableElement;
      }
      sibling = sibling.nextElementSibling;
      depth++;
    }

    // Check parent container for a table.
    const parent = el.parentElement;
    if (parent) {
      const table = parent.querySelector("table");
      if (table) {
        return table as HTMLTableElement;
      }
    }

    return null;
  }

  /**
   * Extract date values from table cells and push any future dates onto
   * the array.
   */
  function extractDatesFromTable(
    table: HTMLTableElement,
    futureDates: Date[],
    now: Date,
  ): void {
    const cells = table.querySelectorAll("td, th");
    for (const cell of cells) {
      const text = (cell.textContent || "").trim();

      // Try MM/DD/YYYY or MM/DD/YY format.
      const slashMatch = text.match(/\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/);
      if (slashMatch) {
        const parsed = parseUSDate(slashMatch[1]);
        if (parsed && parsed >= now) {
          futureDates.push(parsed);
        }
        continue;
      }

      // Try "Month DD, YYYY" format (e.g. "January 15, 2025").
      const longMatch = text.match(
        /\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2},?\s+\d{4})\b/i,
      );
      if (longMatch) {
        const parsed = new Date(longMatch[1]);
        if (!isNaN(parsed.getTime()) && parsed >= now) {
          futureDates.push(parsed);
        }
        continue;
      }

      // Try YYYY-MM-DD (ISO format).
      const isoMatch = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
      if (isoMatch) {
        const parsed = new Date(isoMatch[1] + "T00:00:00");
        if (!isNaN(parsed.getTime()) && parsed >= now) {
          futureDates.push(parsed);
        }
      }
    }
  }

  /**
   * Parse a US-style date string (MM/DD/YYYY or MM/DD/YY).
   * Returns a Date object or null if parsing fails.
   */
  function parseUSDate(dateStr: string): Date | null {
    const parts = dateStr.split("/");
    if (parts.length !== 3) return null;

    const month = parseInt(parts[0], 10);
    const day = parseInt(parts[1], 10);
    let year = parseInt(parts[2], 10);

    if (isNaN(month) || isNaN(day) || isNaN(year)) return null;

    // Handle 2-digit years: 00-49 -> 2000-2049, 50-99 -> 1950-1999.
    if (year < 100) {
      year += year < 50 ? 2000 : 1900;
    }

    const date = new Date(year, month - 1, day);

    // Validate that the date components match (catches things like Feb 30).
    if (
      date.getFullYear() !== year ||
      date.getMonth() !== month - 1 ||
      date.getDate() !== day
    ) {
      return null;
    }

    return date;
  }

  /**
   * Format a Date as an ISO date string (YYYY-MM-DD).
   */
  function formatISODate(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  /**
   * Capture the relevant HTML from the current page for later preview.
   */
  function captureHtml(): string {
    const mainContent = document.querySelector("#mainContent");
    if (mainContent) {
      return mainContent.innerHTML;
    }
    // Fallback: the whole body, truncated to avoid excessive storage use.
    const bodyHtml = document.body.innerHTML;
    const MAX_HTML_LENGTH = 500_000;
    if (bodyHtml.length > MAX_HTML_LENGTH) {
      return bodyHtml.substring(0, MAX_HTML_LENGTH) + "\n<!-- truncated -->";
    }
    return bodyHtml;
  }

  // -----------------------------------------------------------------------
  // Messaging helpers
  // -----------------------------------------------------------------------

  function sendScrapeResult(
    caseId: string,
    nextCourtDate: string | null,
    html: string,
  ): void {
    const message: ScrapeResultMessage = {
      type: "SCRAPE_RESULT",
      caseId,
      nextCourtDate,
      html,
    };
    chrome.runtime.sendMessage(message).catch((err) => {
      warn("Failed to send SCRAPE_RESULT:", err);
    });
  }

  function sendScrapeError(caseId: string, error: string): void {
    const message: ScrapeErrorMessage = {
      type: "SCRAPE_ERROR",
      caseId,
      error,
    };
    chrome.runtime.sendMessage(message).catch((err) => {
      warn("Failed to send SCRAPE_ERROR:", err);
    });
  }

  // -----------------------------------------------------------------------
  // Command listener
  // -----------------------------------------------------------------------

  /**
   * Listen for commands from the background service worker.
   */
  chrome.runtime.onMessage.addListener(
    (
      message: BackgroundCommand,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response?: unknown) => void,
    ): boolean => {
      switch (message.type) {
        case "CLICK_SEARCH_CASES": {
          const success = handleClickSearchCases();
          sendResponse({ ok: success });
          return false;
        }

        case "FILL_AND_SEARCH": {
          const success = handleFillAndSearch(message.caseId);
          sendResponse({ ok: success });
          // handleFillAndSearch starts async polling internally.
          return false;
        }

        case "PARSE_RESULTS": {
          handleParseResults(message.caseId);
          sendResponse({ ok: true });
          return false;
        }

        default:
          // Unknown command; ignore.
          return false;
      }
    },
  );

  // -----------------------------------------------------------------------
  // Initialisation
  // -----------------------------------------------------------------------

  /**
   * On page load, detect the page type and notify the background worker.
   */
  function init(): void {
    const pageType = detectPageType();
    const url = window.location.href;

    log(`Page loaded: type=${pageType}, url=${url}`);

    const message: ScraperReadyMessage = {
      type: "SCRAPER_READY",
      pageType,
      url,
    };

    // Send the SCRAPER_READY message. The background will respond with a
    // command (or null if this tab is not part of a scrape job).
    chrome.runtime.sendMessage(message, (response: BackgroundResponse | undefined) => {
      if (chrome.runtime.lastError) {
        // This can happen when the extension context is invalidated or
        // if the background isn't ready yet. Not necessarily an error.
        log("No response to SCRAPER_READY (may not be a scrape tab):", chrome.runtime.lastError.message);
        return;
      }

      if (!response || !response.command) {
        log("No command received; this tab is not part of a scrape job.");
        return;
      }

      // Execute the command we received in the response.
      log("Received immediate command:", response.command.type);
      switch (response.command.type) {
        case "CLICK_SEARCH_CASES":
          handleClickSearchCases();
          break;
        case "FILL_AND_SEARCH":
          handleFillAndSearch(response.command.caseId);
          break;
        case "PARSE_RESULTS":
          handleParseResults(response.command.caseId);
          break;
      }
    });
  }

  // Run init once the DOM is ready.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
