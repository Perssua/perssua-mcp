const DEFAULT_API_URL =
  'https://us-central1-strawberry-cb687.cloudfunctions.net/assistantRemoteApi';
const MAX_REMOTE_RESPONSE_BYTES = 2 * 1024 * 1024;
const REMOTE_TIMEOUT_MS = 15_000;

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
  const files = [];
  const fileRegex = /### File: (.+?)\n(`{3,})\n([\s\S]*?)\n\2/g;
  let match;
  let lastIndex = 0;
  let manualText = '';
  while ((match = fileRegex.exec(contextString)) !== null) {
    if (match.index > lastIndex) {
      const preceding = contextString.substring(lastIndex, match.index).trim();
      if (preceding) manualText += `${manualText ? '\n\n' : ''}${preceding}`;
    }
    files.push({ name: match[1], contentIncluded: false });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < contextString.length) {
    const trailing = contextString.substring(lastIndex).trim();
    if (trailing) manualText += `${manualText ? '\n\n' : ''}${trailing}`;
  }
  if (files.length === 0 && contextString.trim()) manualText = contextString.trim();
  return { files, manualText };
};

const redactMcpServers = (servers) => (
  Array.isArray(servers)
    ? servers
      .filter((server) => server && typeof server === 'object' && typeof server.url === 'string')
      .map((server) => ({
        ...(typeof server.id === 'string' ? { id: server.id } : {}),
        ...(typeof server.name === 'string' ? { name: server.name } : {}),
        url: server.url,
        ...(typeof server.transport === 'string' ? { transport: server.transport } : {}),
        ...(typeof server.metadata === 'string' ? { metadata: server.metadata } : {}),
        hasCredential: server.hasCredential === true,
      }))
    : []
);

export const mapRemoteAssistant = (assistant, permissions = {}) => {
  const source = assistant?.source === 'user' ? 'user' : 'remote_config';
  const kind = source === 'user' ? 'custom' : 'built_in';
  const knowledge = parseAssistantContext(String(assistant?.context || ''));
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
    selected: false,
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
    } catch {
      throw new AssistantRemoteApiError('The Perssua assistant service is unavailable.', {
        status: 503,
        code: 'remote_unavailable',
      });
    } finally {
      clearTimeout(timeout);
    }
    const challenge = response.headers.get('www-authenticate') || undefined;
    let payload = {};
    let payloadInvalid = false;
    try {
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_REMOTE_RESPONSE_BYTES) {
        throw new Error('Response too large');
      }
      const responseText = await response.text();
      if (Buffer.byteLength(responseText, 'utf8') > MAX_REMOTE_RESPONSE_BYTES) {
        throw new Error('Response too large');
      }
      payload = JSON.parse(responseText);
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
  };

  return {
    async listAssistants() {
      const payload = await request('/v1/assistants');
      return {
        version: 2,
        available: true,
        selectedAssistantId: null,
        snapshotRevision: null,
        updatedAt: null,
        assistants: Array.isArray(payload.assistants) ? payload.assistants.map(mapRosterEntry) : [],
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
