# Perssua WebMCP Session Studio

This document describes the public challenge source in
[`webmcp-session-studio/`](./webmcp-session-studio/) and separates it from
Perssua work that existed before the August 25–September 3, 2026 WebMCP
Challenge window. The intended production route is
`https://perssua.com/studio`; publishing that route is a separate release
action and this repository does not deploy it.

## Submission identity

Use these user-provided facts exactly on Devpost and other submission surfaces:

| Field | Value |
|---|---|
| Legal name | **MONTANO PRODUCTIONS B.V.** |
| Registered address | John M. Keynesplein 1, 1066 EP Amsterdam, Netherlands |
| KvK | 93885067 |
| VAT/BTW ID | NL866560683B01 |
| Shareholder | Lucas Silveira Montano |
| Director | Sara Ennes da Silva |
| Authorized WebMCP Challenge submitter/signatory | Sara Ennes da Silva |
| Website/product site | https://perssua.com |
| Product/project | Perssua / Perssua WebMCP Session Studio |

Perssua is the product/project, not the legal entrant. Shareholder status is
not evidence that Lucas Silveira Montano is an authorized signatory or legal
representative. Sara Ennes da Silva is listed as Director and is separately
confirmed as the authorized Challenge submitter/signatory.

### Submission identity checklist

- [x] Exact legal name: **MONTANO PRODUCTIONS B.V.**
- [x] Address, KvK, VAT/BTW ID, shareholder, director, website, and product facts
  match the table.
- [x] Perssua remains identified as the product/project.
- [x] Sara Ennes da Silva is the authorized submitter/signatory.
- [ ] Public contact email remains pending and maintained privately. Do not add
  one to GitHub without explicit publication authorization.

No email, phone number, additional representative title, or separate contact
person is inferred or published here.

## Challenge-window scope

### Pre-existing Perssua and MCP work

Before the challenge window, Perssua already had:

- a desktop session experience, assistant roster, and assistant-creation flow;
- the `perssua://session/start` custom scheme;
- local single-use MCP handoff files and the public `@perssua/mcp` server;
- MCP tools for status, assistants, sessions, assistant creation, and hosted
  session links;
- allowlisted inline links, HTTPS fragment launcher patterns, and desktop
  artifact hosting.

Those are product and integration context, not WebMCP challenge work.

### Added during August 25–September 3, 2026

The Challenge work adds:

- a browser-native, five-step assistant/session wizard shared by a human and a
  browser agent;
- a create-only, browser-native proposal flow for a new Perssua assistant;
- guarded `document.modelContext.registerTool(...)` registration for exactly
  five purpose-built tools;
- narrow schemas, unknown-property rejection, strict runtime limits, and
  browser execution cancellation;
- append-only agent knowledge changes and `confirm: true` reset behavior;
- a visible append-only ledger of exact agent before/after changes, separate
  from human edits;
- a human-only **Create assistant and start session** boundary;
- create-proposal `source=webmcp` handoffs with strict field, compiled-context,
  and encoded-URL rejection—never silent truncation;
- an untrusted create-assistant proposal that the Perssua app must validate and
  show for human confirmation before creating anything;
- deterministic v0.27.0 desktop downloads for the optional handoff;
- a complete browser-only demonstration and this public MIT source, tests, and
  documentation.

## Product and permission model

The five steps are draft, human review, knowledge, first message, and **Start
the session**. The final step retains complete review before the human-controlled
handoff. Agents can propose or append visible data through tools, but tools can
only advance a complete proposal to the visible review step. They cannot open
Perssua, submit a message, create an assistant, attach a file, redirect, or
demand login.

The deployed `/studio` route supports `?lang=en`, `?lang=pt`, and `?lang=es`.
The standalone package preserves that explicit language selection and uses a
safe English fallback for unknown values.

The new-assistant payload is untrusted input. `mode=create` means “show this
proposal for confirmation,” not “create automatically.” After the human clicks
the final CTA, Perssua confirms the assistant when needed, opens the session,
and pre-fills the first message without sending it. The desktop app owns
validation, confirmation, and creation. Every handoff remains a visible human
action.

WebMCP is progressive enhancement. Unsupported browsers show **Manual mode**
and retain the complete wizard, meters, ledger, review, downloads, and optional
handoff. Perssua need not be installed to demonstrate the browser or tool
behavior; only the custom-scheme handoff requires it.

## Registered tools

| Name | Input and behavior | Safety annotation |
|---|---|---|
| `inspect_studio_setup` | Optional `section` and `offset`; reads a compact summary, paginated field, or ledger receipts. | `readOnlyHint: true`, `untrustedContentHint: true` |
| `define_assistant` | Updates one or more new-assistant proposal fields and/or `sessionGoal`. A complete draft advances only to visible human review. | `readOnlyHint: false`, `untrustedContentHint: true` |
| `append_knowledge_note` | Required non-empty `note` (≤2,000). Appends after existing knowledge and rejects combined overflow. | `readOnlyHint: false`, `untrustedContentHint: true` |
| `prepare_first_session` | Required non-empty `openingPrompt` (≤4,000). Stages it for review without opening or submitting. | `readOnlyHint: false`, `untrustedContentHint: true` |
| `reset_studio_setup` | Required `confirm: true`. Clears fields, returns to the draft step, and records every cleared value. | `readOnlyHint: false`, `untrustedContentHint: true` |

Every registration uses one shared `AbortController`. Unmount cleanup or any
partial registration failure aborts the whole registration set. Tool execution
also checks the browser-provided signal.

## Handoff and size contract

