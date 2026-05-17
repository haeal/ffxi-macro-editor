import { AUTO_TRANSLATE_PHRASES } from './ffxiAutoTranslateData.js';

export const BOOK_COUNT = 20;
export const PAGE_COUNT = 10;
export const MACROS_PER_PAGE = 20;
export const MACRO_LINE_COUNT = 6;
export const MACRO_LINE_LIMIT = 60;
export const SLOT_LABELS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
const FILE_HEADER_LENGTH = 24;
const MACRO_RECORD_LENGTH = 380;
const MACRO_RECORD_PREFIX_BYTES = 4;
const MACRO_LINE_BYTES = 61;
const MACRO_NAME_BYTES = 10;
const TITLE_BYTES = 16;
const AUTO_TRANSLATE_TOKEN_LENGTH = 6;
const MACRO_DATA_FILE_LENGTH = FILE_HEADER_LENGTH + (MACROS_PER_PAGE * MACRO_RECORD_LENGTH);
const TITLE_FILE_LENGTH = FILE_HEADER_LENGTH + (BOOK_COUNT * TITLE_BYTES);
const AUTO_TRANSLATE_PHRASE_PREFIXES = buildAutoTranslatePhrasePrefixes();

function cloneBytes(source) {
  return new Uint8Array(source).slice();
}

function createRecoveredByteView(arrayBuffer, expectedLength) {
  const originalBytes = new Uint8Array(arrayBuffer);
  const recoveredBytes = new Uint8Array(expectedLength);
  const copiedLength = Math.min(originalBytes.byteLength, expectedLength);

  recoveredBytes.set(originalBytes.subarray(0, copiedLength), 0);

  return {
    originalBytes,
    recoveredBytes,
    copiedLength,
    expectedLength,
    recoveryMode: originalBytes.byteLength === expectedLength
      ? 'exact'
      : (originalBytes.byteLength < expectedLength ? 'padded' : 'truncated'),
    byteLengthDelta: expectedLength - originalBytes.byteLength
  };
}

function describeRecoveryIssue(fileName, recoveryMode, actualLength, expectedLength) {
  if (recoveryMode === 'exact') {
    return '';
  }

  if (recoveryMode === 'padded') {
    return `${fileName} is shorter than expected (${actualLength} bytes, expected ${expectedLength}). Missing bytes were padded with zeros so the file can still be edited and exported.`;
  }

  return `${fileName} is longer than expected (${actualLength} bytes, expected ${expectedLength}). Extra trailing bytes were excluded so the recoverable macro data can still be edited and exported.`;
}

function byteArraysEqual(left, right) {
  if (!left || !right || left.byteLength !== right.byteLength) {
    return false;
  }

  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function toAsciiBytes(value, maxLength) {
  const normalized = String(value ?? '');
  const bytes = new Uint8Array(Math.min(normalized.length, maxLength));

  for (let index = 0; index < bytes.length; index += 1) {
    const codePoint = normalized.charCodeAt(index);
    bytes[index] = codePoint <= 0x7f ? codePoint : 0x3f;
  }

  return bytes;
}

function hexKeyToBytes(hexKey) {
  const bytes = new Uint8Array(Math.floor(hexKey.length / 2));

  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hexKey.slice(index * 2, (index * 2) + 2), 16);
  }

  return bytes;
}

function buildAutoTranslatePhrasePrefixes() {
  const prefixes = new Map();

  for (const [hexKey, phrase] of AUTO_TRANSLATE_PHRASES) {
    if (!phrase || phrase.trim().length < 3 || prefixes.has(phrase)) {
      continue;
    }

    const prefix = phrase[0];
    const bucket = prefixes.get(prefix) ?? [];
    bucket.push({ phrase, bytes: hexKeyToBytes(hexKey) });
    prefixes.set(prefix, bucket);
  }

  for (const bucket of prefixes.values()) {
    bucket.sort((left, right) => right.phrase.length - left.phrase.length || left.phrase.localeCompare(right.phrase));
  }

  return prefixes;
}

