/**
 * Streamable-HTTP transport for the Perssua MCP server.
 *
 * Stateless mode: each POST /mcp request gets a fresh server + transport pair,
 * which keeps the endpoint simple and safe for connector-style clients
 * (ChatGPT developer-mode connectors, Grok connectors) that are pointed at a
 * URL. Binds to 127.0.0.1 — expose it through a tunnel/reverse proxy of your
 * choice when a hosted connector needs to reach it.
 */

import http from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { createPerssuaMcpServer } from './server.js';

const MAX_BODY_BYTES = 4 * 1024 * 1024;

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(undefined);
      }
    });
    req.on('error', reject);
  });

const sendJson = (res, statusCode, body) => {
  if (res.headersSent) return;
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

export const startHttpServer = ({
  port = 8433,
  host = '127.0.0.1',
  createServerFn = createPerssuaMcpServer,
} = {}) => {
  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || host}`);

    if (url.pathname !== '/mcp') {
      sendJson(res, 404, { error: 'Not found. The MCP endpoint is POST /mcp.' });
      return;
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed. Use POST (stateless mode).' },
        id: null,
      });
      return;
    }

    try {
      const body = await readBody(req);
      const server = createServerFn();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      res.on('close', () => {
        transport.close();
        server.close();
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      sendJson(res, 500, {
        jsonrpc: '2.0',
        error: { code: -32603, message: `Internal error: ${error.message}` },
        id: null,
      });
    }
  });

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => resolve(httpServer));
  });
};
