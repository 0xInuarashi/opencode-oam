/**
 * acp.ts — ACP (Agent Client Protocol) Transport Layer
 *
 * This file is the communication backbone between OAM and OpenCode.
 *
 * How it works:
 * - OAM acts as an ACP "Client" and OpenCode acts as an ACP "Agent".
 * - We spawn `opencode acp` as a child process.
 * - Communication happens over stdio (stdin/stdout) using JSON-RPC 2.0.
 * - Each JSON-RPC message is a single line of JSON, separated by newlines.
 *
 * There are 3 types of messages flowing through this pipe:
 *
 * 1. REQUESTS we send TO OpenCode (e.g. "initialize", "session/new", "session/prompt")
 *    - We send a JSON object with an `id`, `method`, and `params`.
 *    - We wait for a response with the same `id` containing `result` or `error`.
 *
 * 2. REQUESTS OpenCode sends TO US (e.g. "session/request_permission")
 *    - OpenCode asks us things like "can I run this shell command?"
 *    - We need to respond with the same `id`. This is how OAM auto-approves everything.
 *
 * 3. NOTIFICATIONS OpenCode sends TO US (e.g. "session/update")
 *    - One-way messages with no `id` — no response expected.
 *    - These carry streaming content: agent messages, tool calls, plans, etc.
 *    - We emit these as events so the Manager can react to them.
 */

import { spawn, type ChildProcess } from "child_process";
import { createInterface } from "readline";
import { EventEmitter } from "events";

/**
 * Represents a request we sent that we're still waiting on a response for.
 * The promise resolve/reject are stored so we can settle them when the response arrives.
 */
interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export class ACPClient extends EventEmitter {
  private proc: ChildProcess | null = null;

  debug = false;

  /** Auto-incrementing counter for JSON-RPC request IDs */
  private nextId = 0;

  /** Map of request ID → pending promise. When a response comes back, we look it up here. */
  private pending = new Map<number, PendingRequest>();

  /**
   * Map of method name → handler function.
   * These handle incoming REQUESTS from the agent (e.g. permission requests).
   * Not to be confused with notifications, which are handled via EventEmitter.
   */
  private handlers = new Map<
    string,
    (params: Record<string, unknown>) => Promise<unknown>
  >();

  /**
   * Spawns the OpenCode ACP subprocess and wires up all the I/O.
   * After calling this, the process is running and ready to receive JSON-RPC messages.
   */
  spawn(command: string, args: string[], cwd?: string): void {
    // Launch the child process with piped stdin/stdout/stderr
    this.proc = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
    });

    // Read stdout line-by-line — each line is one JSON-RPC message
    const rl = createInterface({ input: this.proc.stdout! });
    rl.on("line", (line) => this.onLine(line));

    // Forward stderr as events (OpenCode may log debug info here)
    this.proc.stderr?.on("data", (chunk: Buffer) => {
      this.emit("stderr", chunk.toString());
    });

    // When the process exits, reject all pending requests and notify listeners
    this.proc.on("exit", (code) => {
      for (const [, p] of this.pending) {
        p.reject(new Error(`Process exited with code ${code}`));
      }
      this.pending.clear();
      this.emit("exit", code);
    });

    this.proc.on("error", (err) => {
      this.emit("error", err);
    });
  }

  /**
   * Register a handler for incoming requests FROM the agent.
   * For example, when OpenCode wants permission to run a tool, it sends a
   * "session/request_permission" request and we need to respond.
   */
  onRequest(
    method: string,
    handler: (params: Record<string, unknown>) => Promise<unknown>
  ): void {
    this.handlers.set(method, handler);
  }

  /**
   * Send a JSON-RPC request TO the agent and wait for its response.
   * Returns a promise that resolves with the result or rejects with the error.
   */
  async request(method: string, params: Record<string, unknown>): Promise<any> {
    if (!this.proc?.stdin) throw new Error("Not connected");

    // Assign a unique ID so we can match the response to this request
    const id = this.nextId++;
    const msg = { jsonrpc: "2.0", id, method, params };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const raw = JSON.stringify(msg);
      if (this.debug) console.log(`\x1b[90m[acp:send] ${raw.slice(0, 200)}${raw.length > 200 ? "…" : ""}\x1b[0m`);
      this.proc!.stdin!.write(raw + "\n");
    });
  }

  /** Kill the child process and clean up */
  destroy(): void {
    this.proc?.kill();
    this.proc = null;
  }

  /**
   * Called for every line of stdout from the child process.
   * Parses the JSON and routes it to the right handler based on message type.
   */
  private onLine(line: string): void {
    if (this.debug) {
      const preview = line.slice(0, 200) + (line.length > 200 ? "…" : "");
      console.log(`\x1b[90m[acp:recv] ${preview}\x1b[0m`);
    }
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    if ("id" in msg && ("result" in msg || "error" in msg)) {
      // CASE 1: This is a RESPONSE to a request WE sent.
      // Look up the pending promise by ID and settle it.
      const p = this.pending.get(msg.id as number);
      if (p) {
        this.pending.delete(msg.id as number);
        if (msg.error) {
          p.reject(msg.error);
        } else {
          p.resolve(msg.result);
        }
      }
    } else if ("id" in msg && "method" in msg) {
      // CASE 2: This is a REQUEST from the agent TO US.
      // e.g. "session/request_permission" — the agent wants us to approve something.
      this.handleIncoming(msg);
    } else if ("method" in msg && !("id" in msg)) {
      // CASE 3: This is a NOTIFICATION from the agent (no response expected).
      // e.g. "session/update" with streaming content, tool calls, plans, etc.
      this.emit("notification", msg.method, msg.params);
    }
  }

  /**
   * Handles an incoming JSON-RPC request from the agent.
   * Looks up the registered handler for the method and sends back a response.
   */
  private async handleIncoming(msg: Record<string, unknown>): Promise<void> {
    const method = msg.method as string;
    const handler = this.handlers.get(method);
    const id = msg.id as number;

    if (handler) {
      try {
        const result = await handler(
          (msg.params as Record<string, unknown>) || {}
        );
        // Send success response back to the agent
        this.respond(id, result);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        // Send error response back to the agent
        this.respondError(id, -32603, message);
      }
    } else {
      // No handler registered for this method — tell the agent we don't support it
      this.respondError(id, -32601, `Method not found: ${method}`);
    }
  }

  /** Send a success response back to the agent for a request it sent us */
  private respond(id: number, result: unknown): void {
    if (!this.proc?.stdin) return;
    this.proc.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"
    );
  }

  /** Send an error response back to the agent for a request it sent us */
  private respondError(id: number, code: number, message: string): void {
    if (!this.proc?.stdin) return;
    this.proc.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n"
    );
  }
}
