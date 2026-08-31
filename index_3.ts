/**
 * Aspire (youraspire) READ-ONLY MCP connector
 * -------------------------------------------------------------
 * Live, read-only access to Aspire for Claude/Cowork.
 * - Aspire ClientId/Secret live ONLY in this server's env (never seen by Claude or viewers).
 * - The server issues ONLY HTTP GETs against an allow-list of resources -> read-only by construction.
 * - Protected by a secret token embedded in the URL path (/mcp/<CONNECTOR_TOKEN>).
 *
 * Transport: Streamable HTTP, stateless.
 */

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const ASPIRE_BASE_URL = process.env.ASPIRE_BASE_URL ?? "https://cloud-api.youraspire.com";
const ASPIRE_TOKEN_URL = process.env.ASPIRE_TOKEN_URL ?? `${ASPIRE_BASE_URL}/Authorization`;
const ASPIRE_CLIENT_ID = requireEnv("ASPIRE_CLIENT_ID");
const ASPIRE_SECRET = requireEnv("ASPIRE_SECRET");
const CONNECTOR_TOKEN = requireEnv("CONNECTOR_TOKEN");
const PORT = Number(process.env.PORT ?? 8080);

const ALLOWED_RESOURCES = new Set(
  (process.env.ALLOWED_RESOURCES ??
    "Invoices,InvoiceOpportunities,Opportunities,WorkTickets,Receipts,Contacts,Properties,Payments,Companies"
  ).split(",").map((s) => s.trim())
);

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

let cachedToken: { value: string; expiresAt: number } | null = null;
async function getAspireToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) return cachedToken.value;
  const res = await fetch(ASPIRE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ ClientId: ASPIRE_CLIENT_ID, Secret: ASPIRE_SECRET }),
  });
  if (!res.ok) throw new Error(`Aspire auth failed: ${res.status} ${await res.text()}`);
  const data: any = await res.json();
  const token = data.token ?? data.access_token ?? data.Token;
  if (!token) throw new Error("Aspire auth: no token in response");
  const ttlSec = Number(data.expires_in ?? data.expiresIn ?? 3600);
  cachedToken = { value: token, expiresAt: Date.now() + ttlSec * 1000 };
  return token;
}

async function aspireGet(resource: string, odata: Record<string, string | number | undefined>) {
  if (!ALLOWED_RESOURCES.has(resource)) {
    throw new Error(`Resource "${resource}" not allowed. Allowed: ${[...ALLOWED_RESOURCES].join(", ")}`);
  }
  const token = await getAspireToken();
  const url = new URL(`${ASPIRE_BASE_URL}/${resource}`);
  for (const [k, v] of Object.entries(odata)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (!res.ok) throw new Error(`Aspire GET ${resource} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "aspire-readonly", version: "1.1.0" });

  server.tool(
    "list_aspire_resources",
    "List the Aspire resources this read-only connector can query.",
    {},
    async () => ({ content: [{ type: "text", text: [...ALLOWED_RESOURCES].join("\n") }] })
  );

  // Generic read-only query. Param names have NO leading "$" (Claude rejects those);
  // the server maps them to the OData "$"-prefixed params when calling Aspire.
  server.tool(
    "aspire_query",
    "Run a READ-ONLY query against an Aspire resource. Use for any live Aspire lookup " +
      "(invoices, opportunities, receipts, work tickets, AR, etc.). Narrow with filter/select and cap with top. " +
      "filter/select/orderby/expand use OData syntax, e.g. filter: \"InvoiceDate ge 2026-01-01T00:00:00Z\".",
    {
      resource: z.string().describe("e.g. Invoices, Opportunities, Receipts, WorkTickets"),
      filter: z.string().optional().describe("OData $filter, e.g. AmountRemaining gt 0"),
      select: z.string().optional().describe("Comma-separated fields to return"),
      orderby: z.string().optional().describe("e.g. InvoiceDate desc"),
      expand: z.string().optional().describe("Related entities to expand"),
      top: z.number().int().positive().max(1000).optional().describe("Max rows (<=1000)"),
      skip: z.number().int().nonnegative().optional().describe("Rows to skip (paging)"),
    },
    async (args) => {
      const rows = await aspireGet(args.resource, {
        $filter: args.filter,
        $select: args.select,
        $orderby: args.orderby,
        $expand: args.expand,
        $top: args.top ?? 200,
        $skip: args.skip,
      });
      return { content: [{ type: "text", text: JSON.stringify(rows) }] };
    }
  );

  server.tool(
    "aspire_open_ar",
    "Open invoices (AmountRemaining > 0) with customer, amount, due date — live from Aspire.",
    { top: z.number().int().positive().max(1000).optional() },
    async ({ top }) => {
      const rows = await aspireGet("Invoices", {
        $filter: "AmountRemaining gt 0",
        $select: "InvoiceNumber,PropertyName,CompanyName,Amount,AmountRemaining,InvoiceDate,DueDate",
        $orderby: "DueDate asc", $top: top ?? 500,
      });
      return { content: [{ type: "text", text: JSON.stringify(rows) }] };
    }
  );

  return server;
}

// Shared MCP request handler (stateless streamable-HTTP).
async function runMcp(req: express.Request, res: express.Response) {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => transport.close());
  const server = buildServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

// Pull the connector token out of an Authorization header.
// Accepts "Authorization: Bearer <token>" and a bare "Authorization: <token>".
function bearerToken(req: express.Request): string | undefined {
  const auth = req.header("authorization");
  if (!auth) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return (m ? m[1] : auth).trim();
}

const app = express();
app.use(express.json({ limit: "4mb" }));
app.get("/health", (_req, res) => res.json({ ok: true }));

// Preferred: token travels in the Authorization header, never in the URL.
// 403 (not 401) on a bad/missing token so clients don't try to negotiate OAuth.
app.post("/mcp", async (req, res) => {
  if (bearerToken(req) !== CONNECTOR_TOKEN) return res.status(403).end();
  await runMcp(req, res);
});

// DEPRECATED legacy route: token in the URL path. Kept only so existing installs
// keep working during migration to header auth. Remove (and rotate CONNECTOR_TOKEN)
// once every consumer sends the token as an Authorization header.
app.post("/mcp/:token", async (req, res) => {
  if (req.params.token !== CONNECTOR_TOKEN) return res.status(404).end();
  await runMcp(req, res);
});

app.listen(PORT, () =>
  console.log(`Aspire read-only MCP on :${PORT} (POST /mcp with Bearer token; legacy /mcp/<token> still accepted)`)
);
