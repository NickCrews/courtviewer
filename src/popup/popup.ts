import type { Case } from "../types.js";
import { getCases, addCase, updateCase, deleteCase } from "../storage.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let cases: Case[] = [];
let sortField: keyof Case = "clientName";
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
let clientNameInput: HTMLInputElement;
let notesInput: HTMLTextAreaElement;
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
  clientNameInput = document.getElementById("clientNameInput") as HTMLInputElement;
  notesInput = document.getElementById("notesInput") as HTMLTextAreaElement;
  cancelBtn = document.getElementById("cancelBtn") as HTMLButtonElement;
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

  // Poll scrape status every 2 seconds
  pollScrapeStatus();
  statusPollTimer = setInterval(pollScrapeStatus, 2000);
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
        scrapeCase(caseId, e.shiftKey);
        break;
      case "edit":
        editCase(caseId);
        break;
      case "delete":
        confirmDeleteCase(caseId);
        break;
      case "preview":
        previewCase(caseId);
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
    const haystack = `${c.clientName} ${c.id} ${c.notes}`.toLowerCase();
    return haystack.includes(searchQuery);
  });

  // 2. Sort
  filtered.sort((a, b) => {
    const aVal = a[sortField];
    const bVal = b[sortField];

    // Nulls always sort last regardless of direction
    if (aVal == null && bVal == null) return 0;
    if (aVal == null) return 1;
    if (bVal == null) return -1;

    let cmp: number;
    if (typeof aVal === "string" && typeof bVal === "string") {
      cmp = aVal.localeCompare(bVal, undefined, { sensitivity: "base" });
    } else {
      cmp = String(aVal).localeCompare(String(bVal));
    }
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

    // Client name
    const tdClient = document.createElement("td");
    tdClient.textContent = c.clientName || "\u2014";
    tr.appendChild(tdClient);

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
  if (activeScrapes[c.id]) {
    const state = escapeHtml(activeScrapes[c.id]);
    return `<span class="scrape-status"><span class="status-dot active"></span>${state}</span>`;
  }
  if (c.lastScraped) {
    const rel = formatRelativeTime(c.lastScraped);
    return `<span class="scrape-status"><span class="status-dot done"></span>${escapeHtml(rel)}</span>`;
  }
  return `<span class="scrape-status"><span class="status-dot never"></span>Never</span>`;
}

function buildActionButtons(c: Case): string {
  const scrapeLabel = activeScrapes[c.id] ? "Scraping..." : "Scrape";
  const scrapeDisabled = activeScrapes[c.id] ? "disabled" : "";
  let html = `<button class="btn btn-sm btn-outline" data-action="scrape" data-case-id="${escapeHtml(c.id)}" ${scrapeDisabled}>${scrapeLabel}</button>`;
  html += `<button class="btn btn-sm btn-outline" data-action="edit" data-case-id="${escapeHtml(c.id)}">Edit</button>`;
  html += `<button class="btn btn-sm btn-danger" data-action="delete" data-case-id="${escapeHtml(c.id)}">Delete</button>`;
  if (c.scrapedHtml) {
    html += `<button class="btn btn-sm btn-outline" data-action="preview" data-case-id="${escapeHtml(c.id)}">Preview</button>`;
  }
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
  activeScrapes[id] = "init";
  renderTable();
}

function editCase(id: string): void {
  const c = cases.find((x) => x.id === id);
  if (!c) return;
  showModal("edit", c);
}

function confirmDeleteCase(id: string): void {
  const c = cases.find((x) => x.id === id);
  const label = c ? `${c.id} (${c.clientName || "unnamed"})` : id;
  if (!confirm(`Delete case ${label}? This cannot be undone.`)) return;

  deleteCase(id).then(async () => {
    cases = await getCases();
    renderTable();
  });
}

function previewCase(id: string): void {
  const c = cases.find((x) => x.id === id);
  if (!c || !c.scrapedHtml) return;
  console.debug("Previewing scraped HTML for case", c.scrapedHtml.slice(0, 100));
  const blob = new Blob([c.scrapedHtml], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  chrome.tabs.create({ url });
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
    editingCaseId = null;
    caseIdInput.value = prefilledCaseId || "";
    caseIdInput.disabled = false;
    clientNameInput.value = "";
    notesInput.value = "";
  } else if (mode === "edit" && caseData) {
    modalTitle.textContent = "Edit Case";
    editingCaseId = caseData.id;
    caseIdInput.value = caseData.id;
    caseIdInput.disabled = true; // Cannot change case ID when editing
    clientNameInput.value = caseData.clientName;
    notesInput.value = caseData.notes;
  }

  caseModal.hidden = false;
  // Focus the first editable field
  if (mode === "add") {
    caseIdInput.focus();
  } else {
    clientNameInput.focus();
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
  const clientName = clientNameInput.value.trim();
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
    // Update existing case
    await updateCase(editingCaseId, { clientName, notes });
  } else {
    // Add new case
    const newCase: Case = {
      id: rawId,
      clientName,
      notes,
      lastScraped: null,
      nextCourtDateTime: null,
      scrapedHtml: null,
    };
    await addCase(newCase);
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
        // If any jobs finished, reload case data (they may have new scrapedHtml / nextCourtDate)
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

function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();

  if (diffMs < 0) return "just now";

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return "just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours !== 1 ? "s" : ""} ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days !== 1 ? "s" : ""} ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months !== 1 ? "s" : ""} ago`;

  const years = Math.floor(months / 12);
  return `${years} year${years !== 1 ? "s" : ""} ago`;
}

/** Format a datetime string like "2024-07-15T14:30:00" as "Jul 15 (year), 8:30 AM" and highlight if within 7 days
 * 
 * If the year is the current year, it will be omitted for brevity.
*/
function formatCourtDateTime(datetimeStr: string | null): string {
  if (!datetimeStr) return "\u2014";

  const date = new Date(datetimeStr);
  if (isNaN(date.getTime())) {
    return escapeHtml(datetimeStr);
  }

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

  const formatted = `${datePart}, ${timePart}`;

  if (diffDays >= 0 && diffDays <= 7) {
    return `<span class="upcoming">${escapeHtml(formatted)}</span>`;
  }

  return escapeHtml(formatted);
}
