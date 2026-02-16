export interface Case {
  id: string;
  defendantName: string;
  prosecutor: string | null;
  notes: string;
  lastScraped: string | null;
  nextCourtDateTime: string | null;
  scrapedHtml: string | null;
}

export interface ScrapeJob {
  caseId: string;
  tabId: number;
  state: "init" | "welcome" | "search" | "results" | "done" | "error";
  keepTabOpen?: boolean;
  error?: string;
}

// Messages from popup -> background
export type PopupMessage =
  | { type: "START_SCRAPE"; caseId: string; keepTabOpen?: boolean }
  | { type: "SCRAPE_ALL" }
  | { type: "GET_SCRAPE_STATUS" };

// Messages from content script -> background
export type ContentMessage =
  | { type: "SCRAPER_READY"; pageType: "welcome" | "search" | "results" | "unknown"; url: string }
  | { type: "SCRAPE_RESULT"; caseId: string; nextCourtDateTime: string | null; html: string; prosecutor: string | null; defendant: string | null }
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
