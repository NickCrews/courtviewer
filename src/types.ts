export type ISODateString = `${number}-${number}-${number}T${number}:${number}:${number}.${number}Z`;

// This NEEDS to be kept in sync with the ScrapeState type in content/scraper.ts
export type ScrapeState =
  | { caseId: string, state: "running" }
  | { caseId: string, state: "succeeded", data: ScrapeData }
  | { caseId: string, state: "errored", error: string }
  | { caseId: string, state: "noCaseFound" }

// This NEEDS to be kept in sync with the ScrapeState type in content/scraper.ts
export type ScrapeData = {
  nextCourtDateTime: string | null;
  prosecutor: string | null;
  defendant: string | null;
}

export interface Case {
  id: string;
  defendantName: string;
  prosecutor: string | null;
  notes: string;
  lastScrape?: ScrapeState & { timestamp: ISODateString };
  nextCourtDateTime: string | null;
}

export interface ScrapeJob {
  caseId: string;
  tabId: number;
  timestampStarted: ISODateString
  keepTabOpen: boolean;
  state: ScrapeState;
}

// Messages from popup -> background
export type PopupMessage =
  | { type: "START_SCRAPE"; caseId: string; keepTabOpen: boolean }
  | { type: "SCRAPE_ALL" }
  | { type: "GET_SCRAPE_STATUS" };

// Messages from content script -> background
export type ContentMessage =
  | { type: "SCRAPE_STATE_CHANGE"; state: ScrapeState }

// Messages from background -> content script
export type BackgroundCommand =
  | { type: "BEGIN_SCRAPE"; caseId: string }

// Response types
export interface ScrapeStatusResponse {
  active: Record<string, string>; // caseId -> state
}
