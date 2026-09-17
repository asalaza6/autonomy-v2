# Custom-agent failures

Configuration and decision failures are recorded by the custom-agent scheduler.
A skipped decision is a normal polling result. Enable flags, poll windows,
singleton ownership and pool capacity can also prevent a start.

Invocations reserve runtime state before spawning. If a spawn fails, the
scheduler records failure for that invocation and any remaining reservations
that it cannot spawn.

The worker records lifecycle command and Codex failures and invokes the
configured finalizer on success or failure. Repository-specific recovery,
resource release, queue transitions and retry policy belong to those scripts.

See [orchestration](orchestrator-flow.md) and
[configuration](autonomy-v2-config-support.md).
