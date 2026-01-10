import fetch from "node-fetch";
import express from "express";
import crypto from "crypto";

console.log(
	"BOOT: server.js loaded, commit =",
	process.env.RENDER_GIT_COMMIT || "unknown"
);

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));

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
const MCP_SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** -------------------------
 *  Auth
 *  ------------------------- */
function requireApiKey(req, res, next) {
	const auth = req.headers.authorization || "";
	if (!auth.startsWith("Bearer "))
		return res.status(401).json({ error: "Missing API key" });
	const key = auth.slice("Bearer ".length);
	if (key !== MCP_API_KEY)
		return res.status(403).json({ error: "Invalid API key" });
	next();
}

/** -------------------------
 *  Salesforce token cache
 *  ------------------------- */
let cached = { token: null, expiresAt: 0 };

async function getAccessToken() {
	const now = Date.now();
	if (cached.token && cached.expiresAt > now + 30_000) return cached.token;

	const tokenUrl = `${SF_INSTANCE_URL}/services/oauth2/token`;
	const body = new URLSearchParams({
		grant_type: "refresh_token",
		client_id: SF_CLIENT_ID,
		client_secret: SF_CLIENT_SECRET,
		refresh_token: SF_REFRESH_TOKEN,
	});

	const r = await fetch(tokenUrl, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body,
	});

	if (!r.ok) {
		const txt = await r.text();
		throw new Error(`Token refresh failed: ${r.status} ${txt}`);
	}
	const json = await r.json();
	cached.token = json.access_token;
	cached.expiresAt = now + 55 * 60 * 1000; // cache ~55 min
	return cached.token;
}

async function soql(query) {
	const token = await getAccessToken();
	const url = `${SF_INSTANCE_URL}/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(
		query
	)}`;
	const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
	if (!r.ok) throw new Error(await r.text());
	return r.json();
}

/** -------------------------
 *  SSE Job/Event bus (in-memory)
 *  ------------------------- */
const jobs = new Map();
// jobId -> { createdAt, events: Array<{event,data,ts}>, done:boolean, subscribers:Set<res>, ttlTimer }

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
		// Close all subscribers then cleanup
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
	pushEvent(jobId, ok ? "result" : "error", data);

	const job = jobs.get(jobId);
	if (!job) return;
	job.done = true;

	// Close streams shortly after final event
	setTimeout(() => {
		for (const res of job.subscribers) {
			try {
				res.end();
			} catch {}
		}
		job.subscribers.clear();
	}, 500);
}

/** -------------------------
 *  Tool business logic (pure function)
 *  ------------------------- */
