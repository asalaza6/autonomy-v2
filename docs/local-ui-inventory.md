# Local UI migration status

The old control panel, fixed tabs, HTML-string renderer, HTTP routes, hosted
job queue, bridge and hosting entrypoint have been removed. Health scripts live
in the separate `health-script` repository and have no Autonomy UI.

The replacement foundation is in `src/frontend/`: page contracts, config and
preset resolution, host-injected module loading/reloading, repository runtime
and registered action groups. No Electron or other host is introduced.

Shared actions cover Chat and agent toggles. Development adds PRDs/deployment;
maintenance adds package updates/server restart. Repository React pages select
their own presentation through config; replacement pages are not bundled yet.

Local PRD/status helpers moved to `src/autonomy-v2/local/`. The existing
`control-plane.json` config filename is retained for custom-agent consumers.

See [Local frontend](local-frontend.md).
