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
import { execSync } from "child_process";
import { ACPClient } from "./acp.js";

/** Options passed in from the CLI to configure a job */
export interface ManagerOptions {
  task: string;
  cwd: string;
  model?: string;
  maxTurns?: number;
  debug?: boolean;
}

/** The result of the eval LLM deciding whether the job is done */
interface Evaluation {
  done: boolean;
  nextPrompt: string;
  summary?: string;
}

/** Record of a single turn for the progress report */
interface TurnRecord {
  turn: number;
  promptSnippet: string;
  responseSnippet: string;
  stopReason: string;
  evalDone: boolean;
  evalSummary?: string;
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

  /** History of all turns for the final progress report */
  private history: TurnRecord[] = [];

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
    this.client.debug = opts.debug ?? false;
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

    this.client.on("stderr", (data: string) => {
      for (const line of data.split("\n").filter(Boolean)) {
        console.log(`${C.red}[opencode:stderr]${C.reset} ${C.dim}${line}${C.reset}`);
      }
    });

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

    // Step 4: Expand the user's task into a detailed brief.
    // The manager LLM takes the terse request and produces a thorough spec
    // with architecture decisions, file structure, and acceptance criteria.
    const brief = await this.expand();

    // Step 5: The prompt loop.
    // Start with the expanded brief wrapped in agent instructions,
    // then keep going with follow-up prompts from the manager LLM.
    let prompt = this.initialPrompt(brief);
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
        this.history.push({
          turn, promptSnippet: prompt.slice(0, 200),
          responseSnippet: this.agentBuf.slice(0, 200),
          stopReason: stop, evalDone: false,
        });
        this.log2(`${C.red}✗${C.reset} agent refused — stopping`);
        break;
      }

      // Step 6: Ask the manager LLM — is the task done? What should we say next?
      this.log2(`${C.yellow}◈${C.reset}  evaluating…`);
      const ev = await this.evaluate();

      this.history.push({
        turn, promptSnippet: prompt.slice(0, 200),
        responseSnippet: this.agentBuf.slice(0, 200),
        stopReason: stop, evalDone: ev.done, evalSummary: ev.summary,
      });

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

    // Step 7: Print the progress report and clean up
    this.printReport();
    this.client.destroy();
  }

  /**
   * Uses the manager LLM to expand a terse user request into a detailed
   * implementation brief — architecture, file structure, tech choices,
   * acceptance criteria, etc. Streams the output token-by-token so the
   * user sees progress in real-time.
   */
  private async expand(): Promise<string> {
    console.log(`\n${C.bold}${C.blue}┌── expanding task${C.reset}`);

    try {
      const stream = await this.openai.chat.completions.create({
        model: this.model,
        stream: true,
        messages: [
          {
            role: "system",
            content: [
              `You are a human developer's stand-in — you're typing instructions into a`,
              `coding agent (like Claude Code / Cursor / OpenCode). Write exactly what a`,
              `skilled developer would type: direct, concise, opinionated.`,
              ``,
              `Your job: take the user's brief task and turn it into a clear prompt that`,
              `tells the agent what to build and how. Think "senior dev pairing with an`,
              `AI" — not "architect writing a design doc."`,
              ``,
              `Keep it short. A few paragraphs max. Include:`,
              `- What to build (1-2 sentences)`,
              `- Key decisions: tech stack, patterns, file structure (bullet points)`,
              `- Implementation order if it matters (numbered list)`,
              `- Any gotchas worth flagging (only non-obvious ones)`,
              ``,
              `Do NOT include:`,
              `- Verbose explanations of obvious things`,
              `- "You could do X or Y" hedging — just pick one`,
              `- Acceptance criteria, testing instructions, or boilerplate checklists`,
              `- Markdown headers or formatting — just plain text`,
              ``,
              `Write like you're in a Slack DM to a competent colleague, not a spec doc.`,
            ].join("\n"),
          },
          {
            role: "user",
            content: `Task: ${this.task}`,
          },
        ],
        temperature: 0.3,
      });

      let buf = "";
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          buf += delta;
          process.stdout.write(`${C.dim}${delta}${C.reset}`);
        }
      }

      console.log(`\n${C.bold}${C.blue}└──${C.reset}\n`);
      if (buf) return buf;
    } catch (err: unknown) {
      console.log(`\n${C.bold}${C.blue}└──${C.reset}`);
      this.logError("expand() failed", err);
    }

    // Fallback — just use the raw task if the expand call fails
    return this.task;
  }

  /**
   * Builds the first prompt sent to OpenCode.
   * Wraps the expanded brief with agent instructions and ground rules.
   */
  private initialPrompt(brief: string): string {
    return [
      brief,
      "",
      "---",
      "Work fully autonomously. Don't ask questions — I'll review after each step.",
      "Install deps, create files, test when possible.",
      'Say "TASK COMPLETE" with a short summary when done.',
    ].join("\n");
  }

  /**
   * The manager brain — reviews the agent's work after each turn and decides
   * what to do next. This isn't a simple "done yet?" check. The manager:
   *
   * - Reviews code quality and architectural decisions
   * - Catches mistakes early and course-corrects
   * - Answers questions on the user's behalf with opinionated decisions
   * - Breaks down remaining work into clear next steps
   * - Knows when to push for more vs. when to accept "good enough"
   *
   * If the eval LLM call fails, falls back to a generic "keep going" prompt.
   */
  private static readonly EVAL_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    {
      type: "function",
      function: {
        name: "ls",
        description: "List files and directories. Returns output of `ls -la` for the given path.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Directory path (relative to cwd)" } },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "find",
        description: "Find files matching a name pattern. Returns matching paths (max 50 results).",
        parameters: {
          type: "object",
          properties: { pattern: { type: "string", description: "File name pattern (e.g. '*.py', 'server.*')" } },
          required: ["pattern"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "grep",
        description: "Search for a pattern in files. Returns matching lines with file paths.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Search pattern (regex)" },
            path: { type: "string", description: "File or directory to search in (default: .)" },
          },
          required: ["pattern"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "tree",
        description: "Show directory structure as a tree (max 3 levels deep).",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Directory path (default: .)" } },
        },
      },
    },
  ];

  private execTool(name: string, args: Record<string, string>): string {
    const MAX = 10_000;
    try {
      let cmd: string;
      switch (name) {
        case "ls":
          cmd = `ls -la ${JSON.stringify(args.path || ".")}`;
          break;
        case "find":
          cmd = `find . -name ${JSON.stringify(args.pattern)} -maxdepth 5 | head -50`;
          break;
        case "grep":
          cmd = `grep -rn ${JSON.stringify(args.pattern)} ${JSON.stringify(args.path || ".")} | head -50`;
          break;
        case "tree":
          cmd = `find ${JSON.stringify(args.path || ".")} -maxdepth 3 -print | head -80 | sort`;
          break;
        default:
          return `Unknown tool: ${name}`;
      }
      const out = execSync(cmd, {
        cwd: this.cwd,
        timeout: 10_000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return out.length > MAX ? out.slice(0, MAX) + "\n…(truncated)" : out;
    } catch (err: unknown) {
      const e = err as { stderr?: string; message?: string };
      return e.stderr || e.message || "Command failed";
    }
  }

  private async evaluate(): Promise<Evaluation> {
    const tail = this.log;
    const maxToolRounds = 5;

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: [
          `You are a senior engineering manager overseeing a coding agent.`,
          `Original task: "${this.task}"`,
          `Working directory: ${this.cwd}`,
          ``,
          `You have tools to inspect the actual filesystem — use them to verify work`,
          `when you're unsure. You can ls, cat, find, grep, and tree the project.`,
          ``,
          `Your job is to decide whether the task is DONE or needs MORE WORK:`,
          ``,
          `- If the agent says "TASK COMPLETE" and its summary covers the original task, set done:true`,
          `- If you're unsure whether files were created correctly, use your tools to check`,
          `- If the agent asked a question, answer it decisively — don't defer to the user`,
          `- If the task is clearly incomplete (missing major features, not just polish), guide the agent`,
          `- When guiding, be specific and focus on the single most important next step`,
          ``,
          `Err on the side of done:true. Don't nitpick or ask for extras beyond the original task.`,
          ``,
          `When you've made your decision, respond in JSON: {"done": bool, "summary": "...", "nextPrompt": "..."}`,
        ].join("\n"),
      },
      ...tail.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
      {
        role: "user" as const,
        content: "Review the agent's latest response above. Use your tools if needed to verify, then respond with your JSON evaluation.",
      },
    ];

    try {
      for (let round = 0; round < maxToolRounds; round++) {
        const res = await this.openai.chat.completions.create({
          model: this.model,
          messages,
          tools: Manager.EVAL_TOOLS,
          temperature: 0.3,
        });

        const choice = res.choices[0];
        const msg = choice?.message;
        if (!msg) break;

        if (msg.content) {
          console.log(`${C.dim}${C.magenta}${msg.content}${C.reset}`);
        }

        messages.push(msg);

        if (msg.tool_calls?.length) {
          for (const tc of msg.tool_calls) {
            const args = JSON.parse(tc.function.arguments || "{}");
            this.log2(`${C.yellow}⚙${C.reset}  ${C.brightWhite}${tc.function.name}${C.reset}${C.gray}(${JSON.stringify(args)})${C.reset}`);
            const result = this.execTool(tc.function.name, args);
            const preview = result.split("\n").slice(0, 6).join("\n");
            const truncated = result.split("\n").length > 6 ? `\n${C.dim}  …(${result.split("\n").length - 6} more lines)${C.reset}` : "";
            console.log(`${C.dim}${preview}${C.reset}${truncated}`);
            messages.push({
              role: "tool" as const,
              tool_call_id: tc.id,
              content: result,
            });
          }
          continue;
        }

        let text = msg.content;
        if (text) {
          text = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "").trim();
          const jsonMatch = text.match(/\{[\s\S]*"done"\s*:[\s\S]*\}/);
          const jsonStr = jsonMatch ? jsonMatch[0] : text;
          try {
            return JSON.parse(jsonStr) as Evaluation;
          } catch {
            this.log2(`${C.red}✗${C.reset} JSON parse failed. Raw response:`);
            console.log(`${C.dim}${text.slice(0, 500)}${text.length > 500 ? "…" : ""}${C.reset}`);
          }
        }
        break;
      }
    } catch (err: unknown) {
      this.logError("evaluate() failed", err);
    }

    return {
      done: false,
      nextPrompt:
        "Continue working on the task. If you're done, say TASK COMPLETE with a summary.",
    };
  }

  /** Prints a final progress report summarizing every turn of the job */
  private printReport(): void {
    if (this.history.length === 0) return;

    const bar = `${C.gray}${"═".repeat(52)}${C.reset}`;
    console.log(bar);
    console.log(`${C.bold}${C.brightCyan}  ◈ progress report${C.reset}`);
    console.log(bar);

    for (const h of this.history) {
      const status =
        h.evalDone          ? `${C.brightGreen}done${C.reset}` :
        h.stopReason === "refusal" ? `${C.red}refused${C.reset}` :
                            `${C.yellow}continue${C.reset}`;

      console.log(`\n${C.bold}${C.white}  turn ${h.turn}${C.reset}  ${status}  ${C.dim}stop: ${h.stopReason}${C.reset}`);

      // Manager prompt snippet
      const promptLine = h.promptSnippet.replace(/\n/g, " ").slice(0, 80);
      console.log(`${C.blue}  ▸ oam${C.reset}       ${C.dim}${promptLine}${promptLine.length >= 80 ? "…" : ""}${C.reset}`);

      // Agent response snippet
      const respLine = h.responseSnippet.replace(/\n/g, " ").slice(0, 80);
      console.log(`${C.cyan}  ◂ opencode${C.reset}  ${C.dim}${respLine || "[no response]"}${respLine.length >= 80 ? "…" : ""}${C.reset}`);

      if (h.evalSummary) {
        console.log(`${C.gray}  ╰ ${h.evalSummary}${C.reset}`);
      }
    }

    console.log(`\n${bar}`);
    const total = this.history.length;
    const completed = this.history.some((h) => h.evalDone);
    const outcome = completed
      ? `${C.brightGreen}completed${C.reset}`
      : `${C.yellow}incomplete${C.reset}`;
    console.log(`${C.bold}  ${total} turn${total !== 1 ? "s" : ""}${C.reset}  ${C.gray}·${C.reset}  ${outcome}`);
    console.log(bar);
    console.log();
  }

  /** Prints a styled [oam] log line to the terminal */
  private log2(msg: string): void {
    console.log(`${C.bold}${C.brightCyan}[oam]${C.reset} ${msg}`);
  }

  /** Verbose error logger — dumps everything useful for debugging API failures */
  private logError(label: string, err: unknown): void {
    this.log2(`${C.red}✗ ${label}${C.reset}`);

    if (err instanceof Error) {
      console.log(`${C.red}  message:${C.reset}  ${err.message}`);
      // OpenAI SDK errors have status, code, type, headers etc.
      const e = err as unknown as Record<string, unknown>;
      if (e.status) console.log(`${C.red}  status:${C.reset}   ${e.status}`);
      if (e.code) console.log(`${C.red}  code:${C.reset}     ${e.code}`);
      if (e.type) console.log(`${C.red}  type:${C.reset}     ${e.type}`);
      if (e.param) console.log(`${C.red}  param:${C.reset}    ${e.param}`);
      // OpenRouter nests provider error details in error.error
      const nested = e.error as Record<string, unknown> | undefined;
      if (nested) {
        if (nested.message) console.log(`${C.red}  provider:${C.reset} ${nested.message}`);
        if (nested.code) console.log(`${C.red}  p.code:${C.reset}   ${nested.code}`);
        if (nested.metadata) console.log(`${C.red}  metadata:${C.reset} ${C.dim}${JSON.stringify(nested.metadata)}${C.reset}`);
      }
      if (err.stack) {
        const frames = err.stack.split("\n").slice(1, 4).map((l) => l.trim());
        console.log(`${C.dim}  ${frames.join("\n  ")}${C.reset}`);
      }
    } else {
      console.log(`${C.red}  raw:${C.reset} ${C.dim}${JSON.stringify(err, null, 2)}${C.reset}`);
    }
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
