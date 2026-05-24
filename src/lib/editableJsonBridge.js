import {
  MACRO_LINE_COUNT,
  MACRO_LINE_LIMIT,
  getMacroLineByteLength,
  parseTitleFile
} from './ffxiMacroFormat.js';

function sanitizeMacroLineInput(value) {
  return String(value ?? '').replace(/\r\n?|\n/g, ' ');
}

function createEmptyLines() {
  return Array.from({ length: MACRO_LINE_COUNT }, () => '');
}

function getDefaultBookName(bookIndex) {
  return `Book ${bookIndex + 1}`;
}

function getEditableBookName(book) {
  const bookIndex = book.bookIndex ?? book.index ?? 0;
  return String(book.title ?? book.label ?? getDefaultBookName(bookIndex));
}

function getBundleDefaultTitles(bundle) {
  const defaultTitles = new Map();

  for (const titleBank of bundle?.titleBanks ?? []) {
    const originalTitles = titleBank.originalBytes
      ? parseTitleFile(titleBank.fileName, titleBank.originalBytes).titles
      : (titleBank.titles ?? []);

    originalTitles.forEach((title, index) => {
      const bookIndex = (titleBank.bankIndex * originalTitles.length) + index;
      defaultTitles.set(bookIndex, title || getDefaultBookName(bookIndex));
    });
  }

  for (const book of bundle?.parsedBooks ?? []) {
    if (!defaultTitles.has(book.bookIndex)) {
      defaultTitles.set(book.bookIndex, getDefaultBookName(book.bookIndex));
    }
  }

  return defaultTitles;
}

export function isUsedSlot(slot) {
  return Boolean(slot?.name || slot?.lines?.some(Boolean));
}

export function getPageSlots(page) {
  return page?.file?.slots ?? page?.slots ?? [];
}

export function getEditableSlotPayload(slot) {
  return {
    id: slot.id,
    name: String(slot.name ?? ''),
    lines: Array.from({ length: MACRO_LINE_COUNT }, (_, lineIndex) => String(slot.lines?.[lineIndex] ?? ''))
  };
}

export function getEditablePagePayload(page, options = {}) {
  const { includeEmpty = false } = options;
  const slots = getPageSlots(page)
    .filter((slot) => includeEmpty || isUsedSlot(slot))
    .map((slot) => getEditableSlotPayload(slot));

  return {
    pageIndex: page.pageIndex ?? page.index ?? 0,
    slots
  };
}

export function getEditableBookPayload(book, options = {}) {
  const { includeEmpty = false } = options;
  const pages = (book.pages ?? [])
    .map((page) => getEditablePagePayload(page, options))
    .filter((page) => includeEmpty || page.slots.length > 0);
  const bookIndex = book.bookIndex ?? book.index ?? 0;
  const bookName = getEditableBookName(book);

  return {
    bookIndex,
    bookName,
    pages
  };
}

export function getEditableJsonPayload({ bundle = null, books = [], includeEmpty = false } = {}) {
  const parsedBooks = bundle?.parsedBooks ?? [];
  const sourceBooks = parsedBooks.length > 0 ? parsedBooks : books;

  return {
    books: sourceBooks
      .map((book) => getEditableBookPayload(book, { includeEmpty }))
      .filter((book) => includeEmpty || book.pages.length > 0 || book.bookName !== getDefaultBookName(book.bookIndex))
  };
}

export function serializeEditableJsonPayload(payload) {
  return JSON.stringify(payload, null, 2);
}

export function syncBundleUsageMetrics(bundle) {
  const parsedBooks = bundle?.parsedBooks ?? [];

  parsedBooks.forEach((book) => {
    book.pages.forEach((page) => {
      page.usedSlotCount = getPageSlots(page).filter((slot) => isUsedSlot(slot)).length;
    });
    book.usedPageCount = book.pages.filter((page) => page.usedSlotCount > 0).length;
  });
}

