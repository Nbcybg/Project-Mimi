import type { FlowItem, JsonValue } from '@mimi/shared';

const SECRET_KEY =
  /(authorization|proxy[-_]?authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|passwd|credential|cookie|private[-_]?key|client[-_]?secret)/i;

const SECRET_TEXT = [
  /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(xox[baprs]-[A-Za-z0-9-]{10,})/g,
  /\b(sk-[A-Za-z0-9_-]{16,})/g,
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd)=([^&\s"']+)/gi,
];

/** Vault values shorter than this are too common to replace safely. */
const MIN_KNOWN_SECRET = 4;

/** Removes the exact values in the vault, longest first, then credential-shaped text. */
export function redactText(text: string, known?: readonly string[]): string {
  let out = text;
  for (const secret of [...(known ?? [])].filter((value) => value.length >= MIN_KNOWN_SECRET).sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join('[redacted]');
  }
  for (const pattern of SECRET_TEXT) out = out.replace(pattern, '[redacted]');
  return out;
}

/** Deep-copies JSON, replacing values under secret-looking keys and secrets in strings. */
export function redactValue(value: unknown, known?: readonly string[]): unknown {
  if (typeof value === 'string') return redactText(value, known);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, known));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) ? '[redacted]' : redactValue(entry, known);
    }
    return out;
  }
  return value;
}

/** Flow items with secret-looking fields/strings redacted; item order is kept. */
export function redactItems(items: FlowItem[], known?: readonly string[]): FlowItem[] {
  return items.map((item) => ({ ...item, json: redactValue(item.json, known) as Record<string, JsonValue> }));
}
