# translation-lifecycle

## Purpose

Define observable safety and reliability guarantees for translation-lifecycle in the audited WAswitch workflows.

## ADDED Requirements

### Requirement: Queue job identity
Completing an asynchronous translation MUST remove only that job and SHALL preserve manually prioritized jobs.

#### Scenario: Regression prevention
- **WHEN** A manual job is inserted while another translation awaits a response
- **THEN** Both jobs complete once without stranded queued items

### Requirement: Captured conversation context
Translation jobs SHALL retain context from their originating conversation and MUST NOT consume another conversation's messages.

#### Scenario: Regression prevention
- **WHEN** The active conversation changes before a queued job executes
- **THEN** Only the captured source context is supplied

### Requirement: Lossless storage migration
Migration SHALL merge unique records in colliding files and MUST retain source data when persistence cannot be verified.

#### Scenario: Regression prevention
- **WHEN** Source and destination contain different translations under the same filename
- **THEN** Both records remain available after migration
