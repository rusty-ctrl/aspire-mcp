# Aspire read-only connector — build & deploy

A small remote MCP server that gives Claude/Cowork **live, read-only** access to your Aspire data,
so you can hand management a Cowork space that answers questions straight from Aspire in real time.

## How it fits together

```
Management (Cowork) ──▶ Claude ──▶ [Aspire read-only MCP server] ──▶ Aspire REST API
                         (custom connector, HTTPS + token)         (your ClientId/Secret)
```

- Aspire ClientId/Secret live **only** on the server — never in Claude, never shown to viewers.
- The server makes **only GET** requests against an allow-list of resources → read-only by construction.
- Callers must send a shared bearer token (`CONNECTOR_TOKEN`) to reach the server.

## Step 1 — Create an Aspire API credential

In Aspire: **System Admin → API** → create a credential. Copy the **ClientId** and **Secret**.
(Reference: Aspire API guide, base URL `https://cloud-api.youraspire.com`, Swagger at `/swagger`.)

## Step 2 — Configure

```bash
cp .env.example .env      # then fill in ASPIRE_CLIENT_ID, ASPIRE_SECRET
# generate a long random CONNECTOR_TOKEN, e.g.:
openssl rand -hex 32
```

Confirm `ASPIRE_TOKEN_URL` against your API credential page (the POST that returns a bearer token).

## Step 3 — Run locally to verify

```bash
npm install
npm run dev
# in another terminal:
curl -s localhost:8080/health          # -> {"ok":true}
```

## Step 4 — Host it (must be public HTTPS for a claude.ai connector)

Any of these work; pick one:
- **Cloudflare Workers / Render / Fly.io / Railway** — deploy the repo, set the env vars as secrets.
- **A small VM** behind HTTPS (Caddy/nginx) running `npm run build && npm start`.

You need a stable URL like `https://aspire-mcp.yourcompany.com/mcp`.

## Step 5 — Register as a custom connector in Claude

claude.ai → **Settings → Connectors → Add custom connector**:
- URL: `https://<your-host>/mcp`
- Auth: bearer token = your `CONNECTOR_TOKEN`

Add it at the **organization** level so it can be shared, not just your own account.

### Auth: header, not URL

The connector token is sent in the **`Authorization: Bearer <token>`** header — nothing
secret ever appears in the URL. In a Cowork plugin's `.mcp.json`:

```json
{
  "mcpServers": {
    "Aspire_MCP": {
      "type": "http",
      "url": "https://<your-host>/mcp",
      "headers": { "Authorization": "Bearer ${ASPIRE_CONNECTOR_TOKEN}" }
    }
  }
}
```

The server still accepts the old `POST /mcp/<token>` path form for backward
compatibility during migration, but it is **deprecated**. Once every consumer sends the
token as a header, delete the legacy route in `index.ts` and rotate `CONNECTOR_TOKEN`.

## Step 6 — Roll out to management (read-only)

- Enable the connector for the management group/space.
- They open a Cowork space and ask questions ("show me open A/R over 60 days", "billing by division this month") — Claude answers live from Aspire.
- Because the server is GET-only over an allow-list, there is no way for a viewer to change Aspire data.

## Tools exposed

- `list_aspire_resources` — what can be queried.
- `aspire_query` — generic read-only OData query (resource + `$filter`/`$select`/`$top`/`$expand`…).
- `aspire_open_ar` — example curated report (open invoices by customer). Add more curated tools the same way.

## Extending

Add curated, named reports (like `aspire_open_ar`) for the questions management asks most —
they're safer and faster than free-form queries, and read cleanly in Cowork.
