/**
 * manager.ts — The OAM Orchestration Engine
 *
 * This is the brain of OAM. It controls the entire lifecycle of a job:
 *
 * 1. SPAWN — Launches `opencode acp` as a subprocess via the ACPClient.
 * 2. INITIALIZE — Handshakes with OpenCode over ACP (version, capabilities).
 * 3. SESSION — Creates a new conversation session scoped to a working directory.
 * 4. PROMPT LOOP — Sends the user's task, then keeps the conversation going:
 *    - Sends a prompt to OpenCode.
 *    - Streams back all updates (agent messages, tool calls, plans) to the terminal.
 *    - Auto-approves ALL permission requests (no human needed).
 *    - When a turn ends, calls a small LLM (via OpenRouter) to evaluate:
 *      "Is the task done? If not, what should I tell the agent next?"
 *    - Repeats until the eval LLM says done, or we hit max turns.
 * 5. CLEANUP — Kills the OpenCode subprocess and exits.
 *
 * The key insight: OAM sits between the user and OpenCode. The user gives a
 * high-level task ("build a todo app"), and OAM handles all the back-and-forth
 * that would normally require a human — approving file writes, answering
 * clarification questions, deciding when to continue vs. stop.
 */

import OpenAI from "openai";
import { ACPClient } from "./acp.js";

/** Options passed in from the CLI to configure a job */
export interface ManagerOptions {
  task: string;
  cwd: string;
  model?: string;
  maxTurns?: number;
}

/** The result of the eval LLM deciding whether the job is done */
interface Evaluation {
  done: boolean;
  nextPrompt: string;
  summary?: string;
}

/** ANSI color/style helpers — purely cosmetic */
const C = {
  reset:        "\x1b[0m",
  bold:         "\x1b[1m",
  dim:          "\x1b[2m",
  cyan:         "\x1b[36m",
  brightCyan:   "\x1b[96m",
  green:        "\x1b[32m",
  brightGreen:  "\x1b[92m",
  yellow:       "\x1b[33m",
  red:          "\x1b[31m",
  magenta:      "\x1b[35m",
  blue:         "\x1b[34m",
  gray:         "\x1b[90m",
  white:        "\x1b[37m",
  brightWhite:  "\x1b[97m",
} as const;

export class Manager {
  /** ACP transport — handles JSON-RPC communication with the OpenCode subprocess */
  private client: ACPClient;

  /** The ACP session ID for the current conversation */
  private sessionId = "";

  /**
   * Rolling conversation log (user + assistant messages).
   * Fed to the eval LLM so it has context to decide what to do next.
   */
  private log: Array<{ role: "user" | "assistant"; content: string }> = [];

  /**
   * Buffer for the current agent response being streamed in.
   * Chunks arrive one at a time via notifications — we accumulate them here
   * so we have the full response when the turn ends.
   */
  private agentBuf = "";

  /** OpenAI-compatible client pointed at OpenRouter for eval LLM calls */
  private openai: OpenAI;

  /** The original task description from the user */
  private task: string;

  /** Working directory for the OpenCode session */
  private cwd: string;

  /** Model ID for the eval LLM (OpenRouter format, e.g. "openai/gpt-4o-mini") */
  private model: string;

  /** Safety limit — stop after this many prompt turns to avoid infinite loops */
  private maxTurns: number;

  /** Tracks whether we've already printed the header for the current streamed agent reply */
  private responseOpen = false;

