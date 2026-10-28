# customer-undo

## Purpose

Define observable safety and reliability guarantees for customer-undo in the audited WAswitch workflows.

## ADDED Requirements

### Requirement: Safe creation undo
Undoing an automated customer creation MUST reject deletion when any protected customer field has changed, including language and account association.

#### Scenario: Regression prevention
- **WHEN** A user edits language or account after automated creation
- **THEN** Undo preserves the customer and reports a conflict
