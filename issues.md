# Known Issues / Deferred Fixes

## Current Issues We Are Aware Of and Will Fix Later

This document tracks implementation and workflow issues identified during recent
rollouts that are intentionally deferred so we can stabilize behavior in a targeted follow-up.

## 1) Unknown Agent Mapping During Init/Run

### Symptom
Workers can fail to spawn with `Unknown agent "pm-agent"` during initialization or queue reconciliation.

### Root Cause
Agent configuration drift between generated `agents.json`, scaffold state, and runtime expectations left mismatched IDs during bootstrap paths.

### Current Behavior
Init runs but worker registration breaks for missing/unrecognized agents.

### Fix Plan
Align bootstrap defaults, active config defaults, and agent scaffold generation to one source of truth and add schema-safe validation for unknown IDs.

## 2) Repo Initialization Drift for New Projects

### Symptom
`autonomy-v2 init` on empty repos can produce extra/legacy scaffolding and inconsistent baseline behavior.

### Root Cause
Initialization flow allowed mixed legacy paths plus repo-local state/state defaults, causing template-to-runtime differences across environments.

### Current Behavior
Fresh checkouts sometimes get non-deterministic scaffold outputs depending on environment and prior partial state.

### Fix Plan
Make `init` strictly deterministic for repo-local config and prompt scaffolds and preserve only expected, versioned defaults.

## 3) Node Engine Incompatibility for Consumers

### Symptom
Installing `@asalaza6/autonomy-v2` with Node 18 prints `EBADENGINE` warnings.

### Root Cause
Package now requires Node `>=20` while some consumer environments still run older Node runtimes.

### Current Behavior
Warning or blocked usage in incompatible Node environments.

### Fix Plan
Add explicit consumer guidance and pin CI/runtime requirements; consider back-compat strategy only if required by support policy.

## 4) Reviewer/Worker Review Loop Without Closure

### Symptom
Agents re-run in repeated follow-up cycles with no state progress and no functional in-scope change.

### Root Cause
No-op outcomes were not treated as terminal follow-up outcomes, so the same review blockers regenerate follow-up tasks repeatedly.

### Current Behavior
Long-running queues with repeated “blocked but unchanged” behavior, consuming resources and obscuring actual progress.

### Fix Plan
Add deterministic no-op completion handling and guard review follow-ups when no scoped diff exists and no new commit has occurred.

## 5) Scope Leakage in Verification Expectations

### Symptom
Reviewer requests or blocks lanes for checks/tools outside an agent’s configured `allowedPaths`.

### Root Cause
Merge policy and review heuristics do not enforce a strict scope gate before check/fix expectations are required.

### Current Behavior
Implementation agents are asked to mutate scope-violating files (for example root `package.json`) and then blocked again for out-of-scope actions.

### Fix Plan
Enforce hard scope limits for required check fixes and reporting, and keep check gates aligned with allowed paths per lane.

## 6) Test Gate Hard-Failure on Placeholder Repository Scripts

### Symptom
Merge remains blocked by `npm run test --if-present` failing on default “no test specified” script values.

### Root Cause
Default lane checks can be anchored to placeholder scripts that are intentionally non-satisfying at repo bootstrap.

### Current Behavior
Even with valid scoped implementation work, PRs remain blocked by unrelated repository-level failures.

### Fix Plan
Make lane-level gating deterministic: required checks should only fail if they are in-scope or explicitly configured for the lane.

## 7) Cross-Project Agent/Config Template Divergence

### Symptom
Template-only folders and active config expectations diverge (extra template agents present but not part of active roster).

### Root Cause
Active runtime config allowed all template folders, while execution behavior expected a constrained active agent set.

### Current Behavior
Non-active agents can appear in runtime state scaffolds and confuse operational expectations.

### Fix Plan
Keep templates as examples, and make active config explicit with validation that only intended runtime agents are instantiated by default.

## 8) Project Runtime is Not Initiated Before Lane Work

### Symptom
When starting from an empty repo (example: `3d-art`), PM asked for a 3D project, but the pipeline produced scoped implementation tasks only. No app runtime baseline was created (`next` scaffold), no dev process was started, and no runnable build/dev flow existed.

### Root Cause
The orchestration flow did not enforce a mandatory project-initialization prerequisite lane before implementation lanes.

### Current Behavior
Agents can complete scoped diffs against an uninitialized workspace, so outcomes are not end-to-end deliverable even when lane checks pass.

### Fix Plan
Introduce a dedicated bootstrap/preflight lane and startup gate:
- project initialization lane (scaffold base app, scripts, package manager state)
- bootstrap validation (build script, dev script, lockfile/runtime baseline)
- implementation task dispatch should be blocked until bootstrap lane is complete and commit baseline exists.
