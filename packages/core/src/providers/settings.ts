import fs from 'node:fs';
import { z } from 'zod';

/**
 * `provider/model`, e.g. `deepseek/deepseek-flash` (everything after the first "/" is the
 * model id), or the name of a preset from the model pool, e.g. `creative`.
 */
export const modelRefString = z
  .string()
  .regex(/^(?:[^/\s]+\/\S+|[a-z0-9][a-z0-9_-]*)$/, 'expected "<provider>/<model>" or a preset name');

const CostSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cache_read: z.number().nonnegative().optional(),
  cache_write: z.number().nonnegative().optional(),
  context_over_200k: z
    .object({
      input: z.number().nonnegative(),
      output: z.number().nonnegative(),
      cache_read: z.number().nonnegative().optional(),
      cache_write: z.number().nonnegative().optional(),
    })
    .optional(),
});

/** Model metadata, in the shape models.dev publishes (USD per 1M tokens, token limits). */
export const ModelDefSchema = z.object({
  name: z.string().optional(),
  /** What the model is for: chat, image, speech, video, transcription, embedding… */
  type: z.string().optional(),
  status: z.string().optional(),
  attachment: z.boolean().optional(),
  tool_call: z.boolean().optional(),
  modalities: z
    .object({ input: z.array(z.string()).default([]), output: z.array(z.string()).default([]) })
    .optional(),
  limit: z
    .object({ context: z.number().positive(), output: z.number().positive().optional() })
    .partial()
    .optional(),
  cost: CostSchema.partial().optional(),
  /** Passed to the provider SDK as provider options on every call. */
  options: z.record(z.string(), z.unknown()).optional(),
  /** A model that speaks another API dialect than its provider's default (e.g. Claude behind a gateway). */
  provider: z.object({ npm: z.string().optional(), api: z.string().optional() }).optional(),
});
export type ModelDef = z.infer<typeof ModelDefSchema>;

export const ProviderDefSchema = z.object({
  name: z.string().optional(),
  /** AI SDK provider package, e.g. `@ai-sdk/openai-compatible`. */
  npm: z.string().optional(),
  /** Base URL for OpenAI-compatible providers. */
  api: z.string().optional(),
  /** Environment variables that may hold the API key. */
  env: z.array(z.string()).optional(),
  /** Passed to the provider factory: `apiKey`, `baseURL`, `headers`, ... */
  options: z.record(z.string(), z.unknown()).optional(),
  models: z.record(z.string(), ModelDefSchema).optional(),
});
export type ProviderDef = z.infer<typeof ProviderDefSchema>;

export const SettingsSchema = z.strictObject({
  $schema: z.string().optional(),
  /** Default chat model. */
  model: modelRefString,
  /** Cheap model for summaries and the memory writer; falls back to `model`. */
  small_model: modelRefString.optional(),
  /** Model used to describe images when the chat model cannot see them. */
  vision_model: modelRefString.optional(),
  /** Speech-to-text model. */
  transcript_model: modelRefString.optional(),
  /** Makes pictures (generate_image); no fallback. */
  image_model: modelRefString.optional(),
  /** Text-to-speech (text_to_speech); no fallback. */
  speech_model: modelRefString.optional(),
  /** Makes videos (generate_video); no fallback. */
  video_model: modelRefString.optional(),
  /** The agent that answers the user unless a client picks another, and that speaks reminders. */
  default_agent: z.string().default('mimi'),
  /** Custom providers and per-provider/per-model overrides of the models.dev catalog. */
  provider: z.record(z.string(), ProviderDefSchema).default({}),
  compaction: z
    .strictObject({
      auto: z.boolean().default(true),
      /** Compact when the prompt reaches this share of the context window. */
      threshold: z.number().min(0.1).max(0.95).default(0.65),
      /** Share of the context window kept as raw recent messages after compacting. */
      keep_recent: z.number().min(0.02).max(0.6).default(0.25),
      /** Share of the context window the rolling summaries may occupy before old ones are merged. */
      summary_budget: z.number().min(0.02).max(0.5).default(0.15),
      /** Treat the context window as at most this many tokens, whatever the model allows. */
      context_cap: z.number().int().positive().optional(),
    })
    .prefault({}),
  /** Limits for agent-to-agent messaging, per trace (one user turn or scheduled task). */
  mesh: z
    .strictObject({
      /** Maximum chain length of agent-to-agent messages. */
      max_hops: z.number().int().positive().default(8),
      max_trace_tokens: z.number().int().positive().default(2_000_000),
      max_trace_rounds: z.number().int().positive().default(80),
      max_trace_ms: z.number().int().positive().default(900_000),
      /** How long a delegating agent waits for the reply before giving up. */
      reply_timeout_ms: z.number().int().positive().default(300_000),
    })
    .prefault({}),
  session: z
    .strictObject({
      /** A chat that was silent this long continues in a new session, which starts by itself. */
      idle_minutes: z.number().positive().default(240),
      /** A session whose conversation outgrew this many tokens continues in a new one; 0 turns this off. */
      max_tokens: z.number().int().min(0).default(200_000),
    })
    .prefault({}),
  /** Per-tool permission override: "allow" runs without asking, "ask" always asks, "deny" disables. */
  permission: z.record(z.string(), z.enum(['allow', 'ask', 'deny'])).default({}),
  memory: z
    .strictObject({
      /** Run the background memory writer after each turn. */
      auto_write: z.boolean().default(true),
      /** Hard cap for each always-loaded file (profile, preferences). */
      profile_max_chars: z.number().int().positive().default(4000),
    })
    .prefault({}),
});
export type Settings = z.infer<typeof SettingsSchema>;

/** Replaces `{env:NAME}` in every string value, like opencode's config substitution. */
function substituteEnv(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === 'string') {
    return value.replace(/\{env:([^}]+)\}/g, (_match, name: string) => env[name.trim()] ?? '');
  }
  if (Array.isArray(value)) return value.map((item) => substituteEnv(item, env));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, substituteEnv(item, env)]),
    );
  }
  return value;
}

export function parseSettings(raw: unknown, env: NodeJS.ProcessEnv = process.env, origin = 'settings'): Settings {
  const parsed = SettingsSchema.safeParse(substituteEnv(raw, env));
  if (!parsed.success) throw new Error(`Invalid ${origin}:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export function loadSettings(settingsPath: string, env: NodeJS.ProcessEnv = process.env): Settings {
  if (!fs.existsSync(settingsPath)) throw new Error(`Missing settings file: ${settingsPath}`);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (error) {
    throw new Error(`${settingsPath} is not valid JSON: ${(error as Error).message}`);
  }
  return parseSettings(raw, env, settingsPath);
}
