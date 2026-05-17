import {
  BOOK_COUNT,
  MACRO_LINE_COUNT,
  MACRO_LINE_LIMIT,
  createBlankMacroSet,
  exportBundleFiles,
  exportMacroSetFiles,
  inspectMacroFiles
} from './lib/ffxiMacroFormat.js';
import { zipSync } from 'https://cdn.jsdelivr.net/npm/fflate@0.8.3/esm/browser.js';

function sanitizeMacroLineInput(value) {
  return String(value ?? '').replace(/\r\n?|\n/g, ' ');
}

const state = {
  macroSet: createBlankMacroSet(),
  bundleSearchTerm: '',
  selectedBundleKey: null,
  selectedParsedBookKey: null,
  selectedMacroFileName: null,
  selectedBookIndex: 0,
  selectedPageIndex: 0,
  selectedSlotId: 'ctrl-1',
  slotFilter: 'all',
  importScope: 'bundle'
};

const elements = {
  pageShell: document.querySelector('#page-shell'),
  bookPanelTitle: document.querySelector('#book-panel-title'),
  bookCountLabel: document.querySelector('#book-count-label'),
  bundleSearchInput: document.querySelector('#bundle-search-input'),
  bookList: document.querySelector('#book-list'),
  bundleSelector: document.querySelector('#bundle-selector'),
  macroFileSelector: document.querySelector('#macro-file-selector'),
  pageSelector: document.querySelector('#page-selector'),
  slotFilter: document.querySelector('#slot-filter'),
  statusPill: document.querySelector('#status-pill'),
  currentLocationLabel: document.querySelector('#current-location-label'),
  slotGrid: document.querySelector('#slot-grid'),
  selectedSlotTitle: document.querySelector('#selected-slot-title'),
  selectedSlotModifier: document.querySelector('#selected-slot-modifier'),
  macroNameInput: document.querySelector('#macro-name-input'),
  macroLines: document.querySelector('#macro-lines'),
  fileMetadata: document.querySelector('#file-metadata'),
  formatStatus: document.querySelector('#format-status'),
  macroFileInput: document.querySelector('#macro-file-input'),
  macroFolderInput: document.querySelector('#macro-folder-input'),
  downloadBundleButton: document.querySelector('#download-bundle-button'),
  exportStatus: document.querySelector('#export-status'),
  createBlankButton: document.querySelector('#create-blank-button')
};

function getCurrentExportReport() {
  if (state.importScope === 'macro-set') {
    return (state.macroSet.bundles?.length ?? 0) > 0 ? exportMacroSetFiles(state.macroSet) : null;
  }

  const bundle = getCurrentBundle();
  return bundle ? exportBundleFiles(bundle) : null;
}

function getZipEntryPath(bundleLabel, file) {
  const relativePath = (file.relativePath || `${bundleLabel}/${file.fileName}`).replace(/\\/g, '/').replace(/^\/+/, '');
  return relativePath || file.fileName;
}

function createDownloadName(bundleLabel) {
  const safeLabel = String(bundleLabel || 'macro-bundle').replace(/[^a-z0-9._-]+/gi, '_');
  return `${safeLabel}.zip`;
}

