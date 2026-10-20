/** How a reply should sound when it is read aloud. */
export interface SpeechStyle {
  emotion?: string;
  tone?: string;
  /** Voice name or id understood by the speech provider. */
  voice?: string;
  /** Speech rate, 0.5–2. */
  speed?: number;
}

export interface ParsedSpeech {
  /** The reply without its direction line. */
  text: string;
  speech?: SpeechStyle;
}

const KEYS = new Set(['emotion', 'tone', 'voice', 'speed']);
const MAX_VALUE = 80;

function tagsOf(line: string): Array<[string, string]> {
  return [...line.matchAll(/\[([a-z]+)\s*:\s*([^\]\n]*)\]/gi)].map((match) => [
    match[1]!.toLowerCase(),
    match[2]!.trim(),
  ]);
}

/**
 * An assistant reply may begin with one line of voice direction:
 *
 *   [emotion: เศร้า][tone: กระซิบ][speed: 0.9]
 *   ฉันขอโทษ...
 *
 * The line is only recognised when it contains nothing but known tags, so ordinary
 * text such as `[1]` or `[a link]` is never removed. The values are free text; speed
 * is clamped to the range the Web Speech API and speech providers accept.
 */
export function parseSpeech(text: string): ParsedSpeech {
  const source = String(text ?? '');
  const end = source.indexOf('\n');
  const line = end === -1 ? source : source.slice(0, end);
  const tags = tagsOf(line);
  if (tags.length === 0 || tags.some(([key]) => !KEYS.has(key))) return { text: source };

  if (line.replace(/\[([a-z]+)\s*:\s*([^\]\n]*)\]/gi, '').trim()) return { text: source };

  const speech: SpeechStyle = {};
  for (const [key, value] of tags) {
    if (!KEYS.has(key) || !value) continue;
    if (key === 'speed') {
      const speed = Number(value);
      if (Number.isFinite(speed)) speech.speed = Math.min(2, Math.max(0.5, speed));
    } else if (speech[key as 'emotion' | 'tone' | 'voice'] === undefined) {
      speech[key as 'emotion' | 'tone' | 'voice'] = value.slice(0, MAX_VALUE);
    }
  }
  if (Object.keys(speech).length === 0) return { text: source };
  return { text: source.slice(end === -1 ? source.length : end + 1), speech };
}

/** Removes a leading direction line from provider content (string or content parts). */
export function stripSpeechFromContent(content: unknown): { content: unknown; speech?: SpeechStyle } {
  if (typeof content === 'string') {
    const parsed = parseSpeech(content);
    return parsed.speech ? { content: parsed.text, speech: parsed.speech } : { content };
  }
  if (!Array.isArray(content)) return { content };

  let speech: SpeechStyle | undefined;
  let checked = false;
  const parts = content.map((part) => {
    if (!checked && part && typeof part === 'object' && (part as { type?: unknown }).type === 'text') {
      checked = true;
      const text = (part as { text?: unknown }).text;
      if (typeof text === 'string') {
        const parsed = parseSpeech(text);
        if (parsed.speech) {
          speech = parsed.speech;
          return { ...part, text: parsed.text };
        }
      }
    }
    return part;
  });
  return speech ? { content: parts, speech } : { content };
}
