# Tasks

## 1. Conversation and proxy integrity
- [x] 1.1 Fix per-chat drafts and async send clearing (1,5); verify isolated composer regressions.
- [x] 1.2 Preserve unread counts during history replay (2); verify lite unread tests.
- [x] 1.3 Bind proxy tests to effective credentials and invalidate stale results (4); verify editor regressions.
- [x] 1.4 Guard MCP reads and draft placement with stable chat identity (6,8); verify same-title and clipboard-race tests.

## 2. Server and persistence safety
- [x] 2.1 Fix large CRM encoding (3); verify large Unicode encryption round-trip.
- [x] 2.2 Enforce supervisor authorization at update time (7); verify promotion-race and normal update tests.
- [x] 2.3 Preserve all colliding translation records on migration (11); verify merge and failure cases.
- [x] 2.4 Reject creation undo after customer edits (12); verify language and account changes survive.

## 3. Asynchronous jobs and downloads
- [x] 3.1 Fix queue removal and capture source context (9,10); verify manual-priority and chat-switch regressions.
- [x] 3.2 Contain download filesystem/stream failures (13); verify failed status without uncaught exceptions.

## 4. Integration verification
- [x] 4.1 Run affected existing Node, server and isolated Electron suites, preserving Claude's selection translation and terminology behavior; record results and limitations.
- [x] 4.2 Validate OpenSpec and review the final diff; confirm work remains local on the independent branch with no merge or publication.

## 5. Follow-up review regressions
- [x] 5.1 Confirm a same-chat paste after immediate typing and restore the prior clipboard without overwriting a new user copy; retain pre-paste cancellation and navigation/chat-change guards. Add failing regressions first.
- [x] 5.2 Use consistent fallback titles for stable-ID message reads; cover empty phone/group/LID titles and reject changed or missing identities. Add failing regressions first.
- [x] 5.3 Rerun affected suites and Claude feature regressions, inspect latest upstream changes and final diff, validate OpenSpec, and document evidence without committing, merging or publishing.
