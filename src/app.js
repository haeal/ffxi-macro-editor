import {
  BOOK_COUNT,
  MACRO_LINE_COUNT,
  MACRO_LINE_LIMIT,
  createBlankMacroSet,
  exportBundleFiles,
  exportMacroSetFiles,
  getMacroLineByteLength,
  inspectMacroFiles
} from './lib/ffxiMacroFormat.js';
import { AUTO_TRANSLATE_PHRASES } from './lib/ffxiAutoTranslateData.js';
import {
  applyEditableJsonPayload,
  getEditableJsonPayload,
  serializeEditableJsonPayload,
  syncBundleUsageMetrics,
  validateAndNormalizeEditableJsonPayload
} from './lib/editableJsonBridge.js';
import { zipSync } from 'https://cdn.jsdelivr.net/npm/fflate@0.8.3/esm/browser.js';

const AUTO_TRANSLATE_OPEN = '《';
const AUTO_TRANSLATE_CLOSE = '》';
const AUTO_TRANSLATE_RESULT_LIMIT = 60;
const BLANK_JSON_DRAFT_KEY = '__blank-workspace__';
const MONACO_BASE_URL = new URL('../vendor/monaco/vs', import.meta.url).href.replace(/\/$/, '');
const AUTO_TRANSLATE_CHOICES = Array.from(new Set(AUTO_TRANSLATE_PHRASES.values()))
  .filter((phrase) => phrase && phrase.trim().length >= 3)
  .sort((left, right) => left.localeCompare(right));

function sanitizeMacroLineInput(value) {
  return String(value ?? '').replace(/\r\n?|\n/g, ' ');
}

function getMacroLineCounterText(value) {
  return `${getMacroLineByteLength(value)}/${MACRO_LINE_LIMIT}`;
}

function isMacroLineOverLimit(value) {
  return getMacroLineByteLength(value) > MACRO_LINE_LIMIT;
}

function normalizeAutoTranslateSearchTerm(value) {
  return String(value ?? '').replace(/[《》]/g, '').trim();
}

function formatAutoTranslateDisplay(phrase) {
  return `${AUTO_TRANSLATE_OPEN}${phrase}${AUTO_TRANSLATE_CLOSE}`;
}

function getAutoTranslateTokenRanges(value) {
  const ranges = [];
  const tokenPattern = /《[^》]+》/g;

  for (const match of String(value ?? '').matchAll(tokenPattern)) {
    ranges.push({
      start: match.index,
      end: match.index + match[0].length
    });
  }

  return ranges;
}

function rangesIntersect(leftStart, leftEnd, rightStart, rightEnd) {
  return leftStart < rightEnd && leftEnd > rightStart;
}

function getProtectedTokenSelection(value, selectionStart, selectionEnd, mode = 'replace') {
  const normalizedValue = String(value ?? '');
  const tokens = getAutoTranslateTokenRanges(normalizedValue);

  if (tokens.length === 0) {
    return null;
  }

  if (selectionStart === selectionEnd) {
    if (mode === 'backward-delete') {
      return tokens.find((token) => (selectionStart > token.start && selectionStart < token.end) || selectionStart === token.end) ?? null;
    }

    if (mode === 'forward-delete') {
      return tokens.find((token) => (selectionStart > token.start && selectionStart < token.end) || selectionStart === token.start) ?? null;
    }

    return tokens.find((token) => selectionStart > token.start && selectionStart < token.end) ?? null;
  }

  const overlappingTokens = tokens.filter((token) => rangesIntersect(selectionStart, selectionEnd, token.start, token.end));
  if (overlappingTokens.length === 0) {
    return null;
  }

  return {
    start: Math.min(selectionStart, ...overlappingTokens.map((token) => token.start)),
    end: Math.max(selectionEnd, ...overlappingTokens.map((token) => token.end))
  };
}

