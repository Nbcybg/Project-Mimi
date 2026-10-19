import { parseArgs } from 'node:util';
import { AppSettings } from '../app/app-settings.ts';
import { loadConfig } from '../config.ts';
import { AuthStore } from '../providers/auth-store.ts';
import { loadCatalog } from '../providers/catalog.ts';
import { ProviderRegistry } from '../providers/registry.ts';
import { loadSettings } from '../providers/settings.ts';
import { formatModelList } from './commands.ts';

// npm run models -- [provider] [--refresh]
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { refresh: { type: 'boolean', default: false } },
});
const config = loadConfig();
const settings = loadSettings(config.settingsPath);
const catalog = await loadCatalog({
  cachePath: config.catalogCachePath,
  offline: config.catalogOffline,
  url: config.catalogUrl,
  refresh: values.refresh,
});
if (catalog.isEmpty) console.log('The models.dev catalog is not available (offline and no cached copy).\n');

console.log(`Settings (${config.settingsPath})`);
for (const key of ['model', 'small_model', 'vision_model', 'transcript_model', 'image_model', 'speech_model', 'video_model'] as const) {
  const unset = key === 'image_model' || key === 'speech_model' || key === 'video_model' ? '(not set)' : '(falls back to model)';
  console.log(`  ${key.padEnd(17)} ${settings[key] ?? unset}`);
}
console.log();
// Providers connected in the app count here too.
const app = AppSettings.load(config.appSettingsPath);
const registry = new ProviderRegistry(catalog, settings.provider, process.env, {
  auth: new AuthStore(config.authPath),
  extra: () => app.providerDefs(),
  listed: () => app.listedModels(),
});
console.log(formatModelList(registry, positionals[0]));
