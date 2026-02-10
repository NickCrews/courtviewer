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
    nextCourtDateTime: string | null;
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

  function debug(...args: unknown[]): void {
    console.debug(PREFIX, "[DEBUG]", ...args);
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
    debug("Starting page type detection");
    // 1. Search form page: has the case number input field.
    const caseInput = document.querySelector('input[name="caseDscr"]');
    debug(`Checking for case input field:`, caseInput ? "found" : "not found");
    if (caseInput) {
      log("Detected page type: search");
      return "search";
    }

    // 2. Results page: look for result tables or case-detail content.
    debug("Checking for results content");
    if (hasResultsContent()) {
      log("Detected page type: results");
      return "results";
    }

    // 3. Welcome / landing page: a prominent "Search Cases" link or button.
    debug("Checking for search cases link");
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
    const searchResults = document.querySelector(".searchResults, table.results");
    debug(`Checking explicit result containers:`, searchResults ? "found" : "not found");
    if (searchResults) {
      return true;
    }

    const mainContent = document.querySelector("#mainContent");
    debug(`mainContent element:`, mainContent ? "found" : "not found");
    if (mainContent) {
      const tables = mainContent.querySelectorAll("table");
      debug(`Tables in mainContent: ${tables.length}`);
      for (const table of tables) {
        const rowsWithLinks = table.querySelectorAll("tr a");
        if (rowsWithLinks.length >= 2) {
          debug(`Found table with ${rowsWithLinks.length} row links`);
          return true;
        }
      }
    }

    const headings = document.querySelectorAll("h1, h2, h3, h4, h5, h6, .sectionHeader, legend");
    debug(`Found ${headings.length} heading elements`);
    for (const h of headings) {
      if (/event|hearing|calendar|schedule|case\s*detail/i.test(h.textContent || "")) {
        debug(`Found results heading:`, h.textContent?.substring(0, 50));
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
    debug("Handling CLICK_SEARCH_CASES command");
    const anchors = document.querySelectorAll("a");
    debug(`Found ${anchors.length} anchor elements`);
    for (const a of anchors) {
      if (/search\s*cases/i.test(a.textContent || "")) {
        log("Clicking 'Search Cases' anchor:", a.href);
        a.click();
        return true;
      }
    }

    debug("Strategy 1 failed, trying anchor with search.page href");
    for (const a of anchors) {
      if (a.href && /search\.page/i.test(a.href)) {
        log("Clicking anchor with search.page href:", a.href);
        a.click();
        return true;
      }
    }

    debug("Strategy 2 failed, trying button with Search Cases text");
    const buttons = document.querySelectorAll(
      'input[type="submit"], input[type="button"], button',
    );
    debug(`Found ${buttons.length} button elements`);
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
    debug(`Handling FILL_AND_SEARCH command for case: ${caseId}`);
    const input = document.querySelector(
      'input[name="caseDscr"]',
    ) as HTMLInputElement | null;
    if (!input) {
      warn("Could not find case number input (name='caseDscr').");
      return false;
    }

    debug(`Found case input field, current value: "${input.value}"`);
    input.value = caseId;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    log(`Filled case number input with "${caseId}".`);

    debug("Looking for submit button");
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

    debug("Found submit button, clicking");
    log("Clicking search submit button.");
    submitBtn.click();

    debug("Starting to wait for results");
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
    debug(`Starting to wait for results, timeout: ${RESULTS_TIMEOUT_MS}ms, poll interval: ${POLL_INTERVAL_MS}ms`);

    const intervalId = setInterval(() => {
      const elapsed = Date.now() - startTime;
      debug(`Polling for results... elapsed: ${elapsed}ms`);

      if (elapsed > RESULTS_TIMEOUT_MS) {
        clearInterval(intervalId);
        warn("Timed out waiting for results.");
        sendScrapeError(caseId, "Timed out waiting for results after form submission.");
        return;
      }

      const processingDialog = document.querySelector(
        "#processingDialog",
      ) as HTMLElement | null;
      if (processingDialog) {
        const style = window.getComputedStyle(processingDialog);
        const parent = processingDialog.closest(".ui-dialog") as HTMLElement | null;
        if (
          (style.display !== "none" && style.visibility !== "hidden") ||
          (parent &&
            window.getComputedStyle(parent).display !== "none")
        ) {
          debug("Processing dialog still visible, continuing to wait");
          return;
        }
      }

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

      debug("Checking if results content has appeared");
      if (hasResultsContent()) {
        clearInterval(intervalId);
        log("Results content detected after form submission.");
        parseResults(caseId);
        return;
      }

      const caseInput = document.querySelector('input[name="caseDscr"]');
      debug(`Case input still present: ${!!caseInput}`);
      if (!caseInput && hasResultsContent()) {
        clearInterval(intervalId);
        debug("Page changed to results view");
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
    debug(`Parsing results for case: ${caseId}`);
    try {
      const errorEl = document.querySelector(
        ".feedback .feedbackPanelERROR, .feedbackPanelERROR, .feedbackPanelWARNING",
      );
      if (errorEl) {
        const errorText =
          errorEl.textContent?.trim() || "Unknown error from court site.";
        debug("Error element found:", errorText);
        sendScrapeError(caseId, errorText);
        return;
      }

      debug("Looking for case detail link");
      const detailLink = findCaseDetailLink(caseId);
      if (detailLink) {
        log("Found case detail link; clicking through to detail page.");
        debug("Detail link href:", detailLink.href);
        detailLink.click();
        return;
      }

      debug("No detail link found, parsing current page");
      const nextCourtDateTime = findNextCourtDateTime();
      const html = captureHtml();
      debug(`HTML captured: ${html.length} characters`);

      log(`Parsed results: nextCourtDateTime=${nextCourtDateTime}`);

      sendScrapeResult(caseId, nextCourtDateTime, html);
    } catch (err) {
      warn("Error during parseResults:", err);
      debug("Error stack:", err instanceof Error ? err.stack : "N/A");
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
    const normalisedCaseId = caseId.replace(/\s+/g, "").toLowerCase();
    debug(`Looking for detail link with normalised case ID: ${normalisedCaseId}`);

    const mainContent = document.querySelector("#mainContent");
    const searchRoot = mainContent || document.body;

    const links = searchRoot.querySelectorAll("a");
    debug(`Found ${links.length} links in search root`);
    for (const link of links) {
      const linkText = (link.textContent || "").replace(/\s+/g, "").toLowerCase();
      if (linkText.includes(normalisedCaseId)) {
        debug(`Found link with matching case ID text:`, linkText.substring(0, 50));
        if (
          link.href &&
          link.href !== "#" &&
          !link.href.endsWith("#") &&
          link.closest("table, .searchResults, .results")
        ) {
          debug(`Link passes heuristics, returning it`);
          return link;
        } else {
          debug(`Link failed heuristics check`);
        }
      }
    }

    debug("No matching detail link found");
    return null;
  }

  /**
   * Scan the page for court event/hearing dates and times, returning the
   * earliest future datetime as an ISO string (YYYY-MM-DDTHH:MM:SS), or
   * null if none found.
   */
  function findNextCourtDateTime(): string | null {
    debug("Starting search for next court date");
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    debug(`Today's date: ${formatISODate(now)}`);

    const futureDates: Date[] = [];

    const headings = document.querySelectorAll(
      "h1, h2, h3, h4, h5, h6, .sectionHeader, legend, th, caption",
    );
    debug(`Strategy 1: Found ${headings.length} heading elements`);
    for (const heading of headings) {
      const text = heading.textContent || "";
      if (/event|hearing|calendar|schedule/i.test(text)) {
        debug(`Found relevant heading:`, text.substring(0, 50));
        const table = findNearestTable(heading);
        if (table) {
          debug("Found table near heading");
          extractDatesFromTable(table, futureDates, now);
        }
      }
    }
    debug(`Strategy 1 found ${futureDates.length} future dates`);

    if (futureDates.length === 0) {
      debug("Strategy 2: Scanning all tables in mainContent");
      const mainContent = document.querySelector("#mainContent");
      const tables = (mainContent || document.body).querySelectorAll("table");
      debug(`Found ${tables.length} tables`);
      for (const table of tables) {
        extractDatesFromTable(table, futureDates, now);
      }
      debug(`Strategy 2 found ${futureDates.length} future dates`);
    }

    if (futureDates.length === 0) {
      debug("Strategy 3: Scanning all text for date patterns");
      const mainContent = document.querySelector("#mainContent");
      const bodyText = (mainContent || document.body).textContent || "";
      const dateMatches = bodyText.match(
        /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g,
      );
      debug(`Found ${dateMatches?.length || 0} date-like patterns`);
      if (dateMatches) {
        for (const match of dateMatches) {
          const parsed = parseUSDate(match);
          if (parsed && parsed >= now) {
            futureDates.push(parsed);
          }
        }
      }
      debug(`Strategy 3 found ${futureDates.length} future dates`);
    }

    if (futureDates.length === 0) {
      log("No future court dates found on page.");
      return null;
    }

    futureDates.sort((a, b) => a.getTime() - b.getTime());
    const earliest = formatISODateTime(futureDates[0]);
    debug(`Earliest future datetime: ${earliest}`);
    return earliest;
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

      // Try MM/DD/YYYY HH:MM AM/PM format first.
      const dateTimeMatch = text.match(/\b(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}:\d{2})\s*(AM|PM)\b/i);
      if (dateTimeMatch) {
        const parsed = parseUSDateTime(dateTimeMatch[1], dateTimeMatch[2], dateTimeMatch[3]);
        if (parsed && parsed >= now) {
          futureDates.push(parsed);
        }
        continue;
      }

      // Try MM/DD/YYYY or MM/DD/YY format without time.
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
   * Parse a US-style datetime string (MM/DD/YYYY HH:MM AM/PM).
   * Returns a Date object or null if parsing fails.
   */
  function parseUSDateTime(dateStr: string, timeStr: string, meridiem: string): Date | null {
    const parts = dateStr.split("/");
    if (parts.length !== 3) return null;

    const month = parseInt(parts[0], 10);
    const day = parseInt(parts[1], 10);
    let year = parseInt(parts[2], 10);

    if (isNaN(month) || isNaN(day) || isNaN(year)) return null;

    if (year < 100) {
      year += year < 50 ? 2000 : 1900;
    }

    const timeParts = timeStr.split(":");
    if (timeParts.length !== 2) return null;

    let hours = parseInt(timeParts[0], 10);
    const minutes = parseInt(timeParts[1], 10);

    if (isNaN(hours) || isNaN(minutes)) return null;

    if (meridiem.toUpperCase() === "PM" && hours !== 12) {
      hours += 12;
    } else if (meridiem.toUpperCase() === "AM" && hours === 12) {
      hours = 0;
    }

    const date = new Date(year, month - 1, day, hours, minutes, 0);

    if (
      date.getFullYear() !== year ||
      date.getMonth() !== month - 1 ||
      date.getDate() !== day ||
      date.getHours() !== hours ||
      date.getMinutes() !== minutes
    ) {
      return null;
    }

    return date;
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
   * Format a Date as an ISO datetime string without timezone (YYYY-MM-DDTHH:MM:SS).
   */
  function formatISODateTime(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    const h = String(date.getHours()).padStart(2, "0");
    const min = String(date.getMinutes()).padStart(2, "0");
    const s = String(date.getSeconds()).padStart(2, "0");
    return `${y}-${m}-${d}T${h}:${min}:${s}`;
  }

  /**
   * Capture the relevant HTML from the current page for later preview.
   */
  function captureHtml(): string {
    console.debug("Capturing HTML content of the page");
    console.log(document.documentElement);
    console.log(document.documentElement.outerHTML.substring(0, 500));
    const html = document.documentElement.outerHTML;
    const MAX_HTML_LENGTH = 500_000;
    if (html.length > MAX_HTML_LENGTH) {
      return html.substring(0, MAX_HTML_LENGTH) + "\n<!-- truncated -->";
    }
    return html;
  }

  // -----------------------------------------------------------------------
  // Messaging helpers
  // -----------------------------------------------------------------------

  function sendScrapeResult(
    caseId: string,
    nextCourtDateTime: string | null,
    html: string,
  ): void {
    const message: ScrapeResultMessage = {
      type: "SCRAPE_RESULT",
      caseId,
      nextCourtDateTime,
      html,
    };
    console.debug("Sending SCRAPE_RESULT message to background");
    console.debug(html.substring(0, 500));
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
      debug("Received message:", message.type);
      switch (message.type) {
        case "CLICK_SEARCH_CASES": {
          const success = handleClickSearchCases();
          debug(`CLICK_SEARCH_CASES result: ${success}`);
          sendResponse({ ok: success });
          return false;
        }

        case "FILL_AND_SEARCH": {
          const success = handleFillAndSearch(message.caseId);
          debug(`FILL_AND_SEARCH result: ${success}`);
          sendResponse({ ok: success });
          return false;
        }

        case "PARSE_RESULTS": {
          handleParseResults(message.caseId);
          debug("PARSE_RESULTS completed");
          sendResponse({ ok: true });
          return false;
        }

        default:
          debug("Unknown command type, ignoring");
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
    debug("Initializing content script");
    const pageType = detectPageType();
    const url = window.location.href;

    log(`Page loaded: type=${pageType}, url=${url}`);

    const message: ScraperReadyMessage = {
      type: "SCRAPER_READY",
      pageType,
      url,
    };

    debug("Sending SCRAPER_READY message to background");
    chrome.runtime.sendMessage(message, (response: BackgroundResponse | undefined) => {
      if (chrome.runtime.lastError) {
        log("No response to SCRAPER_READY (may not be a scrape tab):", chrome.runtime.lastError.message);
        return;
      }

      if (!response || !response.command) {
        log("No command received; this tab is not part of a scrape job.");
        return;
      }

      log("Received immediate command:", response.command.type);
      debug("Executing immediate command from response");
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
