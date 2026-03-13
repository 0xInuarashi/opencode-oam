/**
 * daemon.ts — OAM Daemon Management
 *
 * Handles starting OAM's web server as a background process,
 * checking its status, and stopping it. Uses a PID file for tracking
 * and a log file for capturing output.
 *
 * PID file: ~/.oam/oam.pid
 * Log file: ~/.oam/oam.log
 */

import { spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { openSync } from "fs";

const OAM_DIR = join(homedir(), ".oam");
const PID_FILE = join(OAM_DIR, "oam.pid");
const LOG_FILE = join(OAM_DIR, "oam.log");

function ensureDir(): void {
  if (!existsSync(OAM_DIR)) mkdirSync(OAM_DIR, { recursive: true });
}

function readPid(): number | null {
  try {
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    if (isNaN(pid)) return null;
    // Check if the process is actually running
    try {
      process.kill(pid, 0); // signal 0 = just check existence
      return pid;
    } catch {
      // Process not running — stale PID file
      unlinkSync(PID_FILE);
      return null;
    }
  } catch {
    return null;
  }
}

function writePid(pid: number): void {
  ensureDir();
  writeFileSync(PID_FILE, String(pid) + "\n");
}

function removePid(): void {
  try { unlinkSync(PID_FILE); } catch { /* ignore */ }
}

const PORT = process.env.OAM_PORT || "3399";
const C = {
  r: "\x1b[0m", b: "\x1b[1m", cy: "\x1b[96m", g: "\x1b[90m",
  gr: "\x1b[32m", rd: "\x1b[31m", y: "\x1b[33m",
};

export function daemonStart(scriptPath: string): void {
  const existing = readPid();
  if (existing) {
    console.log(`${C.y}⚠${C.r}  oam is already running ${C.g}(pid: ${existing})${C.r}`);
    console.log(`${C.g}   http://0.0.0.0:${PORT}${C.r}`);
    return;
  }

  ensureDir();
  const logFd = openSync(LOG_FILE, "a");

  // Figure out how we were invoked so the daemon uses the same runtime.
  // If running via tsx (dev mode), the script is .ts — use tsx.
  // If running via compiled dist, the script is .js — use node directly.
  const isTsx = scriptPath.endsWith(".ts");
  let cmd: string;
  let spawnArgs: string[];

  if (isTsx) {
    // Use npx tsx from the project directory
    cmd = process.execPath; // node
    const tsxBin = join(dirname(scriptPath), "..", "node_modules", ".bin", "tsx");
    if (existsSync(tsxBin)) {
      cmd = tsxBin;
      spawnArgs = [scriptPath, "--serve"];
    } else {
      // Fallback: use node with tsx loader via --import
      spawnArgs = ["--import", "tsx", scriptPath, "--serve"];
    }
  } else {
    cmd = process.execPath;
    spawnArgs = [scriptPath, "--serve"];
  }

  const child = spawn(cmd, spawnArgs, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env },
  });

  child.unref();

  if (child.pid) {
    writePid(child.pid);
    console.log(`${C.b}${C.cy}◈ oam${C.r}  daemon started`);
    console.log(`${C.g}  pid${C.r}   ${child.pid}`);
    console.log(`${C.g}  url${C.r}   http://0.0.0.0:${PORT}`);
    console.log(`${C.g}  log${C.r}   ${LOG_FILE}`);
    console.log(`${C.g}  stop${C.r}  oam --stop`);
  } else {
    console.error(`${C.rd}✗${C.r} failed to start daemon`);
    process.exit(1);
  }
}

export function daemonStop(): void {
  const pid = readPid();
  if (!pid) {
    console.log(`${C.g}no oam daemon is running${C.r}`);
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
    removePid();
    console.log(`${C.b}${C.cy}◈ oam${C.r}  daemon stopped ${C.g}(pid: ${pid})${C.r}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${C.rd}✗${C.r} failed to stop daemon: ${msg}`);
    removePid();
  }
}

export function daemonStatus(): void {
  const pid = readPid();
  if (pid) {
    console.log(`${C.b}${C.gr}●${C.r}  oam daemon is ${C.b}running${C.r}`);
    console.log(`${C.g}  pid${C.r}   ${pid}`);
    console.log(`${C.g}  url${C.r}   http://0.0.0.0:${PORT}`);
    console.log(`${C.g}  log${C.r}   ${LOG_FILE}`);
  } else {
    console.log(`${C.g}○  oam daemon is not running${C.r}`);
  }
}

export function daemonLogs(follow: boolean): void {
  if (!existsSync(LOG_FILE)) {
    console.log(`${C.g}no log file yet${C.r} (${LOG_FILE})`);
    return;
  }

  if (follow) {
    const tail = spawn("tail", ["-f", LOG_FILE], { stdio: "inherit" });
    tail.on("error", () => {
      // fallback: just cat the file
      console.log(readFileSync(LOG_FILE, "utf-8"));
    });
  } else {
    const content = readFileSync(LOG_FILE, "utf-8");
    const lines = content.split("\n");
    // Show last 50 lines
    const tail = lines.slice(-50).join("\n");
    console.log(tail);
  }
}
