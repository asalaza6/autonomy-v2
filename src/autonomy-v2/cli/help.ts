export function printHelp() {
  console.log(`Autonomy v2 generic runtime

Commands:
  init                         Initialize repository definitions
  refresh                      Add missing generic scaffold files
  custom-agent:list
  custom-agent:toggle --runtime-key <key> --enabled <true|false>
  custom-agent:run --runtime-key <key>
  custom-agent:reset --runtime-key <key>
  action:run --name <action> [--input <json>] [--config <file>]
  server:start
  server:kill
  server:restart
  server:status

All commands accept --root <directory>. Agent commands accept --json.
Workflow actions are defined by repository files or optional control presets.`);
}