function downloadCurrentBundleZip() {
  const exportReport = getCurrentExportReport();
  if (!exportReport?.roundTripReady) {
    return;
  }

  const zipEntries = Object.fromEntries(exportReport.files.map((file) => [
    getZipEntryPath(exportReport.label, file),
    file.bytes
  ]));
  const zipBytes = zipSync(zipEntries, { level: 0 });
  const blob = new Blob([zipBytes], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = createDownloadName(exportReport.label);
  link.click();

  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function getCurrentBundle() {
  const bundles = getVisibleBundles();
  return bundles.find((bundle) => bundle.bundleKey === state.selectedBundleKey) ?? state.macroSet.rawBundle ?? null;
}

function formatBytes(byteLength) {
  if (!Number.isFinite(byteLength) || byteLength <= 0) {
    return '0 B';
  }

  if (byteLength < 1024) {
    return `${byteLength} B`;
  }

  if (byteLength < 1024 * 1024) {
    return `${(byteLength / 1024).toFixed(1)} KB`;
  }

  return `${(byteLength / (1024 * 1024)).toFixed(2)} MB`;
}

function getVisibleBundles() {
  const bundles = state.macroSet.bundles ?? [];
  const searchTerm = state.bundleSearchTerm.trim().toLowerCase();

  if (!searchTerm) {
    return bundles;
  }

  return bundles.filter((bundle) => bundle.searchText?.includes(searchTerm));
}

function syncSelectedBundle() {
  const visibleBundles = getVisibleBundles();
  if (visibleBundles.length === 0) {
    state.selectedBundleKey = null;
    state.selectedParsedBookKey = null;
    state.selectedMacroFileName = null;
    return;
  }

  const currentBundleVisible = visibleBundles.some((bundle) => bundle.bundleKey === state.selectedBundleKey);
  if (!currentBundleVisible) {
    state.selectedBundleKey = visibleBundles[0].bundleKey;
    state.selectedParsedBookKey = visibleBundles[0].parsedBooks?.[0]?.bookKey ?? null;
    state.selectedMacroFileName = visibleBundles[0].parsedBooks?.[0]?.pages.find((page) => page.usedSlotCount > 0)?.fileName ?? visibleBundles[0].parsedBooks?.[0]?.pages[0]?.fileName ?? null;
  }
}

function getCurrentParsedBook() {
  const bundle = getCurrentBundle();
  const parsedBooks = bundle?.parsedBooks ?? [];
  return parsedBooks.find((book) => book.bookKey === state.selectedParsedBookKey) ?? parsedBooks[0] ?? null;
}

function getCurrentParsedMacroFile() {
  const parsedBook = getCurrentParsedBook();
  const pages = parsedBook?.pages ?? [];
  return pages.find((page) => page.fileName === state.selectedMacroFileName)?.file ?? pages[0]?.file ?? null;
}

function getActiveSlots() {
  const parsedMacroFile = getCurrentParsedMacroFile();
  if (parsedMacroFile) {
    return parsedMacroFile.slots;
  }

  return getCurrentPage().slots;
}

function getCurrentBook() {
  return state.macroSet.books[state.selectedBookIndex];
}

function getCurrentPage() {
  return getCurrentBook().pages[state.selectedPageIndex];
}

function getCurrentSlot() {
  const slots = getActiveSlots();
  return slots.find((slot) => slot.id === state.selectedSlotId) ?? slots[0];
}

function updateMetadata() {
  const rawBundle = getCurrentBundle();
  const exportReport = getCurrentExportReport();
  const rows = rawBundle
    ? [
        ['Download scope', state.importScope === 'macro-set' ? 'Imported macro backup set' : 'Current bundle'],
        ['Bundle', rawBundle.label],
        ['Files', String(rawBundle.fileCount)],
        ['Profile size', formatBytes(rawBundle.totalByteLength)],
        ['mcr*.dat', String(rawBundle.macroDatCount)],
        ['ttl metadata', String(rawBundle.macroMetaCount)],
        ['cmb*.dat', String(rawBundle.paletteDatCount)],
        ['Parsed macro files', String(rawBundle.parsedMacroFiles?.length ?? 0)],
        ['Extracted titles', String(rawBundle.titles?.filter(Boolean).length ?? 0)],
        ['Exact byte matches', exportReport ? `${exportReport.exactMatchCount}/${exportReport.files.length}` : 'n/a'],
        ['Changed files', exportReport ? String(exportReport.changedFileCount) : 'n/a'],
        ['Sample file', rawBundle.files[0]?.relativePath || rawBundle.files[0]?.fileName || 'n/a'],
        ['Sample header', rawBundle.files[0]?.firstBytesHex || 'n/a']
      ]
    : [
      ['Download scope', 'Current bundle'],
        ['Bundle', 'Blank workspace'],
        ['Files', '0'],
        ['Profile size', '0 B'],
        ['mcr*.dat', '0'],
        ['ttl metadata', '0'],
        ['cmb*.dat', '0'],
        ['Parsed macro files', '0'],
        ['Extracted titles', '0'],
        ['Exact byte matches', 'n/a'],
        ['Changed files', 'n/a'],
        ['Sample file', 'n/a'],
        ['Sample header', 'n/a']
      ];

  elements.fileMetadata.replaceChildren(...rows.flatMap(([label, value]) => {
    const term = document.createElement('dt');
    term.textContent = label;
    const detail = document.createElement('dd');
    detail.textContent = value;
    return [term, detail];
  }));
}

function updateStatus() {
  const exportReport = getCurrentExportReport();
  if (exportReport?.files.length && exportReport.changedFileCount === 0) {
    elements.statusPill.textContent = 'Round-trip verified';
  } else if (exportReport?.roundTripReady) {
    elements.statusPill.textContent = 'Export ready';
  } else {
    elements.statusPill.textContent = getCurrentParsedMacroFile() ? 'Parsed macro file' : (state.macroSet.parsed ? 'Editable shell ready' : 'Inspection mode');
  }
  elements.formatStatus.textContent = state.macroSet.notes.join(' ');
}

function renderExportState() {
  const exportReport = getCurrentExportReport();

  if (!exportReport?.files.length) {
    elements.downloadBundleButton.disabled = true;
    elements.downloadBundleButton.textContent = 'Download Bundle Zip';
    elements.exportStatus.textContent = 'Load a macro backup bundle or folder to validate in-memory round-trip and prepare a zip export.';
    return;
  }

  elements.downloadBundleButton.disabled = !exportReport.roundTripReady;
  elements.downloadBundleButton.textContent = exportReport.scope === 'macro-set' ? 'Download Macro Backup Zip' : 'Download Bundle Zip';

  if (exportReport.scope === 'macro-set') {
    if (exportReport.changedFileCount === 0) {
      elements.exportStatus.textContent = `${exportReport.exactMatchCount}/${exportReport.files.length} files across ${exportReport.bundleCount} bundle${exportReport.bundleCount === 1 ? '' : 's'} match the original bytes exactly. Download will recreate the imported macro backup structure.`;
      return;
    }

    elements.exportStatus.textContent = `${exportReport.exactMatchCount}/${exportReport.files.length} files across ${exportReport.bundleCount} bundle${exportReport.bundleCount === 1 ? '' : 's'} still match the original bytes exactly. Download will recreate the imported macro backup structure with edited macro files re-serialized.`;
    return;
  }

  if (exportReport.changedFileCount === 0) {
    elements.exportStatus.textContent = `${exportReport.exactMatchCount}/${exportReport.files.length} files match the original bytes exactly in memory. The zip will preserve the imported folder structure.`;
    return;
  }

  elements.exportStatus.textContent = `${exportReport.exactMatchCount}/${exportReport.files.length} files still match the original bytes exactly. ${exportReport.changedFileCount} edited macro file${exportReport.changedFileCount === 1 ? '' : 's'} will be re-serialized into the zip while untouched files stay byte-identical.`;
}

function refreshEditIndicators() {
  renderExportState();
  updateMetadata();
  updateStatus();
}

function updateLayoutMode() {
  const hasData = Boolean(getCurrentBundle()?.fileCount);
  elements.pageShell.classList.toggle('has-data', hasData);
}

function renderBundles() {
  const bundles = getVisibleBundles();

  elements.bundleSearchInput.value = state.bundleSearchTerm;
  elements.bundleSearchInput.disabled = (state.macroSet.bundles?.length ?? 0) === 0;

  elements.bundleSelector.replaceChildren(...(bundles.length > 0
    ? bundles.map((bundle) => {
        const option = document.createElement('option');
        option.value = bundle.bundleKey;
        option.textContent = `${bundle.label} (${bundle.fileCount} files, ${formatBytes(bundle.totalByteLength)})`;
        option.selected = bundle.bundleKey === state.selectedBundleKey;
        return option;
      })
    : [(() => {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'Blank workspace';
        option.selected = true;
        return option;
      })()]));

  elements.bundleSelector.disabled = bundles.length <= 1;
}

function renderBooks() {
  const bundle = getCurrentBundle();
  const parsedBooks = bundle?.parsedBooks ?? [];

  if (parsedBooks.length > 0) {
    elements.bookPanelTitle.textContent = 'Books';
    elements.bookCountLabel.textContent = `${parsedBooks.length} parsed`;
    elements.bookList.replaceChildren(...parsedBooks.map((book) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `book-button${book.bookKey === state.selectedParsedBookKey ? ' active' : ''}`;
      button.textContent = book.title;
      button.title = book.title;
      button.addEventListener('click', () => {
        state.selectedParsedBookKey = book.bookKey;
        state.selectedMacroFileName = book.pages.find((page) => page.usedSlotCount > 0)?.fileName ?? book.pages[0]?.fileName ?? null;
        state.selectedSlotId = 'ctrl-1';
        render();
      });
      const meta = document.createElement('span');
      meta.className = 'book-button-meta';
      meta.textContent = `${book.pages.length} page${book.pages.length === 1 ? '' : 's'} · ${book.usedPageCount} used`;
      button.appendChild(meta);
      return button;
    }));
    return;
  }

  elements.bookPanelTitle.textContent = 'Books';
  elements.bookCountLabel.textContent = `${BOOK_COUNT} books`;
  elements.bookList.replaceChildren(...state.macroSet.books.map((book, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `book-button${index === state.selectedBookIndex ? ' active' : ''}`;
    button.textContent = book.label;
    button.addEventListener('click', () => {
      state.selectedBookIndex = index;
      state.selectedPageIndex = 0;
      state.selectedSlotId = 'ctrl-1';
      render();
    });
    return button;
  }));
}

function renderMacroFiles() {
  const parsedBook = getCurrentParsedBook();
  const parsedPages = parsedBook?.pages ?? [];

  elements.macroFileSelector.replaceChildren(...(parsedPages.length > 0
    ? parsedPages.map((page) => {
        const option = document.createElement('option');
        option.value = page.fileName;
        option.textContent = `${page.label} (${page.fileName})${page.usedSlotCount > 0 ? ` · ${page.usedSlotCount}/20 used` : ''}`;
        option.selected = page.fileName === state.selectedMacroFileName;
        return option;
      })
    : [(() => {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'No parsed macro file';
        option.selected = true;
        return option;
      })()]));

  elements.macroFileSelector.disabled = parsedPages.length === 0;
}

function renderPages() {
  const parsedBook = getCurrentParsedBook();
  if (parsedBook) {
    elements.pageSelector.replaceChildren(...parsedBook.pages.map((page) => {
      const option = document.createElement('option');
      option.value = page.fileName;
      option.textContent = `${page.label}${page.usedSlotCount > 0 ? ` · ${page.usedSlotCount}/20 used` : ''}`;
      option.selected = page.fileName === state.selectedMacroFileName;
      return option;
    }));
    elements.pageSelector.disabled = false;
    return;
  }

  const currentBook = getCurrentBook();
  elements.pageSelector.replaceChildren(...currentBook.pages.map((page, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = page.label;
    option.selected = index === state.selectedPageIndex;
    return option;
  }));
  elements.pageSelector.disabled = false;
}

function renderSlots() {
  const slots = getActiveSlots();
  const groups = [
    { key: 'ctrl', title: 'Ctrl' },
    { key: 'alt', title: 'Alt' }
  ].filter((group) => state.slotFilter === 'all' || state.slotFilter === group.key);

  elements.slotGrid.replaceChildren(...groups.map((group) => {
    const column = document.createElement('section');
    column.className = 'slot-column';

    const heading = document.createElement('h3');
    heading.textContent = `${group.title} Palette`;
    column.appendChild(heading);

    const items = document.createElement('div');
    items.className = 'slot-items';

    slots
      .filter((slot) => slot.modifier === group.key)
      .forEach((slot) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `slot-button${slot.id === state.selectedSlotId ? ' active' : ''}`;
        button.title = `${group.title}-${slot.key}: ${slot.name || '(empty)'}`;
        button.addEventListener('click', () => {
          state.selectedSlotId = slot.id;
          renderEditor();
          renderSlots();
        });

        const label = document.createElement('span');
        label.className = 'slot-label';
        label.textContent = `${group.title}-${slot.key}`;

        const name = document.createElement('span');
        name.className = 'slot-name';
        name.textContent = slot.name || '(empty)';

        button.append(label, name);
        items.appendChild(button);
      });

    column.appendChild(items);

    return column;
  }));

  const parsedMacroFile = getCurrentParsedMacroFile();
  if (parsedMacroFile) {
    elements.currentLocationLabel.textContent = `${getCurrentBundle()?.label || 'Bundle'} / ${getCurrentParsedBook()?.title || parsedMacroFile.candidateTitle || parsedMacroFile.fileName} / Page ${parsedMacroFile.pageIndex + 1}`;
    return;
  }

  const currentBook = getCurrentBook();
  elements.currentLocationLabel.textContent = `${currentBook.label} / ${getCurrentPage().label}`;
}

