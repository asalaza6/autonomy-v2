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
  prd:add --id <id> --title <title> [--specification <text>] [--requirement <text>] [--task-spec <json>]
  prd:list [--status <status>]
  prd:archive-completed
  worktree:prepare --task <task-id> [--create]
  scope:validate --task <task-id> [--files <path> ...] [--worktree <path>]
  pr:record --task <task-id> --head-branch <branch> [--publish]
  ${buildRoleEventName(AGENT_ROLES.REVIEW, 'record')} --pr <pr-id> --reviewer <agent-id> --decision <approve|changes-requested> [--publish]
  merge --pr <pr-id> --actor <agent-id> [--execute]
  runtime:status
  update [--package-manager <npm|pnpm|yarn>] [--skip-init]

Output:
  Use --json to print structured JSON for any command.
`);
}

export { printHelp };
