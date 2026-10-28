# Proposal

## Why

Two read-only audits reproduced thirteen defects that can mix customer conversations, discard user data, bypass a supervisor's scope during a race, or interrupt background processing. Fix them against main 3ad4b32, preserving Claude's newly merged selection translation and lash terminology work.

## What Changes

- Isolate lightweight drafts by conversation and preserve edits during an asynchronous send (findings 1, 5).
- Preserve unread counts during history import (2), support valid CRM payload sizes (3), and bind proxy tests to their complete effective identity (4).
- Bind MCP reads and draft placement to the selected conversation across asynchronous work (6, 8).
- Enforce supervisor authorization at the user-update write boundary (7).
- Preserve manual translation jobs and their own conversation context (9, 10).
- Merge translation files without deleting unpreserved entries (11); protect later customer edits during undo (12); contain download stream errors (13).
- Add targeted regressions and exercise relevant existing and native tests with synthetic data.
- Resolve the two follow-up review regressions: clipboard restoration after immediate post-paste typing and false chat-change rejection when the title is unavailable but the chat identifier is stable.

## Capabilities

### New Capabilities

- `conversation-integrity`: Draft, message-read and unread behavior across conversation and history changes.
- `proxy-test-identity`: Tested network identity matches the configuration being saved.
- `translation-lifecycle`: Queue identity, context isolation and durable translation migration.
- `team-user-authorization`: Supervisor permissions remain valid at commit time.
- `crm-upload`: Valid batches encode without argument-limit failures.
- `customer-undo`: Undo does not remove customers modified after AI creation.
- `module-download`: Disk failures are contained and partial downloads cleaned up.

### Modified Capabilities

None; this repository had no OpenSpec capability inventory.

## Impact

Changes are developed in the independent clone on codex/fix-audit-20261028. Existing Electron/Node and Worker modules and tests are reused; no new production dependencies or visual redesign. No changes to Claude's checkout or branches, production data, releases or deployment. Following local verification, the user authorized committing and pushing the Codex branch and opening a PR; merging or releasing remains unauthorized. Tests use temporary user data, synthetic chats and an in-memory database.
