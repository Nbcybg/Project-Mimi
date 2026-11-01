import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { degrees, PDFDocument } from 'pdf-lib';
import { pageRange, pdfDeletePagesTool, pdfMergeTool, pdfRotateTool, pdfSplitTool } from './pdf.ts';
import { PathNotAllowedError } from './path-guard.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-pdf-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const context = { traceId: 't', thread: 'th', agent: 'mimi', allowedDirs: [dir] };

async function makePdf(name: string, pages: number, rotation = 0): Promise<string> {
  const file = path.join(dir, name);
  const doc = await PDFDocument.create();
  for (let page = 0; page < pages; page++) {
    doc.addPage([200, 300]).setRotation(degrees(rotation));
  }
  fs.writeFileSync(file, await doc.save());
  return file;
}

async function countPages(file: string): Promise<number> {
  return (await PDFDocument.load(fs.readFileSync(file))).getPageCount();
}

test('page ranges: numbers, ranges, clamping and mistakes', () => {
  assert.deepEqual(pageRange('1-3,5', 6), [0, 1, 2, 4]);
  assert.deepEqual(pageRange('3', 3), [2]);
  assert.deepEqual(pageRange('2-9', 3), [1, 2]);
  assert.deepEqual(pageRange('3,1,2,2', 3), [0, 1, 2]);
  assert.throws(() => pageRange('0', 3), /must start at 1/);
  assert.throws(() => pageRange('3-1', 3), /must start at 1/);
  assert.throws(() => pageRange('nine', 3), /not a page or range/);
  assert.throws(() => pageRange('9-10', 3), /No pages were selected/);
});

test('pdf_merge joins PDFs in order and leaves the sources alone', async () => {
  const one = await makePdf('one.pdf', 2);
  const two = await makePdf('two.pdf', 1);
  const before = fs.readFileSync(one);
  const result = JSON.parse(
    await pdfMergeTool.execute({ files: [one, two], output: 'merged/all.pdf' }, context),
  ) as { output: string; pages: number };
  assert.equal(result.pages, 3);
  assert.equal(await countPages(path.join(dir, 'merged/all.pdf')), 3);
  assert.deepEqual(fs.readFileSync(one), before, 'a source is never rewritten');
  await assert.rejects(pdfMergeTool.execute({ files: [one, two], output: one }, context), /new file/);
  await assert.rejects(pdfMergeTool.execute({ files: [one, path.join(dir, 'missing.pdf')], output: 'x.pdf' }, context), /Could not read/);
});

test('pdf_split keeps chosen pages or writes one PDF per page', async () => {
  const source = await makePdf('split.pdf', 4);
  const chosen = JSON.parse(
    await pdfSplitTool.execute({ path: source, output: 'chosen.pdf', pages: '2-3' }, context),
  ) as { pages: number[] };
  assert.deepEqual(chosen.pages, [2, 3]);
  assert.equal(await countPages(path.join(dir, 'chosen.pdf')), 2);

  const folder = path.join(dir, 'pages');
  const split = JSON.parse(await pdfSplitTool.execute({ path: source, output: folder }, context)) as { made: string[] };
  assert.equal(split.made.length, 4);
  for (const file of split.made) assert.equal(await countPages(file), 1);
  assert.equal(await countPages(source), 4);

  await assert.rejects(pdfSplitTool.execute({ path: source, output: source, pages: '1' }, context), /new file/);
});

test('pdf_delete_pages removes the selection and pdf_rotate turns pages', async () => {
  const source = await makePdf('edit.pdf', 3);
  const deleted = JSON.parse(
    await pdfDeletePagesTool.execute({ path: source, output: 'kept.pdf', pages: '2' }, context),
  ) as { removed: number[]; pages: number };
  assert.deepEqual(deleted.removed, [2]);
  assert.equal(deleted.pages, 2);
  assert.equal(await countPages(path.join(dir, 'kept.pdf')), 2);
  await assert.rejects(pdfDeletePagesTool.execute({ path: source, output: 'none.pdf', pages: '1-3' }, context), /every page/);

  await pdfRotateTool.execute({ path: source, output: 'rotated.pdf', degrees: 90, pages: '1,3' }, context);
  const rotated = await PDFDocument.load(fs.readFileSync(path.join(dir, 'rotated.pdf')));
  assert.deepEqual(rotated.getPages().map((page) => page.getRotation().angle), [90, 0, 90]);

  await pdfRotateTool.execute({ path: source, output: 'all-rotated.pdf', degrees: 180 }, context);
  const all = await PDFDocument.load(fs.readFileSync(path.join(dir, 'all-rotated.pdf')));
  assert.deepEqual(all.getPages().map((page) => page.getRotation().angle), [180, 180, 180]);
});

test('pdf in-place edits replace the source and keep a backup', async () => {
  const source = await makePdf('in-place.pdf', 3);
  const original = fs.readFileSync(source);
  const deleted = JSON.parse(
    await pdfDeletePagesTool.execute({ path: source, pages: '2', in_place: true }, context),
  ) as { output: string; backup?: string; in_place: boolean };
  assert.equal(deleted.in_place, true);
  assert.equal(deleted.output, source);
  assert.equal(await countPages(source), 2);
  assert.ok(deleted.backup && fs.existsSync(deleted.backup), 'the previous version is kept');
  assert.deepEqual(fs.readFileSync(deleted.backup!), original);

  const rotated = JSON.parse(
    await pdfRotateTool.execute({ path: source, degrees: 90, in_place: true, backup: false }, context),
  ) as { backup?: string; in_place: boolean };
  assert.equal(rotated.in_place, true);
  assert.equal(rotated.backup, undefined, 'backup can be turned off');
  const after = await PDFDocument.load(fs.readFileSync(source));
  assert.deepEqual(after.getPages().map((page) => page.getRotation().angle), [90, 90]);

  await assert.rejects(pdfRotateTool.execute({ path: source, output: source, degrees: 90 }, context), /in_place/);
});

test('pdf tools stay inside the allowed folders', async () => {
  const source = await makePdf('guard.pdf', 1);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-pdf-outside-'));
  try {
    await assert.rejects(pdfSplitTool.execute({ path: source, output: path.join(outside, 'x.pdf'), pages: '1' }, context), PathNotAllowedError);
    await assert.rejects(pdfMergeTool.execute({ files: [source, path.join(outside, 'nope.pdf')], output: 'x.pdf' }, context), PathNotAllowedError);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
