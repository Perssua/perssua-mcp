const DEFAULT_API_URL =
  'https://us-central1-strawberry-cb687.cloudfunctions.net/assistantRemoteApi';
const MAX_REMOTE_RESPONSE_BYTES = 2 * 1024 * 1024;
const REMOTE_TIMEOUT_MS = 15_000;

const readResponseText = async (response) => {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REMOTE_RESPONSE_BYTES) {
    throw new Error('Response too large');
  }
  if (!response.body?.getReader) throw new Error('Response body is not streamable');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > MAX_REMOTE_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Response too large');
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString('utf8');
};

const CUSTOM_EDITABLE_FIELDS = [
  'name',
  'instructions',
  'category',
  'realtimePrompt',
  'followUpPrompt',
  'emailPrompt',
  'requireCertainty',
  'knowledgeText',
];

const BUILT_IN_EDITABLE_FIELDS = CUSTOM_EDITABLE_FIELDS.filter(
  (field) => field !== 'name' && field !== 'category',
);
const MAX_KNOWLEDGE_TEXT_CHARS = 128_000;
const MAX_KNOWLEDGE_FILES = 20;
const MAX_KNOWLEDGE_FILE_NAME_CHARS = 200;

export class AssistantRemoteApiError extends Error {
  constructor(message, { status = 500, code = 'remote_api_error', challenge } = {}) {
    super(message);
    this.name = 'AssistantRemoteApiError';
    this.status = status;
    this.code = code;
    this.challenge = challenge;
  }
}

