import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { toolFileOutput } from '@mimi/shared';
import { defineTool, type ToolDefinition } from './registry.ts';

const require = createRequire(import.meta.url);
/** The Thai font shipped with the app, so PDFs render Thai without the user installing anything. */
const THAI_FONT = require.resolve('@fontsource/noto-sans-thai/files/noto-sans-thai-thai-400-normal.woff');

const XML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const xml = (text: string) => text.replace(/[&<>"]/g, (char) => XML_ESCAPES[char]!);

/** `**bold**`, `*italic*` and `code` inline, as Word runs. */
function docxRuns(paragraph: string): string {
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  const parts = paragraph.split(pattern).filter((part) => part !== undefined);
  return parts
    .map((part) => {
      if (part.startsWith('**') && part.endsWith('**')) {
        const runs = docxRuns(part.slice(2, -2)).replace(/<w:r>(.*?)<\/w:r>/g, '<w:r><w:rPr><w:b/></w:rPr>$1</w:r>');
        return runs;
      }
      if (part.startsWith('*') && part.endsWith('*') && part.length > 2) return `<w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">${xml(part.slice(1, -1))}</w:t></w:r>`;
      if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return `<w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr><w:t xml:space="preserve">${xml(part.slice(1, -1))}</w:t></w:r>`;
      if (part === '') return '';
      return `<w:r><w:t xml:space="preserve">${xml(part)}</w:t></w:r>`;
    })
    .join('');
}

/** Renders the simple markdown the agents write: `#` headings, `-` lists, `**bold**`, `*italic*`, `code`. */
interface StyledLine {
  kind: 'heading' | 'paragraph' | 'bullet';
  text: string;
}
export function styleLines(markdown: string): StyledLine[] {
  return markdown
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => {
      if (/^#{1,3}\s+/.test(line)) return { kind: 'heading' as const, text: line.replace(/^#{1,3}\s+/, '') };
      if (/^[-*]\s+/.test(line)) return { kind: 'bullet' as const, text: line.replace(/^[-*]\s+/, '') };
      return { kind: 'paragraph' as const, text: line };
    })
    .filter((line) => line.text.trim() !== '');
}

/** One blank page of OOXML, with the document body filled in. */
function docxXml(lines: StyledLine[]): string {
  const body = lines
    .map((line) => {
      if (line.kind === 'heading') {
        return `<w:p><w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t xml:space="preserve">${xml(line.text)}</w:t></w:r></w:p>`;
      }
      const indent = line.kind === 'bullet' ? '<w:ind w:left="360" w:hanging="360"/>' : '';
      const bullet = line.kind === 'bullet' ? '<w:r><w:t xml:space="preserve">•\t</w:t></w:r>' : '';
      return `<w:p><w:pPr>${indent}<w:spacing w:after="80"/></w:pPr>${bullet}${docxRuns(line.text)}</w:p>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body>
</w:document>`;
}

/** A minimal ZIP writer (stored entries only): enough for OOXML, which Word reads fine. */
function zip(files: Record<string, string>): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...central, end]);
}

/** Builds a .docx file from the given markdown text. */
export function buildDocx(markdown: string): Buffer {
  const lines = styleLines(markdown);
  return zip({
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    'word/document.xml': docxXml(lines),
  });
}

/** Builds a .pdf file from the given markdown text (Thai and Latin). */
export async function buildPdf(markdown: string): Promise<Buffer> {
  const PDFDocument = (await import('pdfkit')).default;
  const doc = new PDFDocument({ size: 'A4', margins: { top: 56, bottom: 56, left: 56, right: 56 }, info: { Title: 'Mimi export' } });
  doc.registerFont('sans', THAI_FONT);
  doc.font('sans');
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve) => doc.on('end', resolve));
  for (const line of styleLines(markdown)) {
    switch (line.kind) {
      case 'heading':
        doc.moveDown(0.5).fontSize(17).text(line.text, { characterSpacing: 0 }).moveDown(0.2);
        break;
      case 'bullet':
        doc.fontSize(11.5).text(`•  ${line.text}`, { indent: 18, paragraphGap: 4 });
        break;
      default:
        doc.fontSize(11.5).text(line.text, { paragraphGap: 5 });
    }
  }
  doc.end();
  await done;
  return Buffer.concat(chunks);
}

export interface ExportToolDeps {
  /** The folder exports are written into; the tool writes only here. */
  workDir: string;
}

/**
 * `export_document`: the answer as a real file the user can hand over — Word (.docx) or
 * PDF — saved into the working folder and attached to the chat for download.
 */
export function createExportTools(deps: ExportToolDeps): ToolDefinition<any>[] {
  const exportTool = defineTool({
    name: 'export_document',
    description:
      'Export text the agent wrote as a real file: a Word document (.docx) or a PDF, in Thai and English. Supports simple formatting: lines starting with # or ## become headings, lines starting with - become bullets, **bold**, *italic* and `code`. The file is saved in the working folder and attached to the chat.',
    risk: 'write',
    target: 'core',
    inputSchema: z.object({
      filename: z.string().min(1).describe('File name ending in .docx or .pdf, e.g. report.docx'),
      content: z.string().min(1).describe('The full document text (markdown)'),
    }),
    summarize: (input) => `Export ${input.filename}`,
    async execute(input) {
      const name = path.basename(input.filename.trim());
      if (!/\.(docx|pdf)$/i.test(name)) throw new Error('The file name must end in .docx or .pdf.');
      const kind = name.toLowerCase().endsWith('.pdf') ? 'pdf' : 'docx';
      const bytes = kind === 'pdf' ? await buildPdf(input.content) : buildDocx(input.content);
      const target = path.join(deps.workDir, name);
      fs.writeFileSync(target, bytes);
      const mime = kind === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      return toolFileOutput({ name, mime, data: bytes.toString('base64') });
    },
  });
  return [exportTool as ToolDefinition];
}
