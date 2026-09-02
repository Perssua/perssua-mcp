# Perssua WebMCP Session Studio

This directory is the self-contained MIT-licensed source for the Perssua
WebMCP Session Studio challenge entry. It mirrors the behavior of
`https://perssua.com/studio` without depending on the private Perssua website,
the desktop app, analytics infrastructure, or a backend.

The legal challenge entrant is **MONTANO PRODUCTIONS B.V.** Perssua is the
product/project name. See [`../WEBMCP_CHALLENGE.md`](../WEBMCP_CHALLENGE.md)
for the exact company facts and submission checklist.

## What the Studio does

The Studio is a five-step, human-controlled wizard:

1. The human or agent drafts a new-assistant proposal and first-session goal.
2. The human visibly reviews the proposal before continuing.
3. The human or agent adds visible knowledge; agent notes are append-only.
4. The human or agent prepares a first message for review.
5. In **Start the session**, the human reviews the complete handoff and may
   click **Create assistant and start session**.

An agent can help prepare visible values and can advance a complete proposal
only to the visible review step. It cannot open Perssua, submit a message,
create an assistant, attach files, or redirect the browser. Every agent mutation appears in the append-only ledger
with exact before and after values. Human edits remain visibly distinct.

The payload is an **untrusted assistant proposal**. After
the human clicks, Perssua must show it for confirmation, open the session, and
pre-fill the first message without sending it; receiving the payload alone does
not create anything. The browser demo remains complete without Perssua
installed—the app is needed only for the optional final handoff.

## Run locally

Requirements: Node.js 20.19 or newer and npm.

```bash
npm ci
npm run dev
# open http://127.0.0.1:5173/studio/
```

Vite builds with a `/studio/` base so `dist/` can be mounted below the
production route. WebMCP is progressive enhancement: without
`document.modelContext`, the complete wizard runs in explicit manual mode.
Use `?lang=en`, `?lang=pt`, or `?lang=es` to select the Studio locale; unknown
values fall back safely to English.

To exercise native browser tools in a compatible Chrome build:

1. Open `chrome://flags/#enable-webmcp-testing`.
2. Enable **WebMCP for testing** and relaunch Chrome.
3. Open `http://127.0.0.1:5173/studio/`.
4. Inspect or invoke the five registered tools with a compatible browser agent
   or WebMCP inspector.

