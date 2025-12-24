import fetch from "node-fetch";
import express from "express";

console.log("BOOT: server.js loaded, commit =", process.env.RENDER_GIT_COMMIT || "unknown");

const app = express();
app.use(express.json({ limit: "1mb" }));

const {
  MCP_API_KEY,
  SF_CLIENT_ID,
  SF_CLIENT_SECRET,
  SF_REFRESH_TOKEN,
  SF_INSTANCE_URL,
  SF_API_VERSION = "v60.0",
  PORT = 3000
} = process.env;

function requireApiKey(req, res, next) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return res.status(401).json({ error: "Missing API key" });
  const key = auth.slice("Bearer ".length);
  if (key !== MCP_API_KEY) return res.status(403).json({ error: "Invalid API key" });
  next();
}

let cached = { token: null, expiresAt: 0 };

async function getAccessToken() {
  const now = Date.now();
  if (cached.token && cached.expiresAt > now + 30_000) return cached.token;

  // Le plus robuste : utiliser l'instance_url pour le /token
  const tokenUrl = `${SF_INSTANCE_URL}/services/oauth2/token`;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: SF_CLIENT_ID,
    client_secret: SF_CLIENT_SECRET,
    refresh_token: SF_REFRESH_TOKEN
  });

  const r = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
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
  const url = `${SF_INSTANCE_URL}/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(query)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// Healthcheck
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/", (_req, res) => res.status(200).send("ok"));

// Action: searchAccounts
app.post("/actions/search-accounts", requireApiKey, async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const limitRaw = req.body?.limit ?? 5;
    const limit = Math.max(1, Math.min(20, Number(limitRaw) || 5));

    if (!name) return res.status(400).json({ error: "Missing 'name' (string)" });

    // petite protection anti injection SOQL (basique)
    const safe = name.replace(/'/g, "\\'");
    const q = `SELECT Id, Name, Industry, BillingCity FROM Account WHERE Name LIKE '%${safe}%' LIMIT ${limit}`;

    const out = await soql(q);

    // réponse IA-friendly
    const records = (out.records || []).map(r => ({
      id: r.Id,
      name: r.Name,
      industry: r.Industry ?? null,
      city: r.BillingCity ?? null
    }));

    res.json({ records });
  } catch (e) {
    res.status(500).json({ error: "Internal error", details: String(e?.message || e) });
  }
});

app.get("/", (_req, res) => res.status(200).send("ok"));
app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/", (_req, res) => res.type("text").send("ok"));
app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`MCP actions listening on :${PORT}`);
});
