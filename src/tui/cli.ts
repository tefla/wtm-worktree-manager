import { Command } from "commander";
import { runInitCommand } from "./commands/init";
import { runTui } from "./commands/ui";

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("wtm")
    .description("WTM hybrid terminal UI (experimental)")
    .allowExcessArguments(false)
    .showHelpAfterError();

  program
    .command("init")
    .description("Initialise .wtm project structure in the current repository")
    .action(async () => {
      await runInitCommand({ projectPath: process.cwd() });
    });

  program
    .command("ui", { isDefault: true, hidden: true })
    .description("Launch the interactive TUI")
    .action(async () => {
      await runTui({ projectPath: process.cwd() });
    });

  await program.parseAsync(process.argv);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
