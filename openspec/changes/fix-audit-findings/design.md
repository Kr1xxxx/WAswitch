# Design

## Context
Thirteen reproduced audit findings affect local composers, proxy validation, translation jobs and storage, MCP operations, CRM encoding, customer undo, and server authorization. The baseline is main 3ad4b32, including Claude's latest selection translation and lash terminology changes. Work takes place in a separate clone and branch.

## Goals / Non-Goals
Fix each audited behavior and exercise it with synthetic regressions. Preserve existing UI, dependencies, and Claude's functionality. Following local review the user authorized pushing the independent Codex branch and opening a PR. Do not merge, release, modify production data, or interact with live WhatsApp.

## Decisions
- Bind asynchronous operations to stable identity and captured state: per-chat draft revisions, effective proxy identity, stable web chat identifiers, and job-specific translation context. Titles and current global state are insufficient under concurrency.
- Keep database authorization in the conditional update so authorization cannot expire between read and write.
- Encode binary data in bounded chunks using platform APIs, without adding a runtime dependency.
- Merge translation records before removing individual source files; preserve unreadable or unwritable sources. Prefer timestamp ordering for conflicts.
- Compare protected customer state before undoing creation and fail closed for incomplete historical snapshots.
- Observe download stream completion/errors immediately and route failures through the existing failed-download state.
- Extend existing test harnesses where practical; add focused synthetic fixtures only where existing tests cannot exercise races.
- After paste, confirm the draft in the same visible conversation even if the user has started typing. Navigation/destruction and changed identities still invalidate confirmation; do not restore over newly copied clipboard content, and keep unconfirmed pastes unconfirmed.
- Normalize a missing web title to the same display fallback before and after a message-read confirmation. Continue checking both stable identity and the normalized title, preserving protection for partial DOM transitions without extending the MCP hook protocol.

## Follow-up upstream inspection
At the start of the follow-up, remote main is cda9b82: PR #221 changes animation duration variables and PR #222 changes installer artwork typography and its checker. Neither changes the two affected production modules. These commits are inspected only; the local branch remains based on 3ad4b32 and no merge/rebase is performed.

During final verification main advanced to a264e7b, adding PR #220 (wig terms enabled by default), #223 (customer placeholder and editor morph-state cleanup) and #225 (translation-page busy/cancel states and independent translation lane). These overlap older fixes at file level in shell.js and translate-ipc.js but affect different code regions. Verify compatibility in a temporary non-Git source snapshot of a264e7b with the current patch applied; do not merge or rebase either working branch. Run both upstream feature tests and affected audit tests there before closing task 5.3.

## Risks / Trade-offs
Strict chat identity checks may reject DOM states without a verifiable identifier; rejecting an uncertain target is safer than reading or pasting into a different chat. Per-chat drafts and queued context consume bounded session memory. Migration must retain source files on failure rather than silently claim success. Legacy customer logs lacking a full creation snapshot cannot safely authorize deletion.

## Migration Plan
No production deployment or database migration is required. Translation directory migration remains user-triggered and preserves source data on failure. All changes are reviewable in the isolated local branch and can be discarded without affecting Claude's checkout.

## Verification
Run focused regression cases for all thirteen findings, affected existing Node/server suites, and isolated Electron DOM/composer tests when the local runtime permits. Record exact commands, results and limitations in the change tasks and final report.
