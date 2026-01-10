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
  if (!auth.startsWith("Bearer "))
    return res.status(401).json({ error: "Missing API key" });

  if (auth.slice(7) !== MCP_API_KEY)
    return res.status(403).json({ error: "Invalid API key" });

  next();
}

/* ============================================================
 *  Salesforce auth
 * ============================================================ */
let cached = { token: null, expiresAt: 0 };

async function getAccessToken() {
  const now = Date.now();
  if (cached.token && cached.expiresAt > now + 30_000) return cached.token;

  const r = await fetch(
    `${SF_INSTANCE_URL}/services/oauth2/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: SF_CLIENT_ID,
        client_secret: SF_CLIENT_SECRET,
        refresh_token: SF_REFRESH_TOKEN,
      }),
    }
  );

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
  const progress = onProgress || (() => {});
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
  const records = (out.records || []).map(r => ({
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
    res.status(e.status || 500).json({ error: String(e.message || e) });
  }
});

/* ============================================================
 *  MCP SSE – sessions
 * ============================================================ */
const mcpSessions = new Map();

function writeSse(res, event, data) {
  if (res.writableEnded) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/* ============================================================
 *  MCP tools
 * ============================================================ */
const MCP_TOOLS = [
  {
    name: "search-accounts",
    description: "Search Salesforce accounts by name",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        limit: { type: "integer", default: 10 },
      },
      required: ["name"],
    },
  },
];

/* ============================================================
 *  MCP SSE endpoint
 * ============================================================ */
app.get("/sse", requireApiKey, (req, res) => {
  const sessionId = crypto.randomUUID();
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const ttlTimer = setTimeout(() => {
    res.end();
    mcpSessions.delete(sessionId);
  }, MCP_SESSION_TTL_MS);

  mcpSessions.set(sessionId, { res, ttlTimer });

  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
  writeSse(res, "endpoint", `${proto}://${req.get("host")}/message?sessionId=${sessionId}`);

  const ping = setInterval(() => writeSse(res, "ping", { ts: new Date().toISOString() }), 25_000);

  req.on("close", () => {
    clearInterval(ping);
    clearTimeout(ttlTimer);
    mcpSessions.delete(sessionId);
  });
});

/* ============================================================
 *  MCP JSON-RPC
 * ============================================================ */
app.post("/message", requireApiKey, async (req, res) => {
  const sessionId = req.query.sessionId;
  const session = mcpSessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "Unknown session" });

  res.status(202).end();

  const messages = Array.isArray(req.body) ? req.body : [req.body];

  for (const rpc of messages) {
    const { id, method, params } = rpc;
    let result;

    if (method === "initialize") {
      result = {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "sse-salesforce", version: "1.0.0" },
      };
    } else if (method === "tools/list") {
      result = { tools: MCP_TOOLS };
    } else if (method === "tools/call") {
      try {
        const progress = (msg) =>
          writeSse(session.res, "message", {
            jsonrpc: "2.0",
            method: "notifications/progress",
            params: { message: msg },
          });

        const data = await runSearchAccounts(params.arguments, { onProgress: progress });
        result = { structuredContent: data };
      } catch (e) {
        result = { isError: true, content: [{ type: "text", text: e.message }] };
      }
    }

    writeSse(session.res, "message", { jsonrpc: "2.0", id, result });
  }
});

/* ============================================================
 *  Health & diagnostics (sync + SSE compatible)
 * ============================================================ */
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/health/sync", (_req, res) => res.json({ ok: true, mode: "sync" }));
app.get("/routes", (_req, res) =>
  res.json({
    routes: [
      "POST /api/search-accounts (sync)",
      "GET /sse (MCP SSE)",
      "POST /message?sessionId=...",
      "GET /health",
    ],
  })
);

/* ============================================================
 *  Start
 * ============================================================ */
app.listen(port, "0.0.0.0", () => {
  console.log(`Server listening on http://0.0.0.0:${port}`);
});
