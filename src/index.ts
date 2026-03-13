#!/usr/bin/env -S node --no-deprecation
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

// Web UI mode — start the server and stop here
if (args.includes("--serve")) {
  const { startServer } = await import("./server.js");
  startServer();
} else if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  // Show help
  const b = "\x1b[1m", r = "\x1b[0m", cy = "\x1b[96m", g = "\x1b[90m", y = "\x1b[33m", w = "\x1b[97m";
  console.log(`
  ${b}${cy}┌─────────────────────────────────────────┐${r}
  ${b}${cy}│  ◈  oam ${g}· OpenCode Agent Manager${cy}        │${r}
  ${b}${cy}└─────────────────────────────────────────┘${r}

  ${b}${w}Usage${r}  ${cy}oam${r} ${y}<task>${r} ${g}[options]${r}

  ${b}${w}Options${r}
    ${cy}--cwd${r} ${y}<dir>${r}        Working directory ${g}(default: .)${r}
    ${cy}--model${r} ${y}<model>${r}    Eval LLM model ${g}(default: openai/gpt-4o-mini)${r}
    ${cy}--agent-model${r} ${y}<m>${r}  OpenCode model ${g}(e.g. openai/gpt-5.4)${r}
    ${cy}--reasoning${r} ${y}<level>${r} Reasoning effort ${g}(low|medium|high|xhigh, default: high)${r}
    ${cy}--max-turns${r} ${y}<n>${r}    Max conversation turns ${g}(default: 50)${r}
    ${cy}--serve${r}              Start web UI ${g}(default: port 3399, 0.0.0.0)${r}
    ${cy}--debug${r}              Log raw ACP JSON-RPC traffic ${g}(default: off)${r}

  ${b}${w}Environment${r}
    ${cy}OPENROUTER_API_KEY${r}  OpenRouter API key
    ${cy}OAM_MODEL${r}           Default eval model ${g}(OpenRouter model ID)${r}
    ${cy}OAM_AGENT_MODEL${r}     Default OpenCode model ${g}(e.g. openai/gpt-5.4)${r}
    ${cy}OAM_REASONING${r}       Reasoning effort level ${g}(low|medium|high|xhigh)${r}
    ${cy}OAM_PORT${r}            Web UI port ${g}(default: 3399)${r}

  ${b}${w}Examples${r}
    ${g}$${r} oam ${y}"build a todo app with React and TypeScript"${r}
    ${g}$${r} oam ${y}"fix the bug in src/auth.ts"${r} --cwd ./my-project
    ${g}$${r} oam ${y}--serve${r}
`);
  process.exit(0);
} else {
  // CLI mode — parse args and run a job
  let task = "";
  let cwd = process.cwd();
  let model: string | undefined;
  let agentModel: string | undefined;
  let reasoning: string | undefined;
  let maxTurns: number | undefined;
  let debug = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--cwd":
        cwd = resolve(args[++i]);
        break;
      case "--model":
        model = args[++i];
        break;
      case "--agent-model":
        agentModel = args[++i];
        break;
      case "--reasoning":
        reasoning = args[++i];
        break;
      case "--max-turns":
        maxTurns = parseInt(args[++i], 10);
        break;
      case "--debug":
        debug = true;
        break;
      default:
        if (!args[i].startsWith("--")) task = args[i];
    }
  }

  if (!task) {
    console.error(`\x1b[31m✗\x1b[0m no task provided. run \x1b[96moam --help\x1b[0m for usage.`);
    process.exit(1);
  }

  const manager = new Manager({ task, cwd, model, agentModel, reasoning, maxTurns, debug });
  manager.run().catch((err) => {
    console.error(`\x1b[31m[oam] fatal: ${err.message ?? err}\x1b[0m`);
    process.exit(1);
  });
}