function renderEditor() {
  const slot = getCurrentSlot();
  elements.selectedSlotTitle.textContent = `${slot.modifier.toUpperCase()}-${slot.key}`;
  elements.selectedSlotModifier.textContent = slot.modifier.toUpperCase();
  elements.macroNameInput.value = slot.name;

  const lineEditors = Array.from({ length: MACRO_LINE_COUNT }, (_, index) => {
    const line = slot.lines[index] ?? '';
    const wrapper = document.createElement('label');
    wrapper.className = 'line-editor';

    const header = document.createElement('div');
    header.className = 'line-header';

    const label = document.createElement('span');
    label.textContent = `Line ${index + 1}`;

    const counter = document.createElement('span');
    counter.className = `counter${line.length > MACRO_LINE_LIMIT ? ' over-limit' : ''}`;
    counter.textContent = `${line.length}/${MACRO_LINE_LIMIT}`;

    const textarea = document.createElement('textarea');
    textarea.value = line;
    textarea.placeholder = '/ja "Ability" <t>';
    textarea.addEventListener('input', (event) => {
      slot.lines[index] = sanitizeMacroLineInput(event.currentTarget.value);
      renderEditor();
      renderSlots();
      refreshEditIndicators();
    });

    header.append(label, counter);
    wrapper.append(header, textarea);
    return wrapper;
  });

  elements.macroLines.replaceChildren(...lineEditors);
}