export function validateAndNormalizeEditableJsonPayload(payload, expectedPayload) {
  const issues = [];
  const issueDetails = [];

  const pushIssue = (message, options = {}) => {
    issues.push(message);
    issueDetails.push({ message, ...options });
  };

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      issues: ['The JSON root must be an object with a books array.'],
      issueDetails: [{ message: 'The JSON root must be an object with a books array.', path: [] }],
      normalizedPayload: null
    };
  }

  if (!Array.isArray(payload.books)) {
    return {
      issues: ['The JSON root must contain a books array.'],
      issueDetails: [{ message: 'The JSON root must contain a books array.', path: ['books'] }],
      normalizedPayload: null
    };
  }

  const expectedBooksByIndex = new Map(expectedPayload.books.map((book) => [book.bookIndex, book]));
  const normalizedPayload = { books: [] };
  const seenBookIndexes = new Map();

  payload.books.forEach((inputBook, bookPosition) => {
    if (!inputBook || typeof inputBook !== 'object' || Array.isArray(inputBook)) {
      pushIssue(`Book ${bookPosition + 1} must be an object.`, { path: ['books', bookPosition] });
      return;
    }

    if (seenBookIndexes.has(inputBook.bookIndex)) {
      const originalBookPosition = seenBookIndexes.get(inputBook.bookIndex);
      pushIssue(`Book entry ${bookPosition + 1} duplicates bookIndex ${inputBook.bookIndex} already used by book entry ${originalBookPosition + 1}.`, {
        path: ['books', bookPosition, 'bookIndex'],
        duplicateOfPath: ['books', originalBookPosition, 'bookIndex']
      });
      return;
    }
    seenBookIndexes.set(inputBook.bookIndex, bookPosition);

    const expectedBook = expectedBooksByIndex.get(inputBook.bookIndex);
    if (!expectedBook) {
      pushIssue(`Book entry ${bookPosition + 1} references unknown bookIndex ${inputBook.bookIndex}.`, { path: ['books', bookPosition, 'bookIndex'] });
      return;
    }

    if (!Array.isArray(inputBook.pages)) {
      pushIssue(`Book ${expectedBook.bookIndex + 1} must contain a pages array.`, { path: ['books', bookPosition, 'pages'] });
      return;
    }

    const expectedPagesByIndex = new Map(expectedBook.pages.map((page) => [page.pageIndex, page]));
    const normalizedBook = {
      bookIndex: expectedBook.bookIndex,
      bookName: typeof inputBook.bookName === 'string' ? inputBook.bookName : expectedBook.bookName,
      pages: []
    };

    if ('bookName' in inputBook && typeof inputBook.bookName !== 'string') {
      pushIssue(`Book ${expectedBook.bookIndex + 1} bookName must be a string.`, { path: ['books', bookPosition, 'bookName'] });
    }

    const seenPageIndexes = new Map();

    inputBook.pages.forEach((inputPage, pagePosition) => {
      if (!inputPage || typeof inputPage !== 'object' || Array.isArray(inputPage)) {
        pushIssue(`Book ${expectedBook.bookIndex + 1}, page entry ${pagePosition + 1} must be an object.`, { path: ['books', bookPosition, 'pages', pagePosition] });
        return;
      }

      if (seenPageIndexes.has(inputPage.pageIndex)) {
        const originalPagePosition = seenPageIndexes.get(inputPage.pageIndex);
        pushIssue(`Book ${expectedBook.bookIndex + 1}, page entry ${pagePosition + 1} duplicates pageIndex ${inputPage.pageIndex} already used by page entry ${originalPagePosition + 1}.`, {
          path: ['books', bookPosition, 'pages', pagePosition, 'pageIndex'],
          duplicateOfPath: ['books', bookPosition, 'pages', originalPagePosition, 'pageIndex']
        });
        return;
      }
      seenPageIndexes.set(inputPage.pageIndex, pagePosition);

      const expectedPage = expectedPagesByIndex.get(inputPage.pageIndex);
      if (!expectedPage) {
        pushIssue(`Book ${expectedBook.bookIndex + 1} references unknown pageIndex ${inputPage.pageIndex}.`, { path: ['books', bookPosition, 'pages', pagePosition, 'pageIndex'] });
        return;
      }

      if (!Array.isArray(inputPage.slots)) {
        pushIssue(`Book ${expectedBook.bookIndex + 1}, page ${expectedPage.pageIndex + 1} must contain a slots array.`, { path: ['books', bookPosition, 'pages', pagePosition, 'slots'] });
        return;
      }

      const expectedSlotsById = new Map(expectedPage.slots.map((slot) => [slot.id, slot]));
      const normalizedPage = {
        pageIndex: expectedPage.pageIndex,
        slots: []
      };

      inputPage.slots.forEach((inputSlot, slotPosition) => {
        if (!inputSlot || typeof inputSlot !== 'object' || Array.isArray(inputSlot)) {
          pushIssue(`Book ${expectedBook.bookIndex + 1}, page ${expectedPage.pageIndex + 1}, slot entry ${slotPosition + 1} must be an object.`, {
            path: ['books', bookPosition, 'pages', pagePosition, 'slots', slotPosition]
          });
          return;
        }

        const expectedSlot = expectedSlotsById.get(inputSlot.id);
        if (!expectedSlot) {
          pushIssue(`Book ${expectedBook.bookIndex + 1}, page ${expectedPage.pageIndex + 1} references unknown slot id ${inputSlot.id}.`, {
            path: ['books', bookPosition, 'pages', pagePosition, 'slots', slotPosition, 'id']
          });
          return;
        }

        if (typeof inputSlot.name !== 'string') {
          pushIssue(`Slot ${expectedSlot.id} name must be a string.`, {
            path: ['books', bookPosition, 'pages', pagePosition, 'slots', slotPosition, 'name']
          });
        }

        if (!Array.isArray(inputSlot.lines)) {
          pushIssue(`Slot ${expectedSlot.id} must contain a lines array.`, {
            path: ['books', bookPosition, 'pages', pagePosition, 'slots', slotPosition, 'lines']
          });
          return;
        }

        if (inputSlot.lines.length !== MACRO_LINE_COUNT) {
          pushIssue(`Slot ${expectedSlot.id} must contain exactly ${MACRO_LINE_COUNT} lines.`, {
            path: ['books', bookPosition, 'pages', pagePosition, 'slots', slotPosition, 'lines']
          });
        }

        const normalizedLines = [];

        for (let lineIndex = 0; lineIndex < MACRO_LINE_COUNT; lineIndex += 1) {
          const rawLine = inputSlot.lines?.[lineIndex];

          if (typeof rawLine !== 'string') {
            pushIssue(`Slot ${expectedSlot.id} line ${lineIndex + 1} must be a string.`, {
              path: ['books', bookPosition, 'pages', pagePosition, 'slots', slotPosition, 'lines', lineIndex]
            });
            normalizedLines.push('');
            continue;
          }

          if (sanitizeMacroLineInput(rawLine) !== rawLine) {
            pushIssue(`Slot ${expectedSlot.id} line ${lineIndex + 1} must not contain embedded newlines.`, {
              path: ['books', bookPosition, 'pages', pagePosition, 'slots', slotPosition, 'lines', lineIndex]
            });
          }

          if (getMacroLineByteLength(rawLine) > MACRO_LINE_LIMIT) {
            pushIssue(`Slot ${expectedSlot.id} line ${lineIndex + 1} exceeds ${MACRO_LINE_LIMIT} bytes once auto-translate tokens are encoded.`, {
              path: ['books', bookPosition, 'pages', pagePosition, 'slots', slotPosition, 'lines', lineIndex]
            });
          }

          normalizedLines.push(rawLine);
        }

        normalizedPage.slots.push({
          id: expectedSlot.id,
          name: typeof inputSlot.name === 'string' ? inputSlot.name : '',
          lines: normalizedLines
        });
      });

      if (normalizedPage.slots.length > 0) {
        normalizedPage.slots.sort((left, right) => left.id.localeCompare(right.id));
        normalizedBook.pages.push(normalizedPage);
      }
    });

    normalizedBook.pages.sort((left, right) => left.pageIndex - right.pageIndex);
    normalizedPayload.books.push(normalizedBook);
  });

  normalizedPayload.books.sort((left, right) => left.bookIndex - right.bookIndex);

  return {
    issues,
    issueDetails,
    normalizedPayload: issues.length > 0 ? null : normalizedPayload
  };
}

