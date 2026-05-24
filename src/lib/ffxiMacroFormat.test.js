import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BOOK_COUNT,
  PAGE_COUNT,
  MACROS_PER_PAGE,
  MACRO_LINE_COUNT,
  createBlankMacroSet,
  exportBundleFiles,
  exportMacroSetFiles,
  getMacroLineByteLength,
  inspectMacroFile,
  inspectMacroFiles,
  parseMacroDataFile,
  parseTitleFile,
  serializeMacroFile
} from './ffxiMacroFormat.js';

test('createBlankMacroSet returns the expected book/page/slot structure', () => {
  const macroSet = createBlankMacroSet();

  assert.equal(macroSet.books.length, BOOK_COUNT);
  assert.equal(macroSet.books[0].pages.length, PAGE_COUNT);
  assert.equal(macroSet.books[0].pages[0].slots.length, MACROS_PER_PAGE);
  assert.equal(macroSet.books[0].pages[0].slots[0].lines.length, MACRO_LINE_COUNT);
});

test('inspectMacroFile preserves file metadata and marks the set as not fully parsed', () => {
  const bytes = new Uint8Array([0x41, 0x42, 0x43, 0x44, 0x00, 0x12, 0x7f, 0x80]);
  const result = inspectMacroFile('sample.dat', bytes.buffer, 'USER/demo/sample.dat');

  assert.equal(result.source, 'upload');
  assert.equal(result.parsed, false);
  assert.equal(result.rawBundle.files[0].fileName, 'sample.dat');
  assert.equal(result.rawBundle.files[0].relativePath, 'USER/demo/sample.dat');
  assert.equal(result.rawBundle.files[0].byteLength, bytes.byteLength);
  assert.match(result.rawBundle.files[0].firstBytesHex, /^41 42 43 44/);
});

test('parseMacroDataFile reads 20 fixed macro slots from a 7624-byte page file', () => {
  const bytes = new Uint8Array(7624);
  const encoder = new TextEncoder();

  bytes.set(encoder.encode('/ma "Stone II" <t>'), 24 + 4);
  bytes.set(encoder.encode('/ma "Stone" <t>'), 24 + 4 + 61);
  bytes.set(encoder.encode('Stone'), 24 + 4 + (61 * 6));
  bytes.set(encoder.encode('/ma "Cure" <t>'), 24 + (380 * 10) + 4);
  bytes.set(encoder.encode('Cure'), 24 + (380 * 10) + 4 + (61 * 6));

  const parsed = parseMacroDataFile('mcr.dat', bytes.buffer);

  assert.equal(parsed.fileIndex, 0);
  assert.equal(parsed.slots.length, 20);
  assert.equal(parsed.slots[0].modifier, 'ctrl');
  assert.equal(parsed.slots[0].lines[0], '/ma "Stone II" <t>');
  assert.equal(parsed.slots[0].lines[1], '/ma "Stone" <t>');
  assert.equal(parsed.slots[0].name, 'Stone');
  assert.equal(parsed.slots[10].modifier, 'alt');
  assert.equal(parsed.slots[10].lines[0], '/ma "Cure" <t>');
  assert.equal(parsed.slots[10].name, 'Cure');
});

test('parseMacroDataFile rescues truncated macro files by padding missing bytes', () => {
  const bytes = new Uint8Array(100);
  const encoder = new TextEncoder();

  bytes.set(encoder.encode('/ma "Stone" <t>'), 24 + 4);

  const parsed = parseMacroDataFile('mcr.dat', bytes.buffer);

  assert.equal(parsed.hasSizeMismatch, true);
  assert.equal(parsed.recoveryMode, 'padded');
  assert.equal(parsed.actualByteLength, 100);
  assert.equal(parsed.expectedByteLength, 7624);
  assert.equal(parsed.slots[0].lines[0], '/ma "Stone" <t>');
  assert.match(parsed.validationIssues[0], /padded with zeros/i);
});

test('parseMacroDataFile removes embedded newlines from imported macro lines', () => {
  const bytes = new Uint8Array(7624);
  const encoder = new TextEncoder();

  bytes.set(encoder.encode('/ma "Stone"\n<t>'), 24 + 4);

  const parsed = parseMacroDataFile('mcr.dat', bytes.buffer);

  assert.equal(parsed.slots[0].lines[0], '/ma "Stone" <t>');
  assert.match(parsed.validationIssues[0], /contained embedded newlines/i);
});

