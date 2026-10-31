/**
 * A stable code for every failure the user can see in a chat or a toast.
 * The code is short enough to read in a notification and specific enough to act on:
 * E-AUTH-401, E-RATE-429, E-NETWORK, E-CONTEXT, E-MODEL, E-BUDGET, E-CONFIG, E-INTERNAL.
 */
export interface ClassifiedError {
  code: string;
  message: string;
}

interface ErrorShape {
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
  cause?: unknown;
}

const alreadyCoded = /^\s*\[?(E-[A-Z0-9]+(?:-[A-Za-z0-9]+)?)\]?\s*[:\-]\s*/;

function statusOf(error: ErrorShape): number | null {
  for (const value of [error.statusCode, error.status, error.code]) {
    const status = Number(value);
    if (Number.isInteger(status) && status >= 400 && status <= 599) return status;
  }
  const cause = error.cause as ErrorShape | undefined;
  return cause && cause !== error ? statusOf(cause) : null;
}

function rawCodeOf(error: ErrorShape): string | null {
  for (const value of [error.code, (error.cause as ErrorShape | undefined)?.code]) {
    if (typeof value === 'string' && /^[A-Z][A-Z0-9_]+$/.test(value)) return value;
  }
  return null;
}

function baseCode(message: string, status: number | null, raw: string | null): string {
  if (status === 401 || status === 403 || /unauthori[sz]ed|forbidden|invalid (?:api|access) key|authentication|api key/i.test(message)) return 'E-AUTH';
  if (status === 429 || /rate[ _-]?limit|too many requests|quota (?:exceeded|exhausted)|resource[ _-]?exhausted/i.test(message)) return 'E-RATE';
  if (/context (?:length|window)|maximum context|too many tokens|token limit|prompt is too long/i.test(message)) return 'E-CONTEXT';
  if (/model .*(?:not found|does not exist|unsupported)|unknown model|no such model/i.test(message)) return 'E-MODEL';
  if (raw === 'ETIMEDOUT' || raw === 'ESOCKETTIMEDOUT' || /timed? ?out|timeout/i.test(message)) return 'E-TIMEOUT';
  if (raw && /^(?:ECONN|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EPIPE|ECONNRESET)/.test(raw)) return 'E-NETWORK';
  if (/fetch failed|network|socket hang up|getaddrinfo|connection (?:refused|reset)/i.test(message)) return 'E-NETWORK';
  if (/budget|spending limit|daily limit|over (?:the )?limit/i.test(message)) return 'E-BUDGET';
  if (/unknown tool|unknown agent|no agent|not configured|missing api key|does not exist|invalid .*(?:config|setting|input)|required/i.test(message)) return 'E-CONFIG';
  if (status && status >= 500) return 'E-PROVIDER';
  return 'E-INTERNAL';
}

/** Splits an error into a stable code and a message without that code. */
export function classifyError(error: unknown): ClassifiedError {
  const message = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  const existing = alreadyCoded.exec(message);
  if (existing) return { code: existing[1]!, message: message.slice(existing[0].length) };
  const shape = (error && typeof error === 'object' ? error : {}) as ErrorShape;
  const status = statusOf(shape);
  const raw = rawCodeOf(shape);
  const base = baseCode(message, status, raw);
  // HTTP statuses make the code actionable (429 means "wait", 401 means "fix the key").
  const code = status && /^E-(?:AUTH|RATE|MODEL|PROVIDER)$/.test(base) ? `${base}-${status}` : base;
  return { code, message };
}

/** `E-RATE-429: ...` — what a chat note, a toast or a log line shows. */
export function formatError(error: unknown): string {
  const { code, message } = classifyError(error);
  return `${code}: ${message}`;
}

/** The code for a message that is already plain text (e.g. a provider's own error string). */
export function codeForMessage(message: string): string {
  return classifyError(new Error(message)).code;
}

export interface ErrorCodeGuide {
  code: string;
  title: string;
  meaning: string;
  fix: string;
}