function isInsideQuotes(value, index) {
  const precedingText = String(value ?? '').slice(0, Math.max(0, index));
  return (precedingText.match(/"/g) ?? []).length % 2 === 1;
}

function getAutoTranslateInsertionContext(value, selectionStart, selectionEnd) {
  const normalizedValue = String(value ?? '');

  if (selectionEnd > selectionStart) {
    return {
      insertionStart: selectionStart,
      insertionEnd: selectionEnd,
      searchTerm: normalizeAutoTranslateSearchTerm(normalizedValue.slice(selectionStart, selectionEnd))
    };
  }

  const tokenStart = normalizedValue.lastIndexOf(AUTO_TRANSLATE_OPEN, selectionStart);
  const tokenEnd = normalizedValue.indexOf(AUTO_TRANSLATE_CLOSE, selectionStart);

  if (tokenStart !== -1 && tokenEnd !== -1 && tokenStart < selectionStart && selectionStart <= tokenEnd) {
    return {
      insertionStart: tokenStart,
      insertionEnd: tokenEnd + 1,
      searchTerm: normalizeAutoTranslateSearchTerm(normalizedValue.slice(tokenStart, tokenEnd + 1))
    };
  }

  return {
    insertionStart: selectionStart,
    insertionEnd: selectionEnd,
    searchTerm: ''
  };
}

function getAutoTranslateResults(searchTerm) {
  const normalizedSearchTerm = normalizeAutoTranslateSearchTerm(searchTerm).toLowerCase();

  if (!normalizedSearchTerm) {
    return AUTO_TRANSLATE_CHOICES.slice(0, AUTO_TRANSLATE_RESULT_LIMIT);
  }

  const prefixMatches = [];
  const substringMatches = [];

  for (const phrase of AUTO_TRANSLATE_CHOICES) {
    const lowercasePhrase = phrase.toLowerCase();
    if (lowercasePhrase.startsWith(normalizedSearchTerm)) {
      prefixMatches.push(phrase);
    } else if (lowercasePhrase.includes(normalizedSearchTerm)) {
      substringMatches.push(phrase);
    }

    if (prefixMatches.length >= AUTO_TRANSLATE_RESULT_LIMIT) {
      break;
    }
  }

  return [...prefixMatches, ...substringMatches].slice(0, AUTO_TRANSLATE_RESULT_LIMIT);
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
  detailTab: 'macro',
  jsonDrafts: {},
  importScope: 'bundle',
  autoTranslatePicker: {
    isOpen: false,
    target: 'macro',
    lineIndex: null,
    searchTerm: '',
    selectedIndex: 0,
    insertionStart: 0,
    insertionEnd: 0
  }
};

const elements = {
  pageShell: document.querySelector('#page-shell'),
  bookPanelTitle: document.querySelector('#book-panel-title'),
  bookCountLabel: document.querySelector('#book-count-label'),
  bundleSearchInput: document.querySelector('#bundle-search-input'),
  bookList: document.querySelector('#book-list'),
  bundleSelector: document.querySelector('#bundle-selector'),
  pageSelectorLabel: document.querySelector('#page-selector-label'),
  pageSelector: document.querySelector('#page-selector'),
  slotFilter: document.querySelector('#slot-filter'),
  statusPill: document.querySelector('#status-pill'),
  currentLocationLabel: document.querySelector('#current-location-label'),
  slotGrid: document.querySelector('#slot-grid'),
  detailTabMacro: document.querySelector('#detail-tab-macro'),
  detailTabJson: document.querySelector('#detail-tab-json'),
  detailTabContext: document.querySelector('#detail-tab-context'),
  detailPanelMacro: document.querySelector('#detail-panel-macro'),
  detailPanelJson: document.querySelector('#detail-panel-json'),
  detailPanelContext: document.querySelector('#detail-panel-context'),
  jsonSyncStatus: document.querySelector('#json-sync-status'),
  selectedSlotTitle: document.querySelector('#selected-slot-title'),
  selectedSlotModifier: document.querySelector('#selected-slot-modifier'),
  macroNameInput: document.querySelector('#macro-name-input'),
  macroLines: document.querySelector('#macro-lines'),
  jsonTargetLabel: document.querySelector('#json-target-label'),
  jsonStatusMessage: document.querySelector('#json-status-message'),
  jsonValidation: document.querySelector('#json-validation'),
  jsonEditor: document.querySelector('#json-editor'),
  formatJsonButton: document.querySelector('#format-json-button'),
  resetJsonButton: document.querySelector('#reset-json-button'),
  fileMetadata: document.querySelector('#file-metadata'),
  formatStatus: document.querySelector('#format-status'),
  macroFileInput: document.querySelector('#macro-file-input'),
  macroFolderInput: document.querySelector('#macro-folder-input'),
  downloadBundleButton: document.querySelector('#download-bundle-button'),
  exportStatus: document.querySelector('#export-status'),
  createBlankButton: document.querySelector('#create-blank-button')
};

let jsonEditorView = null;
let isSyncingJsonEditor = false;
let jsonEditorReadyPromise = null;

function loadExternalScript(src) {
  return new Promise((resolve, reject) => {
    const existingScript = document.querySelector(`script[data-external-src="${src}"]`);
    if (existingScript) {
      if (existingScript.dataset.loaded === 'true') {
        resolve();
        return;
      }

      existingScript.addEventListener('load', () => resolve(), { once: true });
      existingScript.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.dataset.externalSrc = src;
    script.addEventListener('load', () => {
      script.dataset.loaded = 'true';
      resolve();
    }, { once: true });
    script.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
    document.head.appendChild(script);
  });
}

function createJsonEditor() {
  if (jsonEditorReadyPromise) {
    return jsonEditorReadyPromise;
  }

  jsonEditorReadyPromise = loadExternalScript(`${MONACO_BASE_URL}/loader.js`).then(() => new Promise((resolve, reject) => {
    const monacoRequire = globalThis.require;
    if (typeof monacoRequire !== 'function') {
      reject(new Error('Monaco loader failed to initialize.'));
      return;
    }

    globalThis.MonacoEnvironment = {
      getWorkerUrl() {
        const workerSource = [
          `self.MonacoEnvironment = { baseUrl: '${MONACO_BASE_URL}/' };`,
          `importScripts('${MONACO_BASE_URL}/base/worker/workerMain.js');`
        ].join('\n');

        return `data:text/javascript;charset=utf-8,${encodeURIComponent(workerSource)}`;
      }
    };

    monacoRequire.config({ paths: { vs: MONACO_BASE_URL } });
    monacoRequire(['vs/editor/editor.main', 'vs/language/json/monaco.contribution'], () => {
      const monaco = globalThis.monaco;
      monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
        validate: true,
        allowComments: false,
        enableSchemaRequest: false,
        schemas: []
      });

      jsonEditorView = monaco.editor.create(elements.jsonEditor, {
        value: '',
        language: 'json',
        theme: 'vs-dark',
        automaticLayout: true,
        minimap: { enabled: true },
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        wrappingIndent: 'indent',
        tabSize: 2,
        insertSpaces: true,
        detectIndentation: false,
        renderWhitespace: 'selection',
        renderValidationDecorations: 'on',
        bracketPairColorization: { enabled: true },
        guides: {
          bracketPairs: true,
          indentation: true
        },
        folding: true,
        glyphMargin: true,
        lineNumbers: 'on',
        fontSize: 14,
        fontFamily: 'Cascadia Code, Fira Code, Consolas, monospace',
        padding: {
          top: 12,
          bottom: 12
        }
      });

      jsonEditorView.onDidChangeModelContent(() => {
        if (isSyncingJsonEditor) {
          return;
        }

        handleJsonEditorChange(jsonEditorView.getValue());
      });

      jsonEditorView.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Space, () => {
        openJsonAutoTranslatePicker();
      });

      resolve(jsonEditorView);
    }, reject);
  }));

  return jsonEditorReadyPromise;
}

