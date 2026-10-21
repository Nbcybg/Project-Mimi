import type { ConnectorSpec } from '@mimi/shared';
import { airtableConnector } from './airtable.ts';
import { discordConnector } from './discord.ts';
import { githubConnector } from './github.ts';
import { googleDocsConnector } from './google-docs.ts';
import { googleFormsConnector } from './google-forms.ts';
import { googleTasksConnector } from './google-tasks.ts';
import { hubspotConnector } from './hubspot.ts';
import { notionConnector } from './notion.ts';
import { slackConnector } from './slack.ts';
import { stripeConnector } from './stripe.ts';

export { slackConnector } from './slack.ts';
export { discordConnector } from './discord.ts';
export { notionConnector } from './notion.ts';
export { airtableConnector } from './airtable.ts';
export { googleDocsConnector } from './google-docs.ts';
export { googleTasksConnector } from './google-tasks.ts';
export { googleFormsConnector } from './google-forms.ts';
export { hubspotConnector } from './hubspot.ts';
export { stripeConnector } from './stripe.ts';
export { githubConnector } from './github.ts';

/** Every native connector the runtime knows about. */
export const connectorSpecs: ConnectorSpec[] = [
  slackConnector,
  discordConnector,
  notionConnector,
  airtableConnector,
  googleDocsConnector,
  googleTasksConnector,
  googleFormsConnector,
  hubspotConnector,
  stripeConnector,
  githubConnector,
];