test('parseMacroDataFile renders known auto-translate tokens in macro lines', () => {
  const bytes = new Uint8Array(7624);
  const encoder = new TextEncoder();
  const prefix = encoder.encode('/recast "');
  const suffix = encoder.encode('"');
  const aggressorToken = new Uint8Array([0xfd, 0x02, 0x02, 0x1f, 0x02, 0xfd]);

  bytes.set(prefix, 24 + 4);
  bytes.set(aggressorToken, 24 + 4 + prefix.length);
  bytes.set(suffix, 24 + 4 + prefix.length + aggressorToken.length);

  const parsed = parseMacroDataFile('mcr.dat', bytes.buffer);

  assert.equal(parsed.slots[0].lines[0], '/recast "《Aggressor》"');
});

test('serializeMacroFile round-trips an untouched parsed macro file exactly', () => {
  const bytes = new Uint8Array(7624);
  const encoder = new TextEncoder();

  bytes.set([0xaa, 0xbb, 0xcc, 0xdd], 0);
  bytes.set([0x01, 0x02, 0x03, 0x04], 24);
  bytes.set(encoder.encode('/ma "Stone II" <t>'), 24 + 4);
  bytes.set(encoder.encode('npc>'), 24 + 4 + 17);
  bytes.set(encoder.encode('Stone'), 24 + 4 + (61 * 6));
  bytes.set([0x11, 0x22, 0x33, 0x44], 24 + 380);

  const parsed = parseMacroDataFile('mcr.dat', bytes.buffer);
  const serialized = serializeMacroFile(parsed);

  assert.deepEqual(Array.from(serialized), Array.from(bytes));
});

test('serializeMacroFile preserves untouched auto-translate bytes exactly', () => {
  const bytes = new Uint8Array(7624);
  const encoder = new TextEncoder();
  const prefix = encoder.encode('/ws "');
  const suffix = encoder.encode('" <t>');
  const asuranFistsToken = new Uint8Array([0xfd, 0x02, 0x02, 0x21, 0x75, 0xfd]);

  bytes.set(prefix, 24 + 4);
  bytes.set(asuranFistsToken, 24 + 4 + prefix.length);
  bytes.set(suffix, 24 + 4 + prefix.length + asuranFistsToken.length);

  const parsed = parseMacroDataFile('mcr.dat', bytes.buffer);
  const serialized = serializeMacroFile(parsed);

  assert.equal(parsed.slots[0].lines[0], '/ws "《Asuran Fists》" <t>');
  assert.deepEqual(Array.from(serialized), Array.from(bytes));
});

test('serializeMacroFile encodes edited auto-translate phrases back into macro bytes', () => {
  const parsed = parseMacroDataFile('mcr.dat', new Uint8Array(7624).buffer);

  parsed.slots[0].lines[0] = '/recast 《Aggressor》';

  const serialized = serializeMacroFile(parsed);
  const reparsed = parseMacroDataFile('mcr.dat', serialized.buffer);

  assert.equal(serialized[24 + 4 + 8], 0xfd);
  assert.deepEqual(Array.from(serialized.slice(24 + 4 + 8, 24 + 4 + 14)), [0xfd, 0x02, 0x02, 0x1f, 0x02, 0xfd]);
  assert.equal(reparsed.slots[0].lines[0], '/recast 《Aggressor》');
});

test('getMacroLineByteLength counts auto-translate markers by encoded token size', () => {
  assert.equal(getMacroLineByteLength('/p 《Poison Nails》. 《Distortion》 open <call21>'), 31);
  assert.equal(getMacroLineByteLength('/recast 《Aggressor》'), 14);
});

test('serializeMacroFile strips embedded newlines before export', () => {
  const parsed = parseMacroDataFile('mcr.dat', new Uint8Array(7624).buffer);
  parsed.slots[0].lines[0] = '/ma "Stone"\n<t>';

  const serialized = serializeMacroFile(parsed);
  const reparsed = parseMacroDataFile('mcr.dat', serialized.buffer);

  assert.equal(reparsed.slots[0].lines[0], '/ma "Stone" <t>');
});

test('parseTitleFile reads 20 fixed-width book titles from ttl files', () => {
  const bytes = new Uint8Array(344);
  const encoder = new TextEncoder();

  bytes.set(encoder.encode('WHM'), 24);
  bytes.set(encoder.encode('Book20'), 24 + (19 * 16));

  const parsed = parseTitleFile('mcr.ttl', bytes.buffer);

  assert.equal(parsed.bankIndex, 0);
  assert.equal(parsed.titles.length, 20);
  assert.equal(parsed.titles[0], 'WHM');
  assert.equal(parsed.titles[19], 'Book20');
});

