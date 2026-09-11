#!/usr/bin/env node
/**
 * Perssua MCP server CLI.
 *
 *   perssua-mcp                 stdio transport (Claude Desktop, Claude Code, …)
 *   perssua-mcp --http [port]   streamable-HTTP transport on 127.0.0.1 (default 8433)
 *   perssua-mcp --hosted [port] OAuth-protected remote-only HTTP transport (default 8434)
 *   perssua-mcp --help
 *
 * Environment:
 *   PERSSUA_USER_DATA_DIR   override the app's user-data directory
 *   PERSSUA_MCP_SOURCE      default `source` tag for sessions (claude|chatgpt|grok|…)
 *   PERSSUA_LAUNCH_URL      hosted launcher page that redirects to perssua:// links
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createPerssuaMcpServer, SERVER_NAME, SERVER_VERSION } from '../src/server.js';
import { startHttpServer } from '../src/httpTransport.js';
import { startHostedHttpServer } from '../src/hostedHttpTransport.js';

const HELP = `Perssua MCP server v${SERVER_VERSION}

Usage:
  perssua-mcp                 Run over stdio (local MCP clients: Claude Desktop, Claude Code)
  perssua-mcp --http [port]   Run a streamable-HTTP endpoint on 127.0.0.1 (default port 8433)
  perssua-mcp --hosted [port] Run the OAuth-protected remote-only endpoint (default port 8434)
  perssua-mcp --help          Show this help

Environment variables:
  PERSSUA_USER_DATA_DIR   Override the Perssua user-data directory
  PERSSUA_MCP_SOURCE      Default source tag (claude | chatgpt | grok | ...)
  PERSSUA_LAUNCH_URL      Hosted launcher page URL used by create_session_link
  ASSISTANT_REMOTE_RESOURCE  Canonical public HTTPS MCP resource
  ASSISTANT_REMOTE_ISSUER    OAuth authorization-server issuer
  ASSISTANT_REMOTE_API_URL   Perssua assistant backend base URL
  PERSSUA_MCP_HOST           Hosted-mode listen address (default 0.0.0.0)
`;

const main = async () => {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }

  const httpIndex = args.indexOf('--http');
  if (httpIndex !== -1) {
    const portArg = Number.parseInt(args[httpIndex + 1], 10);
    const port = Number.isInteger(portArg) && portArg > 0 ? portArg : 8433;
    await startHttpServer({ port });
    // eslint-disable-next-line no-console
    console.error(`[${SERVER_NAME}] streamable-HTTP MCP endpoint on http://127.0.0.1:${port}/mcp`);
    return;
  }

  const hostedIndex = args.indexOf('--hosted');
  if (hostedIndex !== -1) {
    const portArg = Number.parseInt(args[hostedIndex + 1], 10);
    const port = Number.isInteger(portArg) && portArg > 0 ? portArg : 8434;
    const host = process.env.PERSSUA_MCP_HOST || '0.0.0.0';
    await startHostedHttpServer({ port, host });
    // eslint-disable-next-line no-console
    console.error(`[${SERVER_NAME}] OAuth-protected hosted MCP endpoint listening on ${host}:${port}/mcp`);
    return;
  }

  const server = createPerssuaMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // eslint-disable-next-line no-console
  console.error(`[${SERVER_NAME}] v${SERVER_VERSION} connected over stdio`);
};

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(`[${SERVER_NAME}] fatal: ${error.message}`);
  process.exit(1);
});
