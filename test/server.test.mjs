import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createPerssuaMcpServer } from '../src/server.js';

const CAPABILITIES = [
  'assistant-roster-v2',
  'assistant-read-v1',
  'assistant-update-v1',
  'assistant-delete-v1',
  'assistant-operations-v1',
];

const BRIDGE = {
  found: true,
  assistantOperationsDir: '/test/external-assistant-operations',
  bridge: {
    protocol: 'perssua',
    bridgeSessionId: 'bridge_session_1',
    accountScope: 'account_scope_1',
    capabilities: CAPABILITIES,
  },
};

const ROSTER = {
  available: true,
  version: 2,
  selectedAssistantId: 'user_0',
  snapshotRevision: 'snapshot_revision_1',
  updatedAt: '2026-09-11T12:00:00.000Z',
  assistants: [
    {
      id: 'user_0',
      name: 'Coach',
      assistantRef: 'assistant_ref_opaque',
      kind: 'custom',
      selected: true,
      revision: 'revision_1',
      permissions: {
        read: true,
        update: true,
        delete: true,
        editableFields: [
          'name',
          'instructions',
          'category',
          'realtimePrompt',
          'followUpPrompt',
          'emailPrompt',
          'requireCertainty',
          'knowledgeText',
        ],
      },
    },
  ],
};

const withClient = async (options, callback) => {
  const server = createPerssuaMcpServer({ allowLaunch: false, ...options });
  const client = new Client(
    { name: 'perssua-mcp-test', version: '1.0.0' },
    { capabilities: {} },
  );
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

test('tools/list exposes read-only reads and destructive revision-checked mutations', async () => {
  await withClient({}, async (client) => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    for (const name of ['get_assistant', 'update_assistant', 'delete_assistant', 'get_operation']) {
      assert.ok(byName[name], `${name} should be registered`);
    }
    assert.equal(byName.get_assistant.annotations.readOnlyHint, true);
    assert.equal(byName.get_operation.annotations.readOnlyHint, true);
    assert.equal(byName.update_assistant.annotations.destructiveHint, true);
    assert.equal(byName.delete_assistant.annotations.destructiveHint, true);
    assert.ok(byName.update_assistant.inputSchema.required.includes('expectedRevision'));
    assert.ok(byName.delete_assistant.inputSchema.required.includes('expectedRevision'));
    assert.equal(byName.update_assistant.inputSchema.properties.patch.properties.sessionGoal, undefined);
    assert.equal(byName.update_assistant.inputSchema.properties.patch.properties.files, undefined);
  });
});

test('list_assistants returns rich metadata without private definitions', async () => {
  await withClient({ readRosterFn: () => ROSTER }, async (client) => {
    const result = await client.callTool({ name: 'list_assistants', arguments: {} });
    assert.equal(result.structuredContent.version, 2);
    assert.equal(result.structuredContent.snapshotRevision, 'snapshot_revision_1');
    assert.equal(result.structuredContent.assistants[0].assistantRef, 'assistant_ref_opaque');
    assert.equal(result.structuredContent.assistants[0].permissions.delete, true);
    assert.equal('instructions' in result.structuredContent.assistants[0], false);
    assert.equal('knowledge' in result.structuredContent.assistants[0], false);
  });
});

test('get_assistant resolves a unique current id and returns pending_app until Perssua executes', async () => {
  let writtenRequest = null;
  await withClient({
    resolveBridgeFn: () => BRIDGE,
    readRosterFn: () => ROSTER,
    writeOperationRequestFn: (_dir, request) => {
      writtenRequest = request;
      return { requestPath: '/test/request.json', reused: false };
    },
    readOperationResultFn: () => null,
  }, async (client) => {
    const result = await client.callTool({
      name: 'get_assistant',
      arguments: { assistant: 'user_0', requestId: 'request_get_1' },
    });

    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.status, 'pending_app');
    assert.equal(result.structuredContent.assistant, undefined);
    assert.equal(writtenRequest.operation, 'get_assistant');
    assert.equal(writtenRequest.accountScope, 'account_scope_1');
    assert.deepEqual(writtenRequest.target, { assistantRef: 'assistant_ref_opaque' });
  });
});

