import fetch from "node-fetch";
import express from "express";
import crypto from "crypto";

/* ============================================================
 *  Boot & app
 * ============================================================ */
console.log(
  "BOOT: server.js loaded, commit =",
  process.env.RENDER_GIT_COMMIT || "unknown"
);

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));

/* Optional: return JSON instead of HTML on bad JSON bodies */
app.use((err, _req, res, next) => {
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Invalid JSON", details: err.message });
  }
  next(err);
});

/* ============================================================
 *  Env
 * ============================================================ */
const {
  MCP_API_KEY,
  SF_CLIENT_ID,
  SF_CLIENT_SECRET,
  SF_REFRESH_TOKEN,
  SF_INSTANCE_URL,
  SF_API_VERSION = "v60.0",
  PORT,
  JOB_TTL_SECONDS = "300",
} = process.env;

const port = Number(PORT || 3000);
const MCP_SESSION_TTL_MS = 10 * 60 * 1000;

/* ============================================================
 *  Auth
 * ============================================================ */
function requireApiKey(req, res, next) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing API key" });
  }
  if (auth.slice(7) !== MCP_API_KEY) {
    return res.status(403).json({ error: "Invalid API key" });
  }
  next();
}

/* ============================================================
 *  Salesforce auth
 * ============================================================ */
let cached = { token: null, expiresAt: 0 };