function setJsonEditorText(value) {
  createJsonEditor().then(() => {
    const nextValue = String(value ?? '');
    const model = jsonEditorView.getModel();
    const currentValue = model?.getValue() ?? '';

    if (currentValue === nextValue) {
      jsonEditorView.layout();
      return;
    }

    isSyncingJsonEditor = true;
    model.setValue(nextValue);
    isSyncingJsonEditor = false;
    jsonEditorView.layout();
  });
}

function getJsonEditorSelectionOffsets() {
  if (!jsonEditorView) {
    return null;
  }

  const model = jsonEditorView.getModel();
  const selectionRange = jsonEditorView.getSelection();
  if (!model || !selectionRange) {
    return null;
  }

  return {
    selectionStart: model.getOffsetAt(selectionRange.getStartPosition()),
    selectionEnd: model.getOffsetAt(selectionRange.getEndPosition())
  };
}

function focusJsonEditorAtOffset(offset) {
  createJsonEditor().then(() => {
    const model = jsonEditorView.getModel();
    if (!model) {
      return;
    }

    const position = model.getPositionAt(Math.max(0, offset));
    const monaco = globalThis.monaco;
    jsonEditorView.focus();
    jsonEditorView.setSelection(new monaco.Selection(position.lineNumber, position.column, position.lineNumber, position.column));
    jsonEditorView.revealPositionInCenterIfOutsideViewport(position);
  });
}

