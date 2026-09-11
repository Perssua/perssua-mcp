# Changelog

All notable changes to `@perssua/mcp` are documented here.

## 0.2.0 - 2026-09-11

- Add a remote-only hosted transport with OAuth protected-resource metadata,
  per-tool `assistants.read`/`assistants.write` scopes, account-scoped backend
  forwarding, and no access to local bridge, filesystem, or session tools.
- Add app-mediated `get_assistant`, `update_assistant`, and `delete_assistant`
  requests plus `get_operation` for app-authored completion receipts.
- Add opaque assistant references, editable-field permissions, and revisions to
  the metadata-only roster contract, preventing stale updates and deletions.
- Require authentication and explicit confirmation in Perssua before an update
  or deletion is persisted; request creation and app launch are never reported
  as operation success.
- Redact OAuth credentials and attached knowledge-file contents from hosted
  responses while preserving editable knowledge text and file attachments.
- Ship the extended create-assistant fields already present in the public
  source: Notch, follow-up, summary, certainty, permanent knowledge, and a
  separate first-session goal.
- Preserve the existing session and assistant-creation handoff contracts for
  older compatible Perssua builds.

## 0.1.0 - 2026-08-27

- Initial release with app status, assistant listing, session start,
  assistant creation, and session-link tools.
