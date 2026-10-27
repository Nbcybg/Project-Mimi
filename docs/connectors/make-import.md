# Make blueprint migration

`importMake()` converts a Make blueprint (`{ name, flow, metadata }`) into a disabled Mimi workflow. It walks nested `routes` and `onerror` flows, maps app modules to native connectors, rewrites `{{<moduleId>.<field>}}` references, and reports everything it could not convert. It never calls an API or saves the workflow.

## Report

```ts
interface MakeImportReport {
  source: string[];
  workflows: Array<{ name: string; title: string; trigger: string; nodes: number }>;
  warnings: string[];
  unsupported: Array<{ module: string; type: string; reason: string }>;
  redacted: Array<{ module: string; field: string }>;
  mapped: Array<{
    module: string;
    connector: string;
    operation: string;
    fields: string[];
    confidence: 'high' | 'medium';
  }>;
  connections: Array<{
    module: string;
    connector: string;
    connectionId?: string;
  }>;
}
```

- `mapped` lists every Make module that became a `connector` node.
- `confidence` is `high` when the connector operation exists and every required field was found. It is `medium` when a required field is missing or the connector is mapped but not installed yet.
- `connections` contains the Make `__IMTCONN__` / `__IMTCONNID__` id as metadata only. Open the node and attach a Mimi connection; the id is not a Mimi connection id.
- Unknown modules become a `code` node that stops the run with the reason, and are listed in `unsupported`.
- Literal values that look like tokens, passwords, or authorization headers are replaced with the redaction placeholder and listed in `redacted`.

## Module mappings

| Make module | Mimi node | Operation |
|---|---|---|
| `gateway:CustomWebHook` | `trigger_webhook` | Webhook trigger |
| `gateway:WebhookRespond` | `respond` | HTTP response |
| `http:ActionSendData` | `http` | HTTP request |
| `builtin:BasicFilter` | `filter` | Condition |
| `builtin:BasicRouter` | `switch` | Branch rules |
| `code:ExecuteCode` | `code` | JavaScript |
| `google-sheets:addRow` | `tool` | `sheets_append` |
| `slack:sendMessage` | `connector:slack` | `send_message` |
| `slack:listChannels` | `connector:slack` | `list_channels` |
| `slack:updateMessage` | `connector:slack` | `update_message` |
| `slack:addReaction` | `connector:slack` | `add_reaction` |
| `discord:sendMessage` | `connector:discord` | `send_message` |
| `notion:createPage` | `connector:notion` | `create_page` |
| `notion:getPage` | `connector:notion` | `get_page` |
| `notion:queryDatabase` | `connector:notion` | `query_database` |
| `airtable:createRecord` | `connector:airtable` | `create_record` |
| `airtable:updateRecord` | `connector:airtable` | `update_record` |
| `airtable:listRecords` | `connector:airtable` | `list_records` |
| `airtable:getRecord` | `connector:airtable` | `get_record` |
| `airtable:deleteRecord` | `connector:airtable` | `delete_record` |
| `google-docs:createDocument` | `connector:google_docs` | `create_document` |
| `google-docs:getDocument` | `connector:google_docs` | `get_document` |
| `google-docs:appendText` | `connector:google_docs` | `append_text` |
| `google-tasks:createTask` | `connector:google_tasks` | `create_task` |
| `google-tasks:listTasks` | `connector:google_tasks` | `list_tasks` |
| `google-forms:listResponses` | `connector:google_forms` | `list_responses` |
| `google-forms:getForm` | `connector:google_forms` | `get_form` |
| `hubspot:createContact` | `connector:hubspot` | `create_contact` |
| `hubspot:updateContact` | `connector:hubspot` | `update_contact` |
| `hubspot:createDeal` | `connector:hubspot` | `create_deal` |
| `hubspot:listDeals` | `connector:hubspot` | `list_deals` |
| `stripe:createCustomer` | `connector:stripe` | `create_customer` |
| `stripe:listCustomers` | `connector:stripe` | `list_customers` |
| `stripe:createPaymentLink` | `connector:stripe` | `create_payment_link` |
| `stripe:refundPayment` | `connector:stripe` | `refund_payment` |
| `github:createIssue` | `connector:github` | `create_issue` |
| `github:listIssues` | `connector:github` | `list_issues` |
| `github:createComment` | `connector:github` | `create_comment` |
| `github:getFile` | `connector:github` | `get_file` |
| `jira:createIssue` | `connector:jira` | `create_issue` |
| `jira:searchIssues` | `connector:jira` | `search_issues` |
| `jira:addComment` | `connector:jira` | `add_comment` |
| `trello:createCard` | `connector:trello` | `create_card` |
| `trello:listCards` | `connector:trello` | `list_cards` |
| `asana:createTask` | `connector:asana` | `create_task` |
| `asana:listTasks` | `connector:asana` | `list_tasks` |
| `clickup:createTask` | `connector:clickup` | `create_task` |
| `clickup:listTasks` | `connector:clickup` | `list_tasks` |
| `monday:createItem` | `connector:monday` | `create_item` |
| `monday:listItems` | `connector:monday` | `list_items` |
| `linear:createIssue` | `connector:linear` | `create_issue` |
| `linear:listIssues` | `connector:linear` | `list_issues` |
| `linear:addComment` | `connector:linear` | `add_comment` |
| `todoist:createTask` | `connector:todoist` | `create_task` |
| `todoist:listTasks` | `connector:todoist` | `list_tasks` |
| `todoist:completeTask` | `connector:todoist` | `complete_task` |
| `dropbox:uploadFile` | `connector:dropbox` | `upload_file` |
| `dropbox:listFolder` | `connector:dropbox` | `list_folder` |
| `dropbox:search` | `connector:dropbox` | `search` |
| `openai:createCompletion` | `connector:openai` | `chat_completion` |
| `openai:createChatCompletion` | `connector:openai` | `chat_completion` |
| `google-drive:listFiles` | `connector:google_drive` | `list_files` |
| `google-drive:createFolder` | `connector:google_drive` | `create_folder` |
| `google-drive:deleteFile` | `connector:google_drive` | `delete_file` |
| `salesforce:createContact` | `connector:salesforce` | `create_contact` |
| `salesforce:listContacts` | `connector:salesforce` | `list_contacts` |
| `pipedrive:createDeal` | `connector:pipedrive` | `create_deal` |
| `pipedrive:listDeals` | `connector:pipedrive` | `list_deals` |
| `shopify:createOrder` | `connector:shopify` | `create_order` |
| `shopify:listProducts` | `connector:shopify` | `list_products` |
| `woocommerce:createProduct` | `connector:woocommerce` | `create_product` |
| `woocommerce:listOrders` | `connector:woocommerce` | `list_orders` |
| `wordpress:createPost` | `connector:wordpress` | `create_post` |
| `wordpress:updatePost` | `connector:wordpress` | `update_post` |
| `mailchimp:addMember` | `connector:mailchimp` | `add_member` |
| `mailchimp:createCampaign` | `connector:mailchimp` | `create_campaign` |
| `sendgrid:sendEmail` | `connector:sendgrid` | `send_email` |
| `twilio:sendSms` | `connector:twilio` | `send_sms` |
| `whatsapp:sendMessage` | `connector:whatsapp` | `send_text` |
| `supabase:insertRow` | `connector:supabase` | `insert_rows` |
| `supabase:selectRows` | `connector:supabase` | `select_rows` |
| `supabase:updateRow` | `connector:supabase` | `update_rows` |