function getCurrentEditableJsonPayload() {
  return getEditableJsonPayload({
    bundle: getCurrentBundle(),
    books: state.macroSet.books
  });
}

function getCurrentEditableJsonReferencePayload() {
  return getEditableJsonPayload({
    bundle: getCurrentBundle(),
    books: state.macroSet.books,
    includeEmpty: true
  });
}

function getCurrentJsonDraftKey() {
  return getCurrentBundle()?.bundleKey ?? BLANK_JSON_DRAFT_KEY;
}

function createJsonDraft(text, normalizedText) {
  return {
    text,
    normalizedText,
    lastStructuredNormalizedText: normalizedText,
    syntaxError: '',
    validationIssues: []
  };
}

function getCurrentJsonDraft() {
  const draftKey = getCurrentJsonDraftKey();
  const currentPayload = getCurrentEditableJsonPayload();
  const currentText = serializeEditableJsonPayload(currentPayload);
  const currentNormalizedText = JSON.stringify(currentPayload);
  const existingDraft = state.jsonDrafts[draftKey];

  if (!existingDraft) {
    const nextDraft = createJsonDraft(currentText, currentNormalizedText);
    state.jsonDrafts[draftKey] = nextDraft;
    return nextDraft;
  }

  existingDraft.lastStructuredNormalizedText = currentNormalizedText;
  if (!existingDraft.syntaxError && existingDraft.validationIssues.length === 0) {
    existingDraft.text = currentText;
    existingDraft.normalizedText = currentNormalizedText;
  }

  return existingDraft;
}

function syncCurrentUsageMetrics() {
  syncBundleUsageMetrics(getCurrentBundle());
}

function getJsonDraftStatus(draft) {
  if (!draft) {
    return {
      tone: 'ok',
      pill: 'Synchronized',
      message: 'JSON will stay synchronized with the selected profile whenever the draft is valid.',
      issues: []
    };
  }

  if (draft.syntaxError) {
    return {
      tone: 'error',
      pill: 'Syntax error',
      message: 'The JSON editor is detached until the syntax is corrected. Macro palettes stay unchanged.',
      issues: [draft.syntaxError]
    };
  }

  if (draft.validationIssues.length > 0) {
    return {
      tone: 'error',
      pill: 'Schema error',
      message: 'The JSON is well-formed but does not match the editable macro structure. Macro palettes stay unchanged.',
      issues: draft.validationIssues
    };
  }

  return {
    tone: 'ok',
    pill: 'Synchronized',
    message: 'Valid JSON changes apply immediately to the selected profile and preserve auto-translate markers like 《Aggressor》.',
    issues: []
  };
}

function renderJsonPanel(syncFromStructured = true) {
  createJsonEditor();
  const draft = syncFromStructured ? getCurrentJsonDraft() : (state.jsonDrafts[getCurrentJsonDraftKey()] ?? getCurrentJsonDraft());
  const status = getJsonDraftStatus(draft);

  elements.jsonTargetLabel.textContent = `Selected profile: ${getCurrentBundle()?.label ?? 'Blank workspace'}`;
  elements.jsonSyncStatus.textContent = status.pill;
  elements.jsonSyncStatus.className = `detail-tab-status status-${status.tone}`;
  elements.jsonStatusMessage.textContent = status.message;
  elements.jsonValidation.hidden = status.issues.length === 0;
  elements.jsonValidation.replaceChildren(...(status.issues.length > 0 ? [(() => {
    const list = document.createElement('ul');
    status.issues.forEach((issue) => {
      const item = document.createElement('li');
      item.textContent = issue;
      list.appendChild(item);
    });
    return list;
  })()] : []));
  elements.formatJsonButton.disabled = Boolean(draft.syntaxError);
  setJsonEditorText(draft.text);
}

