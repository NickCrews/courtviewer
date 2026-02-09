# Alaska Court Viewer

A Chrome extension for tracking and automatically looking up Alaska court case information.

Alaska Court Viewer helps you manage a list of court cases, automatically look up case details from the Alaska Court System's CourtView website, and view upcoming court dates in a sortable, searchable table -- all from your browser toolbar.

---

## Installation Instructions

### Step 1: Download the Extension

- Download this project as a ZIP file from GitHub (or receive it from your IT department).
- Unzip it to a folder you will remember, such as your Desktop.

### Step 2: Build the Extension (One-Time Setup)

You only need to do this once (or again if you receive an updated version).

1. **Install Node.js** -- visit [https://nodejs.org](https://nodejs.org), download the **LTS** version, and run the installer. Accept all the default options.
2. **Open a terminal or command prompt:**
   - On **Windows**: press the Windows key, type `cmd`, and press Enter.
   - On **Mac**: open the Terminal app (found in Applications > Utilities).
3. **Navigate to the unzipped folder.** For example, if you unzipped it to your Desktop:
   ```
   cd Desktop/courtviewer
   ```
4. **Install the required tools** by running:
   ```
   npm install
   ```
5. **Build the extension** by running:
   ```
   npm run build
   ```
6. When the build finishes, a `dist/` folder will appear inside the courtviewer directory. This folder contains the ready-to-use extension.

### Step 3: Install in Chrome

1. Open Chrome and type `chrome://extensions/` in the address bar, then press Enter.
2. In the top-right corner of the page, enable **Developer mode** by clicking the toggle switch.
3. Click the **"Load unpacked"** button that appears.
4. In the file picker, navigate to the courtviewer folder and select the **`dist`** folder inside it. Click "Select Folder" (or "Open").
5. The Alaska Court Viewer icon will appear in your Chrome toolbar.
6. *(Optional)* To keep the icon always visible, click the **puzzle piece** icon in the toolbar and click the **pin** icon next to "Alaska Court Viewer."

---

## How to Use

### Adding Cases

1. Click the Alaska Court Viewer icon in your Chrome toolbar. A popup window will appear.
2. Click **"Add Case."**
3. Enter the case number (for example, `3AN-24-00123CR`), the client name, and any notes you would like to save.
4. Click **Save.**

### Viewing Your Cases

- All of your cases are displayed in a table inside the popup.
- **Sort** by clicking any column header. Click the same header again to reverse the sort order.
- **Search** using the search bar to filter by client name, case ID, or notes.
- The **"Next Court Date"** column shows the next upcoming hearing date for each case.
- The **"Last Scraped"** column shows when the extension last looked up information for that case on CourtView.

### Looking Up Case Information

- Click **"Scrape Now"** next to any individual case to look up its latest information from CourtView.
- Click **"Scrape All"** to look up all of your cases at once. The extension opens background tabs to check each case on the CourtView website.
- The extension will automatically navigate the CourtView website, search for the case, and extract the next court date.
- Results appear in the table once the lookup is complete.
- Click **"Preview"** to see the full case detail page exactly as it appeared on CourtView.

### Editing and Deleting Cases

- Click **"Edit"** next to a case to change its client name or notes.
- Click **"Delete"** to remove a case. This also removes any scraped data that was saved for that case.

---

## Where Your Data is Stored

**This is important information about your data:**

- All case data (case numbers, client names, notes, and scraped court information) is stored **locally in your Chrome browser** using Chrome's built-in storage. Nothing is sent anywhere else.
- Your data **never leaves your computer.** It is not sent to any server, cloud service, or third party.
- Your data persists across browser restarts and computer reboots. You do not need to save manually.
- Your data is tied to your **Chrome profile.** If you use multiple Chrome profiles, each one has its own separate set of data.
- **Clearing Chrome's browsing data** (specifically the "Extensions" category) will delete your Court Viewer data.
- **Uninstalling the extension** will permanently delete all stored data.
- There is **no automatic backup.** Consider periodically writing down critical case information elsewhere as a safeguard.
- Scraped HTML pages are saved locally so that you can preview them later. This means storage usage grows as you add and scrape more cases, but everything stays on your machine.

---

## Troubleshooting

- **The extension icon does not appear in the toolbar.**
  Make sure Developer Mode is enabled on the `chrome://extensions/` page, and that you loaded the `dist` folder (not the top-level courtviewer folder).

- **Scraping does not work.**
  The extension needs to access `records.courts.alaska.gov`. Open that site in a regular browser tab first to confirm it loads. If the site is down or blocked by your network, the extension will not be able to retrieve case information.

- **A scrape is taking too long.**
  The CourtView website can be slow. Each lookup may take 15 to 30 seconds. If it appears stuck for more than a minute, close the background tab and try again.

- **No court date is showing for a case.**
  Some cases may not have upcoming events scheduled on CourtView. The extension displays a dash ("--") when no future court date is found.

- **My data seems to have disappeared.**
  Check that you are using the same Chrome profile you were using before. Data does not sync between different profiles or different devices.

---

## For Developers

### Building

```bash
npm install
npm run build
```

### Testing

```bash
npx playwright install chromium
npm test
```

### Project Structure

| Folder / File | Description |
|---|---|
| `src/popup/` | The extension popup UI that appears when you click the toolbar icon. |
| `src/background/` | The service worker that orchestrates scraping behind the scenes. |
| `src/content/` | Content script that is injected into CourtView website pages to extract case data. |
| `src/types.ts` | Shared TypeScript type definitions used across the project. |
| `src/storage.ts` | Wrapper around the Chrome storage API for reading and writing case data. |
| `tests/` | Playwright end-to-end test suite. |
| `dist/` | The built extension, generated by `npm run build`. This is the folder you load into Chrome. |

### Technology

- **TypeScript**, compiled to ES2020.
- **Chrome Extension Manifest V3.**
- **Playwright** for automated testing.
- **No runtime dependencies** -- pure TypeScript compiled to vanilla JavaScript.
