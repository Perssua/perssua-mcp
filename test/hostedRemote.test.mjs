import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  createHostedHttpHandler,
  protectedResourceMetadata,
} from '../src/hostedHttpTransport.js';
import { AssistantRemoteApiError, createAssistantRemoteApi } from '../src/remoteApi.js';
import { createPerssuaRemoteMcpServer, REMOTE_TOOLS } from '../src/remoteServer.js';

const callHandler = async ({ method = 'GET', url, headers = {} }) => {
  const handler = createHostedHttpHandler({
    resource: 'https://mcp.test.example',
    issuer: 'https://auth.test.example',
    apiUrl: 'https://api.test.example',
  });
  const req = new EventEmitter();
  Object.assign(req, { method, url, headers: { host: 'localhost', ...headers } });
  const response = { statusCode: null, headers: {}, body: '' };
  const res = {
    headersSent: false,
    writeHead(statusCode, responseHeaders) {
      response.statusCode = statusCode;
      response.headers = Object.fromEntries(
        Object.entries(responseHeaders || {}).map(([key, value]) => [key.toLowerCase(), value]),
      );
      this.headersSent = true;
    },
    end(body = '') { response.body = body; },
  };
  await handler(req, res);
  return response;
};

const withClient = async (fetchFn, callback, token = 'access-token-secret') => {
  const server = createPerssuaRemoteMcpServer({
    bearerToken: token,
    apiUrl: 'https://api.test.example',
    fetchFn,
  });
  const client = new Client({ name: 'hosted-test', version: '1.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await callback(client);
  } finally {
    await client.close();
    await server.close();
  }
};

const json = (body, { status = 200, headers } = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', ...headers },
});

test('hosted metadata publishes the exact resource, issuer, and assistant scopes', async () => {
  assert.deepEqual(protectedResourceMetadata({
    resource: 'https://mcp.test.example/',
    issuer: 'https://auth.test.example/',
  }), {
    resource: 'https://mcp.test.example',
    authorization_servers: ['https://auth.test.example'],
    scopes_supported: ['assistants.read', 'assistants.write'],
    resource_documentation: 'https://github.com/Perssua/perssua-mcp',
  });

  const response = await callHandler({ url: '/.well-known/oauth-protected-resource' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), protectedResourceMetadata({
    resource: 'https://mcp.test.example',
    issuer: 'https://auth.test.example',
  }));
});

