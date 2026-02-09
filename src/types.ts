export interface Case {
  id: string;
  clientName: string;
  notes: string;
  lastScraped: string | null;
  nextCourtDate: string | null;
  scrapedHtml: string | null;
}

export interface ScrapeJob {
  caseId: string;
  tabId: number;
  state: "init" | "welcome" | "search" | "results" | "done" | "error";
  error?: string;
}

// Messages from popup -> background
export type PopupMessage =
  | { type: "START_SCRAPE"; caseId: string }
  | { type: "SCRAPE_ALL" }
  | { type: "GET_SCRAPE_STATUS" };

// Messages from content script -> background
export type ContentMessage =
  | { type: "SCRAPER_READY"; pageType: "welcome" | "search" | "results" | "unknown"; url: string }
  | { type: "SCRAPE_RESULT"; caseId: string; nextCourtDate: string | null; html: string }
  | { type: "SCRAPE_ERROR"; caseId: string; error: string };

// Messages from background -> content script
export type BackgroundCommand =
  | { type: "CLICK_SEARCH_CASES" }
  | { type: "FILL_AND_SEARCH"; caseId: string }
  | { type: "PARSE_RESULTS"; caseId: string };

// Response types
export interface ScrapeStatusResponse {
  active: Record<string, string>; // caseId -> state
}
