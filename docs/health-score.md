# Health Score

The health score is a local repo quality check for structure and file size. It is designed to run inside the repo being measured, either from the CLI or through the control-plane bridge.

## Quick Start

From a consumer repo:

```bash
npx autonomy-v2 health:score
```

To see why the score is lower:

```bash
npx autonomy-v2 health:why
```

For automation or scripts:

```bash
npx autonomy-v2 health:score --json
npx autonomy-v2 health:score --score-only
```

## Commands

`health:score` prints the current score, pass/fail status, summary metrics, top score drag, and top large files.

`health:why` prints the same score with a longer explanation of the main reasons the score is lower.

`health:help` prints terminal usage help.

## Options

```bash
npx autonomy-v2 health:score --max-lines 800 --threshold 80 --top 10
```

- `--max-lines <n>` sets the maximum allowed lines per file. Default: `800`.
- `--threshold <n>` sets the passing score. Default: `80`.
- `--top <n>` controls how many causes and files are shown. Default: `10`.
- `--json` prints the full report as JSON.
- `--score-only` prints only the score and pass/fail result.
- `--root <path>` analyzes another local repo path.

## What It Measures

The score currently focuses on:

- files over the line limit
- import cycles
- same-level import density
- TypeScript import graph health when `tsconfig.json` is present
- Rust import graph health when one or more `Cargo.toml` files are present

If TypeScript and Rust are both present, the command combines both reports into one mixed score.

## Control Plane Behavior

The hosted control-plane server does not read consumer repo files. When you click Calculate in the Health tab, the server queues a `health:score` job. The local control bridge claims that job, calculates the score inside the repo, and sends the result back to the control plane.

The CLI command runs the same local health calculation directly, without needing the control plane.

## Examples

Compact pass/fail:

```bash
npx autonomy-v2 health:score --score-only
```

Explain the top 20 issues:

```bash
npx autonomy-v2 health:why --top 20
```

Analyze a repo from another working directory:

```bash
npx autonomy-v2 health:score --root /path/to/repo
```

JSON for CI or dashboards:

```bash
npx autonomy-v2 health:score --json
```
