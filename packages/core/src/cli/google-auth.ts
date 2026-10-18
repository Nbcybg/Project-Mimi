import { AppSettings } from '../app/app-settings.ts';
import { loadConfig } from '../config.ts';
import { startGoogleOAuth } from '../google/oauth-flow.ts';

// npm run google-auth
// One-time sign-in that stores a refresh token for the Gmail and Calendar tools.
// (The app's settings screen does the same with a button.)

const SETUP = `Google is not set up yet. One-time preparation:
  1. https://console.cloud.google.com/ -> create (or pick) a project
  2. "APIs & Services" -> enable "Gmail API" and "Google Calendar API"
  3. "OAuth consent screen" -> External, add your own Google account as a test user
  4. "Credentials" -> Create credentials -> OAuth client ID -> Application type "Desktop app"
  5. Put the two values in .env (or in the app's settings screen):
       GOOGLE_OAUTH_CLIENT_ID=...
       GOOGLE_OAUTH_CLIENT_SECRET=...
  6. Run this command again.`;

const config = loadConfig();
AppSettings.load(config.appSettingsPath).applyToEnv(process.env);
const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.log(SETUP);
  process.exit(1);
}

const flow = await startGoogleOAuth({ clientId, clientSecret, tokenFile: config.googleTokenPath });
console.log(`Open this link in your browser and sign in with the Google account Mimi should use:\n\n${flow.url}\n\nWaiting for Google to send you back here...`);
try {
  await flow.done;
  console.log(`\nDone. Refresh token saved to ${config.googleTokenPath} (git-ignored).\nThe Gmail and Calendar tools work right away.`);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
