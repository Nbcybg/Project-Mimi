# Zapier export migration

`importZapier()` reads a Zapier account export (the `{ metadata, zaps: [...] }` shape) or a single Zap JSON file, orders steps by `parent_id`, maps actions to native connectors/tools, and rewrites `{{step__field}}` references. It is a structural importer, not a Zapier runtime.

Zapier does not publish a stable, documented per-Zap JSON schema. The Team/Enterprise export and account export shapes are versioned and can change. The importer accepts the fixture shape below and reports missing or unknown fields instead of guessing.

## Report

```ts
interface ZapierImportReport {
  source: string[];
  workflows: Array<{ name: string; title: string; trigger: string; nodes: number }>;
  warnings: string[];
  unsupported: Array<{
    step: string;
    api: string;
    action: string;
    reason: string;
  }>;
  redacted: Array<{ step: string; field: string }>;
  mapped: Array<{
    step: string;
    connector: string;
    operation: string;
    fields: string[];
    confidence: 'high' | 'medium';
  }>;
  connections: Array<{
    step: string;
    connector: string;
    authenticationId?: string;
  }>;
}
```

- `mapped` lists steps that became `connector` nodes.
- `confidence` is `high` when the connector operation exists and every required field was found. It is `medium` when a required field is missing or the connector is mapped but not installed yet.
- `connections` contains the opaque Zapier `authentication_id` as metadata only. It is never a Mimi connection id; attach a Mimi connection in the editor.
- `authentication_id` values of `null` or `"-"` are omitted from the report.
- Unmapped steps become a `code` node that stops with an explanation and are listed in `unsupported`.
- Literal values that look like tokens or passwords are replaced with the shared redaction placeholder and listed in `redacted`.

## Input shapes

Accepted top-level forms:

```json
{ "metadata": { "version": 2 }, "zaps": [ { "title": "...", "nodes": { "1": { ... } } } ] }
```

```json
{ "title": "One Zap", "nodes": { "1": { ... }, "2": { ... } } }
```

`nodes` may be an object keyed by step id or an array. `steps` is accepted as an alias. Each step may contain:

```ts
interface ZapStep {
  id: number | string;
  type_of: 'read' | 'write' | 'filter' | string;
  action: string;
  selected_api: string;
  authentication_id?: string | number | null;
  parent_id?: string | number | null;
  root_id?: string | number | null;
  params?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}
```

A Zap with no readable steps is skipped with a warning. A file with no Zap objects fails with a clear error.

## Step graph

The importer builds a parent/child graph from `parent_id`, falling back to `root_id` when the parent is missing. It walks from the trigger step and then appends unconnected steps in id order.

- Zapier branches are flattened into one chain. A warning is emitted when a step has more than one child.
- A `WebHookAPI` trigger becomes a `webhook` trigger.
- `ScheduleAPI` and other non-webhook triggers become a `manual` trigger with a warning; set the real schedule in Mimi.
- Imported workflows are disabled and have `webhook: null`; the server assigns the URL when the workflow is saved.
- Cycles and duplicate step ids are skipped/reported rather than causing an infinite walk.

## Action mappings

| Zapier API | Mimi connector | Actions |
|---|---|---|
| `SlackAPI` | `slack` | `channel_message`, `send_channel_message`, `send_direct_message`, `update_message`, `add_reaction`, `list_channels` |
| `DiscordV2` | `discord` | `send_channel_message` |
| `NotionV2` | `notion` | `create_database_item`, `create_page`, `append_block`, `find_page`, `query_database` |
| `AirtableV2` | `airtable` | `create_record`, `update_record`, `find_record`, `list_records`, `get_record` |
| `GoogleDocsV2` | `google_docs` | `create_document`, `append_text` |
| `GoogleTasksV2` | `google_tasks` | `create_task`, `list_tasks` |
| `GoogleFormsV2` | `google_forms` | `list_responses`, `get_form` |
| `HubSpotV3` | `hubspot` | `create_contact`, `update_contact`, `create_deal`, `list_deals` |
| `StripeV2` | `stripe` | `create_customer`, `list_customers`, `create_payment_link`, `refund_payment` |
| `GithubV2` | `github` | `create_issue`, `create_comment`, `get_file`, `list_issues` |
| `JiraV2` | `jira` | `create_issue`, `add_comment`, `search_issues` |
| `TrelloV2` | `trello` | `create_card`, `list_cards` |
| `AsanaV2` | `asana` | `create_task`, `list_tasks` |
| `ClickUpV2` | `clickup` | `create_task`, `list_tasks` |
| `MondayV2` | `monday` | `create_item`, `list_items` |
| `LinearV2` | `linear` | `create_issue`, `add_comment`, `list_issues` |
| `TodoistV2` | `todoist` | `create_task`, `complete_task`, `list_tasks` |
| `DropboxV2` | `dropbox` | `upload_file`, `list_folder`, `search` |
| `OpenAIV2` | `openai` | `send_prompt`, `chat_completion` |
| `GoogleDriveV2` | `google_drive` | `list_files`, `create_folder`, `delete_file` |
| `SalesforceV2` | `salesforce` | `create_contact`, `list_contacts` |
| `PipedriveV2` | `pipedrive` | `create_deal`, `list_deals` |
| `ShopifyV2` | `shopify` | `create_order`, `list_products` |
| `WooCommerceV2` | `woocommerce` | `create_product`, `list_orders` |
| `WordpressV2` | `wordpress` | `create_post`, `update_post` |
| `MailchimpV2` | `mailchimp` | `add_member`, `create_campaign` |
| `SendGridV2` | `sendgrid` | `send_email` |
| `TwilioAPI` | `twilio` | `send_sms` |
| `WhatsAppV2` | `whatsapp` | `send_message`, `send_text` -> `send_text` |
| `SupabaseV2` | `supabase` | `insert_row`, `select_row`, `update_row` |
| `MicrosoftTeamsV2` | `microsoft_teams` | `send_channel_message` |
| `ZoomV2` | `zoom` | `create_meeting`, `list_meetings` |
| `CalendlyV2` | `calendly` | `list_scheduled_events` |
| `TypeformV2` | `typeform` | `list_responses` |
| `BoxV2` | `box` | `upload_file`, `list_folder` |
| `GoogleAnalyticsV4` | `google_analytics` | `run_report` |
| `GoogleAdsV2` | `google_ads` | `list_campaigns` |
| `LineV2` | `line` | `send_text` |
| `ZohoCRMV2` | `zoho_crm` | `create_contact`, `create_deal` |
| `FacebookV2` | `facebook` | `create_post` |
| `InstagramV2` | `instagram` | `create_post` |
| `LinkedInV2` | `linkedin` | `create_post` |
| `XV2` | `x` | `create_post` |
| `YouTubeV2` | `youtube` | `upload_video` |
| `RedditV2` | `reddit` | `create_comment` |
| `GoogleSearchConsoleV2` | `google_search_console` | `query_search_analytics` |
| `GoogleChatV2` | `google_chat` | `send_message` |
| `GoogleSlidesV2` | `google_slides` | `create_presentation` |
| `GoogleClassroomV2` | `google_classroom` | `create_coursework` |