function render() {
  syncSelectedBundle();
  updateLayoutMode();
  renderBundles();
  renderMacroFiles();
  renderBooks();
  renderPages();
  renderSlots();
  renderEditor();
  renderExportState();
  updateMetadata();
  updateStatus();
}

elements.bundleSelector.addEventListener('change', (event) => {
  state.selectedBundleKey = event.currentTarget.value || null;
  state.selectedParsedBookKey = getCurrentBundle()?.parsedBooks?.[0]?.bookKey ?? null;
  state.selectedMacroFileName = getCurrentBundle()?.parsedBooks?.[0]?.pages.find((page) => page.usedSlotCount > 0)?.fileName ?? getCurrentBundle()?.parsedBooks?.[0]?.pages[0]?.fileName ?? null;
  state.selectedSlotId = 'ctrl-1';
  render();
});

elements.bundleSearchInput.addEventListener('input', (event) => {
  state.bundleSearchTerm = event.currentTarget.value;
  state.selectedSlotId = 'ctrl-1';
  render();
});

elements.macroFileSelector.addEventListener('change', (event) => {
  state.selectedMacroFileName = event.currentTarget.value || null;
  state.selectedSlotId = 'ctrl-1';
  render();
});

elements.pageSelector.addEventListener('change', (event) => {
  const parsedBook = getCurrentParsedBook();
  if (parsedBook) {
    state.selectedMacroFileName = event.currentTarget.value || null;
  } else {
    state.selectedPageIndex = Number.parseInt(event.currentTarget.value, 10);
  }
  state.selectedSlotId = 'ctrl-1';
  render();
});

