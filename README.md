# @perssua/mcp — official Perssua MCP server

Lets MCP-capable AI apps (Claude Desktop, Claude Code, ChatGPT developer-mode
connectors, Grok connectors, and any other MCP client) start a **Perssua
session** with a configured assistant and context (free text + attached text
files), directly from a conversation. Version 0.2 also provides a separate
OAuth-protected hosted mode for account-scoped assistant reads and
confirmation-gated updates/deletes while the desktop is offline.

```
Claude / ChatGPT / Grok ──(MCP tool call)──▶ perssua-mcp
                                               │  writes single-use handoff JSON
                                               ▼
                    <Perssua userData>/external-handoffs/<id>.json
                                               │  opens perssua://session/start?handoff=<id>
                                               ▼
                                         Perssua app
                    (selects the assistant, injects context, opens the
                     session tab, prefills or auto-submits the prompt)
```

## Requirements

- Node.js ≥ 18
- The Perssua desktop app (full flavor) installed and launched at least once
  (it writes the integration bridge at `~/.perssua/bridge.json` on startup)

## Run

```bash
# Local stdio (Claude Desktop, Claude Code, other local MCP clients)
npx -y @perssua/mcp          # once published; from this repo use:
node bin/perssua-mcp.js

# Streamable-HTTP endpoint on http://127.0.0.1:8433/mcp
node bin/perssua-mcp.js --http 8433

# Public remote-only handler, normally behind your hosting platform's TLS proxy
node bin/perssua-mcp.js --hosted 8434
```

`--hosted` exposes only `list_assistants`, `get_assistant`,
`update_assistant`, `delete_assistant`, and `get_operation`. It never loads or
exposes the local bridge, filesystem, session-handoff, or launcher tools. The
canonical resource is `https://mcp.perssua.com`, with its MCP endpoint at
`/mcp` and OAuth protected-resource metadata at
`/.well-known/oauth-protected-resource`. Source availability does not mean the
public resource is deployed.

## Tools

| Tool | What it does |
|---|---|
| `app_status` | Is Perssua installed / running on this machine, where, and which handoff capabilities the installed build advertises. |
| `list_assistants` | Lists metadata-only assistant refs, revisions, kinds, selection, and permissions. Prompts and knowledge never appear in the roster. |
| `get_assistant` | Asks the authenticated app for one editable definition, attached-file metadata, permissions, and revision. Requires `requestId`; may return a pending status. |
| `update_assistant` | Submits an exact `assistantRef` + `expectedRevision` + partial patch + `requestId` for in-app confirmation and persistence. |
| `delete_assistant` | Submits revision-checked deletion of a custom assistant for in-app confirmation. Built-ins cannot be deleted. |
| `get_operation` | Reads the app-authored status/result without exposing receipts from another authenticated account. |
| `start_session` | Writes a handoff (assistant, prompt, context, text files, autoSubmit) and launches the app via `perssua://session/start?handoff=<id>`. Local mode only. |
| `create_assistant` | Creates a custom assistant with its system prompt plus optional Notch, follow-up, summary, certainty, category, and permanent knowledge settings, then opens a session. `sessionGoal` stays at the top level of that first-session handoff and is never saved as assistant knowledge; it is also projected into the legacy first prompt. The handoff always includes the legacy name/instructions/category projection, so older compatible desktops create the basic assistant and ignore optional extensions. Local mode only, handoff channel only. |
| `create_session_link` | Returns a clickable `perssua://session/start?...` link (plus an https launcher link when `PERSSUA_LAUNCH_URL` is set). For hosted/remote connectors. |

There is also one MCP prompt, `new_assistant` — a guided interview (goal → style → knowledge → kickoff) that ends by calling `create_assistant`. In Claude Code it surfaces as `/mcp__perssua__new_assistant`.

### Reading and changing existing assistants

Existing-assistant operations are asynchronous because the Perssua app owns
authentication, permission checks, confirmation, persistence, and final
read-back. A request file or opened deep link is never reported as success.

In hosted mode, reads come from the OAuth subject's account. Updates/deletes
return `pending_confirmation` plus an `operationId`; pass that id as
`get_operation.requestId`. Only the same OAuth token family can read the
result, and only the matching signed-in desktop account can approve it.

1. Call `list_assistants`, then `get_assistant` with a unique `requestId`.
2. Follow pending states with `get_operation` using the same id.
3. For changes, use the opaque `assistantRef`, latest `expectedRevision`, a
   new `requestId`, and only the fields that should change.
4. Treat only `completed` as persisted. On `conflict`, read again before a new
   request. `cancelled` and `failed` are terminal.

Update fields are `name`, `instructions`, `category`, `realtimePrompt`,
`followUpPrompt`, `emailPrompt`, `requireCertainty`, and `knowledgeText`.
Omitted fields stay unchanged. `null` explicitly restores defaults for
nullable fields; name/instructions cannot be blank or cleared. Knowledge text
edits preserve attached files, and get results return file metadata only.
Session goals, first prompts, session context, and file mutation are rejected.

### Version compatibility

