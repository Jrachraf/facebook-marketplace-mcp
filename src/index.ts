#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { FacebookClient } from "./facebook/client.js";
import { searchListingsSchema, createSearchHandler } from "./tools/search.js";
import { getListingSchema, createListingHandler } from "./tools/listing.js";
import {
  searchLocationSchema,
  createLocationHandler,
} from "./tools/location.js";
import {
  monitorSearchSchema,
  checkMonitorsSchema,
  deleteMonitorSchema,
  listMonitorsSchema,
  createMonitorSearchHandler,
  createCheckMonitorsHandler,
  createDeleteMonitorHandler,
  createListMonitorsHandler,
} from "./tools/monitor.js";

/**
 * Facebook session source, in order: FACEBOOK_COOKIES_FILE (JSON/Netscape export),
 * FACEBOOK_COOKIES_JSON (the same data inline, raw or base64 — convenient for container
 * environments), else the local Chrome profile (macOS only).
 */
function resolveCookiesFile(): string | undefined {
  if (process.env.FACEBOOK_COOKIES_FILE) return process.env.FACEBOOK_COOKIES_FILE;
  const inline = process.env.FACEBOOK_COOKIES_JSON?.trim();
  if (!inline) return undefined;
  const text = inline.startsWith("[") || inline.startsWith("{")
    ? inline
    : Buffer.from(inline, "base64").toString("utf8");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-mcp-"));
  const file = path.join(dir, "cookies.json");
  fs.writeFileSync(file, text, { mode: 0o600 });
  return file;
}

console.error(`[mcp] facebook host: ${process.env.FACEBOOK_HOST ?? "www.facebook.com"} | session: ${process.env.FACEBOOK_COOKIES_JSON ? "COOKIES_JSON" : process.env.FACEBOOK_COOKIES_FILE ? "COOKIES_FILE" : "chrome:" + (process.env.CHROME_PROFILE ?? "Default")}`);
const client = new FacebookClient({
  maxRequestsPerMinute: Number(process.env.MAX_REQUESTS_PER_MINUTE ?? 3),
  chromeProfile: process.env.CHROME_PROFILE ?? "Default",
  cookiesFile: resolveCookiesFile(),
});

/** One McpServer per transport/session; tools share the single FacebookClient. */
function createServer(): McpServer {
  const server = new McpServer({
  name: "facebook-marketplace",
  version: "1.0.0",
});

// Search listings
  server.tool(
  "search_listings",
  "Search Facebook Marketplace listings by query, location, and filters",
  searchListingsSchema,
  createSearchHandler(client)
);

// Get listing details
  server.tool(
  "get_listing",
  "Get full details for a specific Facebook Marketplace listing",
  getListingSchema,
  createListingHandler(client)
);

// Search for a location (get coordinates)
  server.tool(
  "search_location",
  "Look up a city/town name to get coordinates for use with search_listings",
  searchLocationSchema,
  createLocationHandler(client)
);

// Save a search monitor
  server.tool(
  "monitor_search",
  "Save a search query as a monitor to track new listings over time",
  monitorSearchSchema,
  createMonitorSearchHandler()
);

// Check monitors for new listings
  server.tool(
  "check_monitors",
  "Check saved monitors for new listings since last check",
  checkMonitorsSchema,
  createCheckMonitorsHandler(client)
);

// Delete a monitor
  server.tool(
  "delete_monitor",
  "Delete a saved search monitor",
  deleteMonitorSchema,
  createDeleteMonitorHandler()
);

// List all monitors
  server.tool(
  "list_monitors",
  "List all saved search monitors",
  listMonitorsSchema,
  createListMonitorsHandler()
);

// Start the server
  return server;
}

/**
 * Transport: stdio (default — spawned by an MCP client) or Streamable HTTP so the
 * server can run as a standalone service (MCP_TRANSPORT=http, PORT, optional
 * MCP_AUTH_TOKEN checked as a Bearer token on every request).
 */
if ((process.env.MCP_TRANSPORT ?? "stdio").toLowerCase() === "http") {
  const port = Number(process.env.PORT ?? 3333);
  const host = process.env.HOST ?? "0.0.0.0";
  const token = process.env.MCP_AUTH_TOKEN;
  // One transport + server per MCP session (the SDK's stateful Streamable HTTP pattern).
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const readJsonBody = (req: http.IncomingMessage): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (!text) return resolve(undefined);
        try {
          resolve(JSON.parse(text));
        } catch (error) {
          reject(error);
        }
      });
      req.on("error", reject);
    });

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, transport: "http", sessions: sessions.size }));
      return;
    }
    if (url.pathname !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    if (token) {
      const header = req.headers.authorization ?? "";
      const given = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      const a = Buffer.from(given);
      const b = Buffer.from(token);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
    }
    try {
      const sessionId = req.headers["mcp-session-id"];
      const body = req.method === "POST" ? await readJsonBody(req) : undefined;
      let transport = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
      if (!transport) {
        if (req.method !== "POST" || !isInitializeRequest(body)) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: no valid session; send initialize first" }, id: null }));
          return;
        }
        const created: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (id: string) => {
            sessions.set(id, created);
          },
        });
        created.onclose = () => {
          if (created.sessionId) sessions.delete(created.sessionId);
        };
        await createServer().connect(created);
        transport = created;
      }
      await (transport as StreamableHTTPServerTransport).handleRequest(req, res, body);
    } catch (error) {
      console.error("[mcp] request failed:", error);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal error" }));
      }
    }
  });
  httpServer.listen(port, host, () => {
    console.error(`[mcp] facebook-marketplace listening on http://${host}:${port}/mcp${token ? " (bearer auth)" : ""}`);
  });
} else {
  await createServer().connect(new StdioServerTransport());
}
