# proxy-test-identity

## Purpose

Define observable safety and reliability guarantees for proxy-test-identity in the audited WAswitch workflows.

## ADDED Requirements

### Requirement: Tested effective proxy
Saving a lite proxy SHALL require a successful test of the same account, mode, endpoint, username and effective password; failed or superseded tests MUST invalidate prior evidence.

#### Scenario: Regression prevention
- **WHEN** Credentials change or an older test completes after a newer test
- **THEN** The old result cannot authorize the new configuration