test('hosted MCP rejects a missing bearer with a discoverable OAuth challenge', async () => {
  const response = await callHandler({
    url: '/mcp',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(response.statusCode, 401);
  const challenge = response.headers['www-authenticate'];
  assert.match(challenge, /resource_metadata="https:\/\/mcp\.test\.example\/\.well-known\/oauth-protected-resource"/);
  assert.match(challenge, /error="invalid_token"/);
  assert.match(challenge, /error_description=/);
});

test('hosted remote API enforces the response cap incrementally and cancels an oversized stream', async () => {
  const chunk = new Uint8Array(1024 * 1024);
  let offset = 0;
  let cancelled = false;
  const response = {
    ok: true,
    status: 200,
    headers: new Headers(),
    body: {
      getReader() {
        return {
          async read() {
            if (offset >= 3) return { done: true };
            offset += 1;
            return { done: false, value: chunk };
          },
          async cancel() { cancelled = true; },
          releaseLock() {},
        };
      },
    },
    text() {
      throw new Error('response.text() must not be used for streamed bodies');
    },
  };
  const api = createAssistantRemoteApi({
    bearerToken: 'access-token-secret',
    apiUrl: 'https://api.test.example',
    fetchFn: async () => response,
  });
  await assert.rejects(
    () => api.listAssistants(),
    (error) => error instanceof AssistantRemoteApiError && error.code === 'invalid_remote_response',
  );
  assert.equal(cancelled, true);
  assert.equal(offset, 3);
});

test('hosted tools expose only remote CRUD with per-tool OAuth schemes and safe annotations', async () => {
  const names = REMOTE_TOOLS.map((tool) => tool.name);
  assert.deepEqual(names, [
    'list_assistants',
    'get_assistant',
    'update_assistant',
    'delete_assistant',
    'get_operation',
  ]);
  assert.equal(names.includes('app_status'), false);
  assert.equal(names.includes('start_session'), false);
  assert.equal(names.includes('create_session_link'), false);
  assert.deepEqual(REMOTE_TOOLS.find((tool) => tool.name === 'list_assistants').securitySchemes, [
    { type: 'oauth2', scopes: ['assistants.read'] },
  ]);
  assert.deepEqual(REMOTE_TOOLS.find((tool) => tool.name === 'update_assistant').securitySchemes, [
    { type: 'oauth2', scopes: ['assistants.write'] },
  ]);
  assert.equal(REMOTE_TOOLS.find((tool) => tool.name === 'get_operation').annotations.readOnlyHint, true);
  assert.equal(REMOTE_TOOLS.find((tool) => tool.name === 'delete_assistant').annotations.destructiveHint, true);
});

test('hosted list/get map the backend contract and redact tokens plus knowledge-file contents', async () => {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/v1/assistants')) {
      return json({ assistants: [{
        id: 'user_0',
        name: 'Coach',
        source: 'user',
        revision: 'sha256:one',
        permissions: { read: true, update: true, delete: true },
      }] });
    }
    return json({
      assistant: {
        id: 'user_0',
        source: 'user',
        name: 'Coach',
        systemPrompt: 'Be concise.',
        category: 'General',
        context: 'Manual notes\n\n### File: secret.md\n```\nprivate file contents\n```',
        requireCertainty: false,
        mcpServers: [{
          url: 'https://user:pass@tools.example/mcp?apiKey=url-secret',
          apiKey: 'upstream-leaked-key',
          metadata: 'Authorization: Bearer metadata-secret; client_secret=also-secret',
          hasCredential: true,
        }, {
          url: 'https://tools.example/with-query?token=hidden',
          hasCredential: false,
        }],
      },
      revision: 'sha256:one',
      permissions: { read: true, update: true, delete: true },
    });
  };
  await withClient(fetchFn, async (client) => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 5);
    assert.deepEqual(tools.find((tool) => tool.name === 'get_assistant')._meta.securitySchemes, [
      { type: 'oauth2', scopes: ['assistants.read'] },
    ]);

    const list = await client.callTool({ name: 'list_assistants', arguments: {} });
    assert.equal(list.structuredContent.assistants[0].assistantRef, 'user_0');
    assert.equal(list.structuredContent.assistants[0].revision, 'sha256:one');
    assert.equal('instructions' in list.structuredContent.assistants[0], false);

    const get = await client.callTool({
      name: 'get_assistant',
      arguments: { assistant: 'user_0', requestId: 'request_get_1' },
    });
    assert.equal(get.structuredContent.status, 'completed');
    assert.equal(get.structuredContent.assistant.instructions, 'Be concise.');
    assert.deepEqual(get.structuredContent.assistant.knowledge, {
      text: 'Manual notes',
      files: [{ name: 'secret.md', contentIncluded: false }],
    });
    assert.deepEqual(get.structuredContent.assistant.mcpServers, [{
      url: 'https://tools.example/mcp',
      hasCredential: true,
    }, {
      url: 'https://tools.example/with-query',
      hasCredential: true,
    }]);
    const serialized = JSON.stringify(get);
    assert.equal(serialized.includes('upstream-leaked-key'), false);
    assert.equal(serialized.includes('url-secret'), false);
    assert.equal(serialized.includes('user:pass'), false);
    assert.equal(serialized.includes('metadata-secret'), false);
    assert.equal(serialized.includes('also-secret'), false);
    assert.equal(serialized.includes('private file contents'), false);
    assert.equal(serialized.includes('access-token-secret'), false);
  });
  assert.ok(calls.every((call) => call.options.headers.Authorization === 'Bearer access-token-secret'));
});

test('hosted list preserves explicit and backend-fallback selection flags', async () => {
  let listCall = 0;
  const fetchFn = async () => {
    listCall += 1;
    return json({
      assistants: listCall === 1
        ? [
          { id: 'remote_0', name: 'Built in', source: 'remote_config', selected: false, permissions: { read: true } },
          { id: 'user_0', name: 'Explicit', source: 'user', selected: true, permissions: { read: true } },
        ]
        : [
          { id: 'remote_0', name: 'Fallback', source: 'remote_config', selected: true, permissions: { read: true } },
          { id: 'user_0', name: 'Other', source: 'user', selected: false, permissions: { read: true } },
        ],
    });
  };
  await withClient(fetchFn, async (client) => {
    const explicit = await client.callTool({ name: 'list_assistants', arguments: {} });
    assert.equal(explicit.structuredContent.selectedAssistantId, 'user_0');
    assert.deepEqual(explicit.structuredContent.assistants.map(({ id, selected }) => ({ id, selected })), [
      { id: 'remote_0', selected: false },
      { id: 'user_0', selected: true },
    ]);
    const fallback = await client.callTool({ name: 'list_assistants', arguments: {} });
    assert.equal(fallback.structuredContent.selectedAssistantId, 'remote_0');
    assert.deepEqual(fallback.structuredContent.assistants.map(({ id, selected }) => ({ id, selected })), [
      { id: 'remote_0', selected: true },
      { id: 'user_0', selected: false },
    ]);
  });
});