async function runSearchAccounts({ name, limit }, { onProgress } = {}) {
	const progress = typeof onProgress === "function" ? onProgress : () => {};

	const trimmed = String(name || "").trim();
	const lim = Math.max(1, Math.min(20, Number(limit) || 10));

	if (!trimmed) {
		const err = new Error("Missing 'name' (string)");
		err.status = 400;
		throw err;
	}

	progress("Préparation de la requête Salesforce...");
	const safe = trimmed.replace(/'/g, "\\'");

	// Ta requête enrichie (j’ai retiré ORDER BY ... NULLS LAST si jamais ça pose souci selon l’API)
	const q = `SELECT Id, Name, Website, Industry, Type, BillingCity, NumberOfEmployees, AnnualRevenue, Owner.Name, LastActivityDate, LastModifiedDate
             FROM Account
             WHERE Name LIKE '%${safe}%'
             ORDER BY LastActivityDate DESC, LastModifiedDate DESC
             LIMIT ${lim}`;

	progress("Requête SOQL prête.", { limit: lim });

	progress("Interrogation de Salesforce...");
	const out = await soql(q);

	progress("Mapping des résultats...");
	const records = (out.records || []).map((r) => ({
		id: r.Id,
		name: r.Name,
		website: r.Website ?? null,
		type: r.Type ?? null,
		numberOfEmployees: r.NumberOfEmployees ?? null,
		annualRevenue: r.AnnualRevenue ?? null,
		owner: r.Owner?.Name ?? null,
		lastActivityDate: r.LastActivityDate ?? null,
		lastModifiedDate: r.LastModifiedDate ?? null,
		industry: r.Industry ?? null,
		city: r.BillingCity ?? null,
	}));

	progress(`Terminé: ${records.length} résultat(s).`);
	return { records };
}

/** -------------------------
 *  MCP SSE (AgentMaurice-compatible)
 *  ------------------------- */
const MCP_SERVER_NAME = "sse-salesforce";
const MCP_SERVER_VERSION = "1.0.0";
const MCP_PROTOCOL_VERSION_FALLBACK = "2024-11-05";
const mcpSessions = new Map();

const MCP_TOOLS = [
	{
		name: "search-accounts",
		description: "Recherche des comptes Salesforce par nom (LIKE %name%)",
		inputSchema: {
			type: "object",
			properties: {
				name: {
					type: "string",
					description: "Nom (ou fragment) du compte client",
				},
				limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
			},
			required: ["name"],
			additionalProperties: false,
		},
	},
];

function writeMcpEvent(res, eventName, data) {
	if (res.writableEnded) return;
	res.write(`event: ${eventName}\n`);
	const payload = typeof data === "string" ? data : JSON.stringify(data);
	res.write(`data: ${payload}\n\n`);
}

function getSession(sessionId) {
	return mcpSessions.get(sessionId);
}

function sendRpcMessage(sessionId, message) {
	const session = getSession(sessionId);
	if (!session) return;
	writeMcpEvent(session.res, "message", message);
}

function sendRpcResponse(sessionId, id, result, error) {
	const response = { jsonrpc: "2.0", id };
	if (error) {
		response.error = error;
	} else {
		response.result = result ?? {};
	}
	sendRpcMessage(sessionId, response);
}

function sendRpcNotification(sessionId, method, params) {
	const notification = {
		jsonrpc: "2.0",
		method,
		params,
	};
	sendRpcMessage(sessionId, notification);
}

function createProgressEmitter(sessionId, progressToken) {
	if (!progressToken) return null;
	let step = 0;
	const total = 5;
	return (message, extra = {}) => {
		step += 1;
		sendRpcNotification(sessionId, "notifications/progress", {
			progressToken,
			progress: step,
			total,
			message,
			...extra,
		});
	};
}

function jsonRpcError(code, message, data) {
	const error = { code, message };
	if (data !== undefined) error.data = data;
	return error;
}

async function handleRpcRequest(sessionId, rpc) {
	if (!rpc || rpc.jsonrpc !== "2.0" || !rpc.method) {
		return { error: jsonRpcError(-32600, "Invalid Request") };
	}

	const { method, params } = rpc;
	switch (method) {
		case "initialize": {
			const protocolVersion =
				params?.protocolVersion || MCP_PROTOCOL_VERSION_FALLBACK;
			return {
				result: {
					protocolVersion,
					capabilities: { tools: { listChanged: false } },
					serverInfo: {
						name: MCP_SERVER_NAME,
						version: MCP_SERVER_VERSION,
					},
					instructions:
						"Utilise le tool search-accounts pour rechercher des comptes Salesforce.",
				},
			};
		}
		case "tools/list":
			return { result: { tools: MCP_TOOLS } };
		case "tools/call": {
			const toolName = params?.name;
			if (toolName !== "search-accounts") {
				return {
					result: {
						content: [
							{
								type: "text",
								text: `Outil inconnu: ${toolName}`,
							},
						],
						isError: true,
					},
				};
			}

			const args = params?.arguments ?? {};
			const progressToken = params?._meta?.progressToken;
			const progress = createProgressEmitter(sessionId, progressToken);

			try {
				const result = await runSearchAccounts(
					{ name: args?.name, limit: args?.limit },
					{
						onProgress: progress,
					}
				);
				return {
					result: {
						content: [
						  {
							type: "text",
							text: `Recherche terminée : ${result.records.length} compte(s) trouvé(s).`,
						  },
    					],
						structuredContent: result,
  					},
				};
			} catch (err) {
				return {
					result: {
						content: [
							{
								type: "text",
								text: String(err?.message || err),
							},
						],
						isError: true,
					},
				};
			}
		}
		case "resources/templates/list":
			return { result: { resourceTemplates: [] } };
		case "resources/list":
			return { result: { resources: [] } };
		case "resources/read":
			return {
				error: jsonRpcError(-32602, "Resource not found"),
			};
		case "ping":
			return { result: {} };
		case "notifications/initialized":
		case "notifications/cancelled":
			return { notification: true };
		default:
			return { error: jsonRpcError(-32601, "Method not found") };
	}
}

/** -------------------------
 *  MCP Tools: discovery
 *  ------------------------- */
app.get("/tools", requireApiKey, (_req, res) => {
	res.json({
		tools: MCP_TOOLS.map((tool) => ({
			name: tool.name,
			description: tool.description,
			input_schema: tool.inputSchema,
		})),
	});
});

/** -------------------------
 *  MCP Tools: start job (async)
 *  ------------------------- */
app.post("/tools/search-accounts", requireApiKey, async (req, res) => {
	const name = req.body?.name;
	const limit = req.body?.limit ?? 10;

	// Create job + respond immediately
	const jobId = createJob();
	res.status(202).json({ job_id: jobId });

	// Run asynchronously, streaming progress on SSE
	(async () => {
		try {
			pushEvent(jobId, "progress", { message: "Démarrage..." });
			const result = await runSearchAccounts(
				{ name, limit },
				{
					onProgress: (message, extra = {}) =>
						pushEvent(jobId, "progress", { message, ...extra }),
				}
			);
			finishJob(jobId, true, result);
		} catch (e) {
			const status = e?.status || 500;
			finishJob(jobId, false, {
				status,
				error: "Internal error",
				details: String(e?.message || e),
			});
		}
	})();
});

/** -------------------------
 *  SSE endpoint
 *  ------------------------- */
app.get("/sse", requireApiKey, (req, res) => {
	const jobId = String(req.query.job_id || "").trim();
	if (!jobId) {
		const sessionId = crypto.randomUUID();
		console.log("MCP SSE connect", { sessionId, ip: req.ip });

		res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
		res.setHeader("Cache-Control", "no-cache, no-transform");
		res.setHeader("Connection", "keep-alive");
		res.setHeader("X-Accel-Buffering", "no");
		res.flushHeaders?.();

		const ttlTimer = setTimeout(() => {
  			const session = mcpSessions.get(sessionId);
  			if (!session) return;
  			try { session.res.end(); } catch {}
  			mcpSessions.delete(sessionId);
  			console.log("MCP session TTL expired", { sessionId });
		}, MCP_SESSION_TTL_MS);

		mcpSessions.set(sessionId, {
  			res,
  			createdAt: Date.now(),
  			ttlTimer,
		});


		const proto = (req.headers["x-forwarded-proto"] || "https").toString().split(",")[0].trim();
		const base = `${proto}://${req.get("host")}`;
		writeMcpEvent(res, "endpoint", `${base}/message?sessionId=${sessionId}`);

		const heartbeat = setInterval(() => {
			writeMcpEvent(res, "ping", {
				ts: new Date().toISOString(),
			});
		}, 25_000);

		req.on("close", () => {
			clearInterval(heartbeat);
			const session = mcpSessions.get(sessionId);
			if (session?.ttlTimer) clearTimeout(session.ttlTimer);
			mcpSessions.delete(sessionId);
			console.log("MCP SSE disconnect", { sessionId });
		});
		return;
	}

	const job = jobs.get(jobId);
	if (!job)
		return res
			.status(404)
			.json({ error: "Unknown job_id (expired or invalid)" });

	// SSE headers
	res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
	res.setHeader("Cache-Control", "no-cache, no-transform");
	res.setHeader("Connection", "keep-alive");
	res.setHeader("X-Accel-Buffering", "no");
	res.flushHeaders?.(); 

	// Ready + replay
	writeJobEvent(res, "ready", {
	  event: "ready",
	  data: { job_id: jobId },
	  ts: new Date().toISOString(),
	});

	for (const ev of job.events) {
		writeJobEvent(res, ev.event, ev);
	}

	// Subscribe for live events
	job.subscribers.add(res);

	// Heartbeat to keep connection alive on Render
	const heartbeat = setInterval(() => {
		try {
			res.write(
				`event: ping\ndata: ${JSON.stringify({
					ts: new Date().toISOString(),
				})}\n\n`
			);
		} catch {}
	}, 25_000);

	req.on("close", () => {
		clearInterval(heartbeat);
		job.subscribers.delete(res);
	});

	// If job already done, close soon after replay
	if (job.done) {
		setTimeout(() => {
			try {
				res.end();
			} catch {}
			job.subscribers.delete(res);
		}, 500);
	}
});

/** -------------------------
 *  MCP SSE message endpoint
 *  ------------------------- */
app.post("/message", requireApiKey, async (req, res) => {
	const sessionId = String(req.query.sessionId || "").trim();
	if (!sessionId || !mcpSessions.has(sessionId)) {
		return res.status(404).json({ error: "Unknown sessionId" });
	}

	const session = mcpSessions.get(sessionId);
	if (session?.ttlTimer) clearTimeout(session.ttlTimer);
	session.ttlTimer = setTimeout(() => {
	  const s = mcpSessions.get(sessionId);
	  if (!s) return;
	  try { s.res.end(); } catch {}
	  mcpSessions.delete(sessionId);
	  console.log("MCP session TTL expired", { sessionId });
	}, MCP_SESSION_TTL_MS);
	
	const payload = req.body;
	if (!payload) {
		return res.status(400).json({ error: "Missing JSON-RPC payload" });
	}

	res.status(202).end();

	const messages = Array.isArray(payload) ? payload : [payload];
	for (const rpc of messages) {
		const id = rpc?.id;
		console.log("MCP RPC", { sessionId, id, method: rpc?.method });
		try {
			const { result, error, notification } = await handleRpcRequest(
				sessionId,
				rpc
			);
			if (notification || id === undefined || id === null) {
				continue;
			}
			sendRpcResponse(sessionId, id, result, error);
		} catch (err) {
			if (id === undefined || id === null) continue;
			sendRpcResponse(
				sessionId,
				id,
				null,
				jsonRpcError(-32603, "Internal error", String(err?.message || err))
			);
		}
	}
});

/** -------------------------
 *  Diagnostics
 *  ------------------------- */
app.get("/", (_req, res) => res.type("text").send("ok"));
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/routes", (_req, res) =>
	res.json({
		routes: [
			"GET /",
			"GET /health",
			"GET /routes",
			"GET /tools (auth)",
			"POST /tools/search-accounts (auth) -> 202 {job_id}",
			"POST /message?sessionId=... (auth) -> MCP JSON-RPC",
			"GET /sse?job_id=... (auth) -> SSE stream",
			"GET /sse (auth) -> MCP SSE stream",
		],
	})
);

app.listen(port, "0.0.0.0", () => {
	console.log(`MCP tools+SSE listening on http://0.0.0.0:${port}`);
});
