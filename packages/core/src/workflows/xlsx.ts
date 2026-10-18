import zlib from 'node:zlib';

/**
 * Reads .xlsx files without a library: an .xlsx is a zip of XML parts. This covers
 * what a household / office sheet needs: every sheet's cell values (shared strings,
 * inline strings, numbers, booleans, formulas' cached results). Styles, merged cells
 * and charts are ignored; dates stay as Excel serial numbers unless asked to convert.
 */

/** The files inside a zip archive (stored or deflated entries). */
export function unzip(data: Buffer): Map<string, Buffer> {
  // The end-of-central-directory record sits in the last 64 KB.
  let end = -1;
  for (let at = data.length - 22; at >= Math.max(0, data.length - 65_558); at--) {
    if (data.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error('not a zip file (no central directory)');
  const count = data.readUInt16LE(end + 10);
  let at = data.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let index = 0; index < count; index++) {
    if (data.readUInt32LE(at) !== 0x02014b50) throw new Error('broken zip central directory');
    const method = data.readUInt16LE(at + 10);
    const compressed = data.readUInt32LE(at + 20);
    const nameLength = data.readUInt16LE(at + 28);
    const extraLength = data.readUInt16LE(at + 30);
    const commentLength = data.readUInt16LE(at + 32);
    const local = data.readUInt32LE(at + 42);
    const name = data.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    const localName = data.readUInt16LE(local + 26);
    const localExtra = data.readUInt16LE(local + 28);
    const start = local + 30 + localName + localExtra;
    const body = data.subarray(start, start + compressed);
    if (method === 0) files.set(name, Buffer.from(body));
    else if (method === 8) files.set(name, zlib.inflateRawSync(body));
    else throw new Error(`zip entry ${name} uses an unsupported compression (${method})`);
  }
  return files;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (match, entity: string) => {
    if (entity[0] === '#') return String.fromCodePoint(entity[1]?.toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1)));
    return ENTITIES[entity] ?? match;
  });

/** All <t> text inside a shared-string or inline-string element (rich text has several). */
const textOf = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((match) => decode(match[1]!)).join('');

/** "B12" → column index 1. */
function columnIndex(reference: string): number {
  const letters = /^[A-Z]+/.exec(reference)?.[0] ?? 'A';
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

export interface Sheet {
  name: string;
  rows: Array<Array<string | number | boolean | null>>;
}

/** Every sheet of a workbook, in workbook order. */
export function readXlsx(data: Buffer): Sheet[] {
  const files = unzip(data);
  const text = (name: string) => files.get(name)?.toString('utf8') ?? '';
  const workbook = text('xl/workbook.xml');
  if (!workbook) throw new Error('not an Excel workbook (.xlsx)');
  const shared = [...text('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) => textOf(match[1]!));
  const rels = new Map(
    [...text('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)].map((match) => {
      const id = /\bId="([^"]+)"/.exec(match[0])?.[1] ?? '';
      const target = /\bTarget="([^"]+)"/.exec(match[0])?.[1] ?? '';
      return [id, target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`];
    }),
  );
  const sheets: Sheet[] = [];
  for (const match of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = decode(/\bname="([^"]*)"/.exec(match[0])?.[1] ?? `Sheet${sheets.length + 1}`);
    const id = /\br:id="([^"]+)"/.exec(match[0])?.[1] ?? '';
    const xml = text(rels.get(id) ?? '');
    const rows: Sheet['rows'] = [];
    for (const row of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const cells: Array<string | number | boolean | null> = [];
      for (const cell of (row[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attributes = cell[1]!;
        const body = cell[2] ?? '';
        const reference = /\br="([A-Z]+\d+)"/.exec(attributes)?.[1];
        const type = /\bt="([^"]+)"/.exec(attributes)?.[1] ?? 'n';
        const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        let value: string | number | boolean | null = null;
        if (type === 's') value = shared[Number(raw)] ?? '';
        else if (type === 'inlineStr') value = textOf(body);
        else if (type === 'b') value = raw === '1';
        else if (type === 'str' || type === 'e') value = raw === undefined ? null : decode(raw);
        else if (raw !== undefined) value = Number(raw);
        const at = reference ? columnIndex(reference) : cells.length;
        while (cells.length < at) cells.push(null);
        cells[at] = value;
      }
      // Rows may skip numbers (empty rows): keep positions by the row's r attribute.
      const number = Number(/\br="(\d+)"/.exec(row[0])?.[1] ?? rows.length + 1);
      while (rows.length < number - 1) rows.push([]);
      rows.push(cells);
    }
    sheets.push({ name, rows });
  }
  return sheets;
}

/** Excel's serial day number as YYYY-MM-DD (the 1900 system). */
export function excelDate(serial: number): string {
  return new Date(Math.round((serial - 25569) * 86_400_000)).toISOString().slice(0, 10);
}

/** A sheet as items: the first non-empty row names the columns. */
export function sheetItems(sheet: Sheet, header = true): Array<Record<string, string | number | boolean | null>> {
  const rows = sheet.rows.filter((row) => row.some((cell) => cell !== null && cell !== ''));
  if (rows.length === 0) return [];
  const width = Math.max(...rows.map((row) => row.length));
  const names = header ? Array.from({ length: width }, (_, index) => String(rows[0]![index] ?? '').trim() || `col${index + 1}`) : Array.from({ length: width }, (_, index) => `col${index + 1}`);
  return (header ? rows.slice(1) : rows).map((row) => Object.fromEntries(names.map((name, index) => [name, row[index] ?? null])));
}

/** A workbook as plain text (for the knowledge base and agents): one block per sheet, tab-separated. */
export function xlsxText(data: Buffer): string {
  return readXlsx(data)
    .map((sheet) => `## ${sheet.name}\n${sheet.rows.filter((row) => row.length > 0).map((row) => row.map((cell) => (cell === null ? '' : String(cell))).join('\t')).join('\n')}`)
    .join('\n\n');
}