function renderDetailTabs() {
  const isMacroTab = state.detailTab === 'macro';
  const isJsonTab = state.detailTab === 'json';
  const isContextTab = state.detailTab === 'context';
  elements.detailTabMacro.classList.toggle('active', isMacroTab);
  elements.detailTabMacro.setAttribute('aria-selected', String(isMacroTab));
  elements.detailTabJson.classList.toggle('active', isJsonTab);
  elements.detailTabJson.setAttribute('aria-selected', String(isJsonTab));
  elements.detailTabContext.classList.toggle('active', isContextTab);
  elements.detailTabContext.setAttribute('aria-selected', String(isContextTab));
  elements.detailPanelMacro.hidden = !isMacroTab;
  elements.detailPanelJson.hidden = !isJsonTab;
  elements.detailPanelContext.hidden = !isContextTab;

  if (isJsonTab) {
    createJsonEditor().then(() => {
      jsonEditorView.layout();
    });
  }
}

function syncJsonDraftFromStructuredState() {
  const draft = getCurrentJsonDraft();
  renderJsonPanel(false);
  return draft;
}

function refreshAfterJsonApply() {
  renderBooks();
  renderPages();
  renderSlots();
  renderEditor();
  renderExportState();
  updateMetadata();
  updateStatus();
  renderDetailTabs();
  renderJsonPanel(false);
}

function handleJsonEditorChange(text) {
  const draft = state.jsonDrafts[getCurrentJsonDraftKey()] ?? getCurrentJsonDraft();
  draft.text = text;
  draft.syntaxError = '';
  draft.validationIssues = [];

  let parsedJson;
  try {
    parsedJson = JSON.parse(text);
  } catch (error) {
    draft.normalizedText = null;
    draft.syntaxError = error.message;
    renderJsonPanel(false);
    return;
  }

  const { issues, normalizedPayload } = validateAndNormalizeEditableJsonPayload(parsedJson, getCurrentEditableJsonReferencePayload());
  if (issues.length > 0 || !normalizedPayload) {
    draft.normalizedText = null;
    draft.validationIssues = issues;
    renderJsonPanel(false);
    return;
  }

  applyEditableJsonPayload(normalizedPayload, {
    bundle: getCurrentBundle(),
    books: state.macroSet.books
  });
  draft.normalizedText = JSON.stringify(normalizedPayload);
  draft.lastStructuredNormalizedText = draft.normalizedText;
  refreshAfterJsonApply();
}

function formatCurrentJsonDraft() {
  const draft = state.jsonDrafts[getCurrentJsonDraftKey()] ?? getCurrentJsonDraft();

  let parsedJson;
  try {
    parsedJson = JSON.parse(draft.text);
  } catch (error) {
    draft.syntaxError = error.message;
    renderJsonPanel(false);
    return;
  }

  const { issues, normalizedPayload } = validateAndNormalizeEditableJsonPayload(parsedJson, getCurrentEditableJsonReferencePayload());
  if (issues.length > 0 || !normalizedPayload) {
    draft.validationIssues = issues;
    draft.syntaxError = '';
    renderJsonPanel(false);
    return;
  }

  draft.text = serializeEditableJsonPayload(normalizedPayload);
  draft.normalizedText = JSON.stringify(normalizedPayload);
  draft.lastStructuredNormalizedText = draft.normalizedText;
  setJsonEditorText(draft.text);
  applyEditableJsonPayload(normalizedPayload, {
    bundle: getCurrentBundle(),
    books: state.macroSet.books
  });
  refreshAfterJsonApply();
}

function resetCurrentJsonDraft() {
  const draftKey = getCurrentJsonDraftKey();
  const payload = getCurrentEditableJsonPayload();
  state.jsonDrafts[draftKey] = createJsonDraft(serializeEditableJsonPayload(payload), JSON.stringify(payload));
  renderJsonPanel(false);
}

