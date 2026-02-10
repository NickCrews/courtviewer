/**
 * Background service worker for the Alaska Court Viewer Chrome extension.
 *
 * Orchestrates scraping of court records from
 * https://records.courts.alaska.gov/eaccess/ by:
 *   - Opening tabs to the court website
 *   - Communicating with the content script to navigate through pages
 *   - Storing scraped results in chrome.storage
 *
 * Message flow:
 *   Popup  -> Background (START_SCRAPE | SCRAPE_ALL | GET_SCRAPE_STATUS)
 *   Content -> Background (SCRAPER_READY | SCRAPE_RESULT | SCRAPE_ERROR)
 *   Background -> Content  (CLICK_SEARCH_CASES | FILL_AND_SEARCH | PARSE_RESULTS)
 */

import type {
  ScrapeJob,
  PopupMessage,
  ContentMessage,
  BackgroundCommand,
  ScrapeStatusResponse,
} from "../types.js";
import { getCases, updateCase } from "../storage.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Entry URL for the Alaska court records site. */
const COURT_URL = "https://records.courts.alaska.gov/eaccess/search.page.3";

/** Maximum number of concurrent scrape tabs. */
const MAX_CONCURRENT = 3;

/** Per-job timeout in milliseconds (60 s). */
const JOB_TIMEOUT_MS = 60_000;

/** Stagger delay between launching successive scrape tabs (ms). */
const STAGGER_DELAY_MS = 500;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Active scrape jobs keyed by tabId. */
const jobsByTab = new Map<number, ScrapeJob>();

/** Reverse lookup: caseId -> tabId for the currently active job. */
const tabByCaseId = new Map<string, number>();

/** Timeout handles for each tab so we can cancel them on cleanup. */
const timeoutsByTab = new Map<number, ReturnType<typeof setTimeout>>();

/**
 * Queue of caseIds waiting to be scraped when we exceed MAX_CONCURRENT.
 * Used by SCRAPE_ALL to throttle concurrency.
 */
const scrapeQueue: string[] = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Log a message with a recognisable prefix for debugging. */
function log(...args: unknown[]): void {
  console.log("[CourtViewer:bg]", ...args);
}

function warn(...args: unknown[]): void {
  console.warn("[CourtViewer:bg]", ...args);
}

/**
 * Remove all traces of a job (maps, timers) for the given tab.
 * Safe to call multiple times for the same tabId.
 */
function cleanupJob(tabId: number): void {
  const job = jobsByTab.get(tabId);
  if (job) {
    tabByCaseId.delete(job.caseId);
  }
  jobsByTab.delete(tabId);

  const timer = timeoutsByTab.get(tabId);
  if (timer !== undefined) {
    clearTimeout(timer);
    timeoutsByTab.delete(tabId);
  }
}

/**
 * Try to close a tab, suppressing errors if it's already gone.
 */
async function safeCloseTab(tabId: number): Promise<void> {
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    // Tab may already be closed; that's fine.
  }
}

/**
 * If there are queued cases and we're below the concurrency limit, start the
 * next scrape.
 */
function processScrapeQueue(): void {
  while (scrapeQueue.length > 0 && jobsByTab.size < MAX_CONCURRENT) {
    const nextCaseId = scrapeQueue.shift();
    if (nextCaseId && !tabByCaseId.has(nextCaseId)) {
      startScrapeForCase(nextCaseId);
    }
  }
}

// ---------------------------------------------------------------------------
// Core scraping orchestration
// ---------------------------------------------------------------------------

/**
 * Begin scraping a single case. Opens a new background tab to the court URL,
 * registers the job, and sets a safety timeout.
 */
async function startScrapeForCase(caseId: string, keepTabOpen = false): Promise<void> {
  if (tabByCaseId.has(caseId)) {
    log(`Scrape already in progress for case ${caseId}, skipping.`);
    return;
  }

  log(`Starting scrape for case ${caseId}`);

  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.create({ url: COURT_URL, active: false });
  } catch (err) {
    warn(`Failed to create tab for case ${caseId}:`, err);
    return;
  }

  const tabId = tab.id;
  if (tabId === undefined) {
    warn(`Created tab has no id for case ${caseId}`);
    return;
  }

  const job: ScrapeJob = {
    caseId,
    tabId,
    state: "init",
    keepTabOpen,
  };

  jobsByTab.set(tabId, job);
  tabByCaseId.set(caseId, tabId);

  // Safety timeout: if the scrape hasn't finished within JOB_TIMEOUT_MS,
  // treat it as an error and clean up.
  const timer = setTimeout(async () => {
    const staleJob = jobsByTab.get(tabId);
    if (staleJob && staleJob.state !== "done") {
      warn(`Scrape for case ${caseId} timed out in state "${staleJob.state}".`);
      cleanupJob(tabId);
      await safeCloseTab(tabId);
      processScrapeQueue();
    }
  }, JOB_TIMEOUT_MS);
  timeoutsByTab.set(tabId, timer);
}

