import test from 'node:test';
import assert from 'node:assert/strict';

import { createBlankMacroSet, inspectMacroFiles } from './ffxiMacroFormat.js';
import {
  applyEditableJsonPayload,
  getEditableJsonPayload,
  serializeEditableJsonPayload,
  validateAndNormalizeEditableJsonPayload
} from './editableJsonBridge.js';

test('getEditableJsonPayload exposes the editable blank macro structure', () => {
  const macroSet = createBlankMacroSet();
  const payload = getEditableJsonPayload({ books: macroSet.books });

  assert.deepEqual(payload, { books: [] });
});

test('applyEditableJsonPayload updates blank workspace slots from valid JSON payloads', () => {
  const macroSet = createBlankMacroSet();
  const payload = {
    books: [
      {
        bookIndex: 0,
        bookName: 'White Mage',
        pages: [
          {
            pageIndex: 0,
            slots: [
              {
                id: 'ctrl-1',
                name: 'Buffs',
                lines: ['/recast 《Aggressor》', '', '', '', '', '']
              }
            ]
          }
        ]
      }
    ]
  };

  applyEditableJsonPayload(payload, { books: macroSet.books });

  assert.equal(macroSet.books[0].label, 'White Mage');
  assert.equal(macroSet.books[0].pages[0].slots[0].name, 'Buffs');
  assert.equal(macroSet.books[0].pages[0].slots[0].lines[0], '/recast 《Aggressor》');
});

test('validateAndNormalizeEditableJsonPayload rejects malformed slot structure', () => {
  const macroSet = createBlankMacroSet();
  applyEditableJsonPayload({
    books: [
      {
        bookIndex: 0,
        pages: [
          {
            pageIndex: 0,
            slots: [
              {
                id: 'ctrl-1',
                name: 'Buffs',
                lines: ['/recast 《Aggressor》', '', '', '', '', '']
              }
            ]
          }
        ]
      }
    ]
  }, { books: macroSet.books });
  const expectedPayload = getEditableJsonPayload({ books: macroSet.books });
  const referencePayload = getEditableJsonPayload({ books: macroSet.books, includeEmpty: true });
  const invalidPayload = JSON.parse(serializeEditableJsonPayload(expectedPayload));

  invalidPayload.books[0].pages[0].slots[0].id = 'ctrl-99';

  const result = validateAndNormalizeEditableJsonPayload(invalidPayload, referencePayload);

  assert.equal(result.normalizedPayload, null);
  assert.match(result.issues[0], /unknown slot id/i);
});

test('validateAndNormalizeEditableJsonPayload rejects embedded newlines', () => {
  const macroSet = createBlankMacroSet();
  applyEditableJsonPayload({
    books: [
      {
        bookIndex: 0,
        pages: [
          {
            pageIndex: 0,
            slots: [
              {
                id: 'ctrl-1',
                name: '',
                lines: ['test', '', '', '', '', '']
              }
            ]
          }
        ]
      }
    ]
  }, { books: macroSet.books });
  const expectedPayload = getEditableJsonPayload({ books: macroSet.books });
  const referencePayload = getEditableJsonPayload({ books: macroSet.books, includeEmpty: true });
  const invalidPayload = JSON.parse(serializeEditableJsonPayload(expectedPayload));

  invalidPayload.books[0].pages[0].slots[0].lines[0] = '/ma "Stone"\n<t>';

  const result = validateAndNormalizeEditableJsonPayload(invalidPayload, referencePayload);

  assert.equal(result.normalizedPayload, null);
  assert.match(result.issues[0], /must not contain embedded newlines/i);
});

test('validateAndNormalizeEditableJsonPayload enforces encoded byte limits for auto-translate text', () => {
  const macroSet = createBlankMacroSet();
  applyEditableJsonPayload({
    books: [
      {
        bookIndex: 0,
        pages: [
          {
            pageIndex: 0,
            slots: [
              {
                id: 'ctrl-1',
                name: '',
                lines: ['test', '', '', '', '', '']
              }
            ]
          }
        ]
      }
    ]
  }, { books: macroSet.books });
  const expectedPayload = getEditableJsonPayload({ books: macroSet.books });
  const referencePayload = getEditableJsonPayload({ books: macroSet.books, includeEmpty: true });
  const invalidPayload = JSON.parse(serializeEditableJsonPayload(expectedPayload));

  invalidPayload.books[0].pages[0].slots[0].lines[0] = '/p 《Poison Nails》. 《Distortion》 open <call21><call21><call21><call21><call21>';

  const result = validateAndNormalizeEditableJsonPayload(invalidPayload, referencePayload);

  assert.equal(result.normalizedPayload, null);
  assert.match(result.issues[0], /exceeds 60 bytes/i);
});

