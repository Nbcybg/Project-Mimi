# n8n migration mapping

`importN8n()` converts n8n app nodes into Mimi `connector` nodes when the node type is one of the 50 native services below. The importer never calls an API and never saves the result automatically; imported workflows start disabled.

## Report

The importer returns a report alongside the workflows:

```ts
interface N8nImportReport {
  source: string[];
  workflows: Array<{ name: string; title: string; trigger: string; nodes: number }>;
  warnings: string[];
  unsupported: Array<{ node: string; type: string; reason: string }>;
  redacted: Array<{ node: string; field: string }>;
  mapped: Array<{
    node: string;
    connector: string;
    operation: string;
    fields: string[];
    confidence: 'high' | 'medium';
  }>;
  connections: Array<{
    node: string;
    connector: string;
    credentialType?: string;
    credentialName?: string;
  }>;
  models: Array<{ node: string; model: string }>;
  prompts: Array<{ node: string; text: string }>;
}
```

- `mapped` lists every app node that became a connector node.
- `confidence` is `high` when the operation exists in the installed connector and every required field was found. It is `medium` when a required field is missing or the connector is mapped but not installed yet.
- `connections` lists the n8n credential metadata per node. Credential values are never imported; open the node and attach a Mimi connection.
- Unknown app nodes and unknown operations inside a mapped app become a `code` placeholder and an `unsupported` entry.
- Values that look like secrets are still removed by the existing `redacted` pass.

## Supported services

| n8n node type | Mimi connector | Common operations |
|---|---|---|
| `slack` | `slack` | `send_message`, `update_message`, `list_messages`, `list_channels`, `list_users`, `add_reaction` |
| `discord` | `discord` | `send_message`, `list_messages`, `delete_message`, `list_channels`, `list_guilds` |
| `notion` | `notion` | `search`, `get_page`, `create_page`, `append_blocks`, `query_database` |
| `airtable` | `airtable` | `list_records`, `get_record`, `create_record`, `update_record`, `delete_record` |
| `googleDocs` | `google_docs` | `create_document`, `get_document`, `append_text`, `replace_text` |
| `googleTasks` | `google_tasks` | `list_tasklists`, `list_tasks`, `create_task`, `complete_task` |
| `googleForms` | `google_forms` | `list_responses`, `get_response`, `get_form`, `create_form` |
| `hubspot` | `hubspot` | `search_contacts`, `create_contact`, `update_contact`, `list_deals`, `create_deal`, `list_tickets` |
| `stripe` | `stripe` | `list_customers`, `create_customer`, `list_payments`, `create_payment_link`, `refund_payment` |
| `github` | `github` | `list_repos`, `get_file`, `create_issue`, `list_issues`, `update_issue`, `create_comment` |
| `jira` | `jira` | `list_projects`, `search_issues`, `create_issue`, `update_issue`, `add_comment` |
| `trello` | `trello` | `list_boards`, `list_lists`, `list_cards`, `create_card`, `move_card` |
| `asana` | `asana` | `list_workspaces`, `list_projects`, `list_tasks`, `create_task`, `complete_task` |
| `clickUp` | `clickup` | `list_spaces`, `list_lists`, `list_tasks`, `create_task`, `update_task` |
| `monday` / `mondayCom` | `monday` | `list_boards`, `list_items`, `create_item`, `update_item`, `create_update` |
| `linear` | `linear` | `list_teams`, `list_issues`, `create_issue`, `update_issue`, `add_comment` |
| `todoist` | `todoist` | `list_projects`, `list_tasks`, `get_task`, `create_task`, `complete_task` |
| `dropbox` | `dropbox` | `list_folder`, `search`, `download_file`, `upload_file`, `get_metadata` |
| `openAi` | `openai` | `list_models`, `create_response`, `create_embedding`, `chat_completion`, `list_files` |
| `googleDrive` | `google_drive` | `list_files`, `get_file`, `create_folder`, `move_file`, `delete_file` |
| `salesforce` | `salesforce` | `search`, `list_contacts`, `create_contact`, `list_opportunities`, `update_opportunity` |
| `pipedrive` | `pipedrive` | `list_persons`, `create_person`, `list_deals`, `create_deal`, `update_deal` |
| `shopify` | `shopify` | `list_products`, `get_product`, `list_orders`, `create_order`, `update_inventory` |
| `wooCommerce` | `woocommerce` | `list_products`, `get_product`, `create_product`, `list_orders`, `update_order` |
| `wordpress` | `wordpress` | `list_posts`, `get_post`, `create_post`, `update_post`, `upload_media` |
| `mailchimp` | `mailchimp` | `list_lists`, `get_list`, `add_member`, `list_campaigns`, `create_campaign` |
| `sendGrid` | `sendgrid` | `send_email`, `list_templates`, `get_template`, `list_senders`, `get_stats` |
| `twilio` | `twilio` | `send_sms`, `list_messages`, `get_message`, `list_calls`, `get_call` |
| `whatsApp` | `whatsapp` | `send_text`, `send_template`, `list_templates`, `list_phone_numbers`, `get_media` |
| `supabase` | `supabase` | `select_rows`, `insert_rows`, `update_rows`, `delete_rows`, `upsert_rows` |
| `microsoftTeams` | `microsoft_teams` | `list_teams`, `list_channels`, `send_message`, `list_messages` |
| `microsoftExcel` | `excel` | `list_worksheets`, `read_range`, `write_range`, `add_row` |
| `zoom` | `zoom` | `list_meetings`, `create_meeting`, `get_meeting`, `delete_meeting` |
| `calendly` | `calendly` | `list_event_types`, `list_scheduled_events`, `create_invitee` |
| `typeform` | `typeform` | `list_forms`, `get_form`, `list_responses` |
| `box` | `box` | `list_folder`, `search`, `upload_file`, `download_file` |
| `googleAnalytics` | `google_analytics` | `list_properties`, `run_report` |
| `googleAds` | `google_ads` | `list_campaigns`, `get_campaign`, `update_campaign_status` |
| `line` | `line` | `send_text`, `send_flex`, `list_followers` |
| `zohoCrm` | `zoho_crm` | `list_contacts`, `create_contact`, `list_deals`, `create_deal` |
| `facebook` / `facebookPages` | `facebook` | `list_pages`, `create_post`, `list_posts` |
| `instagram` | `instagram` | `list_media`, `create_post`, `get_insights` |
| `linkedin` | `linkedin` | `list_organizations`, `create_post`, `get_profile` |
| `x` / `twitter` | `x` | `create_post`, `list_posts`, `delete_post` |
| `youTube` | `youtube` | `search`, `list_channel_videos`, `upload_video` |
| `reddit` | `reddit` | `search`, `list_subreddit_posts`, `create_comment` |
| `googleSearchConsole` | `google_search_console` | `list_sites`, `query_search_analytics` |
| `googleChat` | `google_chat` | `list_spaces`, `send_message`, `list_messages` |
| `googleSlides` | `google_slides` | `create_presentation`, `get_presentation`, `add_text` |
| `googleClassroom` | `google_classroom` | `list_courses`, `list_coursework`, `create_coursework` |