function toEncodedMacroBytes(value, maxLength) {
  const normalized = String(value ?? '');
  const output = [];
  let index = 0;
  let insideQuotes = false;

  while (index < normalized.length && output.length < maxLength) {
    if (normalized[index] === '"') {
      output.push(normalized.charCodeAt(index));
      insideQuotes = !insideQuotes;
      index += 1;
      continue;
    }

    const candidates = insideQuotes ? (AUTO_TRANSLATE_PHRASE_PREFIXES.get(normalized[index]) ?? []) : [];
    const matchedCandidate = candidates.find(({ phrase, bytes }) => normalized.startsWith(phrase, index) && output.length + bytes.length <= maxLength);

    if (matchedCandidate) {
      output.push(...matchedCandidate.bytes);
      index += matchedCandidate.phrase.length;
      continue;
    }

    const codePoint = normalized.charCodeAt(index);
    output.push(codePoint <= 0x7f ? codePoint : 0x3f);
    index += 1;
  }

  return new Uint8Array(output);
}

function sanitizeMacroLineValue(value) {
  return String(value ?? '').replace(/\r\n?|\n/g, ' ');
}

function toHexKey(bytes) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

function decodeAsciiByte(value) {
  return String.fromCharCode(value <= 0x7f ? value : 0x3f);
}

function decodeFFXIString(bytes, start, length) {
  let end = start;
  const limit = Math.min(start + length, bytes.length);

  while (end < limit && bytes[end] !== 0) {
    end += 1;
  }

  const decoded = [];

  for (let index = start; index < end; index += 1) {
    const isTokenStart = bytes[index] === 0xfd;
    const tokenEnd = index + AUTO_TRANSLATE_TOKEN_LENGTH - 1;

    if (isTokenStart && tokenEnd < end && bytes[tokenEnd] === 0xfd) {
      const tokenBytes = bytes.subarray(index, index + AUTO_TRANSLATE_TOKEN_LENGTH);
      const tokenKey = toHexKey(tokenBytes);
      decoded.push(AUTO_TRANSLATE_PHRASES.get(tokenKey) ?? `[autotrans:${tokenKey}]`);
      index += AUTO_TRANSLATE_TOKEN_LENGTH - 1;
      continue;
    }

    decoded.push(decodeAsciiByte(bytes[index]));
  }

  return decoded.join('').trim();
}

function writeFixedCString(bytes, offset, length, value) {
  bytes.fill(0, offset, offset + length);
  bytes.set(toEncodedMacroBytes(value, length), offset);
}

function summarizeFileBytes(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);

  return {
    byteLength: bytes.byteLength,
    asciiFragmentCount: countAsciiFragments(bytes),
    firstBytesHex: Array.from(bytes.slice(0, 16), (value) => value.toString(16).padStart(2, '0')).join(' ')
  };
}

function normalizeRelativePath(relativePath, fileName) {
  return (relativePath || fileName || '').replace(/\\/g, '/');
}

function getParentPath(relativePath) {
  const normalizedPath = normalizeRelativePath(relativePath, '');
  const segments = normalizedPath.split('/').filter(Boolean);
  segments.pop();
  return segments.join('/');
}

function getCommonPathPrefix(paths) {
  const normalizedPaths = paths
    .map((path) => normalizeRelativePath(path, '').split('/').filter(Boolean))
    .filter((segments) => segments.length > 0);

  if (normalizedPaths.length === 0) {
    return '';
  }

  const prefix = [];
  const shortestLength = Math.min(...normalizedPaths.map((segments) => segments.length));

  for (let index = 0; index < shortestLength; index += 1) {
    const candidate = normalizedPaths[0][index];
    if (normalizedPaths.every((segments) => segments[index] === candidate)) {
      prefix.push(candidate);
      continue;
    }

    break;
  }

  return prefix.join('/');
}

function getBundleKey(relativePath, fileName) {
  const parentPath = getParentPath(relativePath);
  return parentPath || 'single-upload';
}

function classifyBundleFile(fileName) {
  if (/^mcr(\d+)?\.dat$/i.test(fileName)) {
    return 'macro-dat';
  }

  if (/^mcr(\.ttl|_2\.ttl)$/i.test(fileName)) {
    return 'macro-meta';
  }

  if (/^cmb\d+\.dat$/i.test(fileName)) {
    return 'palette-dat';
  }

  return 'other';
}