References: [Chrome WebMCP documentation](https://developer.chrome.com/docs/ai/webmcp)
and the [WebMCP specification/explainer](https://github.com/webmachinelearning/webmcp).

## Registered tools

All tools are registered in [`src/studio-webmcp.ts`](./src/studio-webmcp.ts)
with `document.modelContext.registerTool(...)`.

| Tool | Behavior |
|---|---|
| `inspect_studio_setup` | Reads a compact summary, one paginated field, or paginated ledger receipts. It is the only read-only tool. |
| `define_assistant` | Updates visible new-assistant proposal fields and advances a complete draft only to human review. |
| `append_knowledge_note` | Appends one non-empty note after existing knowledge. It cannot replace or delete human text. |
| `prepare_first_session` | Stages the first message for human review. It does not open or submit anything. |
| `reset_studio_setup` | Clears every setup field only when `confirm: true`, returns to draft, and records the reset in the ledger. |

Schemas are narrow, reject unknown properties, and carry
`untrustedContentHint: true`. One shared `AbortController` covers every
registration; unmount cleanup or partial registration failure aborts them all.
Each execution also respects the browser-provided abort signal.

## Exact handoff contract

No Studio value is silently truncated. An over-limit field, compiled context,
or encoded URL blocks handoff and returns a visible error.

| Value | Maximum characters |
|---|---:|
| New assistant name | 200 |
| New assistant instructions | 4,000 |
| New assistant category | 64 |
| Optional Notch, follow-up, and summary prompts | 4,000 each |
| Session goal (`sessionGoal`) | 2,000 |
| First-session goal plus opening message (`prompt`) | 4,000 |
| Permanent knowledge (`context`) | 8,000 |
| Complete encoded `perssua://` URL | 24,000 |

Create-proposal allowlist:

```text
mode=create
assistantName=<proposal>
assistantInstructions=<proposal>
assistantCategory=<optional proposal>
assistantRealtimePrompt=<optional Notch prompt>
assistantFollowUpPrompt=<optional follow-up prompt>
assistantEmailPrompt=<optional summary prompt>
assistantRequireCertainty=<optional true|false|1|0>
sessionGoal=<optional first-session goal>
prompt=<first-session goal plus staged opening message>
context=<permanent knowledge only>
source=webmcp
```

The original v1 keys (`mode`, `assistantName`, `assistantInstructions`, optional
`assistantCategory`, `prompt`, `context`, and `source`) remain the legacy
projection. There is deliberately no inline version
parameter: older Electron builds ignore the optional extension keys and still
create the basic assistant from its name, system prompt, and category. The
`sessionGoal` extension remains session-scoped and is also projected into the
legacy `prompt`. The
serializer excludes unknown keys, `assistant`,
`autoSubmit`, file fields, redirects, login requirements, and handoff tokens.
The optional HTTPS wrapper puts the entire encoded custom-scheme link in the
fragment rather than an HTTP query.

## Privacy and safety

- Only the human-controlled anchor can open Perssua.
- Tools cannot advance steps, create an assistant, open the app, navigate,
  submit a message, download a file, or require login.
- The create payload is untrusted input that the desktop app must validate and
  show for confirmation.
- State and the ledger are in-memory and tab-scoped.
- This standalone package intentionally contains no analytics, telemetry,
  persistence, content logging, server API, or background network request.
- Prompt, context, goal, assistant values, deep links, fragments, and user
  content are never sent to analytics or logs.

## Compatible desktop downloads

The browser demo requires no app. The optional handoff uses deterministic
Perssua v0.27.0 links from
[`src/studio-downloads.ts`](./src/studio-downloads.ts) for Windows, Apple
silicon, Intel Mac, Linux x64, and Linux ARM. These links are isolated from the
production site's global rollout. At export time, global channels remain
v0.25.2 stable and the **v0.26.0 75% canary**; v0.27.0 stays Studio-only.

## Verify

```bash
npm run check

npm run preview -- --port 4173
# open http://127.0.0.1:4173/studio/
```

`check` runs lint, TypeScript, all Vitest tests, and the production build.
Tests cover the five schemas, create-only proposal isolation, append-only
knowledge, exact ledger diffs, reset confirmation, shared abort
cleanup, every size boundary, strict rejection, URL allowlisting, fragment
wrapping, manual fallback, and pinned download URLs.

## Production route mapping

The private production site owns routing, headers, metadata, and global UI.
The public package deliberately replaces its framework and private imports with
a standalone Vite entry point while keeping the wizard contract equivalent.

| Public source | Production responsibility |
|---|---|
| `src/App.tsx`, `src/styles.css` | `/studio` wizard, final-step review, ledger, and human session-start controls |
| `src/studio-brief.ts` | In-tab state, compiled context, strict handoff readiness |
| `src/studio-webmcp.ts` | Tool schemas, behavior, receipts, and registration lifecycle |
| `src/launch-link.ts` | Create-proposal allowlist and strict URL serialization |
| `src/studio-downloads.ts` | Studio-compatible v0.27.0 artifacts |

Production must use HTTPS and should send `Origin-Agent-Cluster: ?1` and
`Permissions-Policy: tools=(self)`. Static hosting must redirect `/studio` to
`/studio/`, rewrite that route to `dist/index.html`, and serve assets below
`/studio/assets/`.

## License

MIT. See [`LICENSE`](./LICENSE). The repository's GitHub-detectable top-level
MIT license remains in place for the wider Perssua MCP project.
