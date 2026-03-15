type ExpectedScrapeData = {
  nextCourtDateTime: string | null;
  prosecutor: string | null;
  defendant: string | null;
};

export type CasePageSnapshot = {
  name: string;
  filePath: string;
  caseId: string;
  now: string;
  expected: ExpectedScrapeData;
};

export const CASE_PAGE_SNAPSHOTS: CasePageSnapshot[] = [
  {
    name: "when the timeline is (event A with a result), (now), (event B with no result), we should detect B as the next court date",
    filePath: "tests/cases/case1.html",
    caseId: "3KO-25-00060CR",
    now: "2026-03-14T00:00:00",
    expected: {
      nextCourtDateTime: "2026-03-24T13:30:00",
      prosecutor: "State of Alaska",
      defendant: "Posey, Lisa Ann",
    },
  },
];