test('parseTitleFile rescues oversized ttl files by ignoring trailing bytes', () => {
  const bytes = new Uint8Array(344 + 20);
  const encoder = new TextEncoder();

  bytes.set(encoder.encode('WHM'), 24);
  bytes.fill(0xff, 344);

  const parsed = parseTitleFile('mcr.ttl', bytes.buffer);

  assert.equal(parsed.hasSizeMismatch, true);
  assert.equal(parsed.recoveryMode, 'truncated');
  assert.equal(parsed.actualByteLength, 364);
  assert.equal(parsed.expectedByteLength, 344);
  assert.equal(parsed.titles[0], 'WHM');
  assert.match(parsed.validationIssues[0], /extra trailing bytes were excluded/i);
});

test('inspectMacroFiles groups related files by parent directory', async () => {
  const files = [
    {
      name: 'mcr.dat',
      webkitRelativePath: 'USER/9247/mcr.dat',
      arrayBuffer: async () => new Uint8Array(7624).buffer
    },
    {
      name: 'mcr1.dat',
      webkitRelativePath: 'USER/9247/mcr1.dat',
      arrayBuffer: async () => new Uint8Array(7624).buffer
    },
    {
      name: 'cmb0.dat',
      webkitRelativePath: 'USER/9247/cmb0.dat',
      arrayBuffer: async () => new Uint8Array([0x08]).buffer
    },
    {
      name: 'mcr.sys',
      webkitRelativePath: 'USER/9247/mcr.sys',
      arrayBuffer: async () => new Uint8Array([0x07]).buffer
    },
    {
      name: 'mcr.dat',
      webkitRelativePath: 'USER/2af2/mcr.dat',
      arrayBuffer: async () => new Uint8Array(7624).buffer
    }
  ];

  const result = await inspectMacroFiles(files);

  assert.equal(result.bundles.length, 2);
  assert.equal(result.rawBundle.label, 'USER/2af2');
  assert.match(result.notes[1], /2 unsupported files ignored and not kept in memory/i);

  const secondBundle = result.bundles.find((bundle) => bundle.label === 'USER/9247');
  assert.equal(secondBundle.fileCount, 2);
  assert.equal(secondBundle.totalByteLength, 15248);
  assert.equal(secondBundle.macroDatCount, 2);
  assert.equal(secondBundle.macroMetaCount, 0);
  assert.equal(secondBundle.paletteDatCount, 0);
  assert.equal(secondBundle.parsedMacroFiles.length, 2);
  assert.equal(secondBundle.parsedBooks.length, 1);
  assert.equal(secondBundle.parsedBooks[0].pages.length, 2);
  assert.match(secondBundle.searchText, /user\/9247/);
});

test('exportBundleFiles keeps untouched bundles byte-identical in memory', async () => {
  const bytes = new Uint8Array(7624);
  const encoder = new TextEncoder();
  bytes.set(encoder.encode('/ma "Cure" <t>'), 24 + 4);
  bytes.set(encoder.encode('Cure'), 24 + 4 + (61 * 6));

  const result = await inspectMacroFiles([
    {
      name: 'mcr.dat',
      webkitRelativePath: 'USER/demo/mcr.dat',
      arrayBuffer: async () => bytes.buffer.slice(0)
    },
    {
      name: 'cmb0.dat',
      webkitRelativePath: 'USER/demo/cmb0.dat',
      arrayBuffer: async () => new Uint8Array([0x09]).buffer
    },
    {
      name: 'mcr.sys',
      webkitRelativePath: 'USER/demo/mcr.sys',
      arrayBuffer: async () => new Uint8Array([0x07, 0x08]).buffer
    }
  ]);

  const exportResult = exportBundleFiles(result.bundles[0]);

  assert.equal(exportResult.roundTripReady, true);
  assert.equal(exportResult.changedFileCount, 0);
  assert.equal(exportResult.exactMatchCount, 1);
  assert.deepEqual(exportResult.files.map((file) => file.fileName).sort(), ['mcr.dat']);
  assert.deepEqual(Array.from(exportResult.files[0].bytes), Array.from(bytes));
});