// ---------------------------------------------------------------------------
// Message listener
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener(
  (
    message: PopupMessage | ContentMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ): boolean => {
    // Route based on message type.
    switch (message.type) {
      // ----- Messages from popup -----

      case "START_SCRAPE": {
        const { caseId, keepTabOpen } = message;
        startScrapeForCase(caseId, keepTabOpen).then(() => {
          sendResponse({ ok: true });
        });
        return true;
      }

      case "SCRAPE_ALL": {
        handleScrapeAll().then(() => {
          sendResponse({ ok: true });
        });
        return true;
      }

      case "GET_SCRAPE_STATUS": {
        const active: Record<string, string> = {};
        for (const [, job] of jobsByTab) {
          active[job.caseId] = job.state;
        }
        const response: ScrapeStatusResponse = { active };
        sendResponse(response);
        return false; // synchronous
      }

      // ----- Messages from content script -----

      case "SCRAPER_READY": {
        handleScraperReady(message, sender, sendResponse);
        return true; // async sendResponse
      }

      case "SCRAPE_RESULT": {
        handleScrapeResult(message, sender).then(() => {
          sendResponse({ ok: true });
        });
        return true;
      }

      case "SCRAPE_ERROR": {
        handleScrapeError(message, sender).then(() => {
          sendResponse({ ok: true });
        });
        return true;
      }

      default: {
        // Unknown message type; ignore.
        return false;
      }
    }
  },
);

// ---------------------------------------------------------------------------
// Handler implementations
// ---------------------------------------------------------------------------

/**
 * SCRAPE_ALL: load every saved case and queue scrapes for all of them,
 * respecting the MAX_CONCURRENT limit with staggered starts.
 */
async function handleScrapeAll(): Promise<void> {
  const cases = await getCases();
  if (cases.length === 0) {
    log("SCRAPE_ALL: no cases to scrape.");
    return;
  }

  log(`SCRAPE_ALL: queuing ${cases.length} cases.`);

  for (const c of cases) {
    // Skip cases already in flight or already queued.
    if (tabByCaseId.has(c.id) || scrapeQueue.includes(c.id)) {
      continue;
    }

    if (jobsByTab.size < MAX_CONCURRENT) {
      await startScrapeForCase(c.id);
      // Small stagger to avoid slamming the server with simultaneous requests.
      await new Promise((r) => setTimeout(r, STAGGER_DELAY_MS));
    } else {
      scrapeQueue.push(c.id);
    }
  }
}

/**
 * Content script reports that it has loaded and detected a page type.
 * We reply with the appropriate command so it knows what to do next.
 */
function handleScraperReady(
  message: ContentMessage & { type: "SCRAPER_READY" },
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): void {
  const tabId = sender.tab?.id;
  if (tabId === undefined) {
    warn("SCRAPER_READY received with no tab id.");
    sendResponse({ command: null });
    return;
  }

  const job = jobsByTab.get(tabId);
  if (!job) {
    // This tab isn't part of a scrape job (e.g. user manually browsing).
    log(`SCRAPER_READY from tab ${tabId} with no associated job; ignoring.`);
    sendResponse({ command: null });
    return;
  }

  const { pageType, url } = message;
  log(`SCRAPER_READY: tab=${tabId}, case=${job.caseId}, page=${pageType}, url=${url}`);

  let command: BackgroundCommand | null = null;

  switch (pageType) {
    case "welcome":
      job.state = "welcome";
      command = { type: "CLICK_SEARCH_CASES" };
      break;

    case "search":
      job.state = "search";
      command = { type: "FILL_AND_SEARCH", caseId: job.caseId };
      break;

    case "results":
      job.state = "results";
      command = { type: "PARSE_RESULTS", caseId: job.caseId };
      break;

    case "unknown":
      warn(
        `SCRAPER_READY: unknown page type for tab ${tabId} (${url}). ` +
        "Content script may need to wait and re-detect.",
      );
      // Don't send a command; the content script will re-try or time out.
      break;
  }

  sendResponse({ command });
}

/**
 * Content script successfully scraped a case. Persist results, clean up.
 */
async function handleScrapeResult(
  message: ContentMessage & { type: "SCRAPE_RESULT" },
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  const tabId = sender.tab?.id;
  const { caseId, nextCourtDateTime, html } = message;

  log(`SCRAPE_RESULT: case=${caseId}, nextCourtDate=${nextCourtDateTime}`);

  // Persist to storage.
  try {
    await updateCase(caseId, {
      lastScraped: new Date().toISOString(),
      nextCourtDateTime,
      scrapedHtml: html,
    });
  } catch (err) {
    warn(`Failed to persist scrape result for case ${caseId}:`, err);
  }

  if (tabId !== undefined) {
    const job = jobsByTab.get(tabId);
    if (job) {
      job.state = "done";
      if (!job.keepTabOpen) {
        // await safeCloseTab(tabId);
      }
    }
    cleanupJob(tabId);
  }

  // Kick off the next queued scrape if any.
  processScrapeQueue();
}

/**
 * Content script encountered an error while scraping.
 */
async function handleScrapeError(
  message: ContentMessage & { type: "SCRAPE_ERROR" },
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  const tabId = sender.tab?.id;
  const { caseId, error } = message;

  warn(`SCRAPE_ERROR: case=${caseId}, error="${error}"`);

  if (tabId !== undefined) {
    const job = jobsByTab.get(tabId);
    if (job) {
      job.state = "error";
      job.error = error;
      if (!job.keepTabOpen) {
        await safeCloseTab(tabId);
      }
    }
    cleanupJob(tabId);
  }

  processScrapeQueue();
}

// ---------------------------------------------------------------------------
// Tab removal listener
// ---------------------------------------------------------------------------

chrome.tabs.onRemoved.addListener((tabId: number) => {
  if (jobsByTab.has(tabId)) {
    log(`Tab ${tabId} was removed; cleaning up associated scrape job.`);
    cleanupJob(tabId);
    processScrapeQueue();
  }
});

// ---------------------------------------------------------------------------
// Startup log
// ---------------------------------------------------------------------------

log("Service worker started.");
