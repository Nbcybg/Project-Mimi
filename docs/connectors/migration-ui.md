# Migration UI (n8n, Make, Zapier)

The workflow screen has one **Import workflow** dialog for all three supported
exports. Everything happens locally: the JSON never leaves this machine, no API
is called, and no credential is imported.

## Flow

1. Pick the source: n8n, Make or Zapier.
2. Upload the export file, or paste the JSON and press **Preview pasted JSON**.
   - n8n: workflow menu -> Download, `.json`.
   - Make: scenario menu -> Export Blueprint, `.json`.
   - Zapier: Zap export `.zap` (or its JSON).
3. Read the preview and the report. Nothing is written yet.
4. Press **Import N workflow(s)**. Each workflow is saved **disabled** with
   `webhook: null`; the server assigns a webhook URL only when it is enabled.

Preview requests carry a `reqId` and the source name, so a slow answer for an
older file or another source is ignored instead of replacing the preview.

## Report sections

| Section | Meaning |
| --- | --- |
| Preview rows | One row per workflow: title, trigger, node count, name, and a collapsed node list. |
| Mapped to Mimi nodes | Imported app steps and the connector/operation they map to, with `high` or `medium` confidence. |
| Unsupported nodes | Steps that became `code` placeholders that stop with an explanation. The reason is shown. |
| Warnings | Required fields missing, flattened branches, ignored routes, credential fallbacks, etc. |
| Redacted secrets | Fields whose value looked like a secret. Only the field path is shown. |
| Connections to pick | Connectors that need a Mimi connection. The dialog links to Hub > Connections; the imported node still has `allow: false` until a connection is chosen. |
| Models / system prompts | n8n only: model names and agent prompts to review before enabling. |
| Errors | Workflows that failed validation during save (the rest are still saved). |

## What is imported

- Nodes, links and branch structure are converted by the matching importer in
  `packages/core/src/workflows/` (`n8n-import.ts`, `make-import.ts`,
  `zapier-import.ts`).
- Expressions are rewritten to Mimi expressions where possible; unknown
  references fall back to `$json` and are listed as warnings.
- App steps become native `connector` nodes with `allow: false`; unsupported
  steps become `code` placeholders.

## Limitations

- Credentials are never imported. Every `oauth2`, `apiKey`, `basic` or `bearer`
  step needs a connection created in Hub > Connections.
- A mapped connector only works when its spec is installed in the running build.
  If a mapping names a connector that is not installed yet, the step remains a
  `medium` confidence mapping and the editor input has to be completed by hand.
- Imported workflows are always disabled; they are not scheduled and they have no
  webhook URL until the user enables them.
- The report is a summary, not a full diff: it lists what the importer noticed,
  not every field it copied.

## Smoke checklist

1. Import the fixtures:
   - `packages/core/src/test/fixtures/import/n8n/top-services.json`
   - `packages/core/src/test/fixtures/import/make/branch-and-error.blueprint.json`
   - `packages/core/src/test/fixtures/import/zapier/secure-webhook.zapfile.json`
2. Switch the source selector and confirm the file hint and accepted extensions
   change; previewing a second file while the first is in flight keeps the newest
   preview.
3. Check the report shows mapped nodes, unsupported nodes with reasons, redacted
   fields and connections.
4. Press import and confirm the workflows are saved disabled; check the report
   names and the toast.
5. Enable one imported workflow and confirm the server assigns a webhook URL and
   any missing connection shows in the node editor.
6. Paste invalid JSON and confirm a readable error appears without saving.
