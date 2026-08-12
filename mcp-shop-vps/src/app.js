import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { requireBearerToken } from "./auth.js";

/**
 * Registers one MCP mount (routes + auth + per-session transports) onto an
 * existing Express app at `mountPath`. Auth is applied per-route (not via
 * app.use) so multiple mounts with different bearer tokens can share one
 * Express instance/port — e.g. a customer-facing mount at /mcp and an
 * admin-only mount at /admin/mcp, each with its own token and its own
 * McpServer capabilities.
 */
export function createApp({ app, db, authToken, serverName, registerCapabilities, mountPath = "/mcp", publicUrl }) {
  function buildMcpServer() {
    const server = new McpServer({ name: serverName, version: "0.1.0" });
    registerCapabilities(server, db, publicUrl);
    return server;
  }

  const auth = requireBearerToken(authToken);
  const transports = {};

  const mcpPostHandler = async (req, res) => {
    try {
      const sessionId = req.headers["mcp-session-id"];
      let transport;

      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports[id] = transport;
          },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports[sid]) delete transports[sid];
        };
        const server = buildMcpServer();
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: No valid session ID provided" },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("Error handling MCP POST:", error);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  };

  const mcpGetHandler = async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  };

  const mcpDeleteHandler = async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    try {
      await transports[sessionId].handleRequest(req, res);
    } catch (error) {
      console.error("Error handling MCP DELETE:", error);
      if (!res.headersSent) res.status(500).send("Error processing session termination");
    }
  };

  app.post(mountPath, auth, mcpPostHandler);
  app.get(mountPath, auth, mcpGetHandler);
  app.delete(mountPath, auth, mcpDeleteHandler);

  return { transports };
}