elements.slotFilter.addEventListener('change', (event) => {
  state.slotFilter = event.currentTarget.value;
  renderSlots();
});

elements.macroNameInput.addEventListener('input', (event) => {
  const slot = getCurrentSlot();
  slot.name = event.currentTarget.value;
  renderSlots();
  refreshEditIndicators();
});

elements.createBlankButton.addEventListener('click', () => {
  state.macroSet = createBlankMacroSet();
  state.importScope = 'bundle';
  state.selectedBundleKey = null;
  state.selectedParsedBookKey = null;
  state.selectedMacroFileName = null;
  state.selectedBookIndex = 0;
  state.selectedPageIndex = 0;
  state.selectedSlotId = 'ctrl-1';
  render();
});

elements.downloadBundleButton.addEventListener('click', () => {
  downloadCurrentBundleZip();
});

async function importFiles(fileList, importScope = 'bundle') {
  const files = Array.from(fileList ?? []);
  if (files.length === 0) {
    return;
  }

  state.macroSet = await inspectMacroFiles(files);
  state.importScope = importScope;
  state.bundleSearchTerm = '';
  state.selectedBundleKey = state.macroSet.rawBundle?.bundleKey ?? null;
  state.selectedParsedBookKey = state.macroSet.rawBundle?.parsedBooks?.[0]?.bookKey ?? null;
  state.selectedMacroFileName = state.macroSet.rawBundle?.parsedBooks?.[0]?.pages.find((page) => page.usedSlotCount > 0)?.fileName ?? state.macroSet.rawBundle?.parsedBooks?.[0]?.pages[0]?.fileName ?? null;
  state.selectedBookIndex = 0;
  state.selectedPageIndex = 0;
  state.selectedSlotId = 'ctrl-1';
  render();
}

elements.macroFileInput.addEventListener('change', async (event) => {
  await importFiles(event.currentTarget.files, 'bundle');
});

elements.macroFolderInput.addEventListener('change', async (event) => {
  await importFiles(event.currentTarget.files, 'macro-set');
});

render();