API and action names are matched case-insensitively and punctuation-insensitively. Version suffixes such as `V2`, `V3`, `V4` and `API` are ignored.

Special steps:

| Zapier step | Mimi node |
|---|---|
| `WebHookAPI` / `catch_hook` | `trigger_webhook` |
| `ScheduleAPI` / any action | `trigger_manual` with a warning |
| `FilterAPI` / `filter` | `filter` |
| `CodeAPI` / `run_javascript` | `code` with a review warning |
| `CodeAPI` / `run_python` | stop-with-explanation placeholder |
| `GoogleSheetsV2API` / `append_row` | `tool: sheets_append` |
| `WebhooksAPI` / `post` | `http` |
| `PathsAPI`, `FormatterAPI` | placeholder; not reconstructed |
| unknown API or action | placeholder + `unsupported` report |

## Parameter mapping

Step `params` are flattened and matched to the connector operation's declared fields using exact names first, then aliases such as `base` -> `baseId`, `worksheet` -> `sheetName`, `spreadsheet` -> `spreadsheetId`, `message` -> `text`, and `repository` -> `repo`.

- Number and boolean fields are coerced; JSON fields are parsed when possible.
- Header name/value arrays become objects.
- `GoogleSheetsV2API.append_row` maps to the `sheets_append` tool. The spreadsheet is a Mimi tool preset, so the node warns to choose it; the value object becomes one row.
- `WebhooksAPI.post` maps `url`, `method`, `headers`, and `data` to the HTTP node.
- Missing required fields are reported as `confidence: 'medium'`; the step still imports.
- Connector actions use `allow: false`, so writes need explicit consent in the editor.

## Expressions

Zapier references use double underscores:

- `{{1__email}}` -> `{{ $trigger.json.email }}` when step 1 is the trigger.
- `{{2__email}}` -> `{{ $node["Step title"].json.email }}` for later steps.
- Nested fields such as `{{2__line_items__0__name}}` become `{{ $node["Step title"].json.line_items["0"].name }}`.
- `{{now}}` / `{{zap_meta_human_now}}` become `{{ $now }}`.

Unknown step ids fall back to `{{ $json.<field> }}` with a warning. Formatter functions are kept as text and reported; rewrite them for Mimi expressions.

## Filters

`FilterAPI` criteria become `filter` conditions. The importer maps common Zapier operators (`iexist`, `text_contains`, `text_exactly`, `number_greater`, `date_after`, and similar) to Mimi operators. Criteria are combined with `and`. A filter with no criteria passes everything and is reported.

## Secrets and connections

- Zapier credentials are never imported. `authentication_id` is recorded as metadata only.
- `null` and `"-"` authentication ids are omitted.
- Secret-looking paths such as authorization, token, password, API key, and client secret are replaced with the shared redaction placeholder. Known token formats are redacted even under generic keys.
- Expressions are not treated as literal secrets.

## Limitations

- Zapier has no stable public per-Zap JSON API. Treat the input as versioned and review the report after each export change.
- Branches (Paths) and Formatter steps are flattened or become placeholders; they are not reconstructed as native switch/code logic.
- Dynamic field choices, line-item schemas, polling triggers, and app-specific nested parameter shapes are not resolved.
- Python code is not executed. JavaScript code is imported, but Zapier helpers are not available.
- Zapier authentication ids are opaque; they cannot be mapped to Mimi accounts.
- The importer is not wired into the desktop import dialog yet; that belongs to the migration UI workstream.