const parseAssistantContext = (contextString) => {
  if (!contextString) return { files: [], manualText: '' };
  const marker = '### File: ';
  const firstMarker = contextString.indexOf(marker);
  if (firstMarker === -1) return { files: [], manualText: contextString.trim() };

  const failClosed = () => ({ files: [], manualText: '' });
  const manualText = contextString.slice(0, firstMarker).trim();
  const serializedFiles = contextString.slice(firstMarker);
  const files = [];
  let cursor = 0;
  while (cursor < serializedFiles.length) {
    if (!serializedFiles.startsWith(marker, cursor)) return failClosed();
    const nameEnd = serializedFiles.indexOf('\n', cursor + marker.length);
    if (nameEnd === -1) return failClosed();
    const name = serializedFiles.slice(cursor + marker.length, nameEnd);
    if (!name) return failClosed();

    const fenceStart = nameEnd + 1;
    const fenceEnd = serializedFiles.indexOf('\n', fenceStart);
    if (fenceEnd === -1) return failClosed();
    const fence = serializedFiles.slice(fenceStart, fenceEnd);
    if (!/^`{3,}$/.test(fence)) return failClosed();

    const contentStart = fenceEnd + 1;
    const closingPrefix = `\n${fence}`;
    let searchAt = contentStart;
    let closingEnd = -1;
    let nextCursor = -1;
    while (searchAt < serializedFiles.length) {
      const prefixAt = serializedFiles.indexOf(closingPrefix, searchAt);
      if (prefixAt === -1) break;
      const lineEnd = prefixAt + closingPrefix.length;
      if (lineEnd < serializedFiles.length && serializedFiles[lineEnd] !== '\n') {
        searchAt = lineEnd;
        continue;
      }
      const remainder = serializedFiles.slice(lineEnd);
      if (!remainder.trim()) {
        closingEnd = lineEnd;
        nextCursor = serializedFiles.length;
        break;
      }
      if (remainder.startsWith(`\n\n${marker}`)) {
        closingEnd = lineEnd;
        nextCursor = lineEnd + 2;
        break;
      }
      // Canonical producers choose a fence longer than any run in the file.
      // An earlier same-length fence is therefore ambiguous and must not let
      // the remaining attachment body escape into manual knowledge.
      return failClosed();
    }
    if (closingEnd === -1) return failClosed();

    files.push({ name, contentIncluded: false });
    cursor = nextCursor;
  }
  return { files, manualText };
};

const parseStructuredKnowledge = (knowledge) => {
  if (!knowledge || typeof knowledge !== 'object' || Array.isArray(knowledge)) {
    return { files: [], manualText: '' };
  }
  if (knowledge.text !== null && typeof knowledge.text !== 'string') {
    return { files: [], manualText: '' };
  }
  if (!Array.isArray(knowledge.files)) return { files: [], manualText: '' };
  if (
    (typeof knowledge.text === 'string' && knowledge.text.length > MAX_KNOWLEDGE_TEXT_CHARS)
    || knowledge.files.length > MAX_KNOWLEDGE_FILES
  ) return { files: [], manualText: '' };

  const files = [];
  for (const file of knowledge.files) {
    if (
      !file
      || typeof file !== 'object'
      || Array.isArray(file)
      || typeof file.name !== 'string'
      || !file.name.trim()
      || file.name.length > MAX_KNOWLEDGE_FILE_NAME_CHARS
      || /[\r\n]/.test(file.name)
    ) {
      return { files: [], manualText: '' };
    }
    files.push({ name: file.name, contentIncluded: false });
  }
  return {
    files,
    manualText: typeof knowledge.text === 'string' ? knowledge.text : '',
  };
};

const sanitizeMcpUrl = (value) => {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    const redacted = Boolean(
      url.username
      || url.password
      || (url.pathname && url.pathname !== '/')
      || url.search
      || url.hash
    );
    return { url: `${url.origin}/`, redacted };
  } catch {
    return undefined;
  }
};

const redactMcpServers = (servers) => (
  Array.isArray(servers)
    ? servers
      .filter((server) => server && typeof server === 'object' && typeof server.url === 'string')
      .map((server) => {
        const sanitizedUrl = sanitizeMcpUrl(server.url);
        if (!sanitizedUrl) return null;
        return {
          ...(typeof server.id === 'string' ? { id: server.id } : {}),
          ...(typeof server.name === 'string' ? { name: server.name } : {}),
          url: sanitizedUrl.url,
          ...(typeof server.transport === 'string' ? { transport: server.transport } : {}),
          // A credential-bearing URL is redacted before it leaves the hosted
          // adapter, but still needs to be surfaced as credentialed metadata.
          hasCredential: server.hasCredential === true || sanitizedUrl.redacted,
        };
      })
      .filter(Boolean)
    : []
);

export const mapRemoteAssistant = (assistant, permissions = {}) => {
  const source = assistant?.source === 'user' ? 'user' : 'remote_config';
  const kind = source === 'user' ? 'custom' : 'built_in';
  const knowledge = Object.prototype.hasOwnProperty.call(assistant || {}, 'knowledge')
    ? parseStructuredKnowledge(assistant.knowledge)
    : parseAssistantContext(String(assistant?.context || ''));
  const editableFields = permissions.update
    ? (kind === 'custom' ? CUSTOM_EDITABLE_FIELDS : BUILT_IN_EDITABLE_FIELDS)
    : [];
  return {
    assistantRef: String(assistant?.id || ''),
    id: String(assistant?.id || ''),
    kind,
    name: String(assistant?.name || ''),
    instructions: String(assistant?.systemPrompt || ''),
    category: assistant?.category == null ? null : String(assistant.category),
    realtimePrompt: assistant?.realtimePrompt == null ? null : String(assistant.realtimePrompt),
    followUpPrompt: assistant?.followUpPrompt == null ? null : String(assistant.followUpPrompt),
    emailPrompt: assistant?.emailPrompt == null ? null : String(assistant.emailPrompt),
    requireCertainty: assistant?.requireCertainty === true,
    knowledge: {
      text: knowledge.manualText || null,
      files: knowledge.files,
    },
    mcpServers: redactMcpServers(assistant?.mcpServers),
    permissions: {
      read: permissions.read === true,
      update: permissions.update === true,
      delete: permissions.delete === true,
      editableFields,
    },
  };
};

const mapRosterEntry = (entry) => {
  const kind = entry?.source === 'user' ? 'custom' : 'built_in';
  const permissions = entry?.permissions || {};
  return {
    id: String(entry?.id || ''),
    assistantRef: String(entry?.id || ''),
    name: String(entry?.name || ''),
    kind,
    selected: entry?.selected === true,
    revision: String(entry?.revision || ''),
    permissions: {
      read: permissions.read === true,
      update: permissions.update === true,
      delete: permissions.delete === true,
      editableFields: permissions.update
        ? (kind === 'custom' ? CUSTOM_EDITABLE_FIELDS : BUILT_IN_EDITABLE_FIELDS)
        : [],
    },
  };
};

const mapOperation = (operation, requestId) => {
  const status = String(operation?.status || 'failed');
  const mapped = {
    version: 1,
    requestId: requestId || String(operation?.operation_id || ''),
    operationId: String(operation?.operation_id || ''),
    operation: operation?.type === 'delete' ? 'delete_assistant' : 'update_assistant',
    status,
    target: { assistantRef: String(operation?.assistant_id || '') },
    expectedRevision: String(operation?.expected_revision || ''),
    createdAt: operation?.created_at,
    updatedAt: operation?.resolved_at || operation?.created_at,
    expiresAt: operation?.expires_at,
  };
  if (operation?.assistant_before) {
    mapped.assistantBefore = mapRemoteAssistant(operation.assistant_before, {
      read: true,
      update: operation.type === 'update',
      delete: operation.type === 'delete',
    });
  }
  if (operation?.assistant) {
    mapped.assistant = mapRemoteAssistant(operation.assistant, {
      read: true,
      update: true,
      delete: operation.assistant.source === 'user',
    });
  }
  if (operation?.revision) mapped.currentRevision = String(operation.revision);
  if (operation?.error) {
    mapped.error = {
      code: String(operation.error).toUpperCase(),
      message: String(operation.error).replaceAll('_', ' '),
      retryable: status !== 'cancelled',
    };
  }
  return mapped;
};

export const createAssistantRemoteApi = ({
  bearerToken,
  apiUrl = process.env.ASSISTANT_REMOTE_API_URL || DEFAULT_API_URL,
  fetchFn = globalThis.fetch,
} = {}) => {
  if (typeof fetchFn !== 'function') throw new Error('A fetch implementation is required.');
  const baseUrl = String(apiUrl).replace(/\/$/, '');

  const request = async (path, { method = 'GET', body } = {}) => {
    let response;
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), REMOTE_TIMEOUT_MS);
    try {
      response = await fetchFn(`${baseUrl}${path}`, {
        method,
        signal: abortController.signal,
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const challenge = response.headers.get('www-authenticate') || undefined;
      let payload = {};
      let payloadInvalid = false;
      try {
        payload = JSON.parse(await readResponseText(response));
      } catch {
        // A malformed upstream error must not echo response bodies or credentials.
        payloadInvalid = true;
      }
      if (response.ok && payloadInvalid) {
        throw new AssistantRemoteApiError('The Perssua assistant service returned an invalid response.', {
          status: 502,
          code: 'invalid_remote_response',
        });
      }
      if (!response.ok) {
        throw new AssistantRemoteApiError(
          typeof payload.message === 'string' ? payload.message : 'The Perssua assistant service rejected the request.',
          {
            status: response.status,
            code: typeof payload.error === 'string' ? payload.error : 'remote_api_error',
            challenge,
          },
        );
      }
      return payload;
    } catch (error) {
      if (error instanceof AssistantRemoteApiError) throw error;
      throw new AssistantRemoteApiError('The Perssua assistant service is unavailable.', {
        status: 503,
        code: 'remote_unavailable',
      });
    } finally {
      clearTimeout(timeout);
    }
  };

  return {
    async listAssistants() {
      const payload = await request('/v1/assistants');
      const assistants = Array.isArray(payload.assistants)
        ? payload.assistants.map(mapRosterEntry)
        : [];
      return {
        version: 2,
        available: true,
        selectedAssistantId: assistants.find((assistant) => assistant.selected)?.id || null,
        snapshotRevision: null,
        updatedAt: null,
        assistants,
      };
    },

    async getAssistant(assistantRef, requestId) {
      const payload = await request(`/v1/assistants/${encodeURIComponent(assistantRef)}`);
      return {
        version: 1,
        requestId,
        operation: 'get_assistant',
        status: 'completed',
        target: { assistantRef: String(payload.assistant?.id || assistantRef) },
        currentRevision: String(payload.revision || ''),
        assistant: {
          ...mapRemoteAssistant(payload.assistant, payload.permissions),
          revision: String(payload.revision || ''),
        },
      };
    },

    async updateAssistant({ assistantRef, expectedRevision, patch, requestId }) {
      const payload = await request('/v1/operations', {
        method: 'POST',
        body: {
          type: 'update',
          assistant_id: assistantRef,
          expected_revision: expectedRevision,
          idempotency_key: requestId,
          // The backend intentionally accepts the same frozen vocabulary as
          // the public MCP tool, including knowledgeText's file-preserving
          // semantics and explicit null-only clears.
          patch,
        },
      });
      return mapOperation(payload, requestId);
    },

    async deleteAssistant({ assistantRef, expectedRevision, requestId }) {
      const payload = await request('/v1/operations', {
        method: 'POST',
        body: {
          type: 'delete',
          assistant_id: assistantRef,
          expected_revision: expectedRevision,
          idempotency_key: requestId,
        },
      });
      return mapOperation(payload, requestId);
    },

    async getOperation(operationId) {
      const payload = await request(`/v1/operations/${encodeURIComponent(operationId)}`);
      return mapOperation(payload, operationId);
    },
  };
};

export const ASSISTANT_REMOTE_API_DEFAULT_URL = DEFAULT_API_URL;
