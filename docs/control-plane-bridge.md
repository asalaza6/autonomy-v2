# Control Plane Bridge

The bridge is the local process that executes queued control-plane jobs on this machine.
The browser UI and queue API live online in the shared hosted deployment;
the bridge stays on the machine that has access to the target repos.

## What it does

- Polls the control-plane server for queued jobs.
- Claims one job at a time so two bridges do not run the same work.
- Maps a control-plane repo id to a real local repo path.
- Runs the repo-local `prd:add` flow in that repo.
- Runs the repo-local `deploy` flow for queued deploy jobs.
- Pushes a fresh status snapshot back to the server.
- Marks the job completed or failed.

## What it does not do

- It does not host the browser UI.
- It does not store the main application state on the hosted side.
- It does not replace the existing repo-local Autonomy scheduler.

## Typical setup

Run the hosted control-plane server online, then point the bridge at it from the local repo machine.

Run the bridge in one terminal:

```bash
npx autonomy-v2-control bridge --server-url https://your-control-plane.example.com
```

## Repo mapping

`--repo-map` is optional. If you do not pass it, the bridge defaults to the current working directory.

If you do pass it, it becomes the lookup table that tells the bridge where each repo lives on disk. Each repo still provides its canonical `repoId` from `prompts/autonomous/v2/config/control-plane.json`.

Example:

```bash
--repo-map /Users/me/projects/app-one,/Users/me/projects/admin-app
```

That means:

- the bridge reads the repo-local `repoId` for `/Users/me/projects/app-one`
- the bridge reads the repo-local `repoId` for `/Users/me/projects/admin-app`

## Lifecycle

1. You submit a PRD in the browser.
2. The server stores it as a queued job.
3. The bridge sees the queued job.
4. The bridge runs `prd:add` inside the mapped repo.
5. The bridge updates the server with the latest repo status.
6. The existing repo-local Autonomy runtime continues from there.

For deploys, the same queue boundary applies: clicking Deploy in the manager
creates a deploy job, the bridge claims it, and the bridge runs the mapped
repo's local `autonomy-v2 deploy` command. The deploy command can then
fast-forward the production branch and run the repo's configured
`deployCommand`.

## Practical notes

- One bridge process can usually handle multiple repos.
- You only need multiple bridges if you want different machines or stricter isolation.
- If the bridge is stopped, queued jobs wait until it starts again.
- The hosted server no longer needs a deploy-time repo allowlist. Repos appear when bridges register them by pushing status.
- `AUTONOMY_CONTROL_PLANE_PERSIST=0` still keeps queue/status storage in memory.