/**
 * What each code means and what to do next. The AI Overseer reads this through
 * the `error_codes` tool, and the same text is in docs/error-codes.md.
 */
export const ERROR_CODE_GUIDE: ErrorCodeGuide[] = [
  {
    code: 'E-AUTH',
    title: 'Authentication / permission',
    meaning: 'The provider rejected the API key, the OAuth account is not connected, or the key has no access to this model/scope. Codes such as E-AUTH-401 / E-AUTH-403 keep the HTTP status.',
    fix: 'Check the provider key in Hub > Keys or reconnect the account (Settings > Google/Microsoft). Do not put the key in a prompt or tool.',
  },
  {
    code: 'E-RATE',
    title: 'Rate limit / quota',
    meaning: 'The provider is throttling requests or the plan/quota is exhausted (often HTTP 429). Codes such as E-RATE-429 keep the status.',
    fix: 'Wait and retry, lower parallel runs, or check the provider plan/quota. A workflow with retries can ride out a short limit.',
  },
  {
    code: 'E-CONTEXT',
    title: 'Context window full',
    meaning: 'The conversation plus the prompt is longer than the model can accept.',
    fix: 'Start a new session, let compaction run, or use a model with a larger context. Do not keep resending the same huge prompt.',
  },
  {
    code: 'E-MODEL',
    title: 'Model missing / unsupported',
    meaning: 'The model reference does not exist at the provider, was removed, or does not support this input (for example an image on a text-only model). Codes such as E-MODEL-404 keep the status.',
    fix: 'Check the model reference and the provider catalog, then pick a model that supports the input.',
  },
  {
    code: 'E-TIMEOUT',
    title: 'Timed out',
    meaning: 'A provider, tool, workflow node or the network did not answer in time.',
    fix: 'Retry, raise the node/tool timeout if the work is genuinely slow, or check the network/PC agent. Repeated timeouts usually mean a larger configuration problem.',
  },
  {
    code: 'E-NETWORK',
    title: 'Network / connection',
    meaning: 'DNS, TCP, TLS or the provider endpoint failed (fetch failed, ECONNREFUSED, ENOTFOUND, reset). The PC agent may be offline for PC tools.',
    fix: 'Check the internet and the provider URL; start/reconnect the PC agent for PC tools. Do not retry a write blindly if it may have reached the other side.',
  },
  {
    code: 'E-BUDGET',
    title: 'Budget reached',
    meaning: 'The daily spending limit or the trace budget (tokens, rounds or time across one turn) is exhausted.',
    fix: 'Raise the budget in Settings or wait for the daily reset. For a runaway trace, narrow the prompt or reduce sub-agent loops.',
  },
  {
    code: 'E-CONFIG',
    title: 'Configuration error',
    meaning: 'An agent/tool/skill/workflow names something that does not exist, a required key or setting is missing, or the input is invalid.',
    fix: 'Run config_validate, fix the named item (agent_history / tool_history can undo a bad write), then test with tool_test or agent_message.',
  },
  {
    code: 'E-PROVIDER',
    title: 'Provider server error',
    meaning: 'The provider returned a server-side failure (usually HTTP 5xx). It is not caused by the local setup.',
    fix: 'Retry later or switch to another model/provider. Codes such as E-PROVIDER-500 keep the status.',
  },
  {
    code: 'E-INTERNAL',
    title: 'Unexpected error',
    meaning: 'Something failed that does not match a known category. The message is the best clue.',
    fix: 'Read the full message, reproduce with the smallest test (tool_test / agent_message / workflow_runs), and report the exact step.',
  },
];

/** Looks up a code, ignoring an HTTP suffix such as -429. */
export function errorGuideFor(code: string): ErrorCodeGuide | undefined {
  const normalized = code.trim().toUpperCase();
  return ERROR_CODE_GUIDE.find((entry) => entry.code === normalized || normalized.startsWith(`${entry.code}-`));
}