## Parameter mapping

The importer resolves an n8n `resource` / `operation` pair against a mapping table, then fills the connector operation's declared input fields:

- exact field-name matches first, then aliases such as `channelId` → `channel`, `repository` → `owner` + `repo`, `q` → `query`, and `limit` → `per_page`;
- n8n resource locators (`{ "__rl": true, "value": ... }`) are unwrapped;
- `additionalFields`, `updateFields`, and `options` are flattened into the parameter bag;
- `fieldsUi.fieldValues` and `propertiesUi.propertyValues` are converted into objects for JSON fields;
- expressions are converted with the same `convertExpression()` pass as native nodes;
- `whatsapp` message sends switch to `send_template` when `messageType` is `template`; `line` sends switch to `send_flex` when it is `flex`.

Connector nodes are created with `allow: false`, so write and delete operations need explicit consent in the editor. No `account` is set because n8n credential ids are not Mimi connection ids.

## Triggers

These n8n trigger nodes become connector trigger pools:

| n8n trigger | Mimi trigger pool | Notes |
|---|---|---|
| `slackTrigger` | `connector:slack:events` | Add the signing secret named `SLACK_SIGNING_SECRET`, then point Slack Events at the workflow webhook URL. |
| `githubTrigger` | `connector:github:events` | Add the webhook secret named `GITHUB_WEBHOOK_SECRET`, then configure the GitHub repository webhook. |
| `linearTrigger` | `connector:linear:new_issues` | Poll interval comes from `pollTimes`. |
| `todoistTrigger` | `connector:todoist:new_tasks` | Poll interval comes from `pollTimes`. |

The existing native triggers (schedule, webhook, Gmail, Outlook, Telegram, chat, error, form, RSS) keep their previous behavior.

## Limitations

- The mapping is structural, not a full n8n expression or pagination engine. Recheck filters, pagination options, binary uploads, and nested API-specific bodies.
- Notion property UI values become flat key/value objects. Rebuild Notion property shapes (`title`, `rich_text`, `select`, …) in the node input.
- Airtable `upsert` is imported as `update_record`; review the record id and field payload.
- Future batch E/F connectors are mapped now, but their specs may not be installed in the current build. In that case the input is copied as-is, confidence is `medium`, and a warning says to check the node after adding the connector.
- n8n credentials are metadata only. Secret values, OAuth tokens, and connection ids are never imported.
- An app node with no matching resource/operation becomes a disabled stop-with-explanation placeholder rather than guessing an operation.