test('get_assistant rejects ambiguous names before writing a request', async () => {
  let writes = 0;
  await withClient({
    readRosterFn: () => ({
      ...ROSTER,
      assistants: [
        ROSTER.assistants[0],
        { ...ROSTER.assistants[0], id: 'user_1', assistantRef: 'assistant_ref_2' },
      ],
    }),
    writeOperationRequestFn: () => { writes += 1; },
  }, async (client) => {
    const result = await client.callTool({
      name: 'get_assistant',
      arguments: { assistant: 'Coach', requestId: 'request_get_2' },
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'AMBIGUOUS_ASSISTANT');
    assert.equal(writes, 0);
  });
});

test('update_assistant preserves explicit null clears in the app request', async () => {
  let writtenRequest = null;
  await withClient({
    resolveBridgeFn: () => BRIDGE,
    readRosterFn: () => ROSTER,
    writeOperationRequestFn: (_dir, request) => {
      writtenRequest = request;
      return { requestPath: '/test/request.json', reused: false };
    },
    readOperationResultFn: () => null,
  }, async (client) => {
    const result = await client.callTool({
      name: 'update_assistant',
      arguments: {
        assistantRef: 'assistant_ref_opaque',
        expectedRevision: 'revision_1',
        requestId: 'request_update_1',
        patch: { knowledgeText: null, category: null, requireCertainty: true },
      },
    });

    assert.equal(result.structuredContent.status, 'pending_app');
    assert.deepEqual(writtenRequest.patch, {
      knowledgeText: null,
      category: null,
      requireCertainty: true,
    });
  });
});

test('legacy apps fail closed instead of accepting assistant mutations', async () => {
  await withClient({
    resolveBridgeFn: () => ({
      ...BRIDGE,
      bridge: { ...BRIDGE.bridge, capabilities: ['session-start'] },
    }),
  }, async (client) => {
    const result = await client.callTool({
      name: 'delete_assistant',
      arguments: {
        assistantRef: 'assistant_ref_opaque',
        expectedRevision: 'revision_1',
        requestId: 'request_delete_1',
      },
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.status, 'failed');
    assert.equal(result.structuredContent.error.code, 'APP_UPDATE_REQUIRED');
  });
});

test('built-in permissions prevent delete and unsupported patches before app handoff', async () => {
  let writes = 0;
  const builtInRoster = {
    ...ROSTER,
    assistants: [{
      ...ROSTER.assistants[0],
      kind: 'built_in',
      permissions: {
        read: true,
        update: true,
        delete: false,
        editableFields: ['instructions', 'followUpPrompt'],
      },
    }],
  };
  await withClient({
    resolveBridgeFn: () => BRIDGE,
    readRosterFn: () => builtInRoster,
    writeOperationRequestFn: () => { writes += 1; },
  }, async (client) => {
    const deletion = await client.callTool({
      name: 'delete_assistant',
      arguments: {
        assistantRef: 'assistant_ref_opaque',
        expectedRevision: 'revision_1',
        requestId: 'request_delete_2',
      },
    });
    assert.equal(deletion.structuredContent.error.code, 'PERMISSION_DENIED');

    const rename = await client.callTool({
      name: 'update_assistant',
      arguments: {
        assistantRef: 'assistant_ref_opaque',
        expectedRevision: 'revision_1',
        requestId: 'request_update_3',
        patch: { name: 'Renamed built-in' },
      },
    });
    assert.equal(rename.structuredContent.error.code, 'PERMISSION_DENIED');
    assert.equal(writes, 0);
  });
});

test('get_operation never exposes a receipt from another account scope', async () => {
  const scopeError = new Error('foreign scope');
  scopeError.code = 'RESULT_SCOPE_MISMATCH';
  await withClient({
    resolveBridgeFn: () => BRIDGE,
    readOperationResultFn: () => { throw scopeError; },
  }, async (client) => {
    const result = await client.callTool({
      name: 'get_operation',
      arguments: { requestId: 'request_update_2' },
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'ACCOUNT_SCOPE_MISMATCH');
    assert.equal(result.structuredContent.assistant, undefined);
  });
});

test('get_operation never reports an expired receipt as pending_app', async () => {
  await withClient({
    resolveBridgeFn: () => BRIDGE,
    readRosterFn: () => ROSTER,
    readOperationResultFn: () => {
      const error = new Error('Assistant operation result has expired');
      error.code = 'RESULT_EXPIRED';
      throw error;
    },
    operationRequestExistsFn: () => true,
  }, async (client) => {
    const result = await client.callTool({
      name: 'get_operation',
      arguments: { requestId: 'request_expired_1' },
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.status, 'failed');
    assert.equal(result.structuredContent.error.code, 'OPERATION_EXPIRED');
  });
});
