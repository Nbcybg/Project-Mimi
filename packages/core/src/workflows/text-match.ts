/** How a chat or Telegram trigger decides whether a message is for it. */
export type TextMatch = 'any' | 'starts_with' | 'contains' | 'regex';

export interface MatchResult {
  ok: boolean;
  /** The text after a starts_with prefix (else the whole text), trimmed. */
  rest: string;
}

/** Case-insensitive; an empty pattern matches everything; a broken regex matches nothing. */
export function matchText(match: string, pattern: string, text: string): MatchResult {
  const body = text.trim();
  const wanted = pattern.trim();
  if (!wanted || match === 'any') return { ok: true, rest: body };
  const lower = body.toLowerCase();
  const needle = wanted.toLowerCase();
  switch (match) {
    case 'starts_with':
      return lower.startsWith(needle) ? { ok: true, rest: body.slice(wanted.length).trim() } : { ok: false, rest: body };
    case 'contains':
      return { ok: lower.includes(needle), rest: body };
    case 'regex':
      try {
        return { ok: new RegExp(wanted, 'iu').test(body), rest: body };
      } catch {
        return { ok: false, rest: body };
      }
    default:
      return { ok: false, rest: body };
  }
}
