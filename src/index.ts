#!/usr/bin/env node
// Load .env from OAM's own directory (not cwd) so it works from any folder
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env") });

/**
 * index.ts — OAM CLI Entry Point
 *
 * This is the file that runs when you type `oam` in your terminal.
 * It does three things:
 *
 * 1. Parses command-line arguments (task description, working directory, model, etc.)
 * 2. Validates that a task was provided.
 * 3. Creates a Manager instance and kicks off the job.
 *
 * Usage:
 *   oam "build a todo app with React"
 *   oam "fix the auth bug" --cwd ./my-project --model anthropic/claude-sonnet-4
 *
 * The task string is the only required argument. Everything else has defaults.
 */

import { resolve } from "path";
import { Manager } from "./manager.js";

// Grab everything after `node index.js` (or `oam`)
const args = process.argv.slice(2);

// Show help if no args or --help flag
if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  const b = "\x1b[1m", r = "\x1b[0m", cy = "\x1b[96m", g = "\x1b[90m", y = "\x1b[33m", w = "\x1b[97m";
  console.log(`
  ${b}${cy}┌─────────────────────────────────────────┐${r}
  ${b}${cy}│  ◈  oam ${g}· OpenCode Agent Manager${cy}        │${r}
  ${b}${cy}└─────────────────────────────────────────┘${r}

  ${b}${w}Usage${r}  ${cy}oam${r} ${y}<task>${r} ${g}[options]${r}

  ${b}${w}Options${r}
    ${cy}--cwd${r} ${y}<dir>${r}        Working directory ${g}(default: .)${r}
    ${cy}--model${r} ${y}<model>${r}    Eval LLM model ${g}(default: openai/gpt-4o-mini)${r}
    ${cy}--max-turns${r} ${y}<n>${r}    Max conversation turns ${g}(default: 50)${r}

  ${b}${w}Environment${r}
    ${cy}OPENROUTER_API_KEY${r}  OpenRouter API key
    ${cy}OAM_MODEL${r}           Default model ${g}(OpenRouter model ID)${r}

  ${b}${w}Examples${r}
    ${g}$${r} oam ${y}"build a todo app with React and TypeScript"${r}
    ${g}$${r} oam ${y}"fix the bug in src/auth.ts"${r} --cwd ./my-project
`);
  process.exit(0);
}

// Parse CLI arguments into variables
let task = "";
let cwd = process.cwd();
let model: string | undefined;
let maxTurns: number | undefined;

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case "--cwd":
      // Resolve to absolute path so OpenCode gets a valid working directory
      cwd = resolve(args[++i]);
      break;
    case "--model":
      // Override the eval LLM model (OpenRouter format, e.g. "anthropic/claude-sonnet-4")
      model = args[++i];
      break;
    case "--max-turns":
      // Safety limit for how many back-and-forth turns before giving up
      maxTurns = parseInt(args[++i], 10);
      break;
    default:
      // Any non-flag argument is treated as the task description
      if (!args[i].startsWith("--")) task = args[i];
  }
}

// Can't do anything without a task
if (!task) {
  console.error(`\x1b[31m✗\x1b[0m no task provided. run \x1b[96moam --help\x1b[0m for usage.`);
  process.exit(1);
}

// Create the manager and run the job.
// The manager handles everything from here: spawning opencode,
// running the prompt loop, evaluating progress, and cleaning up.
const manager = new Manager({ task, cwd, model, maxTurns });

manager.run().catch((err) => {
  console.error(`\x1b[31m[oam] fatal: ${err.message ?? err}\x1b[0m`);
  process.exit(1);
});
