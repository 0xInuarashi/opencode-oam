/**
 * server.ts — OAM Web UI
 *
 * Exposes OAM as a web interface with real-time streaming via SSE.
 * Trigger jobs, watch progress, and see results — all from a browser.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { Manager, type ManagerOptions } from "./manager.js";

const PORT = parseInt(process.env.OAM_PORT || "3399", 10);

interface ActiveJob {
  id: string;
  manager: Manager;
  task: string;
  startedAt: number;
  status: "running" | "done" | "error";
  events: Array<Record<string, unknown>>;
  clients: Set<ServerResponse>;
}

const jobs = new Map<string, ActiveJob>();
let jobCounter = 0;

function sendSSE(res: ServerResponse, data: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcastJob(job: ActiveJob, data: Record<string, unknown>): void {
  job.events.push(data);
  for (const client of job.clients) {
    sendSSE(client, data);
  }
}

function parseBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function cors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(res: ServerResponse, status: number, data: unknown): void {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function handleAPI(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // POST /api/jobs — start a new job
  if (path === "/api/jobs" && req.method === "POST") {
    const body = JSON.parse(await parseBody(req));
    const task = body.task as string;
    if (!task) {
      json(res, 400, { error: "task is required" });
      return;
    }

    const id = `job_${++jobCounter}_${Date.now()}`;
    const opts: ManagerOptions = {
      task,
      cwd: body.cwd || process.cwd(),
      model: body.model,
      agentModel: body.agentModel,
      reasoning: body.reasoning,
      maxTurns: body.maxTurns ? parseInt(body.maxTurns, 10) : undefined,
      debug: body.debug ?? false,
    };

    const manager = new Manager(opts);
    const job: ActiveJob = {
      id,
      manager,
      task,
      startedAt: Date.now(),
      status: "running",
      events: [],
      clients: new Set(),
    };
    jobs.set(id, job);

    // Forward all web events from the manager to SSE clients
    manager.on("web", (data: Record<string, unknown>) => {
      broadcastJob(job, data);
    });

    // Run the job in the background
    manager.run()
      .then(() => {
        job.status = "done";
        broadcastJob(job, { type: "finished", status: "done" });
      })
      .catch((err: Error) => {
        job.status = "error";
        broadcastJob(job, { type: "finished", status: "error", error: err.message });
      });

    json(res, 201, { id, task, status: "running" });
    return;
  }

  // GET /api/jobs — list all jobs
  if (path === "/api/jobs" && req.method === "GET") {
    const list = Array.from(jobs.values()).map(j => ({
      id: j.id,
      task: j.task,
      status: j.status,
      startedAt: j.startedAt,
      eventCount: j.events.length,
    }));
    json(res, 200, list);
    return;
  }

  // GET /api/jobs/:id/stream — SSE stream for a job
  const streamMatch = path.match(/^\/api\/jobs\/([^/]+)\/stream$/);
  if (streamMatch && req.method === "GET") {
    const job = jobs.get(streamMatch[1]);
    if (!job) {
      json(res, 404, { error: "job not found" });
      return;
    }

    cors(res);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // Replay all past events
    for (const event of job.events) {
      sendSSE(res, event);
    }

    // Subscribe to new events
    job.clients.add(res);
    req.on("close", () => {
      job.clients.delete(res);
    });
    return;
  }

  json(res, 404, { error: "not found" });
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OAM — OpenCode Agent Manager</title>
<style>
  :root {
    --bg: #0d1117; --surface: #161b22; --border: #30363d;
    --text: #c9d1d9; --text-dim: #8b949e; --text-bright: #f0f6fc;
    --cyan: #58a6ff; --green: #3fb950; --yellow: #d29922;
    --red: #f85149; --magenta: #bc8cff; --blue: #388bfd;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'JetBrains Mono', monospace;
    background: var(--bg); color: var(--text);
    min-height: 100vh;
  }
  .header {
    border-bottom: 1px solid var(--border);
    padding: 16px 24px;
    display: flex; align-items: center; gap: 12px;
  }
  .header h1 { font-size: 16px; color: var(--cyan); font-weight: 600; }
  .header span { color: var(--text-dim); font-size: 13px; }
  .container { max-width: 960px; margin: 0 auto; padding: 24px; }

  /* New job form */
  .form-card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 8px; padding: 20px; margin-bottom: 24px;
  }
  .form-card h2 { font-size: 14px; color: var(--text-bright); margin-bottom: 16px; }
  .form-row { display: flex; gap: 12px; margin-bottom: 12px; }
  .form-row:last-child { margin-bottom: 0; }
  input, select {
    background: var(--bg); border: 1px solid var(--border);
    color: var(--text); padding: 8px 12px; border-radius: 6px;
    font-family: inherit; font-size: 13px; outline: none;
    transition: border-color 0.2s;
  }
  input:focus, select:focus { border-color: var(--cyan); }
  input.task-input { flex: 1; }
  .btn {
    background: var(--cyan); color: var(--bg); border: none;
    padding: 8px 20px; border-radius: 6px; font-family: inherit;
    font-size: 13px; font-weight: 600; cursor: pointer;
    transition: opacity 0.2s;
  }
  .btn:hover { opacity: 0.85; }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-sm { padding: 4px 12px; font-size: 12px; }

  /* Options row */
  .opts { display: flex; gap: 8px; flex-wrap: wrap; }
  .opts input, .opts select { width: 180px; }
  .opts label { font-size: 11px; color: var(--text-dim); display: block; margin-bottom: 4px; }

  /* Job list */
  .jobs-list { display: flex; flex-direction: column; gap: 12px; }
  .job-card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 8px; overflow: hidden; cursor: pointer;
    transition: border-color 0.2s;
  }
  .job-card:hover { border-color: var(--cyan); }
  .job-card.active { border-color: var(--cyan); }
  .job-head {
    padding: 12px 16px; display: flex; align-items: center;
    justify-content: space-between; gap: 12px;
  }
  .job-task { color: var(--text-bright); font-size: 13px; flex: 1;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .job-badge {
    font-size: 11px; padding: 2px 8px; border-radius: 10px;
    font-weight: 600; flex-shrink: 0;
  }
  .badge-running { background: rgba(210,153,34,0.15); color: var(--yellow); }
  .badge-done { background: rgba(63,185,80,0.15); color: var(--green); }
  .badge-error { background: rgba(248,81,73,0.15); color: var(--red); }

  /* Stream output */
  .stream-panel {
    background: var(--bg); border-top: 1px solid var(--border);
    max-height: 0; overflow: hidden; transition: max-height 0.3s ease;
  }
  .job-card.active .stream-panel { max-height: 70vh; }
  .stream-output {
    padding: 16px; font-size: 12px; line-height: 1.6;
    max-height: 65vh; overflow-y: auto; white-space: pre-wrap;
    word-break: break-word;
  }

  /* Event types */
  .ev-log { color: var(--text-dim); }
  .ev-agent { color: var(--text); }
  .ev-thought { color: var(--magenta); opacity: 0.7; }
  .ev-tool { color: var(--yellow); }
  .ev-tool-done { color: var(--green); }
  .ev-tool-fail { color: var(--red); }
  .ev-turn { color: var(--cyan); font-weight: 600; display: block;
    margin-top: 12px; padding-bottom: 4px;
    border-bottom: 1px solid var(--border); }
  .ev-status { color: var(--blue); font-weight: 600; }
  .ev-done { color: var(--green); font-weight: 600; font-size: 13px;
    display: block; margin-top: 8px; }
  .ev-error { color: var(--red); }
  .ev-expand { color: var(--text-dim); }
  .ev-plan { color: var(--blue); }
  .ev-approved { color: var(--green); opacity: 0.7; font-size: 11px; }

  .progress-bar {
    height: 3px; background: var(--border); border-radius: 2px;
    overflow: hidden; margin-top: 4px;
  }
  .progress-fill {
    height: 100%; background: var(--cyan); transition: width 0.3s;
  }

  .empty { text-align: center; color: var(--text-dim); padding: 48px;
    font-size: 13px; }
</style>
</head>
<body>
<div class="header">
  <h1>◈ oam</h1>
  <span>OpenCode Agent Manager</span>
</div>
<div class="container">
  <div class="form-card">
    <h2>New Job</h2>
    <div class="form-row">
      <input class="task-input" id="task" placeholder="describe the task..." autofocus>
      <button class="btn" id="run-btn" onclick="startJob()">Run</button>
    </div>
    <details style="margin-top:12px">
      <summary style="font-size:12px;color:var(--text-dim);cursor:pointer">Options</summary>
      <div class="opts" style="margin-top:12px">
        <div><label>Working Directory</label><input id="opt-cwd" placeholder="(current dir)"></div>
        <div><label>Eval Model</label><input id="opt-model" placeholder="openai/gpt-4o-mini"></div>
        <div><label>Agent Model</label><input id="opt-agent" placeholder="e.g. openai/gpt-5.4"></div>
        <div><label>Reasoning</label>
          <select id="opt-reasoning">
            <option value="">default (high)</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
            <option value="xhigh">xhigh</option>
          </select>
        </div>
        <div><label>Max Turns</label><input id="opt-turns" type="number" placeholder="50" style="width:80px"></div>
      </div>
    </details>
  </div>

  <div id="jobs" class="jobs-list"></div>
  <div class="empty" id="empty-msg">No jobs yet. Enter a task above to start.</div>
</div>

<script>
const jobsEl = document.getElementById('jobs');
const emptyEl = document.getElementById('empty-msg');
const taskEl = document.getElementById('task');
const activeStreams = {};
let activeJobId = null;

taskEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); startJob(); }
});

