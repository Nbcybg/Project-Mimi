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

const KEYLESS_AGENT = 'Mimi/0.3 (personal assistant; https://github.com/Nbcybg/Project-Mimi)';

/** Text of an HTML fragment: tags dropped, the common entities decoded, spaces folded. */
function htmlText(fragment: string): string {
  return fragment
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Results of DuckDuckGo's HTML page (no key needed): title, real link, snippet. */
export function parseDuckDuckGo(html: string): Array<{ title: string; link: string; snippet: string }> {
  const results: Array<{ title: string; link: string; snippet: string }> = [];
  const blocks = html.split(/<div class="result results_links/).slice(1);
  for (const block of blocks) {
    const anchor = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!anchor) continue;
    let link = anchor[1]!.replace(/&amp;/g, '&');
    const target = /[?&]uddg=([^&]+)/.exec(link);
    if (target) link = decodeURIComponent(target[1]!);
    else if (link.startsWith('//')) link = `https:${link}`;
    if (/duckduckgo\.com\/y\.js/.test(link)) continue; // ads
    const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    results.push({ title: htmlText(anchor[2]!), link, snippet: snippet ? htmlText(snippet[1]!) : '' });
  }
  return results;
}

/** Thai place words OpenStreetMap's search understands better in English. */
const PLACE_WORDS: Array<[RegExp, string]> = [
  [/ร้านอาหาร|ที่กิน|ร้านข้าว/g, 'restaurant'],
  [/ร้านกาแฟ|คาเฟ่/g, 'cafe'],
  [/โรงพยาบาล/g, 'hospital'],
  [/ร้านขายยา/g, 'pharmacy'],
  [/ปั๊มน้ำมัน/g, 'fuel'],
  [/โรงแรม/g, 'hotel'],
  [/ธนาคาร/g, 'bank'],
  [/ห้าง|ห้างสรรพสินค้า/g, 'mall'],
  [/แถว|ใกล้|ย่าน/g, ' '],
];

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

  /** Without a Serper key: DuckDuckGo's HTML results. */
  const keylessSearch = async (query: string, count: number): Promise<string> => {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=${region.country}-${region.language}`;
    const response = await fetchFn(url, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36' } });
    if (!response.ok) throw new Error(`Search error ${response.status} (DuckDuckGo). Add a Serper key in the app's settings for steadier results.`);
    const results = parseDuckDuckGo(await response.text()).slice(0, count);
    if (results.length === 0) return 'No results.';
    return results.map((result, index) => `${index + 1}. ${result.title}\n   ${result.link}\n   ${result.snippet}`).join('\n');
  };

  /** Without a Serper key: OpenStreetMap's place search (Nominatim). */
  const keylessPlaces = async (query: string, count: number): Promise<string> => {
    const ask = async (q: string) => {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&limit=${count}&countrycodes=${region.country}&extratags=1&accept-language=${region.language}`;
      const response = await fetchFn(url, { headers: { 'user-agent': KEYLESS_AGENT } });
      return json<Array<{ name?: string; display_name?: string; type?: string; lat?: string; lon?: string; extratags?: Record<string, string> }>>(response, 'Map search');
    };
    let places = await ask(query);
    if (places.length === 0) {
      let english = query;
      for (const [pattern, word] of PLACE_WORDS) english = english.replace(pattern, ` ${word} `);
      english = english.replace(/\s+/g, ' ').trim();
      if (english !== query) places = await ask(english);
    }
    if (places.length === 0) return 'No places found. Try a category word plus the area, e.g. "restaurant Lat Phrao".';
    return places
      .slice(0, count)
      .map((place, index) => {
        const extra = place.extratags ?? {};
        const details = [place.type, extra.cuisine && `cuisine: ${extra.cuisine}`, extra.opening_hours && `hours: ${extra.opening_hours}`, extra.phone ?? extra['contact:phone']].filter(Boolean).join(' · ');
        const link = place.lat && place.lon ? `\n   https://www.google.com/maps?q=${place.lat},${place.lon}` : '';
        return `${index + 1}. ${place.name || place.display_name?.split(',')[0] || '?'}${details ? ` · ${details}` : ''}\n   ${place.display_name ?? ''}${link}`;
      })
      .join('\n') + '\n(Source: OpenStreetMap; ratings need a Serper key.)';
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
      if (!options.key('SERPER_API_KEY')) return keylessSearch(input.query, input.max_results ?? 5);
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
      if (!options.key('SERPER_API_KEY')) return keylessPlaces(input.query, input.max_results ?? 5);
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