Module names are matched case-insensitively and punctuation-insensitively.

## Flow conversion

- A root flow becomes a linear chain after its trigger module.
- `builtin:BasicFilter` becomes a `filter` node. A false result stops the bundle, matching Make.
- `builtin:BasicRouter` becomes a `switch` in `rules` mode. When a route starts with a filter, that filter becomes the route case and is not also imported as a node. A route without a filter uses an always-true case; this is reported as a warning because Make can evaluate routes differently.
- Route tails link to the module after the router. An empty router becomes a passthrough `set` node.
- `onerror.flow` becomes an `error` branch and sets `onError: 'branch'` on the module node.
- Nested trigger modules are skipped with a warning. Only the root webhook trigger is imported; other gateway/schedule triggers become a manual trigger with a warning.
- Each imported workflow is disabled and has `webhook: null`; the server assigns the workflow URL when it is saved.

## Parameter mapping

The mapper and parameters are flattened into one bag. `__IMTCONN__`, `__IMTCONNID__`, `hook`, `module`, and `version` are treated as metadata. For a known connector operation, the importer fills the declared fields using exact names first and then common aliases such as `channelId` -> `channel`, `message` -> `text`, `base_id` -> `baseId`, and `spreadsheet_id` -> `spreadsheetId`.

- Number and boolean fields are coerced; JSON fields are parsed when possible.
- Header/query name-value arrays become objects.
- `http:ActionSendData` maps `method`, `url`, `headers`, `qs`/`query`, and `body`.
- `google-sheets:addRow` maps to the `sheets_append` tool. The spreadsheet itself is a Mimi tool preset, so the node warns to choose it; numeric-key value objects become one row.
- `code:ExecuteCode` is imported as JavaScript with a warning. Make and Mimi have different code APIs, so review the body before enabling the workflow.
- Missing required fields are reported with `confidence: 'medium'` instead of failing the whole import.

## Expressions

Make references use module ids: `{{2.email}}` becomes `{{ $node["Fetch profile"].json.email }}`. References to the root trigger become `{{ $trigger.json.email }}`. Unknown ids fall back to `{{ $json.<field> }}` with a warning. `{{now}}` becomes `{{ $now }}`.

Make formula functions such as `formatDate`, `if`, and `map` are not translated; the importer keeps the text and reports a warning. Recheck expressions that use functions, arithmetic, or Make-only collection helpers.

## Secrets and connections

- Blueprint credentials are never imported. `__IMTCONN__` is recorded as `connectionId` metadata only.
- The importer warns for every mapped connector so the user attaches a Mimi connection.
- Values under secret-looking paths (authorization, token, password, API key, client secret) are replaced with the shared redaction placeholder. Literal values matching known token formats are redacted even when the key is generic.
- Expressions are not treated as literal secrets.

## Limitations

- The mapping is structural, not a full Make module catalog. Unmapped modules become placeholders; add a mapping entry when the connector exists.
- Iterator, aggregator, Data Store, dynamic webhook, and app-specific nested mapper shapes are not reconstructed.
- Router conditions are flattened to one condition per route; multiple AND/OR groups produce a warning.
- Only the first root trigger is imported, and Make schedules become manual triggers.
- Make connection ids are opaque and are not mapped to Mimi accounts.
- This importer is not wired into the desktop import dialog yet; that belongs to the migration UI workstream.
