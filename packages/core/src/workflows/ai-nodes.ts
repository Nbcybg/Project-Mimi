import type { ClassifyCategory, ExtractAttribute, JsonValue } from '@mimi/shared';

/** One direct model call: system prompt + user prompt in, the answer's text out. */
export type Ask = (system: string, prompt: string) => Promise<string>;

const ATTRIBUTE_TYPES = ['string', 'number', 'boolean', 'array', 'object'] as const;

const isRecord = (value: unknown): value is Record<string, JsonValue> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Pulls the JSON value out of a model answer: plain, inside a ``` fence, or wrapped in prose. */
export function parseJsonAnswer(text: string): JsonValue {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = (fenced ? fenced[1]! : text).trim();
  try {
    return JSON.parse(body) as JsonValue;
  } catch {
    // fall through: look for the outermost object or array
  }
  const start = body.search(/[{[]/);
  if (start >= 0) {
    const end = body.lastIndexOf(body[start] === '{' ? '}' : ']');
    if (end > start) {
      try {
        return JSON.parse(body.slice(start, end + 1)) as JsonValue;
      } catch {
        // not JSON either
      }
    }
  }
  throw new Error(`the model did not answer with JSON: ${text.slice(0, 200)}`);
}

/** The extract node's field list; rows without a name are dropped, duplicates keep the first. */
export function attributesOf(value: JsonValue | undefined): ExtractAttribute[] {
  const list: ExtractAttribute[] = [];
  for (const entry of Array.isArray(value) ? value : []) {
    if (!isRecord(entry)) continue;
    const name = String(entry.name ?? '').trim();
    if (!name || list.some((attribute) => attribute.name === name)) continue;
    const type = ATTRIBUTE_TYPES.find((candidate) => candidate === entry.type) ?? 'string';
    const description = String(entry.description ?? '').trim();
    list.push({ name, type, ...(description ? { description } : {}), required: entry.required === true });
  }
  return list;
}

/** The classify node's categories; a plain string is a category without a description. */
export function categoriesOf(value: JsonValue | undefined): ClassifyCategory[] {
  const list: ClassifyCategory[] = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const name = String(isRecord(entry) ? (entry.name ?? '') : (entry ?? '')).trim();
    if (!name || list.some((category) => category.name === name)) continue;
    const description = isRecord(entry) ? String(entry.description ?? '').trim() : '';
    list.push({ name, ...(description ? { description } : {}) });
  }
  return list;
}

const TRUE_WORDS = new Set(['true', 'yes', 'y', '1', 'ใช่', 'จริง']);
const FALSE_WORDS = new Set(['false', 'no', 'n', '0', 'ไม่', 'ไม่ใช่', 'เท็จ']);

/** Makes a model's value fit the declared type; what cannot fit becomes null. */
export function coerce(value: JsonValue | undefined, type: ExtractAttribute['type']): JsonValue {
  if (value === undefined || value === null || value === '') return null;
  switch (type) {
    case 'string':
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
    case 'number': {
      if (typeof value === 'number') return Number.isFinite(value) ? value : null;
      const match = /-?\d+(?:\.\d+)?/.exec(String(value).replace(/,/g, ''));
      return match ? Number(match[0]) : null;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      const word = String(value).trim().toLowerCase();
      return TRUE_WORDS.has(word) ? true : FALSE_WORDS.has(word) ? false : null;
    }
    case 'array':
      return Array.isArray(value) ? value : [value];
    case 'object':
      return isRecord(value) ? value : null;
  }
}

function describeAttributes(attributes: ExtractAttribute[]): string {
  return attributes
    .map((attribute) => {
      const flags = [attribute.type, attribute.required ? 'required' : 'optional'].join(', ');
      return `- "${attribute.name}" (${flags})${attribute.description ? `: ${attribute.description}` : ''}`;
    })
    .join('\n');
}

/** Asks for JSON; one retry tells the model what was wrong with its first answer. */
async function askForJson(ask: Ask, system: string, prompt: string, check: (value: JsonValue) => string | null): Promise<JsonValue> {
  let answer = await ask(system, prompt);
  let problem: string;
  try {
    const value = parseJsonAnswer(answer);
    const issue = check(value);
    if (!issue) return value;
    problem = issue;
  } catch (error) {
    problem = (error as Error).message;
  }
  answer = await ask(
    system,
    `${prompt}\n\nYour previous answer was:\n${answer.slice(0, 2000)}\n\nProblem: ${problem}\nAnswer again with the JSON only.`,
  );
  const value = parseJsonAnswer(answer);
  // A second answer that still misses something is used as far as it goes.
  return value;
}

/** The llm node in JSON mode: any JSON value. */
export function askJson(ask: Ask, system: string, prompt: string): Promise<JsonValue> {
  const rule = 'Answer with valid JSON only: no prose, no code fence.';
  return askForJson(ask, system ? `${system}\n\n${rule}` : rule, prompt, () => null);
}

/** The extract node: one JSON object with the declared fields, each coerced to its type. */
export async function extractFields(
  ask: Ask,
  text: string,
  attributes: ExtractAttribute[],
  instruction: string,
): Promise<Record<string, JsonValue>> {
  const system = [
    'You extract structured data from the text the user gives you.',
    'Answer with ONE JSON object only (no prose, no code fence) that has exactly these keys:',
    describeAttributes(attributes),
    'Use null for a value the text does not give. Do not invent values. Keep string values in the language of the text.',
  ].join('\n');
  const prompt = [instruction.trim(), `<text>\n${text}\n</text>`].filter(Boolean).join('\n\n');
  const answer = await askForJson(ask, system, prompt, (value) => {
    if (!isRecord(value)) return 'the answer must be a JSON object';
    const missing = attributes.filter((attribute) => attribute.required && coerce(value[attribute.name], attribute.type) === null);
    return missing.length > 0 ? `missing required keys: ${missing.map((attribute) => attribute.name).join(', ')}` : null;
  });
  const source = isRecord(answer) ? answer : {};
  const values: Record<string, JsonValue> = {};
  for (const attribute of attributes) values[attribute.name] = coerce(source[attribute.name], attribute.type);
  return values;
}

const normalize = (text: string) => text.trim().replace(/^["'`]+|["'`.]+$/g, '').trim().toLowerCase();

/** The classify node: the index of the chosen category, or -1 when none fits. */
export async function classifyText(ask: Ask, text: string, categories: ClassifyCategory[], instruction: string): Promise<number> {
  const system = [
    'You sort the text the user gives you into exactly one of these categories:',
    categories.map((category) => `- "${category.name}"${category.description ? `: ${category.description}` : ''}`).join('\n'),
    'Answer with JSON only: {"category": "<the exact category name>"}, or {"category": "none"} when no category fits.',
    instruction.trim(),
  ]
    .filter(Boolean)
    .join('\n');
  const answer = await ask(system, `<text>\n${text}\n</text>`);
  let chosen = answer;
  try {
    const value = parseJsonAnswer(answer);
    chosen = isRecord(value) ? String(value.category ?? '') : String(value ?? '');
  } catch {
    // a bare category name is fine too
  }
  const wanted = normalize(chosen);
  return categories.findIndex((category) => normalize(category.name) === wanted);
}
