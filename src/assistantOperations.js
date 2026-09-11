/**
 * Filesystem request/result channel for assistant-management operations.
 *
 * The MCP server may only write requests and read app-authored results inside
 * the operations directory advertised by the Perssua bridge. It never reads
 * Firestore, settings.json, or the app database directly.
 */

import fs from 'node:fs';
import path from 'node:path';

export const ASSISTANT_OPERATION_VERSION = 1;
export const ASSISTANT_OPERATION_REQUESTS_DIR = 'requests';
export const ASSISTANT_OPERATION_RESULTS_DIR = 'results';
export const ASSISTANT_OPERATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export const ASSISTANT_OPERATION_CAPABILITIES = Object.freeze({
  roster: 'assistant-roster-v2',
  read: 'assistant-read-v1',
  update: 'assistant-update-v1',
  delete: 'assistant-delete-v1',
  operations: 'assistant-operations-v1',
});

export const ASSISTANT_OPERATION_STATUSES = Object.freeze([
  'pending_app',
  'pending_authentication',
  'pending_confirmation',
  'completed',
  'conflict',
  'cancelled',
  'failed',
]);

export const ASSISTANT_OPERATION_LIMITS = Object.freeze({
  requestBytes: 256 * 1024,
  resultBytes: 512 * 1024,
  requestMaxAgeMs: 15 * 60 * 1000,
  resultMaxAgeMs: 24 * 60 * 60 * 1000,
  requestIdMinChars: 8,
  requestIdMaxChars: 64,
  sourceChars: 32,
  assistantRefChars: 256,
  revisionChars: 256,
  bridgeSessionIdChars: 256,
  accountScopeChars: 256,
  assistantNameChars: 200,
  assistantInstructionsChars: 32000,
  assistantCategoryChars: 64,
  assistantRealtimePromptChars: 32000,
  assistantFollowUpPromptChars: 32000,
  assistantEmailPromptChars: 32000,
  assistantKnowledgeTextChars: 128000,
  assistantKnowledgeFiles: 20,
});

const boundedString = (value, maxChars, field, { optional = false } = {}) => {
  if ((value === undefined || value === null) && optional) return '';
  if (typeof value !== 'string' || !value) throw new Error(`${field} is required`);
  if (value.length > maxChars) throw new Error(`${field} exceeds ${maxChars} characters`);
  return value;
};

const readJsonFile = (filePath, maxBytes) => {
  const stats = fs.statSync(filePath);
  if (!stats.isFile()) throw new Error('Operation path is not a regular file');
  if (stats.size > maxBytes) throw new Error('Operation file exceeds the size limit');
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
};

const getOperationPath = (operationsDir, subdirectory, requestId) => {
  if (!ASSISTANT_OPERATION_ID_PATTERN.test(requestId || '')) {
    throw new Error('Invalid requestId');
  }
  return path.join(operationsDir, subdirectory, `${requestId}.json`);
};

export const buildAssistantOperationDeepLink = (
  requestId,
  { protocol = 'perssua' } = {},
) => {
  if (!ASSISTANT_OPERATION_ID_PATTERN.test(requestId || '')) {
    throw new Error('Invalid requestId');
  }
  return `${protocol}://assistant/operation?request=${encodeURIComponent(requestId)}`;
};

const PATCH_FIELDS = Object.freeze({
  name: { maxChars: ASSISTANT_OPERATION_LIMITS.assistantNameChars, nullable: false },
  instructions: { maxChars: ASSISTANT_OPERATION_LIMITS.assistantInstructionsChars, nullable: false },
  category: { maxChars: ASSISTANT_OPERATION_LIMITS.assistantCategoryChars, nullable: true },
  realtimePrompt: { maxChars: ASSISTANT_OPERATION_LIMITS.assistantRealtimePromptChars, nullable: true },
  followUpPrompt: { maxChars: ASSISTANT_OPERATION_LIMITS.assistantFollowUpPromptChars, nullable: true },
  emailPrompt: { maxChars: ASSISTANT_OPERATION_LIMITS.assistantEmailPromptChars, nullable: true },
  requireCertainty: { boolean: true },
  knowledgeText: { maxChars: ASSISTANT_OPERATION_LIMITS.assistantKnowledgeTextChars, nullable: true },
});

