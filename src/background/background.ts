/**
 * Background service worker for the Alaska Court Viewer Chrome extension.
 * 
 * There is one instance of this script for the entire extension.
 *
 * Orchestrates scraping of court records from
 * https://records.courts.alaska.gov/eaccess/ by:
 *   - Opening tabs to the court website
 *   - Each of these tabs has its own content script instance which performs the actual scraping
 *   - This background script delegates to content scripts via messages
 *     and listens for their responses to track progress and results.
 *   - Storing scraped results in chrome.storage
 *
 * Message flow:
 *   Popup -> Background (START_SCRAPE | SCRAPE_ALL | GET_SCRAPE_STATUS)
 *   Background -> Content  (BEGIN_SCRAPE)
 *   Content -> Background (SCRAPE_STATE_CHANGE)
 */

import type {
  ScrapeJob,
  PopupMessage,
  ContentMessage,
  BackgroundCommand,
  ScrapeStatusResponse,
  ISODateString,
  Case,
} from "../types.js";
import { getCases, updateCase, getCase } from "../storage.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Entry URL for the Alaska court records site. */
const COURT_URL = "https://records.courts.alaska.gov/eaccess/search.page";

/** Maximum number of concurrent scrape tabs. */
const MAX_CONCURRENT = 3;

/** Per-job timeout in milliseconds (60 s). */
const JOB_TIMEOUT_MS = 60_000;

/** Stagger delay between launching successive scrape tabs (ms). */
const STAGGER_DELAY_MS = 100;

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

function nowIso(): ISODateString {
  return new Date().toISOString() as ISODateString;
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

function waitForTabComplete(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      if (tab?.status === "complete") {
        resolve();
        return;
      }

      const listener = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
        if (updatedTabId === tabId && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };

      chrome.tabs.onUpdated.addListener(listener);
    });
  });
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
    tab = await chrome.tabs.create({ url: COURT_URL, active: keepTabOpen });
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
    keepTabOpen,
    timestampStarted: nowIso(),
    state: { caseId, state: "running" },
  };

  jobsByTab.set(tabId, job);
  tabByCaseId.set(caseId, tabId);

  beginScrapeInTab(tabId, caseId, keepTabOpen).catch((err) => {
    warn(`Failed to start scrape in tab ${tabId} for case ${caseId}:`, err);
  });

  // Safety timeout: if the scrape hasn't finished within JOB_TIMEOUT_MS,
  // treat it as an error and clean up.
  const timer = setTimeout(async () => {
    const staleJob = jobsByTab.get(tabId);
    if (staleJob && staleJob.state.state === "running") {
      warn(`Scrape for case ${caseId} timed out in state "${staleJob.state.state}".`);
      try {
        await updateCase(caseId, {
          lastScrape: { caseId, timestamp: nowIso(), state: "errored", error: "Scrape timed out." },
        });
      } catch (err) {
        warn(`Failed to persist timeout for case ${caseId}:`, err);
      }
      cleanupJob(tabId);
      await safeCloseTab(tabId);
      processScrapeQueue();
    }
  }, JOB_TIMEOUT_MS);
  timeoutsByTab.set(tabId, timer);
}

async function beginScrapeInTab(
  tabId: number,
  caseId: string,
  keepTabOpen: boolean,
): Promise<void> {
  await waitForTabComplete(tabId);
  if (!jobsByTab.has(tabId)) {
    return;
  }
  const command: BackgroundCommand = { type: "BEGIN_SCRAPE", caseId };
  try {
    await chrome.tabs.sendMessage(tabId, command);
  } catch (err) {
    warn(`Failed to send BEGIN_SCRAPE to tab ${tabId}:`, err);
    const job = jobsByTab.get(tabId);
    if (job) {
      job.state = { caseId, state: "errored", error: "Content script unavailable." };
    }
    try {
      await updateCase(caseId, {
        lastScrape: { caseId, timestamp: nowIso(), state: "errored", error: "Content script unavailable." },
      });
    } catch (updateErr) {
      warn(`Failed to persist content script error for case ${caseId}:`, updateErr);
    }
    if (!keepTabOpen) {
      await safeCloseTab(tabId);
    }
    cleanupJob(tabId);
    processScrapeQueue();
  }
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
    const typ = message.type;
    switch (typ) {
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
          active[job.caseId] = job.state.state;
        }
        const response: ScrapeStatusResponse = { active };
        sendResponse(response);
        return false; // synchronous
      }

      // ----- Messages from content script -----

      case "SCRAPE_STATE_CHANGE": {
        handleScrapeStateChange(message, sender).then(() => {
          sendResponse({ ok: true });
        });
        return true;
      }

      default: {
        // Unknown message type; ignore.
        warn("Received message with unknown type:", typ satisfies never);
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
 * Content script reported a scrape state change.
 */
async function handleScrapeStateChange(
  message: ContentMessage & { type: "SCRAPE_STATE_CHANGE" },
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  const tabId = sender.tab?.id;
  const { state } = message;
  const { caseId, state: stateCode } = state;

  log(`SCRAPE_STATE_CHANGE: case=${caseId}, state=${stateCode}`);

  const job = tabId !== undefined ? jobsByTab.get(tabId) : undefined;
  if (stateCode === "running") {
    if (job) {
      job.state = state;
    }
    return;
  }

  if (stateCode === "succeeded") {
    try {
      const existingCase = await getCase(caseId);
      const updates: Partial<Case> = {
        lastScrape: { ...state, timestamp: nowIso() },
        nextCourtDateTime: state.data.nextCourtDateTime,
      };
      if (state.data.prosecutor && (!existingCase?.prosecutor || existingCase.prosecutor === "")) {
        updates.prosecutor = state.data.prosecutor;
      }
      if (state.data.defendant && (!existingCase?.defendantName || existingCase.defendantName === "")) {
        updates.defendantName = state.data.defendant;
      }
      await updateCase(caseId, updates);
    } catch (err) {
      warn(`Failed to persist scrape result for case ${caseId}:`, err);
    }
  } else if (stateCode === "errored" || stateCode === "noCaseFound") {
    try {
      await updateCase(caseId, {
        lastScrape: { ...state, timestamp: nowIso() },
      });
    } catch (err) {
      warn(`Failed to persist scrape state for case ${caseId}:`, err);
    }
  } else {
    throw new Error(`Unknown scrape state: ${(stateCode satisfies never)}`);
  }

  if (job) {
    job.state = state;
    if (!job.keepTabOpen) {
      await safeCloseTab(job.tabId);
    }
  }

  if (tabId !== undefined) {
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
