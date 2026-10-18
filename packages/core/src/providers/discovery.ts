export interface DiscoveredModel {
  id: string;
  name?: string;
  contextLimit?: number;
}

export interface DiscoveryRequest {
  /** SDK package of the provider; decides which "list models" dialect is spoken. */
  npm: string;
  /** Base URL of the provider's API. Optional for the vendors whose address is fixed. */
  baseURL: string | undefined;
  apiKey: string | undefined;
  fetchFn?: typeof fetch;
}

const DEFAULT_BASE_URL: Record<string, string> = {
  '@ai-sdk/deepseek': 'https://api.deepseek.com',
  '@ai-sdk/anthropic': 'https://api.anthropic.com/v1',
  '@ai-sdk/google': 'https://generativelanguage.googleapis.com/v1beta',
};
const TIMEOUT_MS = 15_000;

/** A failed model listing; the message says what the user should check. */
export class DiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscoveryError';
  }
}

/**
 * Asks a provider which models it serves, the way opencode does after a provider is
 * connected. This doubles as the check that the URL and the API key actually work.
 */
export async function discoverModels(request: DiscoveryRequest): Promise<DiscoveredModel[]> {
  const base = (request.baseURL ?? DEFAULT_BASE_URL[request.npm] ?? '').replace(/\/+$/, '');
  if (!base) throw new DiscoveryError('This provider needs a base URL, e.g. https://example.com/v1');
  const key = request.apiKey ?? '';
  const url = `${base}/models`;

  // Three dialects of the same question: OpenAI-style (nearly everyone), Anthropic, Google.
  const headers: Record<string, string> =
    request.npm === '@ai-sdk/anthropic'
      ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
      : request.npm === '@ai-sdk/google'
        ? { 'x-goog-api-key': key }
        : key
          ? { authorization: `Bearer ${key}` }
          : {};

  let response: Response;
  try {
    response = await (request.fetchFn ?? fetch)(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new DiscoveryError(`Could not reach ${url}: ${(error as Error).message}`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new DiscoveryError(`${url} rejected the API key (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    throw new DiscoveryError(`${url} answered HTTP ${response.status}. Check the base URL, or list the model ids by hand.`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new DiscoveryError(`${url} did not return JSON. Check the base URL.`);
  }
  const record = (body ?? {}) as { data?: unknown; models?: unknown };
  const items = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : Array.isArray(body) ? body : null;
  if (!items) throw new DiscoveryError(`${url} did not return a model list.`);

  const models: DiscoveredModel[] = [];
  for (const item of items as Array<Record<string, unknown>>) {
    const rawId = typeof item?.id === 'string' ? item.id : typeof item?.name === 'string' ? item.name : null;
    if (!rawId) continue;
    // Google lists generation methods; skip models that cannot chat (embeddings and the like).
    const methods = item.supportedGenerationMethods;
    if (Array.isArray(methods) && !methods.includes('generateContent')) continue;
    const name = [item.display_name, item.displayName].find((value) => typeof value === 'string') as string | undefined;
    const limit = [item.context_length, item.context_window, item.inputTokenLimit].find((value) => typeof value === 'number') as number | undefined;
    models.push({ id: rawId.replace(/^models\//, ''), name, contextLimit: limit });
  }
  if (models.length === 0) throw new DiscoveryError(`${url} returned no models.`);
  return models.sort((a, b) => a.id.localeCompare(b.id));
}
