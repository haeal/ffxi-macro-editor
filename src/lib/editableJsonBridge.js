import {
  MACRO_LINE_COUNT,
  MACRO_LINE_LIMIT,
  getMacroLineByteLength
} from './ffxiMacroFormat.js';

function sanitizeMacroLineInput(value) {
  return String(value ?? '').replace(/\r\n?|\n/g, ' ');
}

function createEmptyLines() {
  return Array.from({ length: MACRO_LINE_COUNT }, () => '');
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
    modifier: slot.modifier,
    key: slot.key,
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

  return {
    bookIndex: book.bookIndex ?? book.index ?? 0,
    pages
  };
}

export function getEditableJsonPayload({ bundle = null, books = [], includeEmpty = false } = {}) {
  const parsedBooks = bundle?.parsedBooks ?? [];
  const sourceBooks = parsedBooks.length > 0 ? parsedBooks : books;

  return {
    books: sourceBooks
      .map((book) => getEditableBookPayload(book, { includeEmpty }))
      .filter((book) => includeEmpty || book.pages.length > 0)
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

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      issues: ['The JSON root must be an object with a books array.'],
      normalizedPayload: null
    };
  }

  if (!Array.isArray(payload.books)) {
    return {
      issues: ['The JSON root must contain a books array.'],
      normalizedPayload: null
    };
  }

  const expectedBooksByIndex = new Map(expectedPayload.books.map((book) => [book.bookIndex, book]));
  const normalizedPayload = { books: [] };

  payload.books.forEach((inputBook, bookPosition) => {
    if (!inputBook || typeof inputBook !== 'object' || Array.isArray(inputBook)) {
      issues.push(`Book ${bookPosition + 1} must be an object.`);
      return;
    }

    const expectedBook = expectedBooksByIndex.get(inputBook.bookIndex);
    if (!expectedBook) {
      issues.push(`Book entry ${bookPosition + 1} references unknown bookIndex ${inputBook.bookIndex}.`);
      return;
    }

    if (!Array.isArray(inputBook.pages)) {
      issues.push(`Book ${expectedBook.bookIndex + 1} must contain a pages array.`);
      return;
    }

    const expectedPagesByIndex = new Map(expectedBook.pages.map((page) => [page.pageIndex, page]));
    const normalizedBook = {
      bookIndex: expectedBook.bookIndex,
      pages: []
    };

    inputBook.pages.forEach((inputPage, pagePosition) => {
      if (!inputPage || typeof inputPage !== 'object' || Array.isArray(inputPage)) {
        issues.push(`Book ${expectedBook.bookIndex + 1}, page entry ${pagePosition + 1} must be an object.`);
        return;
      }

      const expectedPage = expectedPagesByIndex.get(inputPage.pageIndex);
      if (!expectedPage) {
        issues.push(`Book ${expectedBook.bookIndex + 1} references unknown pageIndex ${inputPage.pageIndex}.`);
        return;
      }

      if (!Array.isArray(inputPage.slots)) {
        issues.push(`Book ${expectedBook.bookIndex + 1}, page ${expectedPage.pageIndex + 1} must contain a slots array.`);
        return;
      }

      const expectedSlotsById = new Map(expectedPage.slots.map((slot) => [slot.id, slot]));
      const normalizedPage = {
        pageIndex: expectedPage.pageIndex,
        slots: []
      };

      inputPage.slots.forEach((inputSlot, slotPosition) => {
        if (!inputSlot || typeof inputSlot !== 'object' || Array.isArray(inputSlot)) {
          issues.push(`Book ${expectedBook.bookIndex + 1}, page ${expectedPage.pageIndex + 1}, slot entry ${slotPosition + 1} must be an object.`);
          return;
        }

        const expectedSlot = expectedSlotsById.get(inputSlot.id);
        if (!expectedSlot) {
          issues.push(`Book ${expectedBook.bookIndex + 1}, page ${expectedPage.pageIndex + 1} references unknown slot id ${inputSlot.id}.`);
          return;
        }

        if (inputSlot.modifier !== expectedSlot.modifier || inputSlot.key !== expectedSlot.key) {
          issues.push(`Slot ${expectedSlot.id} must keep its modifier and key values.`);
        }

        if (typeof inputSlot.name !== 'string') {
          issues.push(`Slot ${expectedSlot.id} name must be a string.`);
        }

        if (!Array.isArray(inputSlot.lines)) {
          issues.push(`Slot ${expectedSlot.id} must contain a lines array.`);
          return;
        }

        if (inputSlot.lines.length !== MACRO_LINE_COUNT) {
          issues.push(`Slot ${expectedSlot.id} must contain exactly ${MACRO_LINE_COUNT} lines.`);
        }

        const normalizedLines = [];

        for (let lineIndex = 0; lineIndex < MACRO_LINE_COUNT; lineIndex += 1) {
          const rawLine = inputSlot.lines?.[lineIndex];

          if (typeof rawLine !== 'string') {
            issues.push(`Slot ${expectedSlot.id} line ${lineIndex + 1} must be a string.`);
            normalizedLines.push('');
            continue;
          }

          if (sanitizeMacroLineInput(rawLine) !== rawLine) {
            issues.push(`Slot ${expectedSlot.id} line ${lineIndex + 1} must not contain embedded newlines.`);
          }

          if (getMacroLineByteLength(rawLine) > MACRO_LINE_LIMIT) {
            issues.push(`Slot ${expectedSlot.id} line ${lineIndex + 1} exceeds ${MACRO_LINE_LIMIT} bytes once auto-translate tokens are encoded.`);
          }

          normalizedLines.push(rawLine);
        }

        normalizedPage.slots.push({
          id: expectedSlot.id,
          modifier: expectedSlot.modifier,
          key: expectedSlot.key,
          name: typeof inputSlot.name === 'string' ? inputSlot.name : '',
          lines: normalizedLines
        });
      });

      if (normalizedPage.slots.length > 0) {
        normalizedPage.slots.sort((left, right) => left.id.localeCompare(right.id));
        normalizedBook.pages.push(normalizedPage);
      }
    });

    if (normalizedBook.pages.length > 0) {
      normalizedBook.pages.sort((left, right) => left.pageIndex - right.pageIndex);
      normalizedPayload.books.push(normalizedBook);
    }
  });

  normalizedPayload.books.sort((left, right) => left.bookIndex - right.bookIndex);

  return {
    issues,
    normalizedPayload: issues.length > 0 ? null : normalizedPayload
  };
}

export function applyEditableJsonPayload(payload, { bundle = null, books = [] } = {}) {
  const parsedBooks = bundle?.parsedBooks ?? [];

  if (parsedBooks.length > 0) {
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