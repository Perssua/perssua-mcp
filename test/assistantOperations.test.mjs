import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  ASSISTANT_OPERATION_CAPABILITIES,
  ASSISTANT_OPERATION_ID_PATTERN,
  buildAssistantOperationDeepLink,
  buildAssistantOperationRequest,
  buildPendingAssistantOperationResult,
  readAssistantOperationRequest,
  readAssistantOperationResult,
  writeAssistantOperationRequest,
} from '../src/assistantOperations.js';

const makeTempDir = () => fs.mkdtempSync(
  path.join(os.tmpdir(), 'perssua-assistant-operation-test-'),
);

test('assistant operation constants freeze the v1 capability and request contract', () => {
  assert.deepEqual(ASSISTANT_OPERATION_CAPABILITIES, {
    roster: 'assistant-roster-v2',
    read: 'assistant-read-v1',
    update: 'assistant-update-v1',
    delete: 'assistant-delete-v1',
    operations: 'assistant-operations-v1',
  });
  assert.match('request_1234', ASSISTANT_OPERATION_ID_PATTERN);
  assert.doesNotMatch('../bad', ASSISTANT_OPERATION_ID_PATTERN);
  assert.equal(
    buildAssistantOperationDeepLink('request_1234'),
    'perssua://assistant/operation?request=request_1234',
  );
});

test('get request is scoped to the bridge session and exact opaque assistant ref', () => {
  const request = buildAssistantOperationRequest({
    requestId: 'request_get_1',
    operation: 'get_assistant',
    bridgeSessionId: 'bridge_session_1',
    accountScope: 'account_scope_1',
    assistantRef: 'assistant_ref_opaque',
    source: 'claude',
    now: () => new Date('2026-09-11T12:00:00.000Z'),
  });

  assert.deepEqual(request, {
    version: 1,
    requestId: 'request_get_1',
    operation: 'get_assistant',
    bridgeSessionId: 'bridge_session_1',
    accountScope: 'account_scope_1',
    createdAt: '2026-09-11T12:00:00.000Z',
    source: 'claude',
    target: { assistantRef: 'assistant_ref_opaque' },
  });
});

test('mutations require a revision and update requires a non-empty patch', () => {
  assert.throws(
    () => buildAssistantOperationRequest({
      requestId: 'request_update_1',
      operation: 'update_assistant',
      bridgeSessionId: 'bridge_session_1',
      accountScope: 'account_scope_1',
      assistantRef: 'assistant_ref_opaque',
      patch: { name: 'Coach' },
    }),
    /expectedRevision/,
  );

  assert.throws(
    () => buildAssistantOperationRequest({
      requestId: 'request_update_2',
      operation: 'update_assistant',
      bridgeSessionId: 'bridge_session_1',
      accountScope: 'account_scope_1',
      assistantRef: 'assistant_ref_opaque',
      expectedRevision: 'revision_1',
      patch: {},
    }),
    /non-empty patch/,
  );

  const request = buildAssistantOperationRequest({
    requestId: 'request_update_3',
    operation: 'update_assistant',
    bridgeSessionId: 'bridge_session_1',
    accountScope: 'account_scope_1',
    assistantRef: 'assistant_ref_opaque',
    expectedRevision: 'revision_1',
    patch: { knowledgeText: null, followUpPrompt: 'Ask one question.' },
  });
  assert.deepEqual(request.patch, {
    knowledgeText: null,
    followUpPrompt: 'Ask one question.',
  });
});

test('request retries are idempotent and reject requestId payload changes', () => {
  const operationsDir = makeTempDir();
  const base = {
    requestId: 'request_update_4',
    operation: 'update_assistant',
    bridgeSessionId: 'bridge_session_1',
    accountScope: 'account_scope_1',
    assistantRef: 'assistant_ref_opaque',
    expectedRevision: 'revision_1',
    patch: { category: null, requireCertainty: true },
  };
  const first = buildAssistantOperationRequest({
    ...base,
    now: () => new Date('2026-09-11T12:00:00.000Z'),
  });
  const retry = buildAssistantOperationRequest({
    ...base,
    bridgeSessionId: 'bridge_session_2',
    source: 'chatgpt',
    patch: { requireCertainty: true, category: null },
    now: () => new Date('2026-09-11T12:01:00.000Z'),
  });

  assert.equal(writeAssistantOperationRequest(operationsDir, first).reused, false);
  assert.equal(writeAssistantOperationRequest(operationsDir, retry).reused, true);

  const changed = buildAssistantOperationRequest({
    ...base,
    patch: { category: 'Sales' },
  });
  assert.throws(
    () => writeAssistantOperationRequest(operationsDir, changed),
    (error) => error.code === 'REQUEST_ID_REUSED',
  );
});