test('editable JSON bridge preserves auto-translate markers for parsed bundles', async () => {
  const bytes = new Uint8Array(7624);
  const result = await inspectMacroFiles([
    {
      name: 'mcr.dat',
      webkitRelativePath: 'USER/demo/mcr.dat',
      arrayBuffer: async () => bytes.buffer
    }
  ]);

  const bundle = result.bundles[0];
  bundle.parsedBooks[0].pages[0].file.slots[0].lines[0] = '/recast 《Aggressor》';
  const expectedPayload = getEditableJsonPayload({ bundle });
  const referencePayload = getEditableJsonPayload({ bundle, includeEmpty: true });
  const updatedPayload = JSON.parse(serializeEditableJsonPayload(expectedPayload));

  updatedPayload.books[0].pages[0].slots[0].name = 'Support';
  updatedPayload.books[0].bookName = 'WAR';
  updatedPayload.books[0].pages[0].slots[0].lines[0] = '/recast 《Aggressor》';

  const validationResult = validateAndNormalizeEditableJsonPayload(updatedPayload, referencePayload);

  assert.deepEqual(validationResult.issues, []);
  applyEditableJsonPayload(validationResult.normalizedPayload, { bundle });

  assert.equal(bundle.parsedBooks[0].title, 'WAR');
  assert.equal(bundle.titles[0], 'WAR');
  assert.equal(bundle.parsedBooks[0].pages[0].file.slots[0].name, 'Support');
  assert.equal(bundle.parsedBooks[0].pages[0].file.slots[0].lines[0], '/recast 《Aggressor》');
});

test('getEditableJsonPayload omits empty books, pages, and slots from sparse JSON', () => {
  const macroSet = createBlankMacroSet();
  macroSet.books[0].pages[0].slots[0].lines[0] = 'test';

  const payload = getEditableJsonPayload({ books: macroSet.books });

  assert.equal(payload.books.length, 1);
  assert.equal(payload.books[0].bookIndex, 0);
  assert.equal(payload.books[0].bookName, 'Book 1');
  assert.equal(payload.books[0].pages.length, 1);
  assert.equal(payload.books[0].pages[0].pageIndex, 0);
  assert.equal(payload.books[0].pages[0].slots.length, 1);
  assert.equal(payload.books[0].pages[0].slots[0].id, 'ctrl-1');
});

test('getEditableJsonPayload keeps renamed books even when they have no used pages', () => {
  const macroSet = createBlankMacroSet();
  macroSet.books[0].label = 'NIN';

  const payload = getEditableJsonPayload({ books: macroSet.books });

  assert.equal(payload.books.length, 1);
  assert.equal(payload.books[0].bookIndex, 0);
  assert.equal(payload.books[0].bookName, 'NIN');
  assert.deepEqual(payload.books[0].pages, []);
});

test('validateAndNormalizeEditableJsonPayload accepts sparse content against full reference shape', () => {
  const macroSet = createBlankMacroSet();
  const sparsePayload = {
    books: [
      {
        bookIndex: 0,
        bookName: 'Anything here should round-trip',
        pages: [
          {
            pageIndex: 0,
            slots: [
              {
                id: 'ctrl-1',
                name: '',
                lines: ['test', '', '', '', '', '']
              }
            ]
          }
        ]
      }
    ]
  };

  const referencePayload = getEditableJsonPayload({ books: macroSet.books, includeEmpty: true });
  const result = validateAndNormalizeEditableJsonPayload(sparsePayload, referencePayload);

  assert.deepEqual(result.issues, []);
  assert.equal(result.normalizedPayload.books[0].bookIndex, 0);
  assert.equal(result.normalizedPayload.books[0].bookName, 'Anything here should round-trip');
  assert.equal(result.normalizedPayload.books[0].pages[0].pageIndex, 0);
  assert.equal(result.normalizedPayload.books[0].pages[0].slots[0].lines[0], 'test');
});

test('validateAndNormalizeEditableJsonPayload keeps book-only rename entries', () => {
  const macroSet = createBlankMacroSet();
  const referencePayload = getEditableJsonPayload({ books: macroSet.books, includeEmpty: true });
  const renamedBookPayload = {
    books: [
      {
        bookIndex: 0,
        bookName: 'NIN',
        pages: []
      }
    ]
  };

  const result = validateAndNormalizeEditableJsonPayload(renamedBookPayload, referencePayload);

  assert.deepEqual(result.issues, []);
  assert.equal(result.normalizedPayload.books.length, 1);
  assert.equal(result.normalizedPayload.books[0].bookName, 'NIN');
  assert.deepEqual(result.normalizedPayload.books[0].pages, []);
});

test('validateAndNormalizeEditableJsonPayload rejects duplicate book indexes with path metadata', () => {
  const macroSet = createBlankMacroSet();
  const referencePayload = getEditableJsonPayload({ books: macroSet.books, includeEmpty: true });
  const duplicateBookPayload = {
    books: [
      {
        bookIndex: 0,
        bookName: 'SMN',
        pages: []
      },
      {
        bookIndex: 0,
        bookName: 'DRG',
        pages: []
      }
    ]
  };

  const result = validateAndNormalizeEditableJsonPayload(duplicateBookPayload, referencePayload);

  assert.equal(result.normalizedPayload, null);
  assert.match(result.issues[0], /duplicates bookIndex 0/i);
  assert.deepEqual(result.issueDetails[0].path, ['books', 1, 'bookIndex']);
  assert.deepEqual(result.issueDetails[0].duplicateOfPath, ['books', 0, 'bookIndex']);
});