function isMacroBackupCategory(category) {
  return category === 'macro-dat' || category === 'macro-meta';
}

function buildBundleSearchText(bundle) {
  const parts = [bundle.label];

  for (const title of bundle.titles ?? []) {
    if (title) {
      parts.push(title);
    }
  }

  for (const file of bundle.parsedMacroFiles ?? []) {
    parts.push(file.fileName);
    if (file.candidateTitle) {
      parts.push(file.candidateTitle);
    }

    for (const slot of file.slots) {
      if (slot.name) {
        parts.push(slot.name);
      }

      for (const line of slot.lines) {
        if (line) {
          parts.push(line);
        }
      }
    }
  }

  return parts.join(' ').toLowerCase();
}

function parseMacroDataIndex(fileName) {
  if (/^mcr\.dat$/i.test(fileName)) {
    return 0;
  }

  const match = fileName.match(/^mcr(\d+)\.dat$/i);
  return match ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

function inferBookAndPageFromFileName(fileName) {
  if (/^mcr\.dat$/i.test(fileName)) {
    return { bookIndex: 0, pageIndex: 0 };
  }

  const match = fileName.match(/^mcr(\d+)\.dat$/i);
  if (!match) {
    return { bookIndex: Number.MAX_SAFE_INTEGER, pageIndex: 0 };
  }

  const digits = match[1];
  if (digits.length === 1) {
    return {
      bookIndex: 0,
      pageIndex: Number.parseInt(digits, 10)
    };
  }

  return {
    bookIndex: Number.parseInt(digits.slice(0, -1), 10),
    pageIndex: Number.parseInt(digits.slice(-1), 10)
  };
}

function groupParsedBooks(parsedMacroFiles, titles) {
  const groupedBooks = new Map();

  for (const file of parsedMacroFiles) {
    const existingBook = groupedBooks.get(file.bookIndex) ?? {
      bookIndex: file.bookIndex,
      bookKey: String(file.bookIndex),
      title: titles[file.bookIndex] || file.candidateTitle || `Book ${file.bookIndex + 1}`,
      pages: []
    };

    existingBook.pages.push({
      fileName: file.fileName,
      pageIndex: file.pageIndex,
      label: `Page ${file.pageIndex + 1}`,
      usedSlotCount: file.slots.filter((slot) => slot.name || slot.lines.some(Boolean)).length,
      file
    });

    groupedBooks.set(file.bookIndex, existingBook);
  }

  return Array.from(groupedBooks.values())
    .map((book) => ({
      ...book,
      pages: book.pages.sort((left, right) => left.pageIndex - right.pageIndex || left.fileName.localeCompare(right.fileName)),
      usedPageCount: book.pages.filter((page) => page.usedSlotCount > 0).length
    }))
    .sort((left, right) => left.bookIndex - right.bookIndex);
}

function parseTitleBankIndex(fileName) {
  if (/^mcr\.ttl$/i.test(fileName)) {
    return 0;
  }

  if (/^mcr_2\.ttl$/i.test(fileName)) {
    return 1;
  }

  return Number.MAX_SAFE_INTEGER;
}

function parseCString(bytes, start, length) {
  return decodeFFXIString(bytes, start, length);
}

function createParsedSlot(slotIndex, bytes, baseOffset) {
  const modifier = slotIndex < 10 ? 'ctrl' : 'alt';
  const key = SLOT_LABELS[slotIndex % 10];
  const lines = [];
  const validationIssues = [];
  const rawLines = [];
  const contentOffset = baseOffset + MACRO_RECORD_PREFIX_BYTES;

  for (let lineIndex = 0; lineIndex < MACRO_LINE_COUNT; lineIndex += 1) {
    const lineOffset = contentOffset + (lineIndex * MACRO_LINE_BYTES);
    const rawLine = parseCString(bytes, lineOffset, MACRO_LINE_BYTES);
    const sanitizedLine = sanitizeMacroLineValue(rawLine);
    if (sanitizedLine !== rawLine) {
      validationIssues.push({ lineIndex, message: `${modifier}-${key} line ${lineIndex + 1} contained embedded newlines. They were replaced with spaces because each macro command line must remain a single in-game line.` });
    }
    lines.push(sanitizedLine);
    rawLines.push(cloneBytes(bytes.subarray(lineOffset, lineOffset + MACRO_LINE_BYTES)));
  }

  const nameOffset = contentOffset + (MACRO_LINE_COUNT * MACRO_LINE_BYTES);
  const parsedName = parseCString(bytes, nameOffset, MACRO_NAME_BYTES);

  return {
    id: `${modifier}-${key}`,
    modifier,
    key,
    name: parsedName,
    lines,
    originalLines: [...lines],
    rawLines,
    originalName: parsedName,
    rawName: cloneBytes(bytes.subarray(nameOffset, nameOffset + MACRO_NAME_BYTES)),
    validationIssues
  };
}

export function parseMacroDataFile(fileName, arrayBuffer) {
  const recoveredView = createRecoveredByteView(arrayBuffer, MACRO_DATA_FILE_LENGTH);
  const bytes = recoveredView.recoveredBytes;
  const slots = [];
  const inferredLocation = inferBookAndPageFromFileName(fileName);

  for (let slotIndex = 0; slotIndex < MACROS_PER_PAGE; slotIndex += 1) {
    const baseOffset = FILE_HEADER_LENGTH + (slotIndex * MACRO_RECORD_LENGTH);
    slots.push(createParsedSlot(slotIndex, bytes, baseOffset));
  }

  const sanitizedLineIssues = slots.flatMap((slot) => (slot.validationIssues ?? []).map((issue) => `${fileName} ${issue.message}`));

  return {
    fileName,
    fileIndex: parseMacroDataIndex(fileName),
    bookIndex: inferredLocation.bookIndex,
    pageIndex: inferredLocation.pageIndex,
    originalBytes: cloneBytes(recoveredView.originalBytes),
    recoveredBytes: cloneBytes(bytes),
    expectedByteLength: MACRO_DATA_FILE_LENGTH,
    actualByteLength: recoveredView.originalBytes.byteLength,
    hasSizeMismatch: recoveredView.recoveryMode !== 'exact',
    recoveryMode: recoveredView.recoveryMode,
    validationIssues: [
      describeRecoveryIssue(fileName, recoveredView.recoveryMode, recoveredView.originalBytes.byteLength, MACRO_DATA_FILE_LENGTH),
      ...sanitizedLineIssues
    ].filter(Boolean),
    headerHex: Array.from(bytes.slice(0, FILE_HEADER_LENGTH), (value) => value.toString(16).padStart(2, '0')).join(' '),
    slots
  };
}

export function parseTitleFile(fileName, arrayBuffer) {
  const recoveredView = createRecoveredByteView(arrayBuffer, TITLE_FILE_LENGTH);
  const bytes = recoveredView.recoveredBytes;
  const titles = [];

  for (let index = 0; index < 20; index += 1) {
    titles.push(parseCString(bytes, FILE_HEADER_LENGTH + (index * TITLE_BYTES), TITLE_BYTES));
  }

  return {
    fileName,
    bankIndex: parseTitleBankIndex(fileName),
    originalBytes: cloneBytes(recoveredView.originalBytes),
    recoveredBytes: cloneBytes(bytes),
    expectedByteLength: TITLE_FILE_LENGTH,
    actualByteLength: recoveredView.originalBytes.byteLength,
    hasSizeMismatch: recoveredView.recoveryMode !== 'exact',
    recoveryMode: recoveredView.recoveryMode,
    validationIssues: [describeRecoveryIssue(fileName, recoveredView.recoveryMode, recoveredView.originalBytes.byteLength, TITLE_FILE_LENGTH)].filter(Boolean),
    titles
  };
}

function createMacroSlot(modifier, key) {
  return {
    id: `${modifier}-${key}`,
    modifier,
    key,
    name: '',
    lines: Array.from({ length: MACRO_LINE_COUNT }, () => '')
  };
}

function createPage(index) {
  const slots = [];

  for (const modifier of ['ctrl', 'alt']) {
    for (const key of SLOT_LABELS) {
      slots.push(createMacroSlot(modifier, key));
    }
  }

  return {
    index,
    label: `Page ${index + 1}`,
    slots
  };
}

function createBook(index) {
  return {
    index,
    label: `Book ${index + 1}`,
    pages: Array.from({ length: PAGE_COUNT }, (_, pageIndex) => createPage(pageIndex))
  };
}

export function createBlankMacroSet() {
  return {
    source: 'blank',
    parsed: true,
    writable: false,
    notes: [
      'Blank workspace created.',
      'Binary import/export is scaffolded but not finished. Live file round-tripping still needs the final format spec.'
    ],
    rawBundle: null,
    books: Array.from({ length: BOOK_COUNT }, (_, bookIndex) => createBook(bookIndex))
  };
}

function countAsciiFragments(bytes) {
  let fragments = 0;
  let runLength = 0;

  for (const value of bytes) {
    const isPrintableAscii = value >= 32 && value <= 126;
    if (isPrintableAscii) {
      runLength += 1;
      continue;
    }

    if (runLength >= 4) {
      fragments += 1;
    }
    runLength = 0;
  }

  if (runLength >= 4) {
    fragments += 1;
  }

  return fragments;
}

export function inspectMacroFile(fileName, arrayBuffer, relativePath = '') {
  const blankSet = createBlankMacroSet();
  const byteSummary = summarizeFileBytes(arrayBuffer);
  const category = classifyBundleFile(fileName);
  const parsedMacroFile = category === 'macro-dat' ? parseMacroDataFile(fileName, arrayBuffer) : null;
  const parsedTitleBank = category === 'macro-meta' && /ttl$/i.test(fileName) ? parseTitleFile(fileName, arrayBuffer) : null;
  const validationIssues = [
    ...(parsedMacroFile?.validationIssues ?? []),
    ...(parsedTitleBank?.validationIssues ?? [])
  ];

  return {
    ...blankSet,
    source: 'upload',
    parsed: false,
    writable: false,
    notes: [
      'File bytes loaded successfully.',
      ...(validationIssues.length > 0 ? validationIssues : []),
      'The binary layout is not fully implemented yet, so the app is showing a blank editable workspace plus file inspection metadata.'
    ],
    rawBundle: {
      bundleKey: getBundleKey(relativePath, fileName),
      label: getBundleKey(relativePath, fileName),
      fileCount: 1,
      totalByteLength: byteSummary.byteLength,
      macroDatCount: classifyBundleFile(fileName) === 'macro-dat' ? 1 : 0,
      macroMetaCount: classifyBundleFile(fileName) === 'macro-meta' ? 1 : 0,
      paletteDatCount: classifyBundleFile(fileName) === 'palette-dat' ? 1 : 0,
      parsedMacroFiles: parsedMacroFile ? [parsedMacroFile] : [],
      titleBanks: parsedTitleBank ? [parsedTitleBank] : [],
      titles: parsedTitleBank ? parsedTitleBank.titles : [],
      files: [
        {
          fileName,
          relativePath,
          category,
          originalBytes: cloneBytes(arrayBuffer),
          parsedMacroFile,
          parsedTitleBank,
          ...byteSummary
        }
      ],
      searchText: getBundleKey(relativePath, fileName).toLowerCase()
    }
  };
}

export async function inspectMacroFiles(fileEntries) {
  const blankSet = createBlankMacroSet();
  const bundles = new Map();
  const relativePaths = [];
  let ignoredFileCount = 0;
  let recoveredFileCount = 0;

  for (const entry of fileEntries) {
    const fileName = entry.name;
    const relativePath = normalizeRelativePath(entry.webkitRelativePath ?? entry.relativePath ?? '', fileName);
    const category = classifyBundleFile(fileName);
    if (!isMacroBackupCategory(category)) {
      ignoredFileCount += 1;
      continue;
    }

    relativePaths.push(relativePath);
    const bundleKey = getBundleKey(relativePath, fileName);
    const arrayBuffer = await entry.arrayBuffer();
    const byteSummary = summarizeFileBytes(arrayBuffer);
    const parsedMacroFile = category === 'macro-dat' ? parseMacroDataFile(fileName, arrayBuffer) : null;
    const parsedTitleBank = category === 'macro-meta' && /ttl$/i.test(fileName) ? parseTitleFile(fileName, arrayBuffer) : null;
    if (parsedMacroFile?.hasSizeMismatch || parsedTitleBank?.hasSizeMismatch) {
      recoveredFileCount += 1;
    }
    const existingBundle = bundles.get(bundleKey) ?? {
      bundleKey,
      label: bundleKey,
      fileCount: 0,
      totalByteLength: 0,
      macroDatCount: 0,
      macroMetaCount: 0,
      paletteDatCount: 0,
      parsedMacroFiles: [],
      titleBanks: [],
      titles: [],
      files: []
    };

    existingBundle.fileCount += 1;
    existingBundle.totalByteLength += byteSummary.byteLength;
    existingBundle.files.push({
      fileName,
      relativePath,
      category,
      originalBytes: cloneBytes(arrayBuffer),
      parsedMacroFile,
      parsedTitleBank,
      ...byteSummary
    });

    if (parsedMacroFile) {
      existingBundle.parsedMacroFiles.push(parsedMacroFile);
    }

    if (parsedTitleBank) {
      existingBundle.titleBanks.push(parsedTitleBank);
    }

    if (category === 'macro-dat') {
      existingBundle.macroDatCount += 1;
    } else if (category === 'macro-meta') {
      existingBundle.macroMetaCount += 1;
    } else if (category === 'palette-dat') {
      existingBundle.paletteDatCount += 1;
    }

    bundles.set(bundleKey, existingBundle);
  }

  const bundleList = Array.from(bundles.values())
    .map((bundle) => {
      bundle.parsedMacroFiles.sort((left, right) => left.fileIndex - right.fileIndex || left.fileName.localeCompare(right.fileName));
      bundle.titleBanks.sort((left, right) => left.bankIndex - right.bankIndex || left.fileName.localeCompare(right.fileName));
      bundle.titles = bundle.titleBanks.flatMap((bank) => bank.titles);
      bundle.parsedMacroFiles = bundle.parsedMacroFiles.map((file) => ({
        ...file,
        candidateTitle: bundle.titles[file.bookIndex] || ''
      }));
      const parsedFileMap = new Map(bundle.parsedMacroFiles.map((file) => [file.fileName, file]));
      bundle.files = bundle.files.map((file) => ({
        ...file,
        parsedMacroFile: file.parsedMacroFile ? parsedFileMap.get(file.fileName) ?? file.parsedMacroFile : null
      }));
      bundle.parsedBooks = groupParsedBooks(bundle.parsedMacroFiles, bundle.titles);
      bundle.searchText = buildBundleSearchText(bundle);
      return bundle;
    })
    .sort((left, right) => left.label.localeCompare(right.label));
  const primaryBundle = bundleList[0] ?? null;
  const importRoot = getCommonPathPrefix(relativePaths);

  return {
    ...blankSet,
    source: 'upload',
    parsed: false,
    writable: false,
    importRoot,
    notes: [
      `${bundleList.length} profile bundle(s) detected from uploaded files.`,
      ignoredFileCount > 0 ? `${ignoredFileCount} unsupported file${ignoredFileCount === 1 ? '' : 's'} ignored and not kept in memory.` : 'Only macro payload and title metadata files are kept in memory.',
      recoveredFileCount > 0 ? `${recoveredFileCount} malformed macro file${recoveredFileCount === 1 ? '' : 's'} had size issues and were recovered with padding or truncation so their data could still be edited and exported.` : 'Imported macro files matched the expected fixed-size layout.',
      'Macro payload files are now partially parsed: each 7624-byte mcr data file is treated as one 20-slot macro palette, and ttl files are parsed as title banks.',
      'Exact book/page mapping across all numbered mcr files is still being verified, so the app currently exposes parsed macro files directly while keeping the broader bundle metadata visible.'
    ],
    bundles: bundleList,
    rawBundle: primaryBundle
  };
}

export function serializeMacroFile(parsedMacroFile) {
  if (!parsedMacroFile) {
    throw new Error('A parsed macro file is required for serialization.');
  }

  const bytes = parsedMacroFile.recoveredBytes
    ? cloneBytes(parsedMacroFile.recoveredBytes)
    : new Uint8Array(MACRO_DATA_FILE_LENGTH);

  if (bytes.byteLength !== MACRO_DATA_FILE_LENGTH) {
    throw new Error(`Unexpected recovered macro file size: ${bytes.byteLength}`);
  }

  parsedMacroFile.slots.forEach((slot, slotIndex) => {
    const baseOffset = FILE_HEADER_LENGTH + (slotIndex * MACRO_RECORD_LENGTH) + MACRO_RECORD_PREFIX_BYTES;

    slot.lines.forEach((line, lineIndex) => {
      const fieldOffset = baseOffset + (lineIndex * MACRO_LINE_BYTES);
      const sanitizedLine = sanitizeMacroLineValue(line);
      if (sanitizedLine === slot.originalLines?.[lineIndex] && slot.rawLines?.[lineIndex]?.byteLength === MACRO_LINE_BYTES) {
        bytes.set(slot.rawLines[lineIndex], fieldOffset);
        return;
      }

      writeFixedCString(bytes, fieldOffset, MACRO_LINE_BYTES, sanitizedLine);
    });

    const nameOffset = baseOffset + (MACRO_LINE_COUNT * MACRO_LINE_BYTES);
    if (slot.name === slot.originalName && slot.rawName?.byteLength === MACRO_NAME_BYTES) {
      bytes.set(slot.rawName, nameOffset);
      return;
    }

    writeFixedCString(bytes, nameOffset, MACRO_NAME_BYTES, slot.name);
  });

  return bytes;
}

export function exportBundleFiles(bundle) {
  if (!bundle) {
    throw new Error('A parsed bundle is required for export.');
  }

  const parsedFileMap = new Map((bundle.parsedMacroFiles ?? []).map((file) => [file.fileName, file]));
  const parsedTitleMap = new Map((bundle.titleBanks ?? []).map((bank) => [bank.fileName, bank]));
  const files = (bundle.files ?? [])
    .filter((file) => isMacroBackupCategory(file.category))
    .map((file) => {
    const parsedMacroFile = parsedFileMap.get(file.fileName) ?? file.parsedMacroFile ?? null;
    const parsedTitleBank = parsedTitleMap.get(file.fileName) ?? file.parsedTitleBank ?? null;
    const bytes = file.category === 'macro-dat' && parsedMacroFile
      ? serializeMacroFile(parsedMacroFile)
      : (file.category === 'macro-meta' && parsedTitleBank?.recoveredBytes
        ? cloneBytes(parsedTitleBank.recoveredBytes)
        : cloneBytes(file.originalBytes ?? new Uint8Array()));
    const originalBytes = cloneBytes(file.originalBytes ?? new Uint8Array());

    return {
      fileName: file.fileName,
      relativePath: file.relativePath,
      category: file.category,
      bytes,
      byteLength: bytes.byteLength,
      exactMatch: byteArraysEqual(bytes, originalBytes)
    };
    });

  return {
    scope: 'bundle',
    bundleKey: bundle.bundleKey,
    label: bundle.label,
    files,
    exactMatchCount: files.filter((file) => file.exactMatch).length,
    changedFileCount: files.filter((file) => !file.exactMatch).length,
    roundTripReady: files.every((file) => file.category !== 'macro-dat' || file.byteLength === MACRO_DATA_FILE_LENGTH)
  };
}

export function exportMacroSetFiles(macroSet) {
  const bundles = macroSet?.bundles ?? [];
  if (bundles.length === 0) {
    throw new Error('A parsed macro set is required for export.');
  }

  const reports = bundles.map((bundle) => exportBundleFiles(bundle));
  const files = reports.flatMap((report) => report.files);
  const label = macroSet.importRoot || getCommonPathPrefix(files.map((file) => file.relativePath)) || 'macro-set';

  return {
    scope: 'macro-set',
    label,
    files,
    bundleCount: reports.length,
    exactMatchCount: files.filter((file) => file.exactMatch).length,
    changedFileCount: files.filter((file) => !file.exactMatch).length,
    roundTripReady: reports.every((report) => report.roundTripReady)
  };
}