/**
 * Content script for the Alaska Court Viewer Chrome extension.
 *
 * Runs on every page under records.courts.alaska.gov/eaccess/*.
 * Detects the current page type, reports readiness to the background service
 * worker, and executes scraping commands it receives back.
 *
 * IMPORTANT: This file MUST be self-contained with NO imports at runtime. Chrome
 * extension content scripts cannot use ES modules. All type definitions
 * needed are inlined below.
 */

(async function () {
  // -----------------------------------------------------------------------
  // Inline type definitions (mirrors src/types.ts -- no imports allowed)
  // -----------------------------------------------------------------------

  type PageType = "welcome" | "searchHome" | "searchResults" | "caseProfile" | "unknown";

  type ScrapeData = {
    nextCourtDateTime: string | null;
    prosecutor: string | null;
    defendant: string | null;
  };

  type ScrapeState =
    | { caseId: string, state: "running" }
    | { caseId: string, state: "succeeded"; data: ScrapeData }
    | { caseId: string, state: "errored"; error: string }
    | { caseId: string, state: "noCaseFound" };

  /** The message the background worker sends to us to trigger a start */
  interface BeginScrapeCommand {
    type: "BEGIN_SCRAPE";
    caseId: string;
  }

  /** The message we send to the background worker to report a state change */
  interface ScrapeStateChangeMessage {
    type: "SCRAPE_STATE_CHANGE";
    state: ScrapeState;
  }

  // -----------------------------------------------------------------------
  // Constants
  // -----------------------------------------------------------------------

  const PREFIX = "[CourtViewer]";
  const ACTIVE_CASE_KEY = "courtviewer_active_case";

  /** Timeout for waiting for results after submitting the search form. */
  const RESULTS_TIMEOUT_MS = 30_000;

  /** Polling interval when waiting for results. */
  const POLL_INTERVAL_MS = 500;

  // 3AN-25-08095CR
  // 3PA-24-00277CR
  // 3KO-25-00060CR
  const CASE_ID_PATTERN = /[0-9A-Z]{3}-\d{2}-\d{5}[A-Z]{2}/i;

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
  // State change helpers
  // -----------------------------------------------------------------------
  // Every time the script takes an action, such as clicking a link, the page
  // might reload, which causes this script to be re-injected.
  // To maintain continuity across page loads, we use a state machine approach.
  // The state is stored in sessionStorage, which persists across page reloads.
  // To make progress, we load the state, run a step, possibly transition to
  // a new state, and then store it back.

  function loadActiveState(): ScrapeState | null {
    try {
      const state = sessionStorage.getItem(ACTIVE_CASE_KEY);
      return state ? JSON.parse(state) : null;
    } catch {
      return null;
    }
  }

  function storeActiveState(state: ScrapeState): void {
    try {
      sessionStorage.setItem(ACTIVE_CASE_KEY, JSON.stringify(state));
    } catch {
      // Ignore storage errors; scrape will still attempt on this page.
    }
  }


  function sendScrapeStateChange(state: ScrapeState): void {
    const message: ScrapeStateChangeMessage = {
      type: "SCRAPE_STATE_CHANGE",
      state,
    };
    chrome.runtime.sendMessage(message).catch((err) => {
      warn("Failed to send SCRAPE_STATE_CHANGE:", err);
    }).then(() => {
      debug("Sent SCRAPE_STATE_CHANGE message:", message);
    });
  }

  function setState(state: ScrapeState): ScrapeState {
    storeActiveState(state);
    sendScrapeStateChange(state);
    return state;
  }

  /**
   * Listen for commands from the background service worker.
   */
  chrome.runtime.onMessage.addListener(
    (
      message: BeginScrapeCommand,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response?: unknown) => void,
    ): boolean => {
      debug("Received message:", message.type);
      if (message.type !== "BEGIN_SCRAPE") {
        return false;
      }
      setState({ caseId: message.caseId, state: "running" });
      runStepWithIoErrorHandling();
      sendResponse({ ok: true });
      return false;
    },
  );

  async function runStepWithIoErrorHandling(): Promise<void> {
    const activeState = loadActiveState();
    if (!activeState) {
      debug("No active scrape state found on page load.");
      return;
    }
    try {
      const newState = await runScrapeStep(activeState);
      debug("Completed scrape step, new state:", newState);
      setState(newState);
    } catch (err) {
      warn("Error in runStepWithIoErrorHandling:", err);
      const state = { caseId: activeState.caseId, state: "errored", error: err instanceof Error ? err.message : String(err) } satisfies ScrapeState;
      setState(state);
    }
  }

  /**
   * Given a starting scrape state, run one step of the scrape process, returning the new state.
   * 
   * This does not do any io, such as loading/saving the state to sessionStorage
   * or sending message to the background worker; it just computes the next state based on the current page's DOM.
   */
  async function runScrapeStep(startingState: ScrapeState): Promise<ScrapeState> {
    if (startingState.state !== "running") {
      return startingState;
    }
    const runningState = { caseId: startingState.caseId, state: "running" } satisfies ScrapeState;
    const caseId = startingState.caseId;
    const pageType = detectPageType();
    log(`Running scrape step: case=${startingState.caseId}, page=${pageType}`);
    const startTime = Date.now();
    const TIME_LIMIT_MS = 30_000;
    while (true) {
      switch (pageType) {
        case "welcome":
          gotoSearchPage()
          return runningState;
        case "searchHome":
          handleFillAndSearch(caseId);
          return runningState;
        case "searchResults":
          const result = await clickToCaseProfile(caseId);
          if (result === "noCaseFound") {
            return { caseId, state: "noCaseFound" };
          } else if (result === "succeeded") {
            // noop
          } else {
            throw new Error(`Unexpected result from clickToCaseProfile: ${result satisfies never}`);
          }
          return runningState;
        case "caseProfile":
          const parsedData = await parseCasePage(caseId);
          return { caseId, state: "succeeded", data: parsedData }
        case "unknown":
          warn("Unknown page type, sleeping and then will retry detection.");
          await new Promise((resolve) => setTimeout(resolve, 1000));
          if (Date.now() - startTime > TIME_LIMIT_MS) {
            throw new Error("Timed out waiting for page to load into a known state.");
          }
          continue;
        default:
          throw new Error(`Unhandled page type: ${pageType satisfies never}`);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Page-type detection
  // -----------------------------------------------------------------------

  /**
   * Examine the DOM to determine which step of the court website we're on.
   * 
   * If we are in the middle of a page transition
   * (e.g. search submitted but results not loaded), may return "unknown".
  */
  function detectPageType(): PageType {
    // Detection order matters: check "search" before "welcome" because the
    // search form page also has navigation links that might match welcome
    // heuristics.
    if (document.querySelector('input[name="caseDscr"]')) {
      return "searchHome";
    }
    // If there is an element with the text "Case Type:"
    if (document.body.textContent?.includes("Case Type:")) {
      return "caseProfile";
    }
    // If there is an element with the text "Search Results"
    if (document.body.textContent?.includes("Search Results")) {
      return "searchResults";
    }
    // a prominent "Search Cases" link or button.
    if (hasSearchCasesLink()) {
      return "welcome";
    }
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
   * Find and click the "Search Cases" link or button on the welcome page.
   */
  function gotoSearchPage(): void {
    debug("Handling CLICK_SEARCH_CASES command");
    const anchors = document.querySelectorAll("a");
    debug(`Found ${anchors.length} anchor elements`);
    for (const a of anchors) {
      if (/search\s*cases/i.test(a.textContent || "")) {
        log("Clicking 'Search Cases' anchor:", a.href);
        a.click();
        return;
      }
    }

    debug("Strategy 1 failed, trying anchor with search.page href");
    for (const a of anchors) {
      if (a.href && /search\.page/i.test(a.href)) {
        log("Clicking anchor with search.page href:", a.href);
        a.click();
        return;
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
        return;
      }
    }

    warn("Could not find 'Search Cases' link or button.");
    throw new Error("Could not find 'Search Cases' link or button on welcome page.");
  }

  /**
   * Fill in the case number on the search form and submit it.
   * Returns immediately; does not wait for results.
   */
  function handleFillAndSearch(caseId: string): void {
    debug(`Handling FILL_AND_SEARCH command for case: ${caseId}`);
    const input = document.querySelector(
      'input[name="caseDscr"]',
    ) as HTMLInputElement | null;
    if (!input) {
      throw new Error("Could not find case number input (name='caseDscr').");
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
      throw new Error("Could not find the search submit button.");
    }

    debug("Found submit button, clicking");
    log("Clicking search submit button.");
    submitBtn.click();
  }

  /**
   * After search form submission, poll the DOM until search results, an error message,
   * or a timeout occurs.
   */
  async function clickToCaseProfile(caseId: string): Promise<"succeeded" | "noCaseFound"> {
    const startTime = Date.now();
    debug(`Starting to wait for results, timeout: ${RESULTS_TIMEOUT_MS}ms, poll interval: ${POLL_INTERVAL_MS}ms`);

    while (Date.now() - startTime < RESULTS_TIMEOUT_MS) {
      try {
        const result = await clickToCaseProfileOnce(caseId);
        return result;
      } catch (err) {
        debug("Error in clickToCaseProfileOnce:", err);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new Error("Timed out waiting for search results to load.");
  }

  async function clickToCaseProfileOnce(caseId: string): Promise<"succeeded" | "noCaseFound"> {
    debug("Looking for case detail link");
    const links = findCaseDetailLinks();
    if (links === null) {
      throw new Error("Not on results page, cannot find case detail link");
    }
    if (links.length === 0) {
      debug(`On results page but found no cases`);
      return "noCaseFound";
    }
    const matchingLinks = links.filter((l) => l.caseId === caseId);
    if (matchingLinks.length === 0) {
      debug(`found ${links.length} case links but none match case ID ${caseId}: `, links.map((l) => l.caseId).join(", "));
      throw new Error("No cases found matching search criteria.");
    }
    const detailLink = matchingLinks[0]!;
    log("Found case detail link; clicking through to detail page.");
    debug("Detail link href:", detailLink.link.href);
    detailLink.link.click();
    return "succeeded";
  }

  /**
 * On a results listing page, find all links to case detail pages.
 *
 * Returns null if we aren't on the results page.
 * Returns an array of links if we're on the results page, even if no matching case ID found, to allow for "no case found" detection.
 */
  function findCaseDetailLinks(): Array<{ caseId: string; link: HTMLAnchorElement }> | null {
    debug(`Looking for detail link with case ID pattern: ${CASE_ID_PATTERN}`);

    // Early exit, if "No Records Found" message is present
    if (document.body.textContent?.includes("No Records Found")) {
      debug(`"No Records Found" message detected on page.`);
      return [];
    }

    const mainContent = document.querySelector("#mainContent");
    const searchRoot = mainContent || document.body;

    const links = searchRoot.querySelectorAll("a");
    debug(`Found ${links.length} links in search root`);
    const results = [];
    for (const link of links) {
      const linkText = (link.textContent || "").replace(/\s+/g, "");
      if (CASE_ID_PATTERN.test(linkText)) {
        debug(`Found link with matching case ID text:`, linkText.substring(0, 50));
        if (
          link.href &&
          link.href !== "#" &&
          !link.href.endsWith("#") &&
          link.closest("table, .searchResults, .results")
        ) {
          debug(`Link passes heuristics, returning it`);
          results.push({ caseId: linkText, link });
        } else {
          debug(`Link failed heuristics check`);
        }
      }
    }
    return results;
  }

  /**
   * Parse the current page for case detail information and send the result
   * back to the background service worker.
   */
  async function parseCasePage(caseId: string): Promise<ScrapeData> {
    debug(`Parsing results for case: ${caseId}`);
    const errorEl = document.querySelector(
      ".feedback .feedbackPanelERROR, .feedbackPanelERROR, .feedbackPanelWARNING",
    );
    if (errorEl) {
      const errorText =
        errorEl.textContent?.trim() || "Unknown error from court site.";
      const message = "Error element found: " + errorText;
      throw new Error(message);
    }

    debug("parsing current page");
    const nextCourtDateTime = findNextCourtDateTime();
    const { prosecutor, defendant } = extractCaseParties(caseId);

    log(`Parsed results: nextCourtDateTime=${nextCourtDateTime}, prosecutor=${prosecutor}, defendant=${defendant}`);

    return { nextCourtDateTime, prosecutor, defendant };

  }

  interface CaseParties {
    prosecutor: string | null;
    defendant: string | null;
  }
  /**
   * Extract prosecutor and defendant from page elements.
   * Looks for elements with text like "Baker, Ryan Craig - Defendant" and "State of Alaska - Prosecution".
   */
  function extractCaseParties(caseId: string): CaseParties {
    debug(`Extracting case parties for case: ${caseId}`);
    let result: CaseParties = { prosecutor: null, defendant: null };

    const allElements = document.querySelectorAll("*");
    for (const el of allElements) {
      const text = (el.textContent || "").trim();

      if (/\s*-\s*Defendant\s*$/i.test(text)) {
        const match = text.match(/^(.+?)\s*-\s*Defendant\s*$/i);
        if (match) {
          result.defendant = match[1].trim();
          debug(`Found defendant element: "${text}" -> extracted: "${result.defendant}"`);
        }
      }

      if (/\s*-\s*Prosecution\s*$/i.test(text)) {
        const match = text.match(/^(.+?)\s*-\s*Prosecution\s*$/i);
        if (match) {
          result.prosecutor = match[1].trim();
          debug(`Found prosecutor element: "${text}" -> extracted: "${result.prosecutor}"`);
        }
      }

      if (result.prosecutor && result.defendant) {
        break;
      }
    }

    debug(`Extracted prosecutor: "${result.prosecutor}", defendant: "${result.defendant}"`);
    if (result.prosecutor && result.defendant) {
      return result;
    }
    warn("Could not extract prosecutor and defendant from page.");
    throw new Error(`Failed to extract case parties for case ${caseId}: prosecutor="${result.prosecutor}", defendant="${result.defendant}"`);
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
   * On page load, run one step of the scrape process.
   */
  function init(): void {
    debug("Initializing content script");
    runStepWithIoErrorHandling();
  }

  // Run init once the DOM is ready.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
