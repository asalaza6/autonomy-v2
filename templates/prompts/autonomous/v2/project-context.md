# Project Context

This file is the project-specific context pack for this repo's Autonomy V2
agents. Edit it after `autonomy-v2 init` so each agent can start with a shared
map of the project instead of rediscovering the repo from scratch.

`autonomy-v2 init --force` preserves this file when it already exists.

## Project Identity

Describe what this repo is, who uses it, and what it owns.

Examples:

- app, service, package, game, site, or internal tool
- important runtime or deployment environment
- primary user-facing workflows

## Mental Model

Describe the short version of how the project works.

Include durable state, runtime/cache state, important background processes,
deployment flow, and any conventions agents should preserve.

## Branch And Deploy Contract

- integration branch: `dev`
- production branch: `main`
- blocked direct targets: `main`, `master`
- deploy command: describe this project's deploy command, if any

Add project-specific deployment notes here.

## Important Files And Directories

List the files and directories agents should check first for common tasks.

Examples:

- app/server entrypoints
- frontend components or routes
- API modules
- data/schema files
- config files
- tests
- docs

## Entrypoints

List useful local commands and scripts.

Examples:

- development server
- build command
- typecheck/lint/test commands
- deploy command

## Current Agents

Describe the configured agents and their responsibilities. Keep this aligned
with `prompts/autonomous/v2/config/agents.json`.

## High-Risk Areas

List areas that require extra care and stronger verification.

Examples:

- auth
- payment or billing
- deploy/release logic
- migrations and data persistence
- generated files or templates
- external APIs

## Useful Test Targets

List focused tests or commands agents should prefer for common changes.
