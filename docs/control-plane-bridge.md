# Control Plane Bridge

The bridge is the local process that executes queued control-plane jobs on this machine.

## What it does

- Polls the control-plane server for queued jobs.
- Claims one job at a time so two bridges do not run the same work.
- Maps a control-plane repo id to a real local repo path.
- Runs the repo-local `prd:add` flow in that repo.
- Pushes a fresh status snapshot back to the server.
- Marks the job completed or failed.

## What it does not do

- It does not host the browser UI.
- It does not store the main application state.
- It does not replace the existing repo-local Autonomy scheduler.

## Typical setup

Run the control-plane server in one terminal:

```bash
npm run autonomy:v2:control
```

Run the bridge in another terminal:

```bash
npm run autonomy:v2:control:bridge
```

Then open the browser page from the server:

```text
http://127.0.0.1:3333
```

## Repo mapping

`--repo-map` is optional. If you do not pass it, the bridge defaults `default` to the current working directory.

If you do pass it, it becomes the lookup table that tells the bridge where each repo lives on disk.

Example:

```bash
--repo-map default=/Users/me/projects/app-one,admin=/Users/me/projects/admin-app
```

That means:

- `default` jobs run in `/Users/me/projects/app-one`
- `admin` jobs run in `/Users/me/projects/admin-app`

## Lifecycle

1. You submit a PRD in the browser.
2. The server stores it as a queued job.
3. The bridge sees the queued job.
4. The bridge runs `prd:add` inside the mapped repo.
5. The bridge updates the server with the latest repo status.
6. The existing repo-local Autonomy runtime continues from there.

## Practical notes

- One bridge process can usually handle multiple repos.
- You only need multiple bridges if you want different machines or stricter isolation.
- If the bridge is stopped, queued jobs wait until it starts again.
