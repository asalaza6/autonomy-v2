import { AGENT_ROLES, buildRoleEventName } from '../../agents/role-catalog.js';

function printHelp() {
  console.log(`
Autonomy v2 CLI

Usage:
  autonomy-v2 <command> [options]

Commands:
  init
  status [--sync]
  task:add --id <id> --title <title> --agent <agent-id> [--acceptance <text>]
  task:finish --task <task-id>
  task:list [--status <status>]
  prd:add --id <id> --title <title> [--specification <text>] [--requirement <text>] [--task-spec <json>] [--priority highest]
  prd:list [--status <status>]
  prd:archive-completed
  worktree:prepare --task <task-id> [--create]
  scope:validate --task <task-id> [--files <path> ...] [--worktree <path>]
  pr:record --task <task-id> --head-branch <branch> [--publish]
  ${buildRoleEventName(AGENT_ROLES.REVIEW, 'record')} --pr <pr-id> --reviewer <agent-id> --decision <approve|changes-requested> [--publish]
  merge --pr <pr-id> --actor <agent-id> [--execute]
  deploy
  runtime:status
  health:score [--max-lines 800] [--threshold 80] [--top 10] [--score-only] [--json]
  health:why [--max-lines 800] [--threshold 80] [--top 10] [--json]
  health:help
  auth [--node-auth-token <token>] [--github-token <token>] [--control-plane-url <url>] [--repo owner/name] [--open] [--skip-verify]
  server:start
  server:kill
  server:restart [--detached] [--foreground] [--keep-old-terminal]
  server:status
  custom-agent:list
  custom-agent:toggle --runtime-key <runtime-key> (--enable|--disable|--enabled <true|false>)
  custom-agent:run --runtime-key <runtime-key>
  custom-agent:reset --runtime-key <runtime-key> [--archive-existing] [--clear-context] [--clear-notes] [--clear-recent-summary]
  update [--package-manager <npm|pnpm|yarn>] [--skip-init]
  refresh

Output:
  Use --json to print structured JSON for any command.
`);
}

export { printHelp };
