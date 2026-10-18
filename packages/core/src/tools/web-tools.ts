import { z } from 'zod';
import { defineTool, type ToolDefinition } from './registry.ts';

export interface WebToolOptions {
  /** Looks up an API key by environment variable name, at call time. */
  key: (name: string) => string | undefined;
  /** Country and language sent to the search provider. */
  region?: { country: string; language: string };
  fetchFn?: typeof fetch;
}

interface SerperSearch {
  answerBox?: { title?: string; answer?: string; snippet?: string };
  knowledgeGraph?: { title?: string; type?: string; description?: string };
  organic?: Array<{ title?: string; link?: string; snippet?: string; date?: string }>;
}
interface SerperMaps {
  places?: Array<{
    title?: string;
    address?: string;
    rating?: number;
    ratingCount?: number;
    category?: string;
    phoneNumber?: string;
    latitude?: number;
    longitude?: number;
  }>;
}
interface SerperVideos {
  videos?: Array<{
    title?: string;
    link?: string;
    snippet?: string;
    duration?: string;
    source?: string;
    channel?: string;
    date?: string;
  }>;
}
interface WeatherPoint {
  dt_txt?: string;
  name?: string;
  sys?: { country?: string };
  main?: { temp?: number; feels_like?: number; humidity?: number };
  weather?: Array<{ description?: string }>;
  wind?: { speed?: number };
  pop?: number;
}

function weatherLine(point: WeatherPoint): string {
  const parts = [
    `${Math.round(point.main?.temp ?? NaN)}°C`,
    point.weather?.[0]?.description ?? '',
    point.main?.feels_like !== undefined ? `feels like ${Math.round(point.main.feels_like)}°C` : '',
    point.main?.humidity !== undefined ? `humidity ${point.main.humidity}%` : '',
    point.wind?.speed !== undefined ? `wind ${point.wind.speed} m/s` : '',
    point.pop !== undefined ? `rain chance ${Math.round(point.pop * 100)}%` : '',
  ];
  return parts.filter(Boolean).join(', ');
}

/**
 * Looking things up outside: web search and places (Serper), weather (OpenWeatherMap).
 * What comes back was written by strangers, so these are untrusted input: an agent that
 * has them cannot also have a shell.
 */
