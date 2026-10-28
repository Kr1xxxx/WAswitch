# team-user-authorization

## Purpose

Define observable safety and reliability guarantees for team-user-authorization in the audited WAswitch workflows.

## ADDED Requirements

### Requirement: Authorization at mutation
Supervisor user updates MUST atomically enforce that the target is an agent in the supervisor's authorized group.

#### Scenario: Regression prevention
- **WHEN** The target becomes an owner before the update executes
- **THEN** The supervisor update is rejected and the owner remains enabled
