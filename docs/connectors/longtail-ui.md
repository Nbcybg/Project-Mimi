# Long-tail catalog UI (Hub > Node & Tools)

Hub > Node & Tools now opens with a **connector catalog** above the node
reference. It is the read-only home for every connector in the build, including
the long tail: connectors imported from OpenAPI specs and tools that come from
MCP servers. Nothing here stores or shows a secret; credentials stay in the
machine vault and are edited on Hub > Accounts.

## What the catalog shows

- One row per connector from `state.connectors`, split by source:
  - `native` - connectors shipped in `packages/core/src/connectors/services/`.
  - `OpenAPI import` - specs whose category is `imported`, created with the
    import dialog (see "OpenAPI import" below).
  - MCP is a separate section (below); MCP servers are not connectors.
- Per row: label, key, source, category, operation count, auth kind, and a
  connection pill:
  - `ไม่ต้องตั้ง credential` for `auth.kind === 'none'`.
  - `ใช้บัญชี Google` / `ต้องเชื่อมบัญชี Google` for OAuth2 connectors whose
    `authorizeUrl` points at `accounts.google.com` (Google provider accounts
    are shared by every Google connector, including YouTube).
  - `n/m connection` for connectors backed by Hub > Connections entries, with a
    "has default" note when one of them is the default.
  - `ต้องสร้าง connection` when the connector has no stored connection yet.
- Filters: search box (label, key, category, operation keys/labels), a source
  chip set (all/native/OpenAPI import), a category select built from the data
  itself, and a **ต้องตั้ง credential** toggle.
- `ตั้งค่า credential` and the detail panel link straight to Hub > Accounts
  (`ui.hubTab = 'accounts'`); the panel never shows field values, only which
  credential fields and scopes an operation needs.

Clicking a row opens the read-only detail panel: description, base URL, auth
kind, operations (label, key, method, path, risk, field count, untrusted input)
and trigger list. Editing still happens in Hub > Accounts (credentials) and the
workflow canvas (nodes).

## MCP section

`MCP server (n)` groups by server and shows, per server: transport, `PC` when it
runs through the PC agent, connection state (`ปิดอยู่` / `ต่อไม่ได้` /
`n เครื่องมือ` / `ยังไม่ได้ต่อ`), and a risk breakdown chip per risk level
(`อ่าน n`, `เขียน n`, ...) plus an `untrusted` chip when the server may carry
third-party text. Clicking a server opens the existing MCP editor.

## Long-tail tools and Quick Work

Quick Work builds its families in `feature-agent-tools.js` `familyOfTool`:
native connectors go to `connector:<key>` families, while custom tools and MCP
tools go to `tool:<name>` families. Long-tail tools therefore never mix into a
native connector family, and this catalog does not change that grouping.

## Data sources

The catalog reads messages the server already sends; only the import dialog
adds `connector-import-*` messages:

| UI state | Message field |
| --- | --- |
| `state.connectors` | `tools.connectors` (`ConnectorView[]`) |
| `state.connections` | `tools.connections` (`ConnectorConnectionView[]`, requested with `connector-connections` if absent) |
| `state.toolMcp` | `tools.mcp` (`McpServerView[]`) |
| `state.settings.accounts` | Google/Microsoft OAuth accounts for the Google pill |

`ConnectorRuntimeImpl.list()` returns `registry.views()` without a `connected`
flag, so the UI derives connection status from the connections list instead.

## OpenAPI import

The catalog header has a **+ นำเข้า OpenAPI** button. The dialog takes an
OpenAPI 3.x JSON file or pasted JSON, plus an optional key and label, and asks
the core for a preview (`connector-import-preview`). The preview shows the
server, auth, every operation with its risk (all marked untrusted), the agent
tool names, unsupported parts and warnings, or the reasons the document was
refused. Confirming sends `connector-import-save`; when an earlier import has
the same key the preview says so and the button reads "แทนที่ด้วย …".

After a save the core broadcasts `tools`, the connector appears under the
`OpenAPI import` source chip, and the detail panel opens. An imported
connector's panel has a delete button (`connector-import-delete`); native
connectors have none. Message shapes, limits and the trust settings the core
enforces are in [`openapi-import.md`](openapi-import.md#importing-in-the-app).

## Smoke checklist

1. Open Hub > Node & Tools.
   - The catalog header counts match `native + OpenAPI import` and the MCP
     summary (`n server (m tools)`).
   - The list shows 50 services and scrolls; the node and tool tables still
     render below it.
2. Search `youtube`, then `paste`, then `sendMessage`.
   - `youtube` finds only the `youtube` connector (not the built-in
     `youtube_search` tool row).
   - Operation keys match in the result set.
3. Category select lists the categories in the build (ads, ai, analytics, ...,
   media, ...) and filters the list.
4. Source chips: `native` keeps every row; `OpenAPI import` shows the empty
   state until something is imported; `ต้องตั้ง credential` hides connectors
   with a working connection.
5. Connection pills:
   - A non-connected OAuth2 connector shows `ต้องสร้าง connection` and a
     `ตั้งค่า credential` button that opens Hub > Accounts.
   - After creating and connecting a connection for that connector, the pill
     shows `1/1 connection`.
   - A Google connector (e.g. `youtube`) shows `ต้องเชื่อมบัญชี Google` until a
     Google account exists, then `ใช้บัญชี Google`.
6. Click `facebook`:
   - The panel shows base URL, OAuth2, credential field labels (no values),
     scopes, and all 3 operations with risk.
7. MCP section: add a server with tools, refresh it, and check the per-server
   risk chips and `untrusted` chip. A disabled server shows `ปิดอยู่`.
8. Quick Work picker (agent > tools): connector families stay under
   `connector:<key>`; custom and MCP tools stay under their own families.
9. OpenAPI import: save the Pet Store fixture
   (`packages/core/src/test/fixtures/openapi/petstore.yaml`) as JSON and upload it.
   - The preview lists 4 operations (อ่าน 2, เขียน 1, ลบ 1) and 4 tool names;
     nothing is stored yet.
   - Confirm: `Pet Store` appears under `OpenAPI import`, the header shows
     `native 50 · OpenAPI import 1`, and `pet_store_*` tools are in the tool
     table.
   - Restart the core: the connector is still there.
   - Upload the YAML file itself, or a copy with an `http://` server: the
     dialog shows why it was refused and nothing is saved.
   - Delete it from its panel: the row and its tools go away.
