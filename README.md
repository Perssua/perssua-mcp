# @perssua/mcp — official Perssua MCP server

Lets MCP-capable AI apps (Claude Desktop, Claude Code, ChatGPT developer-mode
connectors, Grok connectors, and any other MCP client) start a **Perssua
session** with a configured assistant and context (free text + attached text
files), directly from a conversation.

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
```

## Tools

| Tool | What it does |
|---|---|
| `app_status` | Is Perssua installed / running on this machine, where, and which handoff capabilities the installed build advertises. |
| `list_assistants` | Lists the user's assistants (name + id) from the app's roster snapshot. |
| `start_session` | Writes a handoff (assistant, prompt, context, text files, autoSubmit) and launches the app via `perssua://session/start?handoff=<id>`. Local mode only. |
| `create_assistant` | Creates a custom assistant with its system prompt plus optional Notch, follow-up, summary, certainty, category, and permanent knowledge settings, then opens a session. `sessionGoal` stays at the top level of that first-session handoff and is never saved as assistant knowledge; it is also projected into the legacy first prompt. The handoff always includes the legacy name/instructions/category projection, so older compatible desktops create the basic assistant and ignore optional extensions. Local mode only, handoff channel only. |
| `create_session_link` | Returns a clickable `perssua://session/start?...` link (plus an https launcher link when `PERSSUA_LAUNCH_URL` is set). For hosted/remote connectors. |

There is also one MCP prompt, `new_assistant` — a guided interview (goal → style → knowledge → kickoff) that ends by calling `create_assistant`. In Claude Code it surfaces as `/mcp__perssua__new_assistant`.

### Version compatibility

The app advertises its handoff capabilities in `~/.perssua/bridge.json` (`capabilities`, e.g. `["session-start", "session-files", "create-assistant", "create-assistant-extended-prompts"]`). `create_assistant` refuses only when the installed build cannot create assistants at all. Its v1 handoff projection always contains `newAssistant.name`, `newAssistant.instructions`, and optional `newAssistant.category`; optional Notch/follow-up/summary/certainty fields are additive. Older compatible desktops ignore those extensions and create the reviewed basic assistant, while newer ones apply them. `create-assistant-extended-prompts` is informational and is not required to send the backward-compatible payload. Bridges written by builds that predate the capabilities field advertise none.

## Environment variables

| Variable | Purpose |
|---|---|
| `PERSSUA_USER_DATA_DIR` | Override the app's user-data directory (defaults to the bridge file, then platform defaults). |
| `PERSSUA_MCP_SOURCE` | Default source tag stamped on sessions (`claude`, `chatgpt`, `grok`, …). |
| `PERSSUA_LAUNCH_URL` | Hosted launcher page (e.g. `https://perssua.com/launch`) used by `create_session_link` to produce https links that chat UIs reliably render. |

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

## Tests

```bash
npm test   # node --test — no network, no app required
```

## Privacy Policy

Full policy: https://perssua.com/privacy

What this MCP server does with data, specifically:

- **Collection**: the server runs entirely on the user's machine. It reads the
  Perssua integration bridge (`~/.perssua/bridge.json`), the assistants roster
  snapshot (names and ids only), and — when a tool call asks for it — local
  text files the user chose to attach. Tool arguments (prompt, context,
  assistant spec) come from the MCP client.
- **Usage and storage**: payloads are written only to the Perssua app's own
  handoff directory on the same machine, as single-use files the app deletes
  after reading (15-minute expiry). The server keeps no database, no logs of
  content, and no state between calls.
- **Third-party sharing**: none. The server makes no network requests; data
  flows only between the MCP client and the local Perssua app. Session content
  handled by the Perssua app itself is covered by the policy linked above.
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
