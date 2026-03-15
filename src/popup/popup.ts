import type { Case } from "../types.js";
import { getCases, addCase, updateCase, deleteCase } from "../storage.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let cases: Case[] = [];
let sortField: keyof Case = "defendantName";
let sortAsc = true;
let searchQuery = "";
let editingCaseId: string | null = null;

/** Currently active scrape jobs: caseId -> state label */
let activeScrapes: Record<string, string> = {};

/** Handle for the scrape-status polling interval */
let statusPollTimer: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// DOM references (resolved once on DOMContentLoaded)
// ---------------------------------------------------------------------------
let searchInput: HTMLInputElement;
let addCaseBtn: HTMLButtonElement;
let scrapeAllBtn: HTMLButtonElement;
let casesBody: HTMLTableSectionElement;
let emptyState: HTMLDivElement;
let caseModal: HTMLDivElement;
let modalTitle: HTMLHeadingElement;
let caseForm: HTMLFormElement;
let caseIdInput: HTMLInputElement;
let defendantNameInput: HTMLInputElement;
let judgeInput: HTMLInputElement;
let notesInput: HTMLTextAreaElement;
let saveBtn: HTMLButtonElement;
let cancelBtn: HTMLButtonElement;
let previewModal: HTMLDivElement;
let closePreviewBtn: HTMLButtonElement;
let previewFrame: HTMLIFrameElement;
let openInTabLink: HTMLAnchorElement;

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", async () => {
  // Resolve all DOM handles
  searchInput = document.getElementById("searchInput") as HTMLInputElement;
  addCaseBtn = document.getElementById("addCaseBtn") as HTMLButtonElement;
  scrapeAllBtn = document.getElementById("scrapeAllBtn") as HTMLButtonElement;
  casesBody = document.getElementById("casesBody") as HTMLTableSectionElement;
  emptyState = document.getElementById("emptyState") as HTMLDivElement;
  caseModal = document.getElementById("caseModal") as HTMLDivElement;
  modalTitle = document.getElementById("modalTitle") as HTMLHeadingElement;
  caseForm = document.getElementById("caseForm") as HTMLFormElement;
  caseIdInput = document.getElementById("caseIdInput") as HTMLInputElement;
  defendantNameInput = document.getElementById("defendantNameInput") as HTMLInputElement;
  judgeInput = document.getElementById("judgeInput") as HTMLInputElement;
  notesInput = document.getElementById("notesInput") as HTMLTextAreaElement;
  cancelBtn = document.getElementById("cancelBtn") as HTMLButtonElement;
  saveBtn = document.getElementById("saveBtn") as HTMLButtonElement;
  previewModal = document.getElementById("previewModal") as HTMLDivElement;
  closePreviewBtn = document.getElementById("closePreviewBtn") as HTMLButtonElement;
  previewFrame = document.getElementById("previewFrame") as HTMLIFrameElement;
  openInTabLink = document.getElementById("openInTabLink") as HTMLAnchorElement;

  // Load data
  cases = await getCases();
  renderTable();

  // Bind listeners
  bindEventListeners();

  // Listen for external storage changes (e.g. background script updating a case)
  chrome.storage.onChanged.addListener(handleStorageChange);

  // Poll scrape status every 1 second
  pollScrapeStatus();
  statusPollTimer = setInterval(pollScrapeStatus, 1000);
});