const normalizePatch = (patch) => {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return undefined;
  const normalized = {};
  for (const [field, value] of Object.entries(patch)) {
    const rule = PATCH_FIELDS[field];
    if (!rule) throw new Error(`Unsupported assistant patch field: ${field}`);
    if (rule.boolean) {
      if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`);
      normalized[field] = value;
      continue;
    }
    if (value === null) {
      if (!rule.nullable) throw new Error(`${field} cannot be cleared`);
      normalized[field] = null;
      continue;
    }
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`${field} must be a non-empty string or explicit null`);
    }
    if (value.length > rule.maxChars) {
      throw new Error(`${field} exceeds ${rule.maxChars} characters`);
    }
    normalized[field] = value;
  }
  return normalized;
};

/**
 * Build the v1 request envelope shared by reads and mutations.
 */
export const buildAssistantOperationRequest = ({
  requestId,
  operation,
  bridgeSessionId,
  accountScope,
  assistantRef,
  expectedRevision,
  patch,
  source = 'mcp',
  now = () => new Date(),
} = {}) => {
  if (!ASSISTANT_OPERATION_ID_PATTERN.test(requestId || '')) {
    throw new Error('Invalid requestId');
  }
  if (!['get_assistant', 'update_assistant', 'delete_assistant'].includes(operation)) {
    throw new Error('Invalid assistant operation');
  }

  const scopedSessionId = boundedString(
    bridgeSessionId,
    ASSISTANT_OPERATION_LIMITS.bridgeSessionIdChars,
    'bridgeSessionId',
  );
  const targetRef = boundedString(
    assistantRef,
    ASSISTANT_OPERATION_LIMITS.assistantRefChars,
    'assistantRef',
  );
  const scopedAccount = boundedString(
    accountScope,
    ASSISTANT_OPERATION_LIMITS.accountScopeChars,
    'accountScope',
  );
  const normalizedSource = boundedString(
    source || 'mcp',
    ASSISTANT_OPERATION_LIMITS.sourceChars,
    'source',
  );

  const request = {
    version: ASSISTANT_OPERATION_VERSION,
    requestId,
    operation,
    bridgeSessionId: scopedSessionId,
    accountScope: scopedAccount,
    createdAt: now().toISOString(),
    source: normalizedSource,
    target: { assistantRef: targetRef },
  };

  if (operation !== 'get_assistant') {
    const revision = boundedString(
      expectedRevision,
      ASSISTANT_OPERATION_LIMITS.revisionChars,
      'expectedRevision',
    );
    request.expectedRevision = revision;
  }

  if (operation === 'update_assistant') {
    const normalizedPatch = normalizePatch(patch);
    if (!normalizedPatch || Object.keys(normalizedPatch).length === 0) {
      throw new Error('update_assistant requires a non-empty patch');
    }
    request.patch = normalizedPatch;
  }

  return request;
};

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
};

const requestIdentity = (request) => JSON.stringify(stableValue({
  operation: request?.operation,
  accountScope: request?.accountScope,
  target: request?.target,
  expectedRevision: request?.expectedRevision,
  patch: request?.patch,
}));

/**
 * Write a request once. Retrying the exact logical requestId + payload is
 * idempotent; reusing it for a different payload fails closed.
 */
export const writeAssistantOperationRequest = (operationsDir, request) => {
  const requestPath = getOperationPath(
    operationsDir,
    ASSISTANT_OPERATION_REQUESTS_DIR,
    request?.requestId,
  );
  const serialized = JSON.stringify(request);
  if (Buffer.byteLength(serialized, 'utf8') > ASSISTANT_OPERATION_LIMITS.requestBytes) {
    throw new Error('Assistant operation request exceeds the size limit');
  }

  fs.mkdirSync(path.dirname(requestPath), { recursive: true });
  try {
    fs.writeFileSync(requestPath, serialized, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    return { requestPath, reused: false };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = readJsonFile(requestPath, ASSISTANT_OPERATION_LIMITS.requestBytes);
    if (requestIdentity(existing) !== requestIdentity(request)) {
      const conflict = new Error('requestId was already used for a different operation payload');
      conflict.code = 'REQUEST_ID_REUSED';
      throw conflict;
    }
    return { requestPath, reused: true };
  }
};

export const assistantOperationRequestExists = (operationsDir, requestId) => {
  try {
    return fs.statSync(getOperationPath(
      operationsDir,
      ASSISTANT_OPERATION_REQUESTS_DIR,
      requestId,
    )).isFile();
  } catch {
    return false;
  }
};

/**
 * Read and scope an MCP-authored request. A request is only considered
 * pending while it belongs to the current bridge account and is within the
 * request lifetime; otherwise callers fail closed instead of reporting a
 * request that can never be completed in this session.
 */
export const readAssistantOperationRequest = (
  operationsDir,
  requestId,
  { accountScope, now = Date.now } = {},
) => {
  let request;
  try {
    request = readJsonFile(
      getOperationPath(operationsDir, ASSISTANT_OPERATION_REQUESTS_DIR, requestId),
      ASSISTANT_OPERATION_LIMITS.requestBytes,
    );
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }

  if (
    request?.version !== ASSISTANT_OPERATION_VERSION
    || request.requestId !== requestId
    || !['get_assistant', 'update_assistant', 'delete_assistant'].includes(request.operation)
    || typeof request.bridgeSessionId !== 'string'
    || !request.bridgeSessionId
    || typeof request.accountScope !== 'string'
    || !request.accountScope
  ) {
    throw new Error('Invalid assistant operation request');
  }
  const createdAtMs = Date.parse(request.createdAt || '');
  if (!Number.isFinite(createdAtMs)) {
    throw new Error('Assistant operation request has an invalid createdAt timestamp');
  }
  if (!accountScope || request.accountScope !== accountScope) {
    const error = new Error('Assistant operation request belongs to a different account scope');
    error.code = 'REQUEST_SCOPE_MISMATCH';
    throw error;
  }
  if (now() - createdAtMs > ASSISTANT_OPERATION_LIMITS.requestMaxAgeMs) {
    const error = new Error('Assistant operation request has expired');
    error.code = 'REQUEST_EXPIRED';
    throw error;
  }
  return request;
};

const isKnownStatus = (status) => ASSISTANT_OPERATION_STATUSES.includes(status);

/**
 * Read and scope an app-authored receipt. A result from an older app process
 * or account session is never surfaced through the current bridge.
 */
export const readAssistantOperationResult = (
  operationsDir,
  requestId,
  { accountScope, now = Date.now } = {},
) => {
  let result;
  try {
    result = readJsonFile(
      getOperationPath(operationsDir, ASSISTANT_OPERATION_RESULTS_DIR, requestId),
      ASSISTANT_OPERATION_LIMITS.resultBytes,
    );
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }

  if (
    result?.version !== ASSISTANT_OPERATION_VERSION
    || result.requestId !== requestId
    || !['get_assistant', 'update_assistant', 'delete_assistant'].includes(result.operation)
    || !isKnownStatus(result.status)
  ) {
    throw new Error('Invalid assistant operation result');
  }
  const updatedAtMs = Date.parse(result.updatedAt || '');
  if (!Number.isFinite(updatedAtMs)) {
    throw new Error('Assistant operation result has an invalid updatedAt timestamp');
  }
  if (
    typeof result.bridgeSessionId !== 'string'
    || !result.bridgeSessionId
    || !accountScope
    || result.accountScope !== accountScope
  ) {
    const error = new Error('Assistant operation result belongs to a different account scope');
    error.code = 'RESULT_SCOPE_MISMATCH';
    throw error;
  }
  if (now() - updatedAtMs > ASSISTANT_OPERATION_LIMITS.resultMaxAgeMs) {
    const error = new Error('Assistant operation result has expired');
    error.code = 'RESULT_EXPIRED';
    throw error;
  }
  return result;
};

export const buildPendingAssistantOperationResult = (request, details = {}) => ({
  version: ASSISTANT_OPERATION_VERSION,
  requestId: request.requestId,
  operation: request.operation,
  bridgeSessionId: request.bridgeSessionId,
  accountScope: request.accountScope,
  status: 'pending_app',
  createdAt: request.createdAt,
  updatedAt: request.createdAt,
  target: request.target,
  ...(request.expectedRevision ? { expectedRevision: request.expectedRevision } : {}),
  ...details,
});