async function getAccessToken() {
  const now = Date.now();
  if (cached.token && cached.expiresAt > now + 30_000) return cached.token;

  const r = await fetch(`${SF_INSTANCE_URL}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: SF_CLIENT_ID,
      client_secret: SF_CLIENT_SECRET,
      refresh_token: SF_REFRESH_TOKEN,
    }),
  });

  if (!r.ok) throw new Error(await r.text());
  const json = await r.json();

  cached = {
    token: json.access_token,
    expiresAt: now + 55 * 60 * 1000,
  };
  return cached.token;
}

async function soql(query) {
  const token = await getAccessToken();
  const r = await fetch(
    `${SF_INSTANCE_URL}/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(query)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

/* ============================================================
 *  Business logic (shared)
 * ============================================================ */
async function runSearchAccounts({ name, limit }, { onProgress } = {}) {
  const progress = typeof onProgress === "function" ? onProgress : () => {};
  const trimmed = String(name || "").trim();
  const lim = Math.max(1, Math.min(20, Number(limit) || 10));

  if (!trimmed) {
    const e = new Error("Missing 'name'");
    e.status = 400;
    throw e;
  }

  progress("Preparing SOQL...");
  const safe = trimmed.replace(/'/g, "\\'");
  const q = `
    SELECT Id, Name, Website, Industry, Type, BillingCity,
           NumberOfEmployees, AnnualRevenue, Owner.Name,
           LastActivityDate, LastModifiedDate
    FROM Account
    WHERE Name LIKE '%${safe}%'
    ORDER BY LastActivityDate DESC, LastModifiedDate DESC
    LIMIT ${lim}
  `;

  progress("Querying Salesforce...");
  const out = await soql(q);

  progress("Mapping results...");
  const records = (out.records || []).map((r) => ({
    id: r.Id,
    name: r.Name,
    website: r.Website ?? null,
    type: r.Type ?? null,
    industry: r.Industry ?? null,
    city: r.BillingCity ?? null,
    employees: r.NumberOfEmployees ?? null,
    revenue: r.AnnualRevenue ?? null,
    owner: r.Owner?.Name ?? null,
    lastActivityDate: r.LastActivityDate ?? null,
    lastModifiedDate: r.LastModifiedDate ?? null,
  }));

  progress(`Done (${records.length})`);
  return { records };
}

/* ============================================================
 *  REST – synchronous (GPT Actions)
 * ============================================================ */
app.post("/api/search-accounts", requireApiKey, async (req, res) => {
  try {
    const result = await runSearchAccounts(req.body || {});
    res.json(result);
  } catch (e) {
    res.status(e?.status || 500).json({ error: String(e?.message || e) });
  }
});

/* Optional REST discovery endpoint (handy for debugging) */
app.get("/tools", requireApiKey, (_req, res) => {
  res.json({
    tools: [
      {
        name: "search-accounts",
        description: "Search Salesforce accounts by name",
        input_schema: {
          type: "object",
          properties: {
            name: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
          },
          required: ["name"],
          additionalProperties: false,
        },
      },
    ],
  });
});

/* ============================================================
 *  SSE Job/Event bus (optional legacy job mode)
 *  (kept only if you still use /sse?job_id=... elsewhere)
 * ============================================================ */
const jobs = new Map();

function writeJobEvent(res, eventName, payloadObj) {
  if (res.writableEnded) return;
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payloadObj)}\n\n`);
}

function createJob() {
  const jobId = crypto.randomUUID();
  const job = {
    createdAt: Date.now(),
    events: [],
    done: false,
    subscribers: new Set(),
    ttlTimer: null,
  };

  const ttlMs = Math.max(30, Number(JOB_TTL_SECONDS) || 300) * 1000;
  job.ttlTimer = setTimeout(() => {
    for (const res of job.subscribers) {
      try {
        res.end();
      } catch {}
    }
    jobs.delete(jobId);
  }, ttlMs);

  jobs.set(jobId, job);
  return jobId;
}

function pushEvent(jobId, event, data) {
  const job = jobs.get(jobId);
  if (!job) return;

  const payload = { event, data, ts: new Date().toISOString() };
  job.events.push(payload);

  for (const res of job.subscribers) {
    writeJobEvent(res, event, payload);
  }
}

function finishJob(jobId, ok, data) {
  const job = jobs.get(jobId);
  if (!job) return;

  pushEvent(jobId, ok ? "result" : "error", data);
  job.done = true;

  // Clear TTL timer once finished (avoid lingering timers)
  if (job.ttlTimer) {
    clearTimeout(job.ttlTimer);
    job.ttlTimer = null;
  }

  setTimeout(() => {
    for (const res of job.subscribers) {
      try {
        res.end();
      } catch {}
    }
    job.subscribers.clear();
  }, 500);
}

/* Optional async job start (returns job_id) */
app.post("/tools/search-accounts", requireApiKey, async (req, res) => {
  const jobId = createJob();
  res.status(202).json({ job_id: jobId });

  (async () => {
    try {
      pushEvent(jobId, "progress", { message: "Starting..." });
      const result = await runSearchAccounts(req.body || {}, {
        onProgress: (message) => pushEvent(jobId, "progress", { message }),
      });
      finishJob(jobId, true, result);
    } catch (e) {
      finishJob(jobId, false, {
        status: e?.status || 500,
        error: String(e?.message || e),
      });
    }
  })();
});

/* ============================================================
 *  MCP SSE – sessions
 * ============================================================ */
const mcpSessions = new Map();

function writeSse(res, event, data) {
  if (res.writableEnded) return;
  res.write(`event: ${event}\n`);
  // If data is a string, keep it; otherwise JSON
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  res.write(`data: ${payload}\n\n`);
}

/* MCP tools */
const MCP_TOOLS = [
  {
    name: "search-accounts",
    description: "Search Salesforce accounts by name",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Account name or fragment" },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
];

/* ============================================================
 *  /sse
 *   - If job_id is present -> legacy job SSE stream
 *   - If job_id is absent  -> MCP SSE session stream
 * ============================================================ */
app.get("/sse", requireApiKey, (req, res) => {
  const jobId = String(req.query.job_id || "").trim();

  /* ----------------------------
   * Legacy job stream
   * ---------------------------- */
  if (jobId) {
    const job = jobs.get(jobId);
    if (!job) return res.status(404).json({ error: "Unknown job_id" });

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    writeJobEvent(res, "ready", {
      event: "ready",
      data: { job_id: jobId },
      ts: new Date().toISOString(),
    });

    for (const ev of job.events) {
      writeJobEvent(res, ev.event, ev);
    }

    job.subscribers.add(res);

    const heartbeat = setInterval(() => {
      try {
        res.write(
          `event: ping\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`
        );
      } catch {}
    }, 25_000);

    req.on("close", () => {
      clearInterval(heartbeat);
      job.subscribers.delete(res);
    });

    if (job.done) {
      setTimeout(() => {
        try {
          res.end();
        } catch {}
        job.subscribers.delete(res);
      }, 500);
    }
    return;
  }

  /* ----------------------------
   * MCP SSE session stream
   * ---------------------------- */
  const sessionId = crypto.randomUUID();

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const ttlTimer = setTimeout(() => {
    try {
      res.end();
    } catch {}
    mcpSessions.delete(sessionId);
    console.log("MCP session TTL expired", { sessionId });
  }, MCP_SESSION_TTL_MS);

  mcpSessions.set(sessionId, { res, ttlTimer });

  const proto = (req.headers["x-forwarded-proto"] || "https")
    .toString()
    .split(",")[0]
    .trim();
  const base = `${proto}://${req.get("host")}`;
  writeSse(res, "endpoint", `${base}/message?sessionId=${sessionId}`);

  const ping = setInterval(() => writeSse(res, "ping", { ts: new Date().toISOString() }), 25_000);

  req.on("close", () => {
    clearInterval(ping);
    clearTimeout(ttlTimer);
    mcpSessions.delete(sessionId);
  });
});

/* ============================================================
 *  MCP JSON-RPC message endpoint
 * ============================================================ */
function jsonRpcError(code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return err;
}

