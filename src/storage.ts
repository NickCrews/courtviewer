import type { Case } from "./types.js";

const CASES_KEY = "courtviewer_cases";

export async function getCases(): Promise<Case[]> {
  const result = await chrome.storage.local.get(CASES_KEY);
  return result[CASES_KEY] || [];
}

export async function saveCases(cases: Case[]): Promise<void> {
  await chrome.storage.local.set({ [CASES_KEY]: cases });
}

export async function getCase(id: string): Promise<Case | undefined> {
  const cases = await getCases();
  return cases.find((c) => c.id === id);
}

export async function addCase(newCase: Case): Promise<void> {
  const cases = await getCases();
  const existing = cases.findIndex((c) => c.id === newCase.id);
  if (existing >= 0) {
    cases[existing] = { ...cases[existing], ...newCase };
  } else {
    cases.push(newCase);
  }
  await saveCases(cases);
}

export async function updateCase(
  id: string,
  updates: Partial<Case>,
): Promise<void> {
  const cases = await getCases();
  const idx = cases.findIndex((c) => c.id === id);
  if (idx >= 0) {
    cases[idx] = { ...cases[idx], ...updates };
    await saveCases(cases);
  }
}

export async function deleteCase(id: string): Promise<void> {
  const cases = await getCases();
  await saveCases(cases.filter((c) => c.id !== id));
}