function createAutoTranslatePicker() {
  const overlay = document.createElement('div');
  overlay.className = 'auto-translate-picker';
  overlay.hidden = true;

  const panel = document.createElement('section');
  panel.className = 'auto-translate-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', 'Auto-translate phrase search');

  const header = document.createElement('div');
  header.className = 'auto-translate-header';

  const titleGroup = document.createElement('div');
  const title = document.createElement('h3');
  title.textContent = 'Insert Auto-Translate Phrase';
  const subtitle = document.createElement('p');
  subtitle.textContent = 'Type to search, then press Enter or click to insert the bracketed token.';
  titleGroup.append(title, subtitle);

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'auto-translate-close';
  closeButton.textContent = 'Close';

  header.append(titleGroup, closeButton);

  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.className = 'auto-translate-search';
  searchInput.placeholder = 'Search auto-translate phrases';
  searchInput.autocomplete = 'off';
  searchInput.spellcheck = false;

  const resultsInfo = document.createElement('p');
  resultsInfo.className = 'auto-translate-results-info';

  const results = document.createElement('div');
  results.className = 'auto-translate-results';

  panel.append(header, searchInput, resultsInfo, results);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) {
      closeAutoTranslatePicker();
    }
  });

  closeButton.addEventListener('click', () => {
    closeAutoTranslatePicker();
  });

  searchInput.addEventListener('input', (event) => {
    state.autoTranslatePicker.searchTerm = event.currentTarget.value;
    state.autoTranslatePicker.selectedIndex = 0;
    renderAutoTranslatePicker();
  });

  searchInput.addEventListener('keydown', (event) => {
    const resultsList = getAutoTranslateResults(state.autoTranslatePicker.searchTerm);

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      state.autoTranslatePicker.selectedIndex = Math.min(state.autoTranslatePicker.selectedIndex + 1, Math.max(resultsList.length - 1, 0));
      renderAutoTranslatePicker();
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      state.autoTranslatePicker.selectedIndex = Math.max(state.autoTranslatePicker.selectedIndex - 1, 0);
      renderAutoTranslatePicker();
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      const phrase = resultsList[state.autoTranslatePicker.selectedIndex];
      if (phrase) {
        insertAutoTranslatePhrase(phrase);
      }
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      closeAutoTranslatePicker();
    }
  });

  results.addEventListener('mousedown', (event) => {
    event.preventDefault();
  });

  return {
    autoTranslatePicker: overlay,
    autoTranslateSearch: searchInput,
    autoTranslateResultsInfo: resultsInfo,
    autoTranslateResults: results
  };
}

Object.assign(elements, createAutoTranslatePicker());

function getLineTextarea(lineIndex) {
  return elements.macroLines.querySelector(`textarea[data-line-index="${lineIndex}"]`);
}

function focusLineTextarea(lineIndex, caretPosition) {
  const textarea = getLineTextarea(lineIndex);
  if (!textarea) {
    return;
  }

  textarea.focus();
  textarea.setSelectionRange(caretPosition, caretPosition);
}

function selectProtectedToken(textarea, protectedSelection) {
  textarea.setSelectionRange(protectedSelection.start, protectedSelection.end);
}

function closeAutoTranslatePicker() {
  const { target, lineIndex, insertionStart } = state.autoTranslatePicker;
  state.autoTranslatePicker = {
    isOpen: false,
    target: 'macro',
    lineIndex: null,
    searchTerm: '',
    selectedIndex: 0,
    insertionStart: 0,
    insertionEnd: 0
  };
  renderAutoTranslatePicker();

  if (target === 'json') {
    requestAnimationFrame(() => focusJsonEditorAtOffset(insertionStart));
    return;
  }

  if (lineIndex !== null) {
    requestAnimationFrame(() => focusLineTextarea(lineIndex, insertionStart));
  }
}

function renderAutoTranslatePicker() {
  const pickerState = state.autoTranslatePicker;
  elements.autoTranslatePicker.hidden = !pickerState.isOpen;
  if (!pickerState.isOpen) {
    elements.autoTranslateResults.replaceChildren();
    elements.autoTranslateResultsInfo.textContent = '';
    return;
  }

  const results = getAutoTranslateResults(pickerState.searchTerm);
  const selectedIndex = Math.min(pickerState.selectedIndex, Math.max(results.length - 1, 0));
  state.autoTranslatePicker.selectedIndex = selectedIndex;
  elements.autoTranslateSearch.value = pickerState.searchTerm;
  elements.autoTranslateResultsInfo.textContent = `${results.length} phrase${results.length === 1 ? '' : 's'} shown`;

  elements.autoTranslateResults.replaceChildren(...(results.length > 0
    ? results.map((phrase, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `auto-translate-result${index === selectedIndex ? ' active' : ''}`;
        button.textContent = formatAutoTranslateDisplay(phrase);
        button.title = phrase;
        button.addEventListener('mouseenter', () => {
          state.autoTranslatePicker.selectedIndex = index;
          renderAutoTranslatePicker();
        });
        button.addEventListener('click', () => {
          insertAutoTranslatePhrase(phrase);
        });
        return button;
      })
    : [(() => {
        const emptyState = document.createElement('p');
        emptyState.className = 'auto-translate-empty';
        emptyState.textContent = 'No matching auto-translate phrases.';
        return emptyState;
      })()]));

  const selectedButton = elements.autoTranslateResults.querySelector('.auto-translate-result.active');
  selectedButton?.scrollIntoView({ block: 'nearest' });
}