test('patches reject session/file fields and total UTF-8 byte overflow without truncation', () => {
  assert.throws(
    () => buildAssistantOperationRequest({
      requestId: 'request_update_5',
      operation: 'update_assistant',
      bridgeSessionId: 'bridge_session_1',
      accountScope: 'account_scope_1',
      assistantRef: 'assistant_ref_opaque',
      expectedRevision: 'revision_1',
      patch: { sessionGoal: 'not assistant-wide' },
    }),
    /Unsupported assistant patch field/,
  );

  const oversizedUtf8 = buildAssistantOperationRequest({
    requestId: 'request_update_6',
    operation: 'update_assistant',
    bridgeSessionId: 'bridge_session_1',
    accountScope: 'account_scope_1',
    assistantRef: 'assistant_ref_opaque',
    expectedRevision: 'revision_1',
    patch: { knowledgeText: '界'.repeat(128000) },
  });
  assert.equal(oversizedUtf8.patch.knowledgeText.length, 128000);
  assert.throws(
    () => writeAssistantOperationRequest(makeTempDir(), oversizedUtf8),
    /size limit/,
  );
});

test('results must be app-authored for the current bridge session', () => {
  const operationsDir = makeTempDir();
  const resultDir = path.join(operationsDir, 'results');
  fs.mkdirSync(resultDir, { recursive: true });
  fs.writeFileSync(
    path.join(resultDir, 'request_get_2.json'),
    JSON.stringify({
      version: 1,
      requestId: 'request_get_2',
      operation: 'get_assistant',
      bridgeSessionId: 'bridge_session_1',
      accountScope: 'account_scope_1',
      status: 'completed',
      createdAt: '2026-09-11T12:00:00.000Z',
      updatedAt: '2026-09-11T12:00:01.000Z',
      target: { assistantRef: 'assistant_ref_opaque' },
      assistant: { name: 'Coach', revision: 'revision_1' },
    }),
  );

  const result = readAssistantOperationResult(operationsDir, 'request_get_2', {
    accountScope: 'account_scope_1',
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.assistant.name, 'Coach');

  assert.throws(
    () => readAssistantOperationResult(operationsDir, 'request_get_2', {
      accountScope: 'different_account',
    }),
    (error) => error.code === 'RESULT_SCOPE_MISMATCH',
  );

  assert.throws(
    () => readAssistantOperationResult(operationsDir, 'request_get_2', {
      accountScope: 'account_scope_1',
      now: () => Date.parse('2026-09-13T12:00:00.000Z'),
    }),
    (error) => error.code === 'RESULT_EXPIRED',
  );
});

test('requests are scoped and expire before they can remain pending forever', () => {
  const operationsDir = makeTempDir();
  const request = buildAssistantOperationRequest({
    requestId: 'request_scope_1',
    operation: 'get_assistant',
    bridgeSessionId: 'bridge_session_1',
    accountScope: 'account_scope_1',
    assistantRef: 'assistant_ref_opaque',
    now: () => new Date('2026-09-11T12:00:00.000Z'),
  });
  writeAssistantOperationRequest(operationsDir, request);

  assert.equal(
    readAssistantOperationRequest(operationsDir, request.requestId, {
      accountScope: 'account_scope_1',
      now: () => Date.parse('2026-09-11T12:01:00.000Z'),
    }).operation,
    'get_assistant',
  );
  assert.throws(
    () => readAssistantOperationRequest(operationsDir, request.requestId, {
      accountScope: 'different_account',
      now: () => Date.parse('2026-09-11T12:01:00.000Z'),
    }),
    (error) => error.code === 'REQUEST_SCOPE_MISMATCH',
  );
  assert.throws(
    () => readAssistantOperationRequest(operationsDir, request.requestId, {
      accountScope: 'account_scope_1',
      now: () => Date.parse('2026-09-11T12:16:00.000Z'),
    }),
    (error) => error.code === 'REQUEST_EXPIRED',
  );
});

test('pending result says only that the app still needs to execute the request', () => {
  const request = buildAssistantOperationRequest({
    requestId: 'request_delete_1',
    operation: 'delete_assistant',
    bridgeSessionId: 'bridge_session_1',
    accountScope: 'account_scope_1',
    assistantRef: 'assistant_ref_opaque',
    expectedRevision: 'revision_1',
    now: () => new Date('2026-09-11T12:00:00.000Z'),
  });
  const pending = buildPendingAssistantOperationResult(request, {
    launched: true,
    requestReused: false,
  });

  assert.equal(pending.status, 'pending_app');
  assert.equal(pending.launched, true);
  assert.equal(pending.expectedRevision, 'revision_1');
  assert.equal('assistant' in pending, false);
});
