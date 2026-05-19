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
        pages: [
          {
            pageIndex: 0,
            slots: [
              {
                id: 'ctrl-1',
                modifier: 'ctrl',
                key: '1',
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
                modifier: 'ctrl',
                key: '1',
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
  assert.match(result.issues[0], /unknown slot id|must keep/i);
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
                modifier: 'ctrl',
                key: '1',
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
                modifier: 'ctrl',
                key: '1',
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
  updatedPayload.books[0].pages[0].slots[0].lines[0] = '/recast 《Aggressor》';

  const validationResult = validateAndNormalizeEditableJsonPayload(updatedPayload, referencePayload);

  assert.deepEqual(validationResult.issues, []);
  applyEditableJsonPayload(validationResult.normalizedPayload, { bundle });

  assert.equal(bundle.parsedBooks[0].pages[0].file.slots[0].name, 'Support');
  assert.equal(bundle.parsedBooks[0].pages[0].file.slots[0].lines[0], '/recast 《Aggressor》');
});

test('getEditableJsonPayload omits empty books, pages, and slots from sparse JSON', () => {
  const macroSet = createBlankMacroSet();
  macroSet.books[0].pages[0].slots[0].lines[0] = 'test';

  const payload = getEditableJsonPayload({ books: macroSet.books });

  assert.equal(payload.books.length, 1);
  assert.equal(payload.books[0].bookIndex, 0);
  assert.equal(payload.books[0].pages.length, 1);
  assert.equal(payload.books[0].pages[0].pageIndex, 0);
  assert.equal(payload.books[0].pages[0].slots.length, 1);
  assert.equal(payload.books[0].pages[0].slots[0].id, 'ctrl-1');
});

test('validateAndNormalizeEditableJsonPayload accepts sparse content against full reference shape', () => {
  const macroSet = createBlankMacroSet();
  const sparsePayload = {
    books: [
      {
        bookIndex: 0,
        pages: [
          {
            pageIndex: 0,
            slots: [
              {
                id: 'ctrl-1',
                modifier: 'ctrl',
                key: '1',
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
  assert.equal(result.normalizedPayload.books[0].pages[0].pageIndex, 0);
  assert.equal(result.normalizedPayload.books[0].pages[0].slots[0].lines[0], 'test');
});