function openAutoTranslatePicker(lineIndex, textarea) {
  const context = getAutoTranslateInsertionContext(textarea.value, textarea.selectionStart ?? 0, textarea.selectionEnd ?? textarea.selectionStart ?? 0);
  state.autoTranslatePicker = {
    isOpen: true,
    target: 'macro',
    lineIndex,
    searchTerm: context.searchTerm,
    selectedIndex: 0,
    insertionStart: context.insertionStart,
    insertionEnd: context.insertionEnd
  };
  renderAutoTranslatePicker();
  requestAnimationFrame(() => {
    elements.autoTranslateSearch.focus();
    elements.autoTranslateSearch.select();
  });
}

function openJsonAutoTranslatePicker() {
  createJsonEditor().then(() => {
    const offsets = getJsonEditorSelectionOffsets();
    if (!offsets) {
      return;
    }

    const context = getAutoTranslateInsertionContext(jsonEditorView.getValue(), offsets.selectionStart, offsets.selectionEnd);
    state.autoTranslatePicker = {
      isOpen: true,
      target: 'json',
      lineIndex: null,
      searchTerm: context.searchTerm,
      selectedIndex: 0,
      insertionStart: context.insertionStart,
      insertionEnd: context.insertionEnd
    };
    renderAutoTranslatePicker();
    requestAnimationFrame(() => {
      elements.autoTranslateSearch.focus();
      elements.autoTranslateSearch.select();
    });
  });
}

function insertAutoTranslatePhrase(phrase) {
  const pickerState = state.autoTranslatePicker;
  const token = formatAutoTranslateDisplay(phrase);

  if (pickerState.target === 'json') {
    createJsonEditor().then(() => {
      const monaco = globalThis.monaco;
      const model = jsonEditorView.getModel();
      if (!model) {
        return;
      }

      const startPosition = model.getPositionAt(pickerState.insertionStart);
      const endPosition = model.getPositionAt(pickerState.insertionEnd);

      isSyncingJsonEditor = true;
      jsonEditorView.executeEdits('auto-translate-token', [
        {
          range: new monaco.Range(
            startPosition.lineNumber,
            startPosition.column,
            endPosition.lineNumber,
            endPosition.column
          ),
          text: token,
          forceMoveMarkers: true
        }
      ]);
      isSyncingJsonEditor = false;

      handleJsonEditorChange(model.getValue());
      state.autoTranslatePicker = {
        isOpen: false,
        target: 'macro',
        lineIndex: null,
        searchTerm: '',
        selectedIndex: 0,
        insertionStart: 0,
        insertionEnd: 0
      };
      renderAutoTranslatePicker();
      requestAnimationFrame(() => focusJsonEditorAtOffset(pickerState.insertionStart + token.length));
    });
    return;
  }

  if (pickerState.lineIndex === null) {
    return;
  }

  const slot = getCurrentSlot();
  const currentLine = slot.lines[pickerState.lineIndex] ?? '';
  const nextLine = sanitizeMacroLineInput(`${currentLine.slice(0, pickerState.insertionStart)}${token}${currentLine.slice(pickerState.insertionEnd)}`);
  const nextCaret = pickerState.insertionStart + token.length;

  slot.lines[pickerState.lineIndex] = nextLine;
  state.autoTranslatePicker = {
    isOpen: false,
    target: 'macro',
    lineIndex: null,
    searchTerm: '',
    selectedIndex: 0,
    insertionStart: 0,
    insertionEnd: 0
  };
  renderAutoTranslatePicker();
  syncCurrentUsageMetrics();
  renderEditor();
  renderPages();
  renderBooks();
  renderSlots();
  refreshEditIndicators();
  syncJsonDraftFromStructuredState();
  requestAnimationFrame(() => focusLineTextarea(pickerState.lineIndex, nextCaret));
}

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

