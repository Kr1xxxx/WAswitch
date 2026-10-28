# conversation-integrity

## Purpose

Define observable safety and reliability guarantees for conversation-integrity in the audited WAswitch workflows.

## ADDED Requirements

### Requirement: Draft isolation
The lite composer SHALL preserve separate drafts per conversation and SHALL clear only the submitted revision after a successful send.

#### Scenario: Regression prevention
- **WHEN** A user switches from conversation A to B while a send is pending
- **THEN** B retains its draft and later edits to A remain intact

### Requirement: Unread history
Historical outgoing messages MUST NOT clear unread counts from newer incoming messages.

#### Scenario: Regression prevention
- **WHEN** Old sent history arrives after a live incoming message
- **THEN** The current unread count remains unchanged

### Requirement: Stable web conversation identity
MCP reads and draft placement SHALL validate a stable conversation identifier across asynchronous operations and SHALL reject changed or unverified targets.

#### Scenario: Regression prevention
- **WHEN** Two conversations share a title or the user switches during clipboard preparation
- **THEN** Messages or pasted drafts are not attributed to the wrong conversation

#### Scenario: Typing immediately after a confirmed paste
- **WHEN** A draft is visible in the original conversation and the user types before the paste confirmation completes
- **THEN** Placement is confirmed and the previous clipboard formats are restored unless the user has copied new content

#### Scenario: Unconfirmed or invalidated paste
- **WHEN** Navigation, a conversation change, or a missing draft prevents confirmation
- **THEN** Placement is not reported as confirmed and the clipboard is not restored prematurely

#### Scenario: Missing display title
- **WHEN** The raw title remains empty and a stable personal, group or LID conversation identifier remains unchanged
- **THEN** Reading succeeds using the consistent fallback display title; changed or missing identifiers still reject the read
