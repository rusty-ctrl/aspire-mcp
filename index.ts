/**
 * Aspire (youraspire) READ-ONLY MCP connector
 * -------------------------------------------------------------
 * Exposes the Aspire REST API to Claude/Cowork as a set of read-only tools.
 * - Aspire ClientId/Secret live ONLY in this server's env (never seen by Claude or viewers).
 * - The server issues ONLY HTTP GETs against an allow-list of resources -> read-only by construction.
 * - Callers must present a shared bearer token (CONNECTOR_TOKEN) to reach the MCP endpoint.
 *
 * Transport: Streamable HTTP (works as a claude.ai custom connector).
 */

import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// ---- Config (all from environment; nothing hard-coded) ----
const ASPIRE_BASE_URL = process.env.ASPIRE_BASE_URL ?? "https://cloud-api.youraspire.com";
// Token endpoint: confirm the exact path on your Aspire API credential page.
// Aspire issues a bearer token from a POST with your ClientId + Secret.
const ASPIRE_TOKEN_URL = process.env.ASPIRE_TOKEN_URL ?? `${ASPIRE_BASE_URL}/Authorization`;
const ASPIRE_CLIENT_ID = requireEnv("ASPIRE_CLIENT_ID");
const ASPIRE_SECRET = requireEnv("ASPIRE_SECRET");
const CONNECTOR_TOKEN = requireEnv("CONNECTOR_TOKEN"); // shared secret the connector must send
const PORT = Number(process.env.PORT ?? 8080);

// Only these Aspire resources may be queried. Add more as needed — READ-only regardless.
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

// ---- Aspire auth: fetch + cache a bearer token ----
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
  // Aspire returns the token as `token` (older) or `access_token`; support both.
  const token = data.token ?? data.access_token ?? data.Token;
  if (!token) throw new Error("Aspire auth: no token in response");
  const ttlSec = Number(data.expires_in ?? data.expiresIn ?? 3600);
  cachedToken = { value: token, expiresAt: Date.now() + ttlSec * 1000 };
  return token;
}

// ---- Read-only GET against Aspire with OData params ----
async function aspireGet(resource: string, odata: Record<string, string | number | undefined>) {
  if (!ALLOWED_RESOURCES.has(resource)) {
    throw new Error(`Resource "${resource}" is not allowed. Allowed: ${[...ALLOWED_RESOURCES].join(", ")}`);
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

// ---- MCP server definition ----
function buildServer(): McpServer {
  const server = new McpServer({ name: "aspire-readonly", version: "1.0.0" });

  server.tool(
    "list_aspire_resources",
    "List the Aspire resources this read-only connector can query, so you know what is available.",
    {},
    async () => ({ content: [{ type: "text", text: [...ALLOWED_RESOURCES].join("\n") }] })
  );

  server.tool(
    "aspire_query",
    "Run a READ-ONLY query against an Aspire resource using OData parameters. " +
      "Use this for any live Aspire lookup (invoices, opportunities, receipts, work tickets, AR, etc.). " +
      "Returns JSON rows. Always narrow with $filter/$select and cap with $top to keep responses small.",
    {
      resource: z.string().describe("Aspire resource, e.g. Invoices, Opportunities, Receipts, WorkTickets"),
      $filter: z.string().optional().describe("OData filter, e.g. InvoiceDate ge 2026-01-01T00:00:00Z"),
      $select: z.string().optional().describe("Comma-separated fields to return"),
      $orderby: z.string().optional().describe("e.g. InvoiceDate desc"),
      $expand: z.string().optional().describe("Related entities to expand"),
      $top: z.number().int().positive().max(1000).optional().describe("Max rows (<=1000)"),
      $skip: z.number().int().nonnegative().optional().describe("Rows to skip (paging)"),
    },
    async (args) => {
      const rows = await aspireGet(args.resource, {
        $filter: args.$filter,
        $select: args.$select,
        $orderby: args.$orderby,
        $expand: args.$expand,
        $top: args.$top ?? 200,
        $skip: args.$skip,
      });
      return { content: [{ type: "text", text: JSON.stringify(rows) }] };
    }
  );

  // Example curated report — open A/R by customer (read-only). Add more like this as management asks.
  server.tool(
    "aspire_open_ar",
    "Return open invoices (AmountRemaining > 0) with customer, amount, and due date — live from Aspire.",
    { top: z.number().int().positive().max(1000).optional() },
    async ({ top }) => {
      const rows = await aspireGet("Invoices", {
        $filter: "AmountRemaining gt 0",
        $select: "InvoiceNumber,PropertyName,CompanyName,Amount,AmountRemaining,InvoiceDate,DueDate",
        $orderby: "DueDate asc",
        $top: top ?? 500,
      });
      return { content: [{ type: "text", text: JSON.stringify(rows) }] };
    }
  );

  return server;
}

// ---- HTTP wiring (Streamable HTTP transport + connector auth) ----
const app = express();
app.use(express.json({ limit: "4mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/mcp", async (req, res) => {
  const auth = req.header("authorization") ?? "";
  if (auth !== `Bearer ${CONNECTOR_TOKEN}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  res.on("close", () => transport.close());
  const server = buildServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(PORT, () => console.log(`Aspire read-only MCP listening on :${PORT}/mcp`));