function renderPages() {
  const parsedBook = getCurrentParsedBook();
  if (parsedBook) {
    elements.pageSelectorLabel.textContent = 'Macro File';
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

  elements.pageSelectorLabel.textContent = 'Page';
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
    counter.className = `counter${isMacroLineOverLimit(line) ? ' over-limit' : ''}`;
    counter.textContent = getMacroLineCounterText(line);

    const textarea = document.createElement('textarea');
    textarea.dataset.lineIndex = String(index);
    textarea.value = line;
    textarea.placeholder = '/ja "Ability" <t>';
    textarea.addEventListener('keydown', (event) => {
      const selectionStart = event.currentTarget.selectionStart ?? 0;
      const selectionEnd = event.currentTarget.selectionEnd ?? selectionStart;

      if (event.ctrlKey && !event.shiftKey && !event.altKey && (event.code === 'Space' || event.key === ' ')) {
        event.preventDefault();
        openAutoTranslatePicker(index, event.currentTarget);
        return;
      }

      if (event.key === 'Backspace') {
        const protectedSelection = getProtectedTokenSelection(event.currentTarget.value, selectionStart, selectionEnd, 'backward-delete');
        if (protectedSelection) {
          selectProtectedToken(event.currentTarget, protectedSelection);
        }
        return;
      }

      if (event.key === 'Delete') {
        const protectedSelection = getProtectedTokenSelection(event.currentTarget.value, selectionStart, selectionEnd, 'forward-delete');
        if (protectedSelection) {
          selectProtectedToken(event.currentTarget, protectedSelection);
        }
        return;
      }

      if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1) {
        const protectedSelection = getProtectedTokenSelection(event.currentTarget.value, selectionStart, selectionEnd, 'replace');
        if (protectedSelection) {
          selectProtectedToken(event.currentTarget, protectedSelection);
        }
      }
    });
    textarea.addEventListener('paste', (event) => {
      const selectionStart = event.currentTarget.selectionStart ?? 0;
      const selectionEnd = event.currentTarget.selectionEnd ?? selectionStart;
      const protectedSelection = getProtectedTokenSelection(event.currentTarget.value, selectionStart, selectionEnd, 'replace');

      if (!protectedSelection) {
        return;
      }

      selectProtectedToken(event.currentTarget, protectedSelection);
    });
    textarea.addEventListener('input', (event) => {
      const sanitizedValue = sanitizeMacroLineInput(event.currentTarget.value);
      slot.lines[index] = sanitizedValue;

      if (event.currentTarget.value !== sanitizedValue) {
        event.currentTarget.value = sanitizedValue;
      }

      counter.className = `counter${isMacroLineOverLimit(sanitizedValue) ? ' over-limit' : ''}`;
      counter.textContent = getMacroLineCounterText(sanitizedValue);
      syncCurrentUsageMetrics();
      renderPages();
      renderBooks();
      refreshEditIndicators();
      syncJsonDraftFromStructuredState();
    });

    header.append(label, counter);
    wrapper.append(header, textarea);
    return wrapper;
  });

  elements.macroLines.replaceChildren(...lineEditors);
}

function render() {
  syncSelectedBundle();
  syncCurrentUsageMetrics();
  updateLayoutMode();
  renderBundles();
  renderBooks();
  renderPages();
  renderSlots();
  renderEditor();
  renderDetailTabs();
  renderJsonPanel();
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

elements.detailTabMacro.addEventListener('click', () => {
  state.detailTab = 'macro';
  renderDetailTabs();
});

elements.detailTabJson.addEventListener('click', () => {
  state.detailTab = 'json';
  renderDetailTabs();
  renderJsonPanel(false);
});

elements.detailTabContext.addEventListener('click', () => {
  state.detailTab = 'context';
  renderDetailTabs();
});

elements.macroNameInput.addEventListener('input', (event) => {
  const slot = getCurrentSlot();
  slot.name = event.currentTarget.value;
  syncCurrentUsageMetrics();
  renderPages();
  renderSlots();
  renderBooks();
  refreshEditIndicators();
  syncJsonDraftFromStructuredState();
});

elements.formatJsonButton.addEventListener('click', () => {
  formatCurrentJsonDraft();
});

elements.resetJsonButton.addEventListener('click', () => {
  resetCurrentJsonDraft();
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