// ---------------------------------------------------------------------------
// Event binding
// ---------------------------------------------------------------------------
function bindEventListeners(): void {
  // Search – debounced input
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  searchInput.addEventListener("input", () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchQuery = searchInput.value.trim().toLowerCase();
      renderTable();
    }, 200);
  });

  // Add Case button
  addCaseBtn.addEventListener("click", () => {
    showModal("add", undefined, searchInput.value.trim());
  });

  // Scrape All button
  scrapeAllBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "SCRAPE_ALL" });
  });

  // Sort headers
  const headers = document.querySelectorAll<HTMLTableCellElement>("th.sortable");
  headers.forEach((th) => {
    th.addEventListener("click", () => {
      const field = th.dataset.sort as keyof Case | undefined;
      if (!field) return;
      if (sortField === field) {
        sortAsc = !sortAsc;
      } else {
        sortField = field;
        sortAsc = true;
      }
      renderTable();
    });
  });

  // Form submit (save)
  caseForm.addEventListener("submit", (e) => {
    e.preventDefault();
    handleSave();
  });

  // Cancel modal
  cancelBtn.addEventListener("click", () => {
    hideModal();
  });

  // Close modal when clicking overlay backdrop
  caseModal.addEventListener("click", (e) => {
    if (e.target === caseModal) hideModal();
  });

  // Close preview
  closePreviewBtn.addEventListener("click", () => {
    hidePreview();
  });
  previewModal.addEventListener("click", (e) => {
    if (e.target === previewModal) hidePreview();
  });

  // Open in full tab
  openInTabLink.addEventListener("click", (e) => {
    e.preventDefault();
    openInTab();
  });

  // Action buttons via event delegation on tbody
  casesBody.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const btn = target.closest<HTMLButtonElement>("button[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    const caseId = btn.dataset.caseId;
    if (!action || !caseId) return;

    switch (action) {
      case "scrape":
        scrapeCase(caseId, false);
        break;
      case "open":
        scrapeCase(caseId, true);
        break;
      case "edit":
        editCase(caseId);
        break;
      case "delete":
        confirmDeleteCase(caseId);
        break;
    }
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderTable(): void {
  // 1. Filter
  const filtered = cases.filter((c) => {
    if (!searchQuery) return true;
    const haystack = `${c.defendantName} ${c.judge} ${c.id} ${c.notes}`.toLowerCase();
    return haystack.includes(searchQuery);
  });

  // 2. Sort
  filtered.sort((a, b) => {
    let aVal: string | null = null;
    let bVal: string | null = null;

    if (sortField === "lastScrape") {
      console.log("a and b", a.lastScrape, b.lastScrape);
      aVal = a.lastScrape ? `${a.lastScrape.state} ${a.lastScrape.timestamp}` : null;
      bVal = b.lastScrape ? `${b.lastScrape.state} ${b.lastScrape.timestamp}` : null;
    } else {
      const aFieldVal = a[sortField as keyof Case];
      const bFieldVal = b[sortField as keyof Case];
      aVal = aFieldVal != null ? String(aFieldVal) : null;
      bVal = bFieldVal != null ? String(bFieldVal) : null;
    }

    // Nulls always sort last regardless of direction
    if (aVal == null && bVal == null) return 0;
    if (aVal == null) return 1;
    if (bVal == null) return -1;

    const cmp = aVal.localeCompare(bVal, undefined, { sensitivity: "base" });
    return sortAsc ? cmp : -cmp;
  });

  // 3. Clear body
  casesBody.innerHTML = "";

  // 4. Show empty state or table rows
  if (filtered.length === 0) {
    if (searchQuery) {
      // No results for search
      emptyState.hidden = false;
      const titleEl = emptyState.querySelector(".empty-state-title");
      const subEl = emptyState.querySelector(".empty-state-subtitle");
      if (titleEl) titleEl.textContent = "No matching cases";
      if (subEl) subEl.textContent = `No cases match "${searchInput.value.trim()}".`;
    } else if (cases.length === 0) {
      emptyState.hidden = false;
      const titleEl = emptyState.querySelector(".empty-state-title");
      const subEl = emptyState.querySelector(".empty-state-subtitle");
      if (titleEl) titleEl.textContent = "No cases tracked yet";
      if (subEl) subEl.textContent = 'Click "Add Case" to start tracking Alaska court cases.';
    } else {
      emptyState.hidden = true;
    }
  } else {
    emptyState.hidden = true;
  }

  // 5. Build rows
  for (const c of filtered) {
    const tr = document.createElement("tr");
    tr.dataset.caseId = c.id;

    // Apply scraping animation if this case is actively being scraped
    if (activeScrapes[c.id]) {
      tr.classList.add("scraping");
    }

    // Defendant name
    const tdDefendant = document.createElement("td");
    tdDefendant.className = "cell-truncate";
    const defText = c.defendantName || "\u2014";
    tdDefendant.textContent = defText;
    tdDefendant.title = defText;
    tr.appendChild(tdDefendant);

    // Judge
    const tdJudge = document.createElement("td");
    tdJudge.className = "cell-truncate";
    const judgeText = c.judge || "\u2014";
    tdJudge.textContent = judgeText;
    tdJudge.title = judgeText;
    tr.appendChild(tdJudge);

    // Case ID
    const tdId = document.createElement("td");
    tdId.textContent = c.id;
    tr.appendChild(tdId);

    // Next court date
    const tdDate = document.createElement("td");
    tdDate.innerHTML = formatCourtDateTime(c.nextCourtDateTime);
    tr.appendChild(tdDate);

    // Last scraped
    const tdScraped = document.createElement("td");
    tdScraped.innerHTML = buildScrapedCell(c);
    tr.appendChild(tdScraped);

    // Actions
    const tdActions = document.createElement("td");
    tdActions.className = "actions-cell";
    tdActions.innerHTML = buildActionButtons(c);
    tr.appendChild(tdActions);

    casesBody.appendChild(tr);
  }

  // 6. Update sort indicators
  updateSortIndicators();
}

function buildScrapedCell(c: Case): string {
  if (!c.lastScrape) {
    return `<span class="scrape-status"><span class="status-dot never"></span>Never</span>`;
  }
  const state = c.lastScrape;
  const when = formatRelativeTime(state.timestamp);
  if (state.state === "succeeded") {
    return `<span class="scrape-status"><span class="status-dot done"></span>${when}</span>`;
  } else if (state.state === "noCaseFound") {
    return `<span class="scrape-status" title="Case not found in search results"><span class="status-dot notfound"></span>Not Found ${when}</span>`;
  } else if (state.state === "errored") {
    return `<span class="scrape-status" title="Error: ${escapeHtml(state.error)}"><span class="status-dot error"></span>Error ${when}</span>`;
  } else if (state.state === "running") {
    return `<span class="scrape-status"><span class="status-dot active"></span>Running</span>`;
  } else {
    throw new Error(`Unknown scrape state: ${(state satisfies never)}`);
  }
}

const ICON_OPEN = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V10"/><path d="M10 2h4v4"/><path d="M14 2 7.5 8.5"/></svg>`;
const ICON_SCRAPE = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 2.5v4h4"/><path d="M2.3 10a6 6 0 1 0 1.2-6.2L1.5 6.5"/></svg>`;
const ICON_EDIT = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 2.5a1.77 1.77 0 0 1 2.5 2.5L5.5 13.5 2 14.5l1-3.5Z"/></svg>`;
const ICON_DELETE = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5h10M6 4.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M12 4.5 11.5 13a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 13L4 4.5"/></svg>`;

function buildActionButtons(c: Case): string {
  const scrapeDisabled = activeScrapes[c.id] ? "disabled" : "";
  const scrapeTitle = activeScrapes[c.id] ? "Scraping…" : "Scrape";
  const openTitle = activeScrapes[c.id] ? "Opening…" : "Open";
  let html = '';
  html += `<button class="btn-icon btn-icon-outline" title="${openTitle}" data-action="open" data-case-id="${escapeHtml(c.id)}" ${scrapeDisabled}>${ICON_OPEN}</button>`;
  html += `<button class="btn-icon btn-icon-outline" title="${scrapeTitle}" data-action="scrape" data-case-id="${escapeHtml(c.id)}" ${scrapeDisabled}>${ICON_SCRAPE}</button>`;
  html += `<button class="btn-icon btn-icon-outline" title="Edit" data-action="edit" data-case-id="${escapeHtml(c.id)}">${ICON_EDIT}</button>`;
  html += `<button class="btn-icon btn-icon-danger" title="Delete" data-action="delete" data-case-id="${escapeHtml(c.id)}">${ICON_DELETE}</button>`;
  return html;
}

function updateSortIndicators(): void {
  const headers = document.querySelectorAll<HTMLTableCellElement>("th.sortable");
  headers.forEach((th) => {
    th.classList.remove("sort-asc", "sort-desc");
    if (th.dataset.sort === sortField) {
      th.classList.add(sortAsc ? "sort-asc" : "sort-desc");
    }
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
function scrapeCase(id: string, keepTabOpen = false): void {
  chrome.runtime.sendMessage({ type: "START_SCRAPE", caseId: id, keepTabOpen });
  activeScrapes[id] = "running";
  renderTable();
}

function editCase(id: string): void {
  const c = cases.find((x) => x.id === id);
  if (!c) return;
  showModal("edit", c);
}

function confirmDeleteCase(id: string): void {
  const c = cases.find((x) => x.id === id);
  const label = c ? `${c.id} (${c.defendantName || "unnamed"})` : id;
  if (!confirm(`Delete case ${label}? This cannot be undone.`)) return;

  deleteCase(id).then(async () => {
    cases = await getCases();
    renderTable();
  });
}

function openInTab(): void {
  chrome.tabs.create({ url: chrome.runtime.getURL("popup/popup.html") });
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------
function showModal(mode: "add" | "edit", caseData?: Case, prefilledCaseId?: string): void {
  clearValidationErrors();

  if (mode === "add") {
    modalTitle.textContent = "Add Case";
    saveBtn.textContent = "Add";
    editingCaseId = null;
    caseIdInput.value = prefilledCaseId || "";
    caseIdInput.disabled = false;
    defendantNameInput.value = "";
    judgeInput.value = "";
    notesInput.value = "";
  } else if (mode === "edit" && caseData) {
    modalTitle.textContent = "Edit Case";
    saveBtn.textContent = "Save";
    editingCaseId = caseData.id;
    caseIdInput.value = caseData.id;
    caseIdInput.disabled = true;
    defendantNameInput.value = caseData.defendantName;
    judgeInput.value = caseData.judge ?? "";
    notesInput.value = caseData.notes;
  }

  caseModal.hidden = false;
  // Focus the first editable field
  if (mode === "add") {
    caseIdInput.focus();
  } else {
    defendantNameInput.focus();
  }
}

function hideModal(): void {
  caseModal.hidden = true;
  editingCaseId = null;
  clearValidationErrors();
}

function hidePreview(): void {
  previewModal.hidden = true;
  previewFrame.srcdoc = "";
}

async function handleSave(): Promise<void> {
  clearValidationErrors();

  const rawId = caseIdInput.value.trim();
  const defendantName = defendantNameInput.value.trim();
  const judge = judgeInput.value.trim();
  const notes = notesInput.value.trim();

  // Validate case ID is provided
  if (!rawId) {
    showFieldError(caseIdInput, "Case number is required.");
    return;
  }

  // Lenient format check: allow alphanumeric chars and dashes, at least 3 chars
  if (!/^[A-Za-z0-9][\w\-]{2,}/.test(rawId)) {
    showFieldError(caseIdInput, "Enter a valid case number (e.g. 3AN-24-00123CR).");
    return;
  }

  // When adding, check for duplicate
  if (!editingCaseId && cases.some((c) => c.id === rawId)) {
    showFieldError(caseIdInput, "A case with this ID already exists.");
    return;
  }

  if (editingCaseId) {
    await updateCase(editingCaseId, { defendantName, judge: judge || null, notes });
  } else {
    const newCase: Case = {
      id: rawId,
      defendantName,
      prosecutor: null,
      judge: judge || null,
      notes,
      nextCourtDateTime: null,
    };
    await addCase(newCase);
    scrapeCase(rawId, false);
  }

  cases = await getCases();
  renderTable();
  hideModal();
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------
function showFieldError(input: HTMLInputElement | HTMLTextAreaElement, message: string): void {
  input.classList.add("input-error");
  // Insert error text after the input
  const errorEl = document.createElement("div");
  errorEl.className = "error-text";
  errorEl.textContent = message;
  input.parentElement?.appendChild(errorEl);
  input.focus();
}

function clearValidationErrors(): void {
  caseForm.querySelectorAll(".input-error").forEach((el) => el.classList.remove("input-error"));
  caseForm.querySelectorAll(".error-text").forEach((el) => el.remove());
}

// ---------------------------------------------------------------------------
// Scrape status polling
// ---------------------------------------------------------------------------
async function pollScrapeStatus(): Promise<void> {
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_SCRAPE_STATUS" });
    if (response && typeof response === "object" && response.active) {
      const prev = JSON.stringify(activeScrapes);
      activeScrapes = response.active as Record<string, string>;
      const next = JSON.stringify(activeScrapes);

      // Re-render only if status changed
      if (prev !== next) {
        // If any jobs finished, reload case data (they may have updated scrape data)
        cases = await getCases();
        renderTable();
      }
    }
  } catch {
    // Background script may not be ready yet; ignore
  }
}

// ---------------------------------------------------------------------------
// Storage change listener
// ---------------------------------------------------------------------------
function handleStorageChange(
  changes: { [key: string]: chrome.storage.StorageChange },
  areaName: string
): void {
  if (areaName !== "local") return;
  if (!changes["courtviewer_cases"]) return;

  // Reload cases from the new value
  const newCases = changes["courtviewer_cases"].newValue;
  if (Array.isArray(newCases)) {
    cases = newCases as Case[];
    renderTable();
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
function escapeHtml(str: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return str.replace(/[&<>"']/g, (ch) => map[ch] ?? ch);
}

function formatCourtDateTime(datetimeStr: string | null): string {
  if (!datetimeStr) return "\u2014";
  const date = new Date(datetimeStr);
  if (isNaN(date.getTime())) return escapeHtml(datetimeStr);

  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  const currentYear = now.getFullYear();
  const dateYear = date.getFullYear();

  const datePart = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: dateYear === currentYear ? undefined : "numeric",
  });
  const timePart = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  let relPart = "";
  if (diffDays >= 0) {
    const weeks = Math.floor(diffDays / 7);
    relPart = weeks > 4
      ? `in ${weeks} weeks`
      : diffDays === 0 ? "today" : diffDays === 1 ? "tomorrow" : `in ${diffDays} days`;
  }

  const cls = diffDays >= 0 && diffDays <= 7 ? " upcoming" : "";
  return `<span class="court-date${cls}"><span class="court-date-day">${escapeHtml(datePart)}</span><span class="court-date-time">${escapeHtml(timePart)}</span>${relPart ? `<span class="court-date-rel">${escapeHtml(relPart)}</span>` : ""}</span>`;
}


function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();

  if (diffMs < 0) return "just now";

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return "just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} d ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months} mo ago`;

  const years = Math.floor(months / 12);
  return `${years} y ago`;
}