test('hosted update/delete keep idempotency and null clears, then get_operation uses operation id', async () => {
  const calls = [];
  const fetchFn = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method: options.method, body });
    if (url.endsWith('/v1/operations') && body.type === 'update') {
      return json({
        operation_id: 'operation_update_1',
        status: 'pending_confirmation',
        type: 'update',
        assistant_id: body.assistant_id,
        expected_revision: body.expected_revision,
        patch: body.patch,
        created_at: '2026-09-11T12:00:00.000Z',
        expires_at: '2026-09-12T12:00:00.000Z',
      }, { status: 202 });
    }
    if (url.endsWith('/v1/operations') && body.type === 'delete') {
      return json({
        operation_id: 'operation_delete_1',
        status: 'pending_confirmation',
        type: 'delete',
        assistant_id: body.assistant_id,
        expected_revision: body.expected_revision,
        created_at: '2026-09-11T12:00:00.000Z',
        expires_at: '2026-09-12T12:00:00.000Z',
      }, { status: 202 });
    }
    return json({
      operation_id: 'operation_update_1',
      status: 'completed',
      type: 'update',
      assistant_id: 'user_0',
      expected_revision: 'sha256:old',
      revision: 'sha256:new',
      created_at: '2026-09-11T12:00:00.000Z',
      expires_at: '2026-09-12T12:00:00.000Z',
      resolved_at: '2026-09-11T12:01:00.000Z',
    });
  };
  await withClient(fetchFn, async (client) => {
    const update = await client.callTool({
      name: 'update_assistant',
      arguments: {
        assistantRef: 'user_0',
        expectedRevision: 'sha256:old',
        requestId: 'request_update_1',
        patch: { category: null, followUpPrompt: null, knowledgeText: null },
      },
    });
    assert.equal(update.structuredContent.status, 'pending_confirmation');
    assert.equal(update.structuredContent.operationId, 'operation_update_1');

    const deletion = await client.callTool({
      name: 'delete_assistant',
      arguments: {
        assistantRef: 'user_0',
        expectedRevision: 'sha256:old',
        requestId: 'request_delete_1',
      },
    });
    assert.equal(deletion.structuredContent.operationId, 'operation_delete_1');

    const completed = await client.callTool({
      name: 'get_operation',
      arguments: { requestId: 'operation_update_1' },
    });
    assert.equal(completed.structuredContent.status, 'completed');
    assert.equal(completed.structuredContent.currentRevision, 'sha256:new');
  });

  assert.deepEqual(calls[0].body, {
    type: 'update',
    assistant_id: 'user_0',
    expected_revision: 'sha256:old',
    idempotency_key: 'request_update_1',
    patch: { category: null, followUpPrompt: null, knowledgeText: null },
  });
  assert.equal(calls[1].body.idempotency_key, 'request_delete_1');
  assert.match(calls[2].url, /\/v1\/operations\/operation_update_1$/);
});

test('backend scope challenges are forwarded in MCP auth metadata without exposing bearer tokens', async () => {
  const upstreamChallenge = 'Bearer resource_metadata="https://mcp.test.example/.well-known/oauth-protected-resource", scope="assistants.write", error="insufficient_scope", error_description="Write scope required"';
  const fetchFn = async () => json(
    { error: 'insufficient_scope', message: 'Write scope required.' },
    { status: 403, headers: { 'WWW-Authenticate': upstreamChallenge } },
  );
  await withClient(fetchFn, async (client) => {
    const result = await client.callTool({
      name: 'delete_assistant',
      arguments: {
        assistantRef: 'user_0',
        expectedRevision: 'sha256:old',
        requestId: 'request_delete_2',
      },
    });
    assert.equal(result.isError, true);
    assert.deepEqual(result._meta['mcp/www_authenticate'], [upstreamChallenge]);
    assert.equal(JSON.stringify(result).includes('access-token-secret'), false);
  });
});