The app advertises its handoff capabilities in `~/.perssua/bridge.json` (`capabilities`, e.g. `["session-start", "session-files", "create-assistant", "create-assistant-extended-prompts"]`). `create_assistant` refuses only when the installed build cannot create assistants at all. Its v1 handoff projection always contains `newAssistant.name`, `newAssistant.instructions`, and optional `newAssistant.category`; optional Notch/follow-up/summary/certainty fields are additive. Older compatible desktops ignore those extensions and create the reviewed basic assistant, while newer ones apply them. `create-assistant-extended-prompts` is informational and is not required to send the backward-compatible payload. Bridges written by builds that predate the capabilities field advertise none.

Existing-assistant tools require `assistant-operations-v1` plus
`assistant-read-v1`, `assistant-update-v1`, or `assistant-delete-v1`; rich
listing uses `assistant-roster-v2`. Older apps fail closed with an update
message before the server writes an unsupported request.

## Environment variables

| Variable | Purpose |
|---|---|
| `PERSSUA_USER_DATA_DIR` | Override the app's user-data directory (defaults to the bridge file, then platform defaults). |
| `PERSSUA_MCP_SOURCE` | Default source tag stamped on sessions (`claude`, `chatgpt`, `grok`, …). |
| `PERSSUA_LAUNCH_URL` | Hosted launcher page (e.g. `https://perssua.com/launch`) used by `create_session_link` to produce https links that chat UIs reliably render. |
| `ASSISTANT_REMOTE_RESOURCE` | Canonical public HTTPS resource/audience (default `https://mcp.perssua.com`). |
| `ASSISTANT_REMOTE_ISSUER` | OAuth authorization-server issuer. |
| `ASSISTANT_REMOTE_API_URL` | Account-scoped assistant API base URL. |
| `PERSSUA_MCP_HOST` | Hosted-mode listen address (default `0.0.0.0`; TLS is normally terminated by the platform). |

## Security model

- Handoff payloads are **single-use** files inside the app's own user-data
  directory; the app validates the id grammar, size (≤ 2 MB) and freshness
  (≤ 15 min) and deletes the file after one read.
- Inline `perssua://` links (the ones `create_session_link` produces) **never
  auto-submit** and **cannot attach files** — any web page can open a custom
  scheme, so the user always reviews the prefilled prompt inside Perssua.
- File attachments are read by this server (running as the user), inlined as
  text, and capped; binary files are skipped. The app never reads arbitrary
  paths from a handoff.
- Existing definitions are returned only by an app-executed read. The roster
  is metadata-only, and opaque refs, revisions, requests, and receipts are
  account-bound. `get_operation` does not disclose old-account results.
- A `requestId` is idempotent only for an exact logical retry. Reuse with a
  different operation, target, revision, patch, or account scope fails closed.
- Hosted mode requires Bearer auth on every MCP request, declares
  `assistants.read`/`assistants.write` per tool, forwards OAuth challenges, and
  returns neither stored MCP credentials nor attached knowledge-file contents.

## Tests

```bash
npm test   # node --test — no network, no app required
```

## Privacy Policy

Full policy: https://perssua.com/privacy

What this MCP server does with data, specifically:

- **Collection (local mode)**: the server runs entirely on the user's machine. It reads the
  Perssua integration bridge (`~/.perssua/bridge.json`), the metadata-only
  assistants roster, app-authored operation receipts, and — when requested — local
  text files the user chose to attach. Tool arguments (prompt, context,
  assistant spec) come from the MCP client.
- **Usage and storage (local mode)**: session/create payloads and assistant-operation
  requests are written only inside directories advertised by the local app.
  The app consumes requests, writes scoped status receipts, and enforces
  retention. The server keeps no database or separate content log.
- **Hosted mode**: the server forwards the OAuth bearer and requested payload
  only to Perssua's account-scoped backend and stores neither. Read results
  redact credentials and attached-file contents; mutations still need desktop
  confirmation.
- **Third-party sharing**: local mode makes no network requests. Hosted mode
  sends the scoped request only to the configured Perssua assistant backend.
  Session content handled by Perssua is covered by the policy linked above.
- **Retention**: nothing is retained by this server. Unconsumed handoff files
  are deleted by the app after 15 minutes.
- **Contact**: help@perssua.com

See `../claude`, `../chatgpt`, and `../grok` for per-client setup, and
`../../docs/integrations.md` for the full protocol reference.

## WebMCP Session Studio challenge source

[`webmcp-session-studio/`](./webmcp-session-studio/) is the public, standalone
source for the Perssua WebMCP Session Studio. Its five-step wizard exposes
exactly five browser-scoped tools through
`document.modelContext.registerTool(...)`, keeps every agent mutation visible
in an append-only ledger, and makes the final `perssua://` handoff a human-only
action. The create-only new-assistant handoff is an untrusted
proposal that the Perssua app must validate and present for confirmation; the
browser tools never create anything. In the final **Start the session** step,
the human uses **Create assistant and start session**; Perssua opens and
pre-fills the session without sending the message.

The WebMCP Challenge legal entrant is **MONTANO PRODUCTIONS B.V.**; Perssua is
the product/project name. Director **Sara Ennes da Silva** is the authorized
WebMCP Challenge submitter/signatory. The public contact email remains pending
and is maintained privately until publication is explicitly authorized.

The Studio is independent from this Node MCP server and can be demonstrated
without the Perssua desktop app installed. See [`WEBMCP_CHALLENGE.md`](./WEBMCP_CHALLENGE.md)
for challenge-window scope, security decisions, testing, compatibility, and the
mapping to the production `https://perssua.com/studio` route.
