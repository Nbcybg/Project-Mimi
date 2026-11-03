# Error codes

Every error a user can see in a chat, a toast or the CLI carries a stable code. The
AI Overseer can explain them with the `error_codes` tool; this file is the same catalog
for people reading the repository.

HTTP statuses are appended where they make the code more actionable (`E-AUTH-401`,
`E-RATE-429`, `E-MODEL-404`, `E-PROVIDER-500`).

| Code | Meaning | What to do |
| --- | --- | --- |
| `E-AUTH` | The provider rejected the API key, the OAuth account is not connected, or the key lacks access to the model/scope. | Fix the key in Hub → Keys or reconnect the account in Settings → Google/Microsoft. Never put the key in a prompt or tool. |
| `E-RATE` | The provider is throttling requests or the plan/quota is exhausted. | Wait and retry, lower parallel runs, or check the provider plan. Workflow retries can ride out a short limit. |
| `E-CONTEXT` | The conversation plus the prompt is longer than the model can accept. | Start a new session, let compaction run, or use a model with a larger context. |
| `E-MODEL` | The model reference does not exist at the provider, was removed, or does not support the input. | Check the model reference and the catalog; pick a model that supports the input (for example images). |
| `E-TIMEOUT` | A provider, tool, workflow node or the network did not answer in time. | Retry; raise a node/tool timeout only when the work is genuinely slow; check the network/PC agent. |
| `E-NETWORK` | DNS, TCP, TLS or the provider endpoint failed. PC tools may also mean the PC agent is offline. | Check the internet and the provider URL; start/reconnect the PC agent for PC tools. Do not blindly retry a write that may have reached the other side. |
| `E-BUDGET` | The daily spending limit or the trace budget (tokens, rounds or time in one turn) is exhausted. | Raise the budget in Settings or wait for the daily reset; narrow the prompt or reduce sub-agent loops. |
| `E-CONFIG` | An agent/tool/skill/workflow names something that does not exist, a required key or setting is missing, or the input is invalid. | Run `config_validate`; use `agent_history` / `tool_history` to undo a bad write; retest with `tool_test` or `agent_message`. |
| `E-PROVIDER` | The provider returned a server-side failure (usually HTTP 5xx). | Retry later or switch model/provider. |
| `E-PROTOCOL` | A client sent a WebSocket message type this core does not know (a newer app on an older core). | Update the core or the app so both speak the same client API (`/health` shows `api` / `minClientApi`; see `docs/native/api-versioning.md`). |
| `E-INTERNAL` | An unexpected failure that matches no known category. | Read the full message, reproduce with the smallest test (`tool_test`, `agent_message`, `workflow_runs`), and report the exact step. |

## For the AI Overseer

The Overseer's system prompt lists these categories. When a user reports a code:

1. Call `error_codes` with that code (or without one to see the catalog).
2. Explain the meaning in the user's language.
3. Give the concrete next step from the guide, and use `config_validate`, `workflow_runs`,
   `tool_test` or `agent_message` to verify a fix.
4. Never guess from the number alone; if the code is unknown, say so and ask for the full
   message.