export function applyEditableJsonPayload(payload, { bundle = null, books = [] } = {}) {
  const parsedBooks = bundle?.parsedBooks ?? [];

  if (parsedBooks.length > 0) {
    const titleBanks = bundle?.titleBanks ?? [];
    const defaultTitles = getBundleDefaultTitles(bundle);

    parsedBooks.forEach((book) => {
      book.title = defaultTitles.get(book.bookIndex) ?? getDefaultBookName(book.bookIndex);
    });

    if (Array.isArray(bundle?.titles)) {
      bundle.titles = bundle.titles.map((_, bookIndex) => defaultTitles.get(bookIndex) ?? getDefaultBookName(bookIndex));
    }

    titleBanks.forEach((titleBank) => {
      const originalTitles = titleBank.originalBytes
        ? parseTitleFile(titleBank.fileName, titleBank.originalBytes).titles
        : (titleBank.titles ?? []);
      titleBank.titles = originalTitles.map((title, titleIndex) => {
        const bookIndex = (titleBank.bankIndex * originalTitles.length) + titleIndex;
        return defaultTitles.get(bookIndex) ?? title ?? getDefaultBookName(bookIndex);
      });
    });

    (bundle?.parsedMacroFiles ?? []).forEach((file) => {
      const defaultTitle = defaultTitles.get(file.bookIndex) ?? getDefaultBookName(file.bookIndex);
      file.candidateTitle = defaultTitle === getDefaultBookName(file.bookIndex) ? '' : defaultTitle;
    });

    parsedBooks.forEach((book) => {
      book.pages.forEach((page) => {
        getPageSlots(page).forEach((slot) => {
          slot.name = '';
          slot.lines = createEmptyLines();
        });
      });
    });

    const parsedBooksByIndex = new Map(parsedBooks.map((book) => [book.bookIndex, book]));
    payload.books.forEach((bookData) => {
      const targetBook = parsedBooksByIndex.get(bookData.bookIndex);
      if (!targetBook) {
        return;
      }

      if (typeof bookData.bookName === 'string') {
        targetBook.title = bookData.bookName;

        if (Array.isArray(bundle?.titles)) {
          bundle.titles[bookData.bookIndex] = bookData.bookName;
        }

        let titleOffset = 0;
        for (const titleBank of titleBanks) {
          const titleCount = titleBank.titles?.length ?? 0;
          if (bookData.bookIndex < titleOffset + titleCount) {
            titleBank.titles[bookData.bookIndex - titleOffset] = bookData.bookName;
            break;
          }
          titleOffset += titleCount;
        }

        (bundle?.parsedMacroFiles ?? []).forEach((file) => {
          if (file.bookIndex === bookData.bookIndex) {
            file.candidateTitle = bookData.bookName;
          }
        });
      }

      const targetPagesByIndex = new Map(targetBook.pages.map((page) => [page.pageIndex, page]));
      bookData.pages.forEach((pageData) => {
        const targetPage = targetPagesByIndex.get(pageData.pageIndex);
        if (!targetPage) {
          return;
        }

        const targetSlotsById = new Map(getPageSlots(targetPage).map((slot) => [slot.id, slot]));
        pageData.slots.forEach((slotData) => {
          const targetSlot = targetSlotsById.get(slotData.id);
          if (!targetSlot) {
            return;
          }

          targetSlot.name = slotData.name;
          targetSlot.lines = slotData.lines.slice();
        });
      });
    });
    syncBundleUsageMetrics(bundle);
    return;
  }

  books.forEach((book) => {
    const bookIndex = book.index ?? book.bookIndex ?? 0;
    book.label = getDefaultBookName(bookIndex);
    book.pages.forEach((page) => {
      page.slots.forEach((slot) => {
        slot.name = '';
        slot.lines = createEmptyLines();
      });
    });
  });

  const booksByIndex = new Map(books.map((book) => [book.index ?? book.bookIndex, book]));
  payload.books.forEach((bookData) => {
    const targetBook = booksByIndex.get(bookData.bookIndex);
    if (!targetBook) {
      return;
    }

    if (typeof bookData.bookName === 'string') {
      targetBook.label = bookData.bookName;
    }

    const pagesByIndex = new Map(targetBook.pages.map((page) => [page.index ?? page.pageIndex, page]));
    bookData.pages.forEach((pageData) => {
      const targetPage = pagesByIndex.get(pageData.pageIndex);
      if (!targetPage) {
        return;
      }

      const slotsById = new Map(targetPage.slots.map((slot) => [slot.id, slot]));
      pageData.slots.forEach((slotData) => {
        const targetSlot = slotsById.get(slotData.id);
        if (!targetSlot) {
          return;
        }

        targetSlot.name = slotData.name;
        targetSlot.lines = slotData.lines.slice();
      });
    });
  });
}