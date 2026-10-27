# Phase 2 connector UI smoke checklist

Run the app, open an agent, then Workflows > New/Edit.

## Connector trigger

1. Add the **Connector trigger** node from the Trigger group.
2. Pick Slack, GitHub, Linear, or Todoist as the service.
3. Pick a trigger. The card must show only that trigger's fields.
4. Change the service or trigger. Old trigger fields, the interval, and input JSON must be cleared.
5. For a webhook trigger, check the POST URL and the required vault secret name.
   - Slack uses `x-slack-signature` and `x-slack-request-timestamp`.
   - GitHub uses `x-hub-signature-256`.
6. For a poll trigger, set **Every (minutes)** and check the sample output shown below the card.
7. Save, reload the workflow, and confirm the trigger still shows the same service and trigger.

## Connector operation

1. Add a **Connector** node and pick Slack.
2. Pick **Send message**.
3. In **Channel**, use the options dropdown. It should list channels from `list_channels`.
4. Pick Discord and **Send message**. `channelId` depends on `guildId`.
5. Change `guildId`. The old `channelId` must clear and the channel options must reload.
6. Pick a write operation and confirm the consent checkbox appears.
7. Run **Test** on the node and confirm it reports success or a readable connector error without leaking credentials.

## Quick Work

1. Open the Quick Work picker and search for `slack`.
2. Filter by **Communication** and confirm only connector families in that category remain.
3. Filter by **On**, **Off**, and **Needs setup**; the category filter must remain active.
4. Clear the category filter and confirm built-in non-connector tools return.

## Responsive layout

1. Resize to phone width.
2. The workflow card fields, trigger hints, category filter, and operation picker must stay usable without horizontal scrolling.
3. Confirm the node test dialog and JSON input editor remain reachable.

## Verification

```powershell
npm.cmd run typecheck
npm.cmd test
```