Limits match Perssua desktop exactly:

| Value | Maximum characters |
|---|---:|
| `assistantName` | 200 |
| `assistantInstructions` | 4,000 |
| optional `assistantCategory` | 64 |
| `prompt` | 4,000 |
| compiled `context` | 8,000 |
| complete encoded custom-scheme URL | 24,000 |

The only handoff path is an untrusted create proposal:

```text
mode=create + assistantName + assistantInstructions
+ optional assistantCategory + prompt + context + source=webmcp
```

Limits are strictly rejected without silent truncation. Unknown parameters,
`assistant`, `autoSubmit`, files, redirects, and handoff tokens are excluded.
When an HTTPS launcher is used, the complete encoded deep link stays in the
fragment, never an HTTP query.

## Privacy and security decisions

- Only the human-controlled anchor opens the custom scheme.
- Tool-returned user content is explicitly marked untrusted.
- State and ledger are in-memory and tab-scoped; refresh clears them.
- This standalone package intentionally has no analytics, consent SDK,
  telemetry, persistence, network logger, API backend, or login requirement.
- Prompt, context, goal, assistant values, deep links, fragments, and user
  content never enter analytics or logs.
- The browser creates no assistant; the app must confirm the untrusted proposal.

## Browser compatibility and production expectations

WebMCP is an evolving preview API. Chrome exposes local testing behind
`chrome://flags/#enable-webmcp-testing`; enable it and relaunch. The Studio
checks `document.modelContext` and fails closed to manual mode. It ships no
polyfill or third-party bridge.

Production must use HTTPS and revalidate against the current WebMCP draft.
Recommended route headers:

```http
Origin-Agent-Cluster: ?1
Permissions-Policy: tools=(self)
```

References:

- [Chrome WebMCP documentation](https://developer.chrome.com/docs/ai/webmcp)
- [WebMCP community specification](https://webmachinelearning.github.io/webmcp/)
- [WebMCP source and explainer](https://github.com/webmachinelearning/webmcp)

## Local testing and build

```bash
cd webmcp-session-studio
npm ci
npm run check

npm run dev
# http://127.0.0.1:5173/studio/

npm run preview -- --port 4173
# http://127.0.0.1:4173/studio/
```

`npm run check` runs ESLint, TypeScript, all Vitest tests, and a production Vite
build. Once dependencies are installed, checks require no private repository,
network access, desktop app, or credentials.

## Demo script

1. Open `/studio/?lang=pt` (then `?lang=es`) and show the localized create-only
   draft and safe English fallback.
2. Call `define_assistant` with name, instructions, optional category, and a
   goal. Show the visible values, exact ledger diff, and its advance only to
   **Review the proposal**.
3. The human checks the visible review confirmation; no assistant exists yet.
4. Add a human knowledge note, then call `append_knowledge_note`. Show that the
   human note remains and the agent note is appended.
5. Call `prepare_first_session`. Show that it only stages the message and does
   not advance, open, submit, or create.
6. Continue to **Start the session**, retain the final review, and explain the
   200/4,000/64/4,000/8,000/24,000 limits and untrusted-proposal confirmation.
7. Try `reset_studio_setup` without `confirm: true`; show refusal. Use confirmed
   reset and show the audited return to the draft step.
8. Rebuild the proposal and let the human click **Create assistant and start
   session**. Perssua confirms the assistant, opens the session, and pre-fills
   the first message without sending it.
9. Repeat the browser/tool portion without the app installed; only the optional
   last handoff is unavailable.

## Deterministic Perssua v0.27.0 downloads

The optional handoff requires a compatible Perssua build. The Studio pins:

- Windows: `Perssua-0.27.0.exe`
- Mac, Apple silicon: `Perssua-0.27.0-arm64.dmg`
- Mac, Intel: `Perssua-0.27.0.dmg`
- Linux x64: `Perssua-0.27.0-x86_64.AppImage`
- Linux ARM: `Perssua-0.27.0-arm64.AppImage`

These are fixed Studio compatibility links, not randomized global downloads.
At export time, global channels remain v0.25.2 stable and the **v0.26.0 75%
canary**. v0.27.0 remains Studio-only. The standalone demo works even when an
artifact or the app is unavailable.

## Production `/studio` mapping and maintenance

| Public file | Production behavior represented |
|---|---|
| `src/App.tsx` | Wizard, fallback, final-step review, ledger, and human-only session-start control |
| `src/styles.css` | Route visuals and responsive states |
| `src/studio-brief.ts` | State, exact diffs, compiled context, strict readiness |
| `src/studio-webmcp.ts` | Five names, schemas, behavior, annotations, cleanup |
| `src/launch-link.ts` | Path allowlists, strict limits, fragment serialization |
| `src/studio-downloads.ts` | Isolated v0.27.0 artifacts |

The private production site owns its framework, route headers, metadata, global
shell, and consented site analytics. Those are deliberately absent here; the
standalone package implements no analytics event. Any production CTA analytics
must represent session-start intent rather than assistant-creation success and
must not contain setup values or user content. A
maintainer must compare these public modules and tests against the private
`/studio` implementation when either changes. For static hosting, redirect
`/studio` to `/studio/`, rewrite that route to `dist/index.html`, and serve
assets at `/studio/assets/`.

## License and submission boundary

The repository's top-level [`LICENSE`](./LICENSE) remains an unmodified,
GitHub-detectable MIT license. The standalone package also includes an MIT
license so copied challenge source retains its terms.

Preparing this source does not deploy, submit to Devpost, change visibility or
licensing, or change global release configuration.