async function startJob() {
  const task = taskEl.value.trim();
  if (!task) return;
  const btn = document.getElementById('run-btn');
  btn.disabled = true;

  const body = { task };
  const cwd = document.getElementById('opt-cwd').value.trim();
  const model = document.getElementById('opt-model').value.trim();
  const agent = document.getElementById('opt-agent').value.trim();
  const reasoning = document.getElementById('opt-reasoning').value;
  const turns = document.getElementById('opt-turns').value;
  if (cwd) body.cwd = cwd;
  if (model) body.model = model;
  if (agent) body.agentModel = agent;
  if (reasoning) body.reasoning = reasoning;
  if (turns) body.maxTurns = turns;

  try {
    const res = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    taskEl.value = '';
    addJobCard(data.id, data.task, 'running');
    toggleJob(data.id);
  } catch (err) {
    alert('Failed to start job: ' + err.message);
  }
  btn.disabled = false;
}

function addJobCard(id, task, status) {
  emptyEl.style.display = 'none';
  const card = document.createElement('div');
  card.className = 'job-card';
  card.id = 'card-' + id;
  card.innerHTML = \`
    <div class="job-head" onclick="toggleJob('\${id}')">
      <span class="job-task">\${esc(task)}</span>
      <span class="job-badge badge-\${status}" id="badge-\${id}">\${status}</span>
    </div>
    <div class="progress-bar"><div class="progress-fill" id="prog-\${id}" style="width:0%"></div></div>
    <div class="stream-panel">
      <div class="stream-output" id="stream-\${id}"></div>
    </div>
  \`;
  jobsEl.prepend(card);
}

function toggleJob(id) {
  const card = document.getElementById('card-' + id);
  if (!card) return;

  if (activeJobId && activeJobId !== id) {
    const prev = document.getElementById('card-' + activeJobId);
    if (prev) prev.classList.remove('active');
  }

  card.classList.toggle('active');
  activeJobId = card.classList.contains('active') ? id : null;

  if (card.classList.contains('active') && !activeStreams[id]) {
    connectSSE(id);
  }
}

function connectSSE(id) {
  const src = new EventSource('/api/jobs/' + id + '/stream');
  activeStreams[id] = src;
  const el = document.getElementById('stream-' + id);

  src.onmessage = (e) => {
    const d = JSON.parse(e.data);
    renderEvent(id, el, d);
  };

  src.onerror = () => {
    src.close();
    delete activeStreams[id];
  };
}

function renderEvent(id, el, d) {
  const s = document.createElement('span');

  switch (d.type) {
    case 'turn':
      s.className = 'ev-turn';
      s.textContent = '── turn ' + d.turn + '/' + d.maxTurns + ' ';
      const pct = Math.round((d.turn / d.maxTurns) * 100);
      const prog = document.getElementById('prog-' + id);
      if (prog) prog.style.width = pct + '%';
      break;
    case 'agent_chunk':
      s.className = 'ev-agent';
      s.textContent = d.text;
      break;
    case 'thought_chunk':
      s.className = 'ev-thought';
      s.textContent = d.text;
      break;
    case 'expand_chunk':
      s.className = 'ev-expand';
      s.textContent = d.text;
      break;
    case 'tool_call':
      s.className = 'ev-tool';
      s.textContent = '\\n⚙ ' + d.title + ' [' + d.status + ']\\n';
      break;
    case 'tool_done':
      s.className = d.status === 'completed' ? 'ev-tool-done' : 'ev-tool-fail';
      s.textContent = (d.status === 'completed' ? '✓ ' : '✗ ') + d.id + '\\n';
      break;
    case 'approved':
      s.className = 'ev-approved';
      s.textContent = '✓ approved: ' + d.title + ' → ' + d.option + '\\n';
      break;
    case 'plan':
      s.className = 'ev-plan';
      const lines = d.entries.map(e =>
        (e.status === 'completed' ? '✓' : e.status === 'running' ? '›' : '○') + ' ' + e.content
      ).join('\\n');
      s.textContent = '\\n◈ plan\\n' + lines + '\\n';
      break;
    case 'status':
      s.className = 'ev-status';
      s.textContent = '\\n◈ ' + d.phase + '...\\n';
      break;
    case 'log':
      s.className = 'ev-log';
      s.textContent = '[oam] ' + d.text + '\\n';
      break;
    case 'done':
      s.className = 'ev-done';
      s.textContent = '\\n✓ Job complete! ' + (d.summary || '') + ' (' + d.turns + ' turns)\\n';
      updateBadge(id, 'done');
      break;
    case 'finished':
      if (d.status === 'error') {
        s.className = 'ev-error';
        s.textContent = '\\n✗ Error: ' + (d.error || 'unknown') + '\\n';
        updateBadge(id, 'error');
      } else {
        updateBadge(id, 'done');
      }
      break;
    default:
      s.className = 'ev-log';
      s.textContent = JSON.stringify(d) + '\\n';
  }

  el.appendChild(s);
  el.scrollTop = el.scrollHeight;
}

function updateBadge(id, status) {
  const badge = document.getElementById('badge-' + id);
  if (badge) {
    badge.className = 'job-badge badge-' + status;
    badge.textContent = status;
  }
  const prog = document.getElementById('prog-' + id);
  if (prog) prog.style.width = '100%';
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// Load existing jobs on page load
fetch('/api/jobs').then(r => r.json()).then(list => {
  if (list.length) emptyEl.style.display = 'none';
  for (const j of list.reverse()) {
    addJobCard(j.id, j.task, j.status);
  }
}).catch(() => {});
</script>
</body>
</html>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  if (url.pathname.startsWith("/api/")) {
    try {
      await handleAPI(req, res);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      json(res, 500, { error: message });
    }
    return;
  }

  // Serve the frontend for everything else
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(HTML);
});

export function startServer(): void {
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`\n\x1b[1m\x1b[96m  ◈ oam web\x1b[0m  \x1b[90m·\x1b[0m  http://0.0.0.0:${PORT}`);
    console.log(`\x1b[90m  Open in your browser to trigger and watch jobs\x1b[0m\n`);
  });
}