test('validateAndNormalizeEditableJsonPayload rejects duplicate page indexes with path metadata', () => {
  const macroSet = createBlankMacroSet();
  const referencePayload = getEditableJsonPayload({ books: macroSet.books, includeEmpty: true });
  const duplicatePagePayload = {
    books: [
      {
        bookIndex: 0,
        bookName: 'SMN',
        pages: [
          {
            pageIndex: 0,
            slots: []
          },
          {
            pageIndex: 0,
            slots: []
          }
        ]
      }
    ]
  };

  const result = validateAndNormalizeEditableJsonPayload(duplicatePagePayload, referencePayload);

  assert.equal(result.normalizedPayload, null);
  assert.match(result.issues[0], /duplicates pageIndex 0/i);
  assert.deepEqual(result.issueDetails[0].path, ['books', 0, 'pages', 1, 'pageIndex']);
  assert.deepEqual(result.issueDetails[0].duplicateOfPath, ['books', 0, 'pages', 0, 'pageIndex']);
});

test('validateAndNormalizeEditableJsonPayload rejects non-string bookName values', () => {
  const macroSet = createBlankMacroSet();
  const referencePayload = getEditableJsonPayload({ books: macroSet.books, includeEmpty: true });
  const invalidPayload = {
    books: [
      {
        bookIndex: 0,
        bookName: 123,
        pages: []
      }
    ]
  };

  const result = validateAndNormalizeEditableJsonPayload(invalidPayload, referencePayload);

  assert.equal(result.normalizedPayload, null);
  assert.match(result.issues[0], /bookName must be a string/i);
});

test('applyEditableJsonPayload resets omitted blank book names back to defaults', () => {
  const macroSet = createBlankMacroSet();

  applyEditableJsonPayload({
    books: [
      {
        bookIndex: 1,
        bookName: 'DRG',
        pages: []
      }
    ]
  }, { books: macroSet.books });

  applyEditableJsonPayload({
    books: [
      {
        bookIndex: 2,
        bookName: 'DRG',
        pages: []
      }
    ]
  }, { books: macroSet.books });

  assert.equal(macroSet.books[1].label, 'Book 2');
  assert.equal(macroSet.books[2].label, 'DRG');
});

test('applyEditableJsonPayload applies omission to the full blank hierarchy when content moves', () => {
  const macroSet = createBlankMacroSet();

  applyEditableJsonPayload({
    books: [
      {
        bookIndex: 1,
        bookName: 'DRG',
        pages: [
          {
            pageIndex: 0,
            slots: [
              {
                id: 'ctrl-1',
                name: 'Jump',
                lines: ['/ja "Jump" <me>', '', '', '', '', '']
              }
            ]
          }
        ]
      }
    ]
  }, { books: macroSet.books });

  applyEditableJsonPayload({
    books: [
      {
        bookIndex: 2,
        bookName: 'DRG',
        pages: [
          {
            pageIndex: 1,
            slots: [
              {
                id: 'ctrl-1',
                name: 'Jump',
                lines: ['/ja "Jump" <me>', '', '', '', '', '']
              }
            ]
          }
        ]
      }
    ]
  }, { books: macroSet.books });

  assert.equal(macroSet.books[1].label, 'Book 2');
  assert.equal(macroSet.books[1].pages[0].slots[0].name, '');
  assert.equal(macroSet.books[1].pages[0].slots[0].lines[0], '');
  assert.equal(macroSet.books[2].label, 'DRG');
  assert.equal(macroSet.books[2].pages[1].slots[0].name, 'Jump');
  assert.equal(macroSet.books[2].pages[1].slots[0].lines[0], '/ja "Jump" <me>');
});

test('validateAndNormalizeEditableJsonPayload preserves explicitly included unchanged books', () => {
  const macroSet = createBlankMacroSet();

  applyEditableJsonPayload({
    books: [
      {
        bookIndex: 0,
        bookName: 'SMN',
        pages: []
      },
      {
        bookIndex: 1,
        bookName: 'DRG',
        pages: []
      }
    ]
  }, { books: macroSet.books });

  const referencePayload = getEditableJsonPayload({ books: macroSet.books, includeEmpty: true });
  const movedPayload = {
    books: [
      {
        bookIndex: 0,
        bookName: 'SMN',
        pages: []
      },
      {
        bookIndex: 2,
        bookName: 'DRG',
        pages: []
      }
    ]
  };

  const result = validateAndNormalizeEditableJsonPayload(movedPayload, referencePayload);

  assert.deepEqual(result.issues, []);
  assert.equal(result.normalizedPayload.books.length, 2);
  assert.equal(result.normalizedPayload.books[0].bookIndex, 0);
  assert.equal(result.normalizedPayload.books[0].bookName, 'SMN');
  assert.equal(result.normalizedPayload.books[1].bookIndex, 2);
  assert.equal(result.normalizedPayload.books[1].bookName, 'DRG');
});