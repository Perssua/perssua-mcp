/**
 * Public hosted transport. This module intentionally imports no desktop bridge,
 * filesystem, deep-link, or launcher code. TLS is terminated by the hosting
 * platform/reverse proxy; ASSISTANT_REMOTE_RESOURCE remains the canonical HTTPS
 * audience advertised to OAuth clients.
 */

import http from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { createPerssuaRemoteMcpServer } from './remoteServer.js';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
export const DEFAULT_REMOTE_RESOURCE = 'https://mcp.perssua.com';
export const DEFAULT_REMOTE_ISSUER =
  'https://us-central1-strawberry-cb687.cloudfunctions.net/assistantRemoteAuth';

const normalizeResource = (value) => String(value || DEFAULT_REMOTE_RESOURCE).replace(/\/$/, '');

export const protectedResourceMetadata = ({
  resource = process.env.ASSISTANT_REMOTE_RESOURCE || DEFAULT_REMOTE_RESOURCE,
  issuer = process.env.ASSISTANT_REMOTE_ISSUER || DEFAULT_REMOTE_ISSUER,
  documentation = 'https://github.com/Perssua/perssua-mcp',
} = {}) => ({
  resource: normalizeResource(resource),
  authorization_servers: [String(issuer).replace(/\/$/, '')],
  scopes_supported: ['assistants.read', 'assistants.write'],
  resource_documentation: documentation,
});

const challengeFor = (resource, {
  scope,
  error = 'invalid_token',
  description = 'A valid Perssua OAuth access token is required.',
} = {}) => (
  `Bearer resource_metadata="${normalizeResource(resource)}/.well-known/oauth-protected-resource", `
  + `${scope ? `scope="${scope}", ` : ''}error="${error}", error_description="${description}"`
);

const bearerToken = (authorization) => {
  const match = String(authorization || '').match(/^Bearer\s+([^\s].*)$/i);
  return match ? match[1].trim() : '';
};

const readBody = (req) => new Promise((resolve, reject) => {
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
    if (chunks.length === 0) return resolve(undefined);
    try {
      return resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch {
      return resolve(undefined);
    }
  });
  req.on('error', reject);
});

const sendJson = (res, statusCode, body, headers = {}) => {
  if (res.headersSent) return;
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
};

export const createHostedHttpHandler = ({
  resource = process.env.ASSISTANT_REMOTE_RESOURCE || DEFAULT_REMOTE_RESOURCE,
  issuer = process.env.ASSISTANT_REMOTE_ISSUER || DEFAULT_REMOTE_ISSUER,
  apiUrl = process.env.ASSISTANT_REMOTE_API_URL,
  fetchFn = globalThis.fetch,
  createServerFn = createPerssuaRemoteMcpServer,
} = {}) => {
  const canonicalResource = normalizeResource(resource);
  const metadata = protectedResourceMetadata({ resource: canonicalResource, issuer });
  return async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/.well-known/oauth-protected-resource') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD' });
        return;
      }
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' });
        res.end();
        return;
      }
      sendJson(res, 200, metadata, { 'Cache-Control': 'public, max-age=300' });
      return;
    }

    if (url.pathname !== '/mcp') {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed. Use POST.' },
        id: null,
      }, { Allow: 'POST' });
      return;
    }

    const token = bearerToken(req.headers.authorization);
    if (!token) {
      sendJson(res, 401, {
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Authentication required.' },
        id: null,
      }, { 'WWW-Authenticate': challengeFor(canonicalResource) });
      return;
    }

    let server;
    let transport;
    try {
      const body = await readBody(req);
      server = createServerFn({ bearerToken: token, apiUrl, fetchFn });
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (transport) await transport.close().catch(() => {});
      if (server) await server.close().catch(() => {});
      sendJson(res, 500, {
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Hosted Perssua MCP request failed.' },
        id: null,
      });
    }
  };
};

export const startHostedHttpServer = ({
  port = 8434,
  host = '0.0.0.0',
  ...handlerOptions
} = {}) => {
  const httpServer = http.createServer(createHostedHttpHandler(handlerOptions));
  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => resolve(httpServer));
  });
};