export function createWebTools(options: WebToolOptions): ToolDefinition<any>[] {
  const fetchFn = options.fetchFn ?? fetch;
  const region = options.region ?? { country: 'th', language: 'th' };
  const need = (name: string, what: string, where: string): string => {
    const key = options.key(name);
    if (!key) throw new Error(`${what} is not set up: add the ${where} API key under "Tool keys" in the app's settings.`);
    return key;
  };
  const json = async <T>(response: Response, service: string): Promise<T> => {
    const text = await response.text();
    if (!response.ok) throw new Error(`${service} error ${response.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text) as T;
  };
  const serper = async <T>(endpoint: 'search' | 'maps' | 'videos', query: string, count: number): Promise<T> => {
    const response = await fetchFn(`https://google.serper.dev/${endpoint}`, {
      method: 'POST',
      headers: { 'X-API-KEY': need('SERPER_API_KEY', 'Web search', 'Serper'), 'content-type': 'application/json' },
      body: JSON.stringify({ q: query, gl: region.country, hl: region.language, num: count }),
    });
    return json<T>(response, 'Search');
  };

  const webSearch = defineTool({
    name: 'web_search',
    description:
      'Search the web for current information. Returns titles, links and snippets of the top results (and a direct answer when the search engine has one).',
    risk: 'read',
    target: 'core',
    untrustedInput: true,
    inputSchema: z.object({
      query: z.string().min(1),
      max_results: z.number().int().positive().max(10).optional(),
    }),
    summarize: (input) => `Search the web: ${input.query}`,
    async execute(input) {
      const found = await serper<SerperSearch>('search', input.query, input.max_results ?? 5);
      const lines: string[] = [];
      const answer = found.answerBox?.answer ?? found.answerBox?.snippet;
      if (answer) lines.push(`Answer: ${answer}`);
      if (found.knowledgeGraph?.title) {
        const graph = found.knowledgeGraph;
        lines.push(`${graph.title}${graph.type ? ` (${graph.type})` : ''}${graph.description ? `: ${graph.description}` : ''}`);
      }
      for (const [index, result] of (found.organic ?? []).slice(0, input.max_results ?? 5).entries()) {
        lines.push(`${index + 1}. ${result.title ?? ''}${result.date ? ` (${result.date})` : ''}\n   ${result.link ?? ''}\n   ${result.snippet ?? ''}`);
      }
      return lines.length > 0 ? lines.join('\n') : 'No results.';
    },
  });

  const mapSearch = defineTool({
    name: 'map_search',
    description:
      'Find places (restaurants, shops, services, addresses) on the map. Returns name, address, rating and a map link for the top matches. Put the area in the query, e.g. "ร้านกาแฟ อารีย์".',
    risk: 'read',
    target: 'core',
    untrustedInput: true,
    inputSchema: z.object({
      query: z.string().min(1),
      max_results: z.number().int().positive().max(10).optional(),
    }),
    summarize: (input) => `Search places: ${input.query}`,
    async execute(input) {
      const found = await serper<SerperMaps>('maps', input.query, input.max_results ?? 5);
      const places = (found.places ?? []).slice(0, input.max_results ?? 5);
      if (places.length === 0) return 'No places found.';
      return places
        .map((place, index) => {
          const rating = place.rating !== undefined ? ` · ${place.rating}★${place.ratingCount ? ` (${place.ratingCount})` : ''}` : '';
          const link = place.latitude !== undefined && place.longitude !== undefined ? `\n   https://www.google.com/maps?q=${place.latitude},${place.longitude}` : '';
          return `${index + 1}. ${place.title ?? ''}${place.category ? ` · ${place.category}` : ''}${rating}\n   ${place.address ?? ''}${place.phoneNumber ? ` · ${place.phoneNumber}` : ''}${link}`;
        })
        .join('\n');
    },
  });

  const youtubeSearch = defineTool({
    name: 'youtube_search',
    description:
      'Search YouTube for videos. Returns title, channel, duration, date and link of the top matches. Use it to find a video to watch or a tutorial to follow.',
    risk: 'read',
    target: 'core',
    untrustedInput: true,
    inputSchema: z.object({
      query: z.string().min(1),
      max_results: z.number().int().positive().max(10).optional(),
    }),
    summarize: (input) => `Search YouTube: ${input.query}`,
    async execute(input) {
      const found = await serper<SerperVideos>('videos', input.query, input.max_results ?? 5);
      const videos = (found.videos ?? []).slice(0, input.max_results ?? 5);
      if (videos.length === 0) return 'No videos found.';
      return videos
        .map((video, index) => {
          const meta = [video.channel, video.duration, video.date?.slice(0, 10)].filter(Boolean).join(' · ');
          return `${index + 1}. ${video.title ?? ''}${meta ? ` (${meta})` : ''}\n   ${video.link ?? ''}\n   ${video.snippet ?? ''}`;
        })
        .join('\n');
    },
  });

  const weather = defineTool({
    name: 'weather',
    description:
      'Current weather and the forecast for the next days (every 3 hours, up to 5 days) for a city. Use the English or local city name, optionally with a country code, e.g. "Bangkok,TH".',
    risk: 'read',
    target: 'core',
    untrustedInput: true,
    inputSchema: z.object({
      city: z.string().min(1),
      days: z.number().int().min(0).max(5).optional().describe('Forecast days to include; 0 for the current weather only'),
    }),
    summarize: (input) => `Weather for ${input.city}`,
    async execute(input) {
      const key = need('OPENWEATHER_API_KEY', 'Weather', 'OpenWeatherMap');
      const query = `q=${encodeURIComponent(input.city)}&units=metric&lang=${region.language}&appid=${encodeURIComponent(key)}`;
      const now = await json<WeatherPoint>(await fetchFn(`https://api.openweathermap.org/data/2.5/weather?${query}`), 'Weather');
      const lines = [`${now.name ?? input.city}${now.sys?.country ? `, ${now.sys.country}` : ''} now: ${weatherLine(now)}`];
      const days = input.days ?? 1;
      if (days > 0) {
        const forecast = await json<{ list?: WeatherPoint[] }>(
          await fetchFn(`https://api.openweathermap.org/data/2.5/forecast?${query}&cnt=${days * 8}`),
          'Weather',
        );
        // Every 6 hours, to keep the answer short. The service reports these times in UTC.
        for (const point of (forecast.list ?? []).filter((_point, index) => index % 2 === 1)) {
          lines.push(`${point.dt_txt?.slice(0, 16) ?? '?'} UTC: ${weatherLine(point)}`);
        }
      }
      return lines.join('\n');
    },
  });

  return [webSearch, mapSearch, youtubeSearch, weather];
}