test('exportBundleFiles marks edited macro pages as changed while preserving other files', async () => {
  const bytes = new Uint8Array(7624);
  const encoder = new TextEncoder();
  bytes.set(encoder.encode('Stone'), 24 + 4 + (61 * 6));

  const result = await inspectMacroFiles([
    {
      name: 'mcr.dat',
      webkitRelativePath: 'USER/demo/mcr.dat',
      arrayBuffer: async () => bytes.buffer.slice(0)
    }
  ]);

  result.bundles[0].parsedMacroFiles[0].slots[0].name = 'Cure';

  const exportResult = exportBundleFiles(result.bundles[0]);

  assert.equal(exportResult.changedFileCount, 1);
  assert.equal(exportResult.files.find((file) => file.fileName === 'mcr.dat')?.exactMatch, false);
  assert.equal(exportResult.files.length, 1);
});

test('exportBundleFiles rescues malformed macro files into a writable fixed-size export', async () => {
  const bytes = new Uint8Array(100);
  const encoder = new TextEncoder();
  bytes.set(encoder.encode('/ma "Stone" <t>'), 24 + 4);

  const result = await inspectMacroFiles([
    {
      name: 'mcr.dat',
      webkitRelativePath: 'USER/demo/mcr.dat',
      arrayBuffer: async () => bytes.buffer.slice(0)
    }
  ]);

  const exportResult = exportBundleFiles(result.bundles[0]);

  assert.match(result.notes[2], /recovered with padding or truncation/i);
  assert.equal(exportResult.roundTripReady, true);
  assert.equal(exportResult.changedFileCount, 1);
  assert.equal(exportResult.files[0].byteLength, 7624);
  assert.equal(exportResult.files[0].exactMatch, false);
  assert.equal(exportResult.files[0].bytes[24 + 4], '/'.charCodeAt(0));
});

test('exportBundleFiles rescues malformed ttl files into fixed-size metadata exports', async () => {
  const bytes = new Uint8Array(20);
  const encoder = new TextEncoder();
  bytes.set(encoder.encode('WHM'), 0);

  const result = await inspectMacroFiles([
    {
      name: 'mcr.ttl',
      webkitRelativePath: 'USER/demo/mcr.ttl',
      arrayBuffer: async () => bytes.buffer.slice(0)
    }
  ]);

  const exportResult = exportBundleFiles(result.bundles[0]);
  const exportedTitleFile = exportResult.files.find((file) => file.fileName === 'mcr.ttl');

  assert.equal(exportedTitleFile?.byteLength, 344);
  assert.equal(exportedTitleFile?.exactMatch, false);
  assert.equal(exportedTitleFile?.bytes[0], 'W'.charCodeAt(0));
});

test('exportBundleFiles serializes edited title metadata bytes', async () => {
  const bytes = new Uint8Array(344);
  const encoder = new TextEncoder();
  bytes.set(encoder.encode('WHM'), 24);

  const result = await inspectMacroFiles([
    {
      name: 'mcr.ttl',
      webkitRelativePath: 'USER/demo/mcr.ttl',
      arrayBuffer: async () => bytes.buffer.slice(0)
    }
  ]);

  result.bundles[0].titleBanks[0].titles[0] = 'WAR';

  const exportResult = exportBundleFiles(result.bundles[0]);
  const exportedTitleFile = exportResult.files.find((file) => file.fileName === 'mcr.ttl');
  const reparsedTitleFile = parseTitleFile('mcr.ttl', exportedTitleFile.bytes.buffer);

  assert.equal(exportedTitleFile?.exactMatch, false);
  assert.equal(reparsedTitleFile.titles[0], 'WAR');
});

test('exportMacroSetFiles preserves the full imported tree for folder-style uploads', async () => {
  const result = await inspectMacroFiles([
    {
      name: 'mcr.dat',
      webkitRelativePath: 'USER/9247/mcr.dat',
      arrayBuffer: async () => new Uint8Array(7624).buffer
    },
    {
      name: 'cmb0.dat',
      webkitRelativePath: 'USER/cmb0.dat',
      arrayBuffer: async () => new Uint8Array([0x08]).buffer
    },
    {
      name: 'mcr.dat',
      webkitRelativePath: 'USER/2af2/mcr.dat',
      arrayBuffer: async () => new Uint8Array(7624).buffer
    }
  ]);

  const exportResult = exportMacroSetFiles(result);

  assert.equal(result.importRoot, 'USER');
  assert.equal(exportResult.scope, 'macro-set');
  assert.equal(exportResult.label, 'USER');
  assert.equal(exportResult.bundleCount, 2);
  assert.equal(exportResult.files.length, 2);
  assert.deepEqual(exportResult.files.map((file) => file.relativePath).sort(), ['USER/2af2/mcr.dat', 'USER/9247/mcr.dat']);
});