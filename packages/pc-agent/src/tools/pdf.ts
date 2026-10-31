import fs from 'node:fs/promises';
import path from 'node:path';
import { degrees, PDFDocument } from 'pdf-lib';
import { z } from 'zod';
import { defineTool } from '@mimi/shared';
import { resolveAllowedPath } from './path-guard.ts';

const MAX_PAGES = 5_000;

/** Zero-based page indexes from a range like "1-3,5"; 1-based input, clamped to the document. */
export function pageRange(text: string, pageCount: number): number[] {
  const wanted = new Set<number>();
  for (const raw of text.split(',')) {
    const token = raw.trim();
    if (!token) continue;
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(token);
    if (!match) throw new Error(`"${token}" is not a page or range like 1-3.`);
    const first = Number(match[1]);
    const last = match[2] === undefined ? first : Number(match[2]);
    if (first < 1 || last < first) throw new Error(`Page range "${token}" must start at 1 and end after it starts.`);
    for (let page = first; page <= Math.min(last, pageCount); page++) wanted.add(page - 1);
  }
  if (wanted.size === 0) throw new Error(`No pages were selected (this document has ${pageCount}).`);
  return [...wanted].sort((a, b) => a - b);
}

async function loadPdf(file: string): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(await fs.readFile(file));
  } catch (error) {
    throw new Error(`Could not read "${path.basename(file)}" as a PDF: ${(error as Error).message}`);
  }
}

function guardPages(count: number): void {
  if (count === 0) throw new Error('That PDF has no pages.');
  if (count > MAX_PAGES) throw new Error(`That PDF has ${count} pages; this tool stops at ${MAX_PAGES}.`);
}

async function writePdf(doc: PDFDocument, output: string): Promise<void> {
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, await doc.save());
}

async function uniquePath(target: string): Promise<string> {
  let chosen = target;
  for (let n = 2; ; n++) {
    try {
      await fs.access(chosen);
      chosen = `${target.slice(0, -4)}-${n}.pdf`;
    } catch {
      return chosen;
    }
  }
}

export const pdfMergeTool = defineTool({
  name: 'pdf_merge',
  description: 'Join two or more PDFs into one new file, in the order given. Source files are never changed.',
  risk: 'write',
  target: 'pc',
  inputSchema: z.object({
    files: z.array(z.string()).min(2).describe('PDF paths inside the allowed folders, in order'),
    output: z.string().min(1).describe('New .pdf path'),
  }),
  summarize: (input) => `Merge ${input.files.length} PDFs into ${input.output}`,
  async execute(input, context) {
    const sources = input.files.map((file) => resolveAllowedPath(file, context.allowedDirs));
    const output = resolveAllowedPath(input.output, context.allowedDirs);
    if (sources.some((source) => source.toLowerCase() === output.toLowerCase())) throw new Error('The output must be a new file, not one of the sources.');
    const merged = await PDFDocument.create();
    let pages = 0;
    for (const source of sources) {
      const doc = await loadPdf(source);
      guardPages(doc.getPageCount());
      pages += doc.getPageCount();
      const copied = await merged.copyPages(doc, doc.getPageIndices());
      for (const page of copied) merged.addPage(page);
    }
    if (pages > MAX_PAGES) throw new Error(`The merged document would have ${pages} pages; this tool stops at ${MAX_PAGES}.`);
    await writePdf(merged, output);
    return JSON.stringify({ ok: true, output, sources, pages, summary: `Merged ${sources.length} PDFs into ${output} (${pages} page(s)).` }, null, 2);
  },
});

export const pdfSplitTool = defineTool({
  name: 'pdf_split',
  description:
    'Split a PDF into a new file. With `pages` ("1-3,5") it writes those pages to `output`; without it, `output` is a folder and every page becomes its own PDF. The source is never changed.',
  risk: 'write',
  target: 'pc',
  inputSchema: z.object({
    path: z.string().min(1).describe('Source PDF inside the allowed folders'),
    output: z.string().min(1).describe('New .pdf path, or a folder when pages is omitted'),
    pages: z.string().optional().describe('Pages to keep, e.g. "1-3,5"; omit to split every page'),
  }),
  summarize: (input) => `Split ${input.path}${input.pages ? ` (pages ${input.pages})` : ''} -> ${input.output}`,
  async execute(input, context) {
    const source = resolveAllowedPath(input.path, context.allowedDirs);
    const doc = await loadPdf(source);
    guardPages(doc.getPageCount());
    if (input.pages?.trim()) {
      const output = resolveAllowedPath(input.output, context.allowedDirs);
      if (output.toLowerCase() === source.toLowerCase()) throw new Error('The output must be a new file, not the source.');
      const pages = pageRange(input.pages, doc.getPageCount());
      const result = await PDFDocument.create();
      const copied = await result.copyPages(doc, pages);
      for (const page of copied) result.addPage(page);
      await writePdf(result, output);
      return JSON.stringify({ ok: true, output, pages: pages.map((page) => page + 1), summary: `Wrote page(s) ${pages.map((page) => page + 1).join(', ')} to ${output}.` }, null, 2);
    }
    const folder = resolveAllowedPath(input.output, context.allowedDirs);
    await fs.mkdir(folder, { recursive: true });
    const base = path.basename(source, path.extname(source));
    const made: string[] = [];
    for (const index of doc.getPageIndices()) {
      const one = await PDFDocument.create();
      const [page] = await one.copyPages(doc, [index]);
      one.addPage(page!);
      const target = await uniquePath(path.join(folder, `${base}-page-${index + 1}.pdf`));
      await writePdf(one, target);
      made.push(target);
    }
    return JSON.stringify({ ok: true, output: folder, made, summary: `Split ${made.length} page(s) into ${folder}.` }, null, 2);
  },
});

export const pdfDeletePagesTool = defineTool({
  name: 'pdf_delete_pages',
  description: 'Remove pages from a PDF and write the rest to a new file. The source is never changed.',
  risk: 'write',
  target: 'pc',
  inputSchema: z.object({
    path: z.string().min(1).describe('Source PDF inside the allowed folders'),
    output: z.string().min(1).describe('New .pdf path'),
    pages: z.string().min(1).describe('Pages to remove, e.g. "2,5-7"'),
  }),
  summarize: (input) => `Delete pages ${input.pages} from ${path.basename(input.path)}`,
  async execute(input, context) {
    const source = resolveAllowedPath(input.path, context.allowedDirs);
    const output = resolveAllowedPath(input.output, context.allowedDirs);
    if (output.toLowerCase() === source.toLowerCase()) throw new Error('The output must be a new file, not the source.');
    const doc = await loadPdf(source);
    guardPages(doc.getPageCount());
    const remove = new Set(pageRange(input.pages, doc.getPageCount()));
    const keep = doc.getPageIndices().filter((index) => !remove.has(index));
    if (keep.length === 0) throw new Error('That would delete every page; use delete_path for the whole file.');
    const result = await PDFDocument.create();
    const copied = await result.copyPages(doc, keep);
    for (const page of copied) result.addPage(page);
    await writePdf(result, output);
    return JSON.stringify({ ok: true, output, removed: [...remove].map((index) => index + 1), pages: keep.length, summary: `Wrote ${keep.length} page(s) to ${output}.` }, null, 2);
  },
});

export const pdfRotateTool = defineTool({
  name: 'pdf_rotate',
  description: 'Rotate pages of a PDF by 90, 180 or 270 degrees and write a new file. The source is never changed.',
  risk: 'write',
  target: 'pc',
  inputSchema: z.object({
    path: z.string().min(1).describe('Source PDF inside the allowed folders'),
    output: z.string().min(1).describe('New .pdf path'),
    degrees: z.union([z.literal(90), z.literal(180), z.literal(270)]).describe('Clockwise rotation'),
    pages: z.string().optional().describe('Pages to rotate, e.g. "1-3"; omit for every page'),
  }),
  summarize: (input) => `Rotate ${input.pages ? `pages ${input.pages}` : 'all pages'} of ${path.basename(input.path)} by ${input.degrees}°`,
  async execute(input, context) {
    const source = resolveAllowedPath(input.path, context.allowedDirs);
    const output = resolveAllowedPath(input.output, context.allowedDirs);
    if (output.toLowerCase() === source.toLowerCase()) throw new Error('The output must be a new file, not the source.');
    const doc = await loadPdf(source);
    guardPages(doc.getPageCount());
    const selected = input.pages?.trim()
      ? new Set(pageRange(input.pages, doc.getPageCount()))
      : new Set(doc.getPageIndices());
    for (const index of selected) {
      const page = doc.getPage(index);
      const current = page.getRotation().angle;
      page.setRotation(degrees((current + input.degrees) % 360));
    }
    await writePdf(doc, output);
    return JSON.stringify({ ok: true, output, pages: [...selected].map((index) => index + 1), degrees: input.degrees, summary: `Rotated ${selected.size} page(s) in ${output}.` }, null, 2);
  },
});

export const pdfTools = [pdfMergeTool, pdfSplitTool, pdfDeletePagesTool, pdfRotateTool];
