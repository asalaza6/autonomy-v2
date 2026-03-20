# Planned Features

## Current Planned Features to Build

This document tracks features that are intentionally planned and not yet implemented.

## 1) Multi-Account Repo-local Codex Profiles

### Status
Planned

### What
Allow one machine to run multiple projects with different Codex/Git identities by reading repo-local configuration and env per workspace.

### Why
Current behavior can mix credentials across repos if machine-level env is shared.

### Scope
- Support repo-local Codex/Git overrides in `prompts/autonomous/v2/config/agents.json`.
- Keep global fallback behavior for backward compatibility.
- Use repo-local env precedence in runner execution.

### Progress
- Design captured.
- Not yet implemented.

## 2) Bootstrap-First Workflow (Project Initialization Lane)

### Status
Planned

### What
Add a required bootstrap/preflight step before implementation lanes so empty repos are initialized into runnable project scaffolds.

### Why
Implementation tasks can run before baseline app/runtime setup, producing non-runnable outcomes.

### Scope
- Require project init lane before implementation task dispatch.
- Validate runnable baseline (package scripts / build/dev entry points) before spawning implementation workers.
- Preserve scope behavior once bootstrap is complete.

### Progress
- Logged as current issue and not yet implemented.

## 3) Deterministic No-Op Completion Handling

### Status
Planned

### What
Stop endless review/implementation loops when a follow-up task has no scoped code changes.

### Why
Repeated no-op follow-ups create infinite queued cycles and block merge progress.

### Scope
- Mark no-op lane follow-ups as terminal when no scoped diff exists and no new commit was introduced.
- Reduce requeue churn and duplicate check gating on unchanged work.
- Keep deterministic failure reporting for real blockers.

### Progress
- Design drafted.
- Not yet implemented.

## 4) Scope-Gated Merge Check Policy

### Status
Planned

### What
Ensure reviewers only require/ask for checks that are in-scope for the current lane.

### Why
Implementation was blocked by failing checks tied to out-of-scope files (`package.json` placeholders, external scripts).

### Scope
- Treat required check failures as lane-blocking only when checks are scoped/configured for that lane.
- Prevent scope-violating fix attempts by implementation agents.
- Record explicit reason when merges fail due to repository-level blockers.

### Progress
- Logged as issue.
- Not yet implemented.
