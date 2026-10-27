import type { ConnectorSpec } from '@mimi/shared';
import { airtableConnector } from './airtable.ts';
import { asanaConnector } from './asana.ts';
import { clickupConnector } from './clickup.ts';
import { discordConnector } from './discord.ts';
import { dropboxConnector } from './dropbox.ts';
import { githubConnector } from './github.ts';
import { googleDocsConnector } from './google-docs.ts';
import { googleDriveConnector } from './google-drive.ts';
import { googleFormsConnector } from './google-forms.ts';
import { googleTasksConnector } from './google-tasks.ts';
import { hubspotConnector } from './hubspot.ts';
import { jiraConnector } from './jira.ts';
import { linearConnector } from './linear.ts';
import { mailchimpConnector } from './mailchimp.ts';
import { mondayConnector } from './monday.ts';
import { notionConnector } from './notion.ts';
import { openaiConnector } from './openai.ts';
import { pipedriveConnector } from './pipedrive.ts';
import { salesforceConnector } from './salesforce.ts';
import { sendgridConnector } from './sendgrid.ts';
import { shopifyConnector } from './shopify.ts';
import { slackConnector } from './slack.ts';
import { stripeConnector } from './stripe.ts';
import { supabaseConnector } from './supabase.ts';
import { todoistConnector } from './todoist.ts';
import { microsoftTeamsConnector } from './microsoft-teams.ts';
import { excelConnector } from './excel.ts';
import { zoomConnector } from './zoom.ts';
import { calendlyConnector } from './calendly.ts';
import { typeformConnector } from './typeform.ts';
import { boxConnector } from './box.ts';
import { googleAnalyticsConnector } from './google-analytics.ts';
import { googleAdsConnector } from './google-ads.ts';
import { lineConnector } from './line.ts';
import { zohoCrmConnector } from './zoho-crm.ts';
import { facebookConnector } from './facebook.ts';
import { instagramConnector } from './instagram.ts';
import { linkedinConnector } from './linkedin.ts';
import { xConnector } from './x.ts';
import { youtubeConnector } from './youtube.ts';
import { redditConnector } from './reddit.ts';
import { googleSearchConsoleConnector } from './google-search-console.ts';
import { googleChatConnector } from './google-chat.ts';
import { googleSlidesConnector } from './google-slides.ts';
import { googleClassroomConnector } from './google-classroom.ts';
import { trelloConnector } from './trello.ts';
import { twilioConnector } from './twilio.ts';
import { whatsappConnector } from './whatsapp.ts';
import { woocommerceConnector } from './woocommerce.ts';
import { wordpressConnector } from './wordpress.ts';

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
export { jiraConnector } from './jira.ts';
export { trelloConnector } from './trello.ts';
export { asanaConnector } from './asana.ts';
export { clickupConnector } from './clickup.ts';
export { mondayConnector } from './monday.ts';
export { linearConnector } from './linear.ts';
export { todoistConnector } from './todoist.ts';
export { dropboxConnector } from './dropbox.ts';
export { openaiConnector } from './openai.ts';
export { googleDriveConnector } from './google-drive.ts';
export { salesforceConnector } from './salesforce.ts';
export { pipedriveConnector } from './pipedrive.ts';
export { shopifyConnector } from './shopify.ts';
export { woocommerceConnector } from './woocommerce.ts';
export { wordpressConnector } from './wordpress.ts';
export { mailchimpConnector } from './mailchimp.ts';
export { sendgridConnector } from './sendgrid.ts';
export { twilioConnector } from './twilio.ts';
export { whatsappConnector } from './whatsapp.ts';
export { supabaseConnector } from './supabase.ts';
export { microsoftTeamsConnector } from './microsoft-teams.ts';
export { excelConnector } from './excel.ts';
export { zoomConnector } from './zoom.ts';
export { calendlyConnector } from './calendly.ts';
export { typeformConnector } from './typeform.ts';
export { boxConnector } from './box.ts';
export { googleAnalyticsConnector } from './google-analytics.ts';
export { googleAdsConnector } from './google-ads.ts';
export { lineConnector } from './line.ts';
export { zohoCrmConnector } from './zoho-crm.ts';
export { facebookConnector } from './facebook.ts';
export { instagramConnector } from './instagram.ts';
export { linkedinConnector } from './linkedin.ts';
export { xConnector } from './x.ts';
export { youtubeConnector } from './youtube.ts';
export { redditConnector } from './reddit.ts';
export { googleSearchConsoleConnector } from './google-search-console.ts';
export { googleChatConnector } from './google-chat.ts';
export { googleSlidesConnector } from './google-slides.ts';
export { googleClassroomConnector } from './google-classroom.ts';

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
  jiraConnector,
  trelloConnector,
  asanaConnector,
  clickupConnector,
  mondayConnector,
  linearConnector,
  todoistConnector,
  dropboxConnector,
  openaiConnector,
  googleDriveConnector,
  salesforceConnector,
  pipedriveConnector,
  shopifyConnector,
  woocommerceConnector,
  wordpressConnector,
  mailchimpConnector,
  sendgridConnector,
  twilioConnector,
  whatsappConnector,
  supabaseConnector,
  microsoftTeamsConnector,
  excelConnector,
  zoomConnector,
  calendlyConnector,
  typeformConnector,
  boxConnector,
  googleAnalyticsConnector,
  googleAdsConnector,
  lineConnector,
  zohoCrmConnector,
  facebookConnector,
  instagramConnector,
  linkedinConnector,
  xConnector,
  youtubeConnector,
  redditConnector,
  googleSearchConsoleConnector,
  googleChatConnector,
  googleSlidesConnector,
  googleClassroomConnector,
];