app.post("/message", requireApiKey, async (req, res) => {
  const sessionId = String(req.query.sessionId || "").trim();
  const session = mcpSessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "Unknown sessionId" });

  // Sliding TTL: refresh on activity
  if (session.ttlTimer) clearTimeout(session.ttlTimer);
  session.ttlTimer = setTimeout(() => {
    const s = mcpSessions.get(sessionId);
    if (!s) return;
    try { s.res.end(); } catch {}
    mcpSessions.delete(sessionId);
    console.log("MCP session TTL expired", { sessionId });
  }, MCP_SESSION_TTL_MS);

  const payload = req.body;
  if (!payload) return res.status(400).json({ error: "Missing JSON-RPC payload" });

  res.status(202).end();

  const messages = Array.isArray(payload) ? payload : [payload];

  for (const rpc of messages) {
    const id = rpc?.id;
    const method = rpc?.method;
    const params = rpc?.params;

    // Notifications (no id) -> ignore replies
    const isNotification = id === undefined || id === null;

    try {
      if (!rpc || rpc.jsonrpc !== "2.0" || !method) {
        if (!isNotification) {
          writeSse(session.res, "message", {
            jsonrpc: "2.0",
            id,
            error: jsonRpcError(-32600, "Invalid Request"),
          });
        }
        continue;
      }

      /* initialize */
      if (method === "initialize") {
        if (!isNotification) {
          writeSse(session.res, "message", {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "sse-salesforce", version: "1.0.0" },
              instructions: "Use tool search-accounts to find Salesforce accounts.",
            },
          });
        }
        continue;
      }

      /* tools/list */
      if (method === "tools/list") {
        if (!isNotification) {
          writeSse(session.res, "message", {
            jsonrpc: "2.0",
            id,
            result: { tools: MCP_TOOLS },
          });
        }
        continue;
      }

      /* tools/call */
      if (method === "tools/call") {
        const toolName = params?.name;
        const args = params?.arguments ?? {};
        const progressToken = params?._meta?.progressToken;

        if (toolName !== "search-accounts") {
          if (!isNotification) {
            writeSse(session.res, "message", {
              jsonrpc: "2.0",
              id,
              result: {
                isError: true,
                content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
              },
            });
          }
          continue;
        }

        let step = 0;
        const total = 4;

        const progress = (message) => {
          // If token exists, send proper progress notifications
          if (progressToken) {
            step += 1;
            writeSse(session.res, "message", {
              jsonrpc: "2.0",
              method: "notifications/progress",
              params: {
                progressToken,
                progress: step,
                total,
                message,
              },
            });
          } else {
            // Otherwise, still emit a lightweight notification
            writeSse(session.res, "message", {
              jsonrpc: "2.0",
              method: "notifications/progress",
              params: { message },
            });
          }
        };

        try {
          const data = await runSearchAccounts(args, { onProgress: progress });

          if (!isNotification) {
            writeSse(session.res, "message", {
              jsonrpc: "2.0",
              id,
              result: {
                content: [
                  {
                    type: "text",
                    text: `Recherche terminée : ${data.records.length} compte(s).`,
                  },
                ],
                structuredContent: data,
              },
            });
          }
        } catch (e) {
          if (!isNotification) {
            writeSse(session.res, "message", {
              jsonrpc: "2.0",
              id,
              result: {
                isError: true,
                content: [{ type: "text", text: String(e?.message || e) }],
              },
            });
          }
        }
        continue;
      }

      /* ping */
      if (method === "ping") {
        if (!isNotification) {
          writeSse(session.res, "message", { jsonrpc: "2.0", id, result: {} });
        }
        continue;
      }

      /* default: method not found */
      if (!isNotification) {
        writeSse(session.res, "message", {
          jsonrpc: "2.0",
          id,
          error: jsonRpcError(-32601, `Method not found: ${method}`),
        });
      }
    } catch (err) {
      if (isNotification) continue;
      writeSse(session.res, "message", {
        jsonrpc: "2.0",
        id,
        error: jsonRpcError(-32603, "Internal error", String(err?.message || err)),
      });
    }
  }
});

/* ============================================================
 *  Health & diagnostics
 * ============================================================ */
app.get("/", (_req, res) => res.type("text").send("ok"));
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/health/sync", (_req, res) => res.json({ ok: true, mode: "sync" }));
app.get("/routes", (_req, res) =>
  res.json({
    routes: [
      "GET / (ok)",
      "GET /health",
      "POST /api/search-accounts (sync)",
      "GET /tools (auth)",
      "POST /tools/search-accounts (auth) -> 202 {job_id} (optional)",
      "GET /sse (auth) -> MCP SSE session",
      "POST /message?sessionId=... (auth) -> MCP JSON-RPC",
      "GET /sse?job_id=... (auth) -> legacy job SSE stream (optional)",
    ],
  })
);

/* ============================================================
 *  Start
 * ============================================================ */
app.listen(port, "0.0.0.0", () => {
  console.log(`Server listening on http://0.0.0.0:${port}`);
});