  constructor(opts: ManagerOptions) {
    this.task = opts.task;
    this.cwd = opts.cwd;
    this.model = opts.model || process.env.OAM_MODEL || "openai/gpt-4o-mini";
    this.maxTurns = opts.maxTurns ?? 50;

    // Point the OpenAI SDK at OpenRouter's API.
    // We pass the key explicitly so the SDK doesn't fall back to OPENAI_API_KEY.
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error("OPENROUTER_API_KEY is not set. See .env.example.");
    }
    this.openai = new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey,
    });

    this.client = new ACPClient();
    this.wire();
  }

  /**
   * Wire up event handlers on the ACP client.
   * This sets up the two key behaviors:
   * 1. Auto-approve all permission requests from OpenCode.
   * 2. Stream all session updates to the terminal.
   */
  private wire(): void {
    // PERMISSION AUTO-APPROVAL
    // When OpenCode wants to do something (write a file, run a command, etc.),
    // it sends a "session/request_permission" request with a list of options
    // like "Allow once", "Allow always", "Reject". We always pick allow.
    // Preference: "allow_always" > "allow_once" > first option.
    this.client.onRequest("session/request_permission", async (params) => {
      const options = params.options as Array<{
        optionId: string;
        kind: string;
        name: string;
      }>;
      const toolCall = params.toolCall as
        | { title?: string; toolCallId?: string }
        | undefined;

      // Pick the most permissive option available
      const pick =
        options.find((o) => o.kind === "allow_always") ||
        options.find((o) => o.kind === "allow_once") ||
        options[0];

      console.log(
        `${C.green}✓${C.reset} ${C.gray}approved:${C.reset} ${C.brightWhite}${toolCall?.title ?? "permission"}${C.reset} ${C.gray}→${C.reset} ${C.dim}${pick?.name ?? "allow"}${C.reset}`
      );

      // Respond to OpenCode with the selected permission option
      return {
        outcome: { outcome: "selected", optionId: pick?.optionId },
      };
    });

    // SESSION UPDATE NOTIFICATIONS
    // OpenCode streams progress via "session/update" notifications.
    // These are one-way (no response needed) — we just display them.
    this.client.on(
      "notification",
      (_method: string, params: Record<string, unknown>) => {
        if (_method === "session/update") this.onUpdate(params);
      }
    );

    // Log when the OpenCode process exits
    this.client.on("exit", (code: number | null) => {
      this.log2(`opencode exited (${code})`);
    });
  }

  /**
   * Handles a session/update notification from OpenCode.
   * These come in many flavors — we handle each type differently:
   * - agent_message_chunk: Text the agent is writing (streamed token by token)
   * - agent_thought_chunk: Internal reasoning (displayed dimmed)
   * - tool_call: Agent started using a tool (read file, run command, etc.)
   * - tool_call_update: Tool finished or failed
   * - plan: Agent's execution plan for the task
   */
  private onUpdate(params: Record<string, unknown>): void {
    const u = params.update as Record<string, unknown>;
    if (!u) return;

    switch (u.sessionUpdate) {
      case "agent_message_chunk": {
        // The agent is streaming its response — accumulate and display in real-time
        const c = u.content as { type?: string; text?: string } | undefined;
        if (c?.type === "text" && c.text) {
          if (!this.responseOpen) {
            this.responseOpen = true;
            console.log(`\n${C.bold}${C.brightCyan}┌── opencode${C.reset}`);
          }
          this.agentBuf += c.text;
          process.stdout.write(c.text);
        }
        break;
      }
      case "agent_thought_chunk": {
        // Internal reasoning — show it dimmed so user can distinguish from actual output
        const c = u.content as { type?: string; text?: string } | undefined;
        if (c?.type === "text" && c.text) {
          process.stdout.write(`${C.dim}${C.magenta}${c.text}${C.reset}`);
        }
        break;
      }
      case "tool_call": {
        // Agent started a tool invocation (e.g. "Reading file src/index.ts")
        const title = u.title as string;
        const status = u.status as string;
        const statusColor = status === "running" ? C.yellow : C.gray;
        console.log(`${C.yellow}⚙${C.reset}  ${C.brightWhite}${title}${C.reset} ${statusColor}${C.dim}[${status}]${C.reset}`);
        break;
      }
      case "tool_call_update": {
        // Tool finished — only log completions and failures (skip in_progress noise)
        const status = u.status as string;
        const id = u.toolCallId as string;
        if (status === "completed") {
          console.log(`${C.green}✓${C.reset}  ${C.dim}${id}${C.reset}`);
        } else if (status === "failed") {
          console.log(`${C.red}✗${C.reset}  ${C.dim}${id}${C.reset}`);
        }
        break;
      }
      case "plan": {
        // Agent shared its execution plan — display each step and its status
        const entries = u.entries as Array<{
          content: string;
          status: string;
        }>;
        if (entries?.length) {
          console.log(`\n${C.bold}${C.blue}◈ plan${C.reset}`);
          for (const e of entries) {
            const sym =
              e.status === "completed" ? `${C.green}✓${C.reset}` :
              e.status === "failed"    ? `${C.red}✗${C.reset}`    :
              e.status === "running"   ? `${C.yellow}›${C.reset}`  :
                                        `${C.gray}○${C.reset}`;
            console.log(`  ${sym} ${C.dim}${e.content}${C.reset}`);
          }
          console.log();
        }
        break;
      }
    }
  }

  /**
   * Main entry point — runs the entire job from start to finish.
   * This is the core loop: init → session → prompt → evaluate → repeat.
   */
  async run(): Promise<void> {
    const bar = `${C.gray}${"─".repeat(52)}${C.reset}`;
    console.log(`\n${bar}`);
    console.log(`${C.bold}${C.brightCyan}  ◈ oam${C.reset}  ${C.dim}OpenCode Agent Manager${C.reset}`);
    console.log(bar);
    console.log(`${C.gray}  task${C.reset}   ${C.brightWhite}${this.task}${C.reset}`);
    console.log(`${C.gray}  cwd${C.reset}    ${C.dim}${this.cwd}${C.reset}`);
    console.log(`${C.gray}  model${C.reset}  ${C.dim}${this.model}${C.reset}`);
    console.log(`${bar}\n`);

    // Step 1: Spawn OpenCode as an ACP subprocess
    this.client.spawn("opencode", ["acp"]);

    // Step 2: Initialize the ACP connection.
    // We tell OpenCode our capabilities (we don't handle fs or terminal —
    // OpenCode will use its own built-in tools for those).
    const init = await this.client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "oam", title: "OAM", version: "0.1.0" },
    });

    const info = init.agentInfo as { name?: string; version?: string } | undefined;
    this.log2(`${C.gray}agent${C.reset}    ${info?.name ?? "opencode"} ${C.dim}v${info?.version ?? "?"}${C.reset}`);

    // Step 3: Create a new session scoped to the working directory.
    // No MCP servers needed — OpenCode has its own tools built in.
    const sess = await this.client.request("session/new", {
      cwd: this.cwd,
      mcpServers: [],
    });
    this.sessionId = sess.sessionId as string;
    this.log2(`${C.gray}session${C.reset}  ${C.dim}${this.sessionId}${C.reset}\n`);

    // Step 4: The prompt loop.
    // Start with the initial prompt (task + autonomy instructions),
    // then keep going with follow-up prompts from the eval LLM.
    let prompt = this.initialPrompt();
    let turn = 0;

    while (turn < this.maxTurns) {
      turn++;
      const pct = Math.round((turn / this.maxTurns) * 20);
      const bar2 = `${C.cyan}${"█".repeat(pct)}${C.dim}${"░".repeat(20 - pct)}${C.reset}`;
      console.log(`\n${C.bold}${C.gray}── turn ${turn}/${this.maxTurns}${C.reset}  ${bar2}\n`);

      // Reset the agent message buffer for this turn
      this.agentBuf = "";
      this.responseOpen = false;

      this.logBlock("oam -> opencode", prompt);

      // Send the prompt and wait for the full turn to complete.
      // During this await, notifications stream in (agent messages, tool calls, etc.)
      // and permission requests are auto-approved — all handled by the wired-up handlers.
      const result = await this.client.request("session/prompt", {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text: prompt }],
      });

      // The turn ended — check why
      const stop = result.stopReason as string;
      if (this.responseOpen) {
        console.log(`\n${C.bold}${C.brightCyan}└──${C.reset}\n`);
      } else {
        this.log2(`${C.dim}[no assistant message]${C.reset}`);
      }
      this.log2(`${C.gray}stop${C.reset}  ${C.dim}${stop}${C.reset}`);

      // Save this exchange to the conversation log for the eval LLM
      this.log.push(
        { role: "user", content: prompt },
        { role: "assistant", content: this.agentBuf }
      );

      // If the agent refused to continue, bail out
      if (stop === "refusal") {
        this.log2(`${C.red}✗${C.reset} agent refused — stopping`);
        break;
      }

      // Step 5: Ask the eval LLM — is the task done? What should we say next?
      const ev = await this.evaluate();
      if (ev.done) {
        console.log(`\n${C.bold}${C.brightGreen}✓ job complete!${C.reset}`);
        if (ev.summary) console.log(`${C.gray}  ${ev.summary}${C.reset}`);
        console.log();
        break;
      }

      // Not done yet — use the eval LLM's suggested follow-up as the next prompt
      prompt = ev.nextPrompt;
      this.log2(`${C.gray}next${C.reset}  ${C.dim}${prompt.slice(0, 120)}${prompt.length > 120 ? "…" : ""}${C.reset}`);
    }

    if (turn >= this.maxTurns) {
      this.log2(`${C.yellow}⚠${C.reset}  max turns ${C.bold}(${this.maxTurns})${C.reset} reached`);
    }

    // Step 6: Clean up — kill the OpenCode subprocess
    this.client.destroy();
  }

  /**
   * Builds the first prompt sent to OpenCode.
   * This sets the ground rules: work autonomously, don't ask questions,
   * make all decisions yourself, and say "TASK COMPLETE" when done.
   */
  private initialPrompt(): string {
    return [
      "You are being managed by an autonomous agent manager (OAM).",
      "Complete the following task fully and autonomously.",
      "Do NOT ask for clarification or confirmation — make all decisions yourself.",
      "If unsure, pick the most reasonable option and proceed.",
      "",
      `TASK: ${this.task}`,
      "",
      "Rules:",
      "- Complete the entire task without stopping to ask questions",
      "- Make all design decisions autonomously",
      "- Create all necessary files and directories",
      "- Install any required dependencies",
      "- Test your work when possible",
      '- When completely done, say "TASK COMPLETE" and provide a brief summary',
    ].join("\n");
  }

  /**
   * Calls the eval LLM (via OpenRouter) to decide what to do next.
   *
   * We send it the original task + the last 2 exchanges (4 messages) from the
   * conversation, and ask it to respond with JSON:
   *   { "done": true/false, "summary": "...", "nextPrompt": "..." }
   *
   * This is the "manager brain" — it decides when the task is finished,
   * answers questions on behalf of the user, tells the agent to fix errors, etc.
   *
   * If the eval LLM call fails for any reason, we fall back to a generic
   * "keep going" prompt so the job doesn't stall.
   */
  private async evaluate(): Promise<Evaluation> {
    // Only send the last 4 messages (2 exchanges) to keep context small and fast
    const tail = this.log.slice(-4);

    try {
      const res = await this.openai.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: "system",
            content: [
              `You evaluate whether a coding agent has completed a task.`,
              `Original task: "${this.task}"`,
              ``,
              `Based on the agent's latest response, determine:`,
              `1. Is the task fully complete?`,
              `2. If not, what should the next instruction be?`,
              ``,
              `Respond in JSON: {"done": bool, "summary": "...", "nextPrompt": "..."}`,
              ``,
              `Guidelines:`,
              `- If the agent said "TASK COMPLETE" or equivalent → done: true`,
              `- If the agent asked a question → answer it reasonably and tell it to proceed`,
              `- If the agent hit an error → tell it to fix the error and continue`,
              `- If the agent is mid-progress → tell it to continue`,
              `- If the agent seems stuck → give specific guidance`,
            ].join("\n"),
          },
          // Feed it recent conversation so it knows what just happened
          ...tail.map((m) => ({
            role: m.role as "user" | "assistant",
            // Truncate to 4000 chars to keep token usage low
            content: m.content.slice(0, 4000),
          })),
        ],
        response_format: { type: "json_object" },
        temperature: 0.2, // Low temperature for consistent, predictable decisions
      });

      const text = res.choices[0]?.message?.content;
      if (text) return JSON.parse(text) as Evaluation;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log2(`${C.red}✗${C.reset} eval error: ${C.dim}${msg}${C.reset}`);
    }

    // Fallback if the eval LLM fails — don't stall, just tell the agent to continue
    return {
      done: false,
      nextPrompt:
        "Continue working on the task. If you're done, say TASK COMPLETE with a summary.",
    };
  }

  /** Prints a styled [oam] log line to the terminal */
  private log2(msg: string): void {
    console.log(`${C.bold}${C.brightCyan}[oam]${C.reset} ${msg}`);
  }

  /** Prints a labeled multi-line block so prompts are easy to spot in the terminal */
  private logBlock(label: string, content: string): void {
    console.log(`\n${C.bold}${C.blue}┌── ${label}${C.reset}`);
    for (const line of content.split("\n")) {
      console.log(`${C.blue}│${C.reset} ${C.dim}${line}${C.reset}`);
    }
    console.log(`${C.blue}└──${C.reset}\n`);
  }
}
