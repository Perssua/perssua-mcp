/**
 * Official Perssua MCP server.
 *
 * Exposes local tools that let MCP clients manage Perssua assistants and start
 * a Perssua session with a chosen assistant and context.
 *
 * Local mode (stdio): writes a single-use handoff file into the app's
 * external-handoffs directory and opens perssua://session/start?handoff=<id>.
 * Local HTTP mode exposes the same tools to a client that can reach this
 * machine. The isolated OAuth-protected hosted surface is implemented by
 * remoteServer.js and hostedHttpTransport.js.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { bridgeSupports, getAppStatus, readAssistantsRoster, resolveBridge } from './bridge.js';
import {
  ASSISTANT_OPERATION_CAPABILITIES,
  ASSISTANT_OPERATION_ID_PATTERN,
  buildAssistantOperationDeepLink,
  buildAssistantOperationRequest,
  buildPendingAssistantOperationResult,
  assistantOperationRequestExists,
  readAssistantOperationResult,
  writeAssistantOperationRequest,
} from './assistantOperations.js';
import {
  HANDOFF_LIMITS,
  buildHandoffPayload,
  buildLegacyPromptProjection,
  writeHandoffFile,
} from './handoffPayload.js';
import {
  buildHandoffDeepLink,
  buildInlineDeepLink,
  buildLauncherUrl,
  openDeepLink,
} from './deepLink.js';

export const SERVER_NAME = 'perssua';
export const SERVER_VERSION = '0.2.0';

const textResult = (lines, { isError = false, structuredContent } = {}) => ({
  isError,
  ...(structuredContent ? { structuredContent } : {}),
  content: [
    {
      type: 'text',
      text: Array.isArray(lines) ? lines.filter(Boolean).join('\n') : String(lines),
    },
  ],
});

const describeAssistants = (roster) => {
  if (!roster.available) {
    return [
      'No assistants roster found yet.',
      'Open the Perssua app once while signed in — it exports the assistant list for integrations automatically.',
    ];
  }
  if (roster.assistants.length === 0) {
    return ['The roster is empty — create an assistant in Perssua first.'];
  }
  return [
    `Assistants (${roster.assistants.length}):`,
    ...roster.assistants.map((assistant) => {
      const selected = assistant.selected ? ' (currently selected)' : '';
      const metadata = [
        assistant.id ? `id: ${assistant.id}` : null,
        assistant.assistantRef ? `assistantRef: ${assistant.assistantRef}` : null,
        assistant.kind ? `kind: ${assistant.kind}` : null,
        assistant.revision ? `revision: ${assistant.revision}` : null,
        assistant.permissions
          ? `permissions: ${['read', 'update', 'delete'].filter((key) => assistant.permissions[key]).join('/') || 'none'}`
          : null,
      ].filter(Boolean).join(', ');
      return `- ${assistant.name || '(unnamed)'}${metadata ? ` — ${metadata}` : ''}${selected}`;
    }),
    roster.version === 2 && roster.snapshotRevision
      ? `Snapshot revision: ${roster.snapshotRevision}`
      : null,
    roster.version !== 2
      ? 'This app exported a legacy roster. Update Perssua before reading or changing assistant definitions.'
      : null,
    roster.updatedAt ? `Last synced: ${roster.updatedAt}` : null,
  ];
};

const getBridgeBinding = (bridge) => ({
  bridgeSessionId:
    typeof bridge?.bridge?.bridgeSessionId === 'string' ? bridge.bridge.bridgeSessionId : '',
  accountScope:
    typeof bridge?.bridge?.accountScope === 'string' ? bridge.bridge.accountScope : '',
});

const buildToolFailure = ({ requestId, operation, code, message, status = 'failed' }) => {
  const structuredContent = {
    version: 1,
    ...(requestId ? { requestId } : {}),
    ...(operation ? { operation } : {}),
    status,
    error: { code, message, retryable: status !== 'cancelled' },
  };
  return textResult([message], { isError: status !== 'pending_authentication', structuredContent });
};

const summarizeOperationResult = (result) => {
  const lines = [
    `requestId: ${result.requestId}`,
    result.operation ? `operation: ${result.operation}` : null,
    `status: ${result.status}`,
  ];
  if (result.status === 'pending_app') {
    lines.push('Perssua has not completed this request yet. Use get_operation with the same requestId.');
  } else if (result.status === 'pending_authentication') {
    lines.push('Open Perssua and sign in; the request is waiting for authentication.');
  } else if (result.status === 'pending_confirmation') {
    lines.push('Perssua is waiting for the user to confirm this request in the app.');
  } else if (result.status === 'completed') {
    lines.push('Perssua persisted and verified the operation.');
  } else if (result.status === 'conflict') {
    lines.push('The target or revision is stale. Read the assistant again before retrying with a new requestId.');
  } else if (result.status === 'cancelled') {
    lines.push('The user cancelled the operation in Perssua.');
  } else if (result.status === 'failed') {
    lines.push('Perssua could not complete the operation.');
  }
  if (result.error?.message) lines.push(`${result.error.code || 'ERROR'}: ${result.error.message}`);
  if (result.manualDeepLink) lines.push(`Open manually: ${result.manualDeepLink}`);
  return lines;
};

const operationResult = (result) => textResult(summarizeOperationResult(result), {
  isError: ['conflict', 'cancelled', 'failed'].includes(result.status),
  structuredContent: result,
});

const resolveAssistantMetadata = (roster, reference) => {
  if (!roster?.available || roster.version !== 2) {
    return { code: 'APP_UPDATE_REQUIRED', error: 'A version 2 assistants roster is not available.' };
  }
  const query = String(reference || '').trim();
  if (!query) return { code: 'INVALID_REQUEST', error: 'assistant is required.' };

  const direct = roster.assistants.filter((assistant) => (
    assistant.assistantRef === query || assistant.id === query
  ));
  if (direct.length === 1) return { assistant: direct[0] };
  if (direct.length > 1) {
    return { code: 'AMBIGUOUS_ASSISTANT', error: 'The assistant reference is ambiguous.' };
  }

  const normalized = query.toLocaleLowerCase();
  const byName = roster.assistants.filter(
    (assistant) => assistant.name.toLocaleLowerCase() === normalized,
  );
  if (byName.length === 1) return { assistant: byName[0] };
  if (byName.length > 1) {
    return {
      code: 'AMBIGUOUS_ASSISTANT',
      error: 'More than one assistant has that name. Use its assistantRef.',
    };
  }
  return { code: 'ASSISTANT_NOT_FOUND', error: `No assistant matches "${query}".` };
};

const validateMutationMetadata = ({ roster, assistantRef, operation, patch }) => {
  if (!roster?.available || roster.version !== 2) {
    return { code: 'APP_UPDATE_REQUIRED', message: 'A version 2 assistants roster is not available.' };
  }
  const assistant = roster.assistants.find((entry) => entry.assistantRef === assistantRef);
  if (!assistant) {
    return { code: 'ASSISTANT_NOT_FOUND', message: 'assistantRef is not present in the current account-bound roster.' };
  }
  const permission = operation === 'delete_assistant' ? 'delete' : 'update';
  if (!assistant.permissions?.[permission]) {
    return {
      code: 'PERMISSION_DENIED',
      message: operation === 'delete_assistant'
        ? 'This assistant cannot be deleted. Built-in assistants never grant delete permission.'
        : 'This assistant does not grant update permission.',
    };
  }
  if (operation === 'update_assistant') {
    const editable = new Set(assistant.permissions.editableFields || []);
    const blocked = Object.keys(patch || {}).filter((field) => !editable.has(field));
    if (blocked.length > 0) {
      return {
        code: 'PERMISSION_DENIED',
        message: `The current assistant permissions do not allow changing: ${blocked.join(', ')}.`,
      };
    }
  }
  return { assistant };
};

const requestIdSchema = z
  .string()
  .regex(ASSISTANT_OPERATION_ID_PATTERN)
  .describe('Caller-generated idempotency key (8-64 URL-safe characters). Reuse it only for an exact retry.');

const sourceSchema = z
  .string()
  .max(32)
  .optional()
  .describe('Calling product, e.g. "claude", "chatgpt", or "cursor".');

const assistantPatchSchema = z.object({
  name: z.string().min(1).max(200).optional()
    .describe('New custom-assistant name. Omit to keep it unchanged.'),
  instructions: z.string().min(1).max(32000).optional()
    .describe('New system instructions. Omit to keep them unchanged.'),
  category: z.string().min(1).max(64).nullable().optional()
    .describe('New category, or null to restore the default category.'),
  realtimePrompt: z.string().min(1).max(32000).nullable().optional()
    .describe('New Notch realtime prompt, or null to restore the default.'),
  followUpPrompt: z.string().min(1).max(32000).nullable().optional()
    .describe('New follow-up prompt, or null to restore the default.'),
  emailPrompt: z.string().min(1).max(32000).nullable().optional()
    .describe('New email/summary prompt, or null to restore the default.'),
  requireCertainty: z.boolean().optional()
    .describe('Whether responses require certainty. Omit to keep it unchanged.'),
  knowledgeText: z.string().min(1).max(128000).nullable().optional()
    .describe('New free-text knowledge, or null to clear it. Attached knowledge files are always preserved.'),
}).describe(
  'Partial assistant definition. Omitted fields remain unchanged; null explicitly clears only nullable fields. Session-only fields and knowledge-file mutation are not accepted.',
);

const operationOutputSchema = z.object({
  version: z.number().int(),
  requestId: z.string().optional(),
  operation: z.enum([
    'get_assistant',
    'update_assistant',
    'delete_assistant',
    'get_operation',
  ]).optional(),
  status: z.enum([
    'pending_app',
    'pending_authentication',
    'pending_confirmation',
    'completed',
    'conflict',
    'cancelled',
    'failed',
  ]),
  bridgeSessionId: z.string().optional(),
  accountScope: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  target: z.object({ assistantRef: z.string() }).passthrough().optional(),
  expectedRevision: z.string().optional(),
  currentRevision: z.string().optional(),
  assistant: z.record(z.unknown()).optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
  }).passthrough().optional(),
  launched: z.boolean().optional(),
  requestReused: z.boolean().optional(),
  launchError: z.string().optional(),
  manualDeepLink: z.string().optional(),
}).passthrough();

const listAssistantsOutputSchema = z.object({
  version: z.number().int().nullable(),
  available: z.boolean(),
  selectedAssistantId: z.string().nullable(),
  snapshotRevision: z.string().nullable(),
  updatedAt: z.string().nullable(),
  assistants: z.array(z.object({
    id: z.string(),
    name: z.string(),
    assistantRef: z.string().optional(),
    kind: z.enum(['custom', 'built_in']).optional(),
    selected: z.boolean(),
    revision: z.string().optional(),
    permissions: z.object({
      read: z.boolean(),
      update: z.boolean(),
      delete: z.boolean(),
      editableFields: z.array(z.string()),
    }).optional(),
  })),
});

/**
 * Create the MCP server instance. `options` lets tests inject fs/spawn-free
 * implementations; production callers use the defaults.
 */
export const createPerssuaMcpServer = ({
  resolveBridgeFn = resolveBridge,
  getAppStatusFn = getAppStatus,
  readRosterFn = readAssistantsRoster,
  writeHandoffFn = writeHandoffFile,
  writeOperationRequestFn = writeAssistantOperationRequest,
  readOperationResultFn = readAssistantOperationResult,
  operationRequestExistsFn = assistantOperationRequestExists,
  openDeepLinkFn = openDeepLink,
  allowLaunch = true,
} = {}) => {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const requireOperationBridge = ({ bridge, capability, requestId, operation }) => {
    if (!bridge.found) {
      return buildToolFailure({
        requestId,
        operation,
        code: 'APP_NOT_INSTALLED',
        message: 'Perssua is not installed or has not been opened yet. Install it from https://perssua.com, open it once, and retry.',
      });
    }
    if (
      !bridgeSupports(bridge, ASSISTANT_OPERATION_CAPABILITIES.operations)
      || !bridgeSupports(bridge, capability)
    ) {
      return buildToolFailure({
        requestId,
        operation,
        code: 'APP_UPDATE_REQUIRED',
        message: 'This Perssua build does not advertise the assistant-management capability required by this tool. Update the app, open it once, and retry.',
      });
    }
    const binding = getBridgeBinding(bridge);
    if (!binding.accountScope) {
      return buildToolFailure({
        requestId,
        operation,
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Perssua is not currently advertising an authenticated account. Open the app, sign in, and retry with the same requestId.',
        status: 'pending_authentication',
      });
    }
    if (!binding.bridgeSessionId) {
      return buildToolFailure({
        requestId,
        operation,
        code: 'APP_NOT_READY',
        message: 'Perssua has not finished initializing its assistant-management bridge. Open the app and retry.',
      });
    }
    return { binding };
  };

  const submitAssistantOperation = async ({
    operation,
    capability,
    requestId,
    assistantRef,
    expectedRevision,
    patch,
    source,
  }) => {
    const bridge = resolveBridgeFn();
    const readiness = requireOperationBridge({ bridge, capability, requestId, operation });
    if (!readiness.binding) return readiness;

    let request;
    let writeResult;
    try {
      request = buildAssistantOperationRequest({
        requestId,
        operation,
        ...readiness.binding,
        assistantRef,
        expectedRevision,
        patch,
        source: source || process.env.PERSSUA_MCP_SOURCE || 'mcp',
      });
      writeResult = writeOperationRequestFn(bridge.assistantOperationsDir, request);
    } catch (error) {
      return buildToolFailure({
        requestId,
        operation,
        code: error.code || 'INVALID_REQUEST',
        message: error.message,
        status: error.code === 'REQUEST_ID_REUSED' ? 'conflict' : 'failed',
      });
    }

    const deepLink = buildAssistantOperationDeepLink(requestId, {
      protocol: bridge.bridge?.protocol || 'perssua',
    });
    let launched = false;
    let launchError = null;
    if (allowLaunch) {
      try {
        launched = await openDeepLinkFn(deepLink);
      } catch (error) {
        launchError = error.message;
      }
    }

    try {
      const result = readOperationResultFn(
        bridge.assistantOperationsDir,
        requestId,
        { accountScope: readiness.binding.accountScope },
      );
      if (result) return operationResult(result);
    } catch (error) {
      return buildToolFailure({
        requestId,
        operation,
        code: error.code || 'INVALID_RESULT',
        message: error.message,
      });
    }

    return operationResult(buildPendingAssistantOperationResult(request, {
      launched,
      requestReused: writeResult.reused,
      ...(launchError ? { launchError } : {}),
      manualDeepLink: deepLink,
    }));
  };

  server.registerTool(
    'app_status',
    {
      title: 'Perssua app status',
      description:
        'Check whether the Perssua desktop app is installed and running on this machine, and where its integration bridge lives.',
      inputSchema: {},
      annotations: { title: 'Perssua app status', readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const status = getAppStatusFn();
      return textResult([
        `installed: ${status.installed}`,
        `running: ${status.running}`,
        `appVersion: ${status.appVersion || 'unknown'}`,
        `bridgeSource: ${status.bridgeSource}`,
        `userDataDir: ${status.userDataDir}`,
        `capabilities: ${status.capabilities?.length ? status.capabilities.join(', ') : '(none advertised — app may predate connectors)'}`,
        status.installed
          ? null
          : 'Perssua was not found on this machine. Download it from https://perssua.com and launch it once.',
      ]);
    },
  );

  server.registerTool(
    'list_assistants',
    {
      title: 'List Perssua assistants',
      description:
        "List the user's configured Perssua assistants and account-bound metadata. Version 2 rosters include opaque assistantRef/revision tokens and explicit read/update/delete permissions, but never prompts or knowledge.",
      inputSchema: {},
      outputSchema: listAssistantsOutputSchema,
      annotations: { title: 'List Perssua assistants', readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const roster = readRosterFn();
      return textResult(describeAssistants(roster), {
        structuredContent: {
          version: roster.version,
          available: roster.available,
          selectedAssistantId: roster.selectedAssistantId,
          snapshotRevision: roster.snapshotRevision,
          updatedAt: roster.updatedAt,
          assistants: roster.assistants,
        },
      });
    },
  );

  server.registerTool(
    'get_assistant',
    {
      title: 'Read a Perssua assistant',
      description:
        'Ask the authenticated Perssua app for the current editable definition, permissions, attached-file metadata, and account-bound revision of one assistant. Accepts an assistantRef, current id, or unique exact name from list_assistants. This never reads private app storage directly.',
      inputSchema: {
        assistant: z.string().min(1).max(256)
          .describe('Opaque assistantRef (preferred), current id, or unique exact assistant name from list_assistants.'),
        requestId: requestIdSchema,
        source: sourceSchema,
      },
      outputSchema: operationOutputSchema,
      annotations: {
        title: 'Read a Perssua assistant',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ assistant, requestId, source }) => {
      const roster = readRosterFn();
      const resolved = resolveAssistantMetadata(roster, assistant);
      if (!resolved.assistant) {
        return buildToolFailure({
          requestId,
          operation: 'get_assistant',
          code: resolved.code,
          message: resolved.error,
        });
      }
      if (!resolved.assistant.permissions?.read) {
        return buildToolFailure({
          requestId,
          operation: 'get_assistant',
          code: 'PERMISSION_DENIED',
          message: 'This assistant is not readable through the current Perssua integration permissions.',
        });
      }
      return submitAssistantOperation({
        operation: 'get_assistant',
        capability: ASSISTANT_OPERATION_CAPABILITIES.read,
        requestId,
        assistantRef: resolved.assistant.assistantRef,
        source,
      });
    },
  );

  server.registerTool(
    'update_assistant',
    {
      title: 'Update a Perssua assistant',
      description:
        'Submit a revision-checked assistant patch for confirmation and persistence in the authenticated Perssua app. Use assistantRef and expectedRevision from get_assistant/list_assistants. Omitted fields stay unchanged; null clears nullable fields. knowledgeText changes preserve attached files.',
      inputSchema: {
        assistantRef: z.string().min(1).max(256)
          .describe('Exact opaque assistantRef returned by list_assistants or get_assistant.'),
        expectedRevision: z.string().min(1).max(256)
          .describe('Exact revision returned by the latest list_assistants or get_assistant result.'),
        patch: assistantPatchSchema,
        requestId: requestIdSchema,
        source: sourceSchema,
      },
      outputSchema: operationOutputSchema,
      annotations: {
        title: 'Update a Perssua assistant',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ assistantRef, expectedRevision, patch, requestId, source }) => {
      const validation = validateMutationMetadata({
        roster: readRosterFn(),
        assistantRef,
        operation: 'update_assistant',
        patch,
      });
      if (!validation.assistant) {
        return buildToolFailure({
          requestId,
          operation: 'update_assistant',
          code: validation.code,
          message: validation.message,
        });
      }
      return submitAssistantOperation({
        operation: 'update_assistant',
        capability: ASSISTANT_OPERATION_CAPABILITIES.update,
        requestId,
        assistantRef,
        expectedRevision,
        patch,
        source,
      });
    },
  );

  server.registerTool(
    'delete_assistant',
    {
      title: 'Delete a Perssua assistant',
      description:
        'Submit a revision-checked deletion for confirmation and persistence in the authenticated Perssua app. Only custom assistants whose current metadata grants delete permission can be deleted; built-ins cannot be deleted.',
      inputSchema: {
        assistantRef: z.string().min(1).max(256)
          .describe('Exact opaque assistantRef returned by list_assistants or get_assistant.'),
        expectedRevision: z.string().min(1).max(256)
          .describe('Exact revision returned by the latest list_assistants or get_assistant result.'),
        requestId: requestIdSchema,
        source: sourceSchema,
      },
      outputSchema: operationOutputSchema,
      annotations: {
        title: 'Delete a Perssua assistant',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ assistantRef, expectedRevision, requestId, source }) => {
      const validation = validateMutationMetadata({
        roster: readRosterFn(),
        assistantRef,
        operation: 'delete_assistant',
      });
      if (!validation.assistant) {
        return buildToolFailure({
          requestId,
          operation: 'delete_assistant',
          code: validation.code,
          message: validation.message,
        });
      }
      return submitAssistantOperation({
        operation: 'delete_assistant',
        capability: ASSISTANT_OPERATION_CAPABILITIES.delete,
        requestId,
        assistantRef,
        expectedRevision,
        source,
      });
    },
  );

  server.registerTool(
    'get_operation',
    {
      title: 'Get a Perssua assistant operation',
      description:
        'Read the latest app-authored status for a get/update/delete assistant request. Details are returned only when the receipt belongs to the account currently authenticated in Perssua.',
      inputSchema: { requestId: requestIdSchema },
      outputSchema: operationOutputSchema,
      annotations: {
        title: 'Get a Perssua assistant operation',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ requestId }) => {
      const bridge = resolveBridgeFn();
      const readiness = requireOperationBridge({
        bridge,
        capability: ASSISTANT_OPERATION_CAPABILITIES.operations,
        requestId,
        operation: 'get_operation',
      });
      if (!readiness.binding) return readiness;

      let result;
      try {
        result = readOperationResultFn(
          bridge.assistantOperationsDir,
          requestId,
          { accountScope: readiness.binding.accountScope },
        );
      } catch (error) {
        return buildToolFailure({
          requestId,
          operation: 'get_operation',
          code: error.code === 'RESULT_SCOPE_MISMATCH'
            ? 'ACCOUNT_SCOPE_MISMATCH'
            : (error.code || 'INVALID_RESULT'),
          message: error.code === 'RESULT_SCOPE_MISMATCH'
            ? 'No operation details are available for the account currently authenticated in Perssua.'
            : error.message,
        });
      }
      if (result) return operationResult(result);

      if (operationRequestExistsFn(bridge.assistantOperationsDir, requestId)) {
        return operationResult({
          version: 1,
          requestId,
          status: 'pending_app',
        });
      }
      return buildToolFailure({
        requestId,
        operation: 'get_operation',
        code: 'OPERATION_NOT_FOUND',
        message: 'No request or app-authored receipt exists for this requestId in the current Perssua bridge.',
      });
    },
  );

  server.registerTool(
    'start_session',
    {
      title: 'Start a Perssua session',
      description:
        'Launch the Perssua desktop app and start a session with an optional assistant, an initial prompt, free-text context, and text files attached as context. ' +
        'Runs on the same machine as the Perssua app; for remote/hosted setups use create_session_link instead. ' +
        'Files must be paths to local text files (binary files are skipped). ' +
        'To start with a NEW assistant that does not exist yet, use create_assistant instead.',
      annotations: {
        title: 'Start a Perssua session',
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        assistant: z
          .string()
          .max(200)
          .optional()
          .describe('Assistant to activate, by name or id (see list_assistants). Omit to keep the current one.'),
        prompt: z
          .string()
          .max(16000)
          .optional()
          .describe('Initial user message for the session.'),
        context: z
          .string()
          .max(128000)
          .optional()
          .describe('Background context injected into the session (project notes, task description, decisions so far).'),
        files: z
          .array(z.string())
          .max(20)
          .optional()
          .describe('Local text-file paths whose contents are attached as session context.'),
        autoSubmit: z
          .boolean()
          .optional()
          .describe('Submit the prompt immediately (default true). When false, the prompt is prefilled for the user to review.'),
        source: z
          .string()
          .max(32)
          .optional()
          .describe('Calling product, e.g. "claude", "chatgpt", "grok". Defaults to the PERSSUA_MCP_SOURCE env var or "mcp".'),
      },
    },
    async ({ assistant, prompt, context, files, autoSubmit, source }) => {
      const bridge = resolveBridgeFn();
      const effectiveSource = source || process.env.PERSSUA_MCP_SOURCE || 'mcp';

      if (!bridge.found) {
        const inlineLink = buildInlineDeepLink({
          assistant,
          prompt,
          context,
          source: effectiveSource,
        });
        return textResult(
          [
            'Perssua does not appear to be installed on this machine (no bridge file or user-data directory found).',
            'Ask the user to install Perssua from https://perssua.com and open it once, then retry.',
            `Fallback link the user can open after installing: ${inlineLink}`,
          ],
          { isError: true },
        );
      }

      const { payload, warnings } = buildHandoffPayload({
        assistant,
        prompt,
        context,
        files,
        autoSubmit: autoSubmit !== false,
        source: effectiveSource,
      });

      let handoffPath;
      try {
        handoffPath = writeHandoffFn(bridge.handoffDir, payload);
      } catch (error) {
        return textResult(
          [`Could not write the session handoff: ${error.message}`],
          { isError: true },
        );
      }

      const deepLink = buildHandoffDeepLink(payload.id);
      let launched = false;
      let launchError = null;
      if (allowLaunch) {
        try {
          launched = await openDeepLinkFn(deepLink);
        } catch (error) {
          launchError = error.message;
        }
      }

      return textResult([
        launched
          ? 'Perssua session start requested — the app is opening with the handoff.'
          : `Handoff written to ${handoffPath}, but the app was not launched${launchError ? ` (${launchError})` : ''}.`,
        `Assistant: ${payload.assistant || '(keep current)'}`,
        payload.prompt ? `Prompt: ${payload.prompt.length} chars${payload.autoSubmit ? ' (auto-submits)' : ' (prefilled for review)'}` : null,
        payload.context ? `Context: ${payload.context.length} chars` : null,
        payload.files ? `Files attached: ${payload.files.map((file) => file.name).join(', ')}` : null,
        warnings.length > 0 ? `Warnings: ${warnings.join('; ')}` : null,
        !launched ? `The user can open this link manually: ${deepLink}` : null,
        !bridge.bridge
          ? 'Note: no integration bridge file was found, so the installed app may predate connectors — if Perssua opens but nothing happens, ask the user to update it from https://perssua.com.'
          : null,
      ]);
    },
  );

  server.registerTool(
    'create_assistant',
    {
      title: 'Create a Perssua assistant',
      description:
        'Create a new custom assistant in the Perssua desktop app with system, Notch, follow-up, and summary behavior, then open a session with it. ' +
        'BEFORE calling this, interview the user briefly so the assistant fits: (1) what is the assistant\'s goal / what sessions will it support, ' +
        '(2) how should it respond (tone, format, language), (3) what knowledge should it carry (notes, files, background), ' +
        '(4) what should the first session start with. Then write the instructions yourself from those answers. ' +
        'Knowledge text and files become the assistant\'s permanent context. sessionGoal is carried only with the first session and is never saved on the assistant. ' +
        'Runs on the same machine as the Perssua app.',
      annotations: {
        title: 'Create a Perssua assistant',
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(200)
          .describe('Assistant name shown in Perssua, e.g. "Interview Coach".'),
        instructions: z
          .string()
          .min(1)
          .max(32000)
          .describe('System prompt defining the assistant: goal, behavior, tone, and response format.'),
        category: z
          .string()
          .max(64)
          .optional()
          .describe('Optional category label for the assistants library.'),
        realtimePrompt: z.string().max(HANDOFF_LIMITS.assistantRealtimePromptChars).optional()
          .describe('Optional complete Notch realtime prompt. Blank uses Perssua\'s fallback.'),
        followUpPrompt: z.string().max(HANDOFF_LIMITS.assistantFollowUpPromptChars).optional()
          .describe('Optional prompt for clickable follow-up suggestions. Blank uses the default.'),
        emailPrompt: z.string().max(HANDOFF_LIMITS.assistantEmailPromptChars).optional()
          .describe('Optional prompt for summaries and end-of-session overview. Blank uses the default.'),
        requireCertainty: z.boolean().optional()
          .describe('Only reply when sufficiently certain.'),
        knowledge: z
          .string()
          .max(128000)
          .optional()
          .describe('Free-text knowledge stored with the assistant (background, notes, decisions).'),
        sessionGoal: z.string().max(HANDOFF_LIMITS.sessionGoalChars).optional()
          .describe('Goal only for this first session; it is not stored on the assistant.'),
        files: z
          .array(z.string())
          .max(20)
          .optional()
          .describe('Local text-file paths whose contents are stored as the assistant\'s knowledge.'),
        firstPrompt: z
          .string()
          .max(16000)
          .optional()
          .describe('First user message for the session that opens with the new assistant.'),
        autoSubmit: z
          .boolean()
          .optional()
          .describe('Submit the first prompt immediately (default true). When false, it is prefilled for review.'),
        source: z
          .string()
          .max(32)
          .optional()
          .describe('Calling product, e.g. "claude", "chatgpt", "grok". Defaults to the PERSSUA_MCP_SOURCE env var or "mcp".'),
      },
    },
    async ({ name, instructions, category, realtimePrompt, followUpPrompt, emailPrompt, requireCertainty, knowledge, sessionGoal, files, firstPrompt, autoSubmit, source }) => {
      const bridge = resolveBridgeFn();
      const effectiveSource = source || process.env.PERSSUA_MCP_SOURCE || 'mcp';
      const sessionScopedPrompt = buildLegacyPromptProjection(
        firstPrompt || '',
        String(sessionGoal || '').trim(),
      );

      if (sessionScopedPrompt.length > HANDOFF_LIMITS.promptChars) {
        return textResult(
          [
            `The session goal plus first prompt exceeds the ${HANDOFF_LIMITS.promptChars}-character compatibility limit.`,
            'Shorten either field and retry. Nothing was written or truncated.',
          ],
          { isError: true },
        );
      }

      if (!bridge.found) {
        return textResult(
          [
            'Perssua does not appear to be installed on this machine (no bridge file or user-data directory found).',
            'Ask the user to install Perssua from https://perssua.com and open it once, then retry.',
            'Assistant creation only works locally — inline links cannot create assistants.',
          ],
          { isError: true },
        );
      }

      // Older app builds silently drop the newAssistant field, so refuse
      // instead of sending a handoff that would lose the user's setup.
      if (!bridgeSupports(bridge, 'create-assistant')) {
        const appVersion = bridge.bridge?.appVersion;
        return textResult(
          [
            `The installed Perssua app${appVersion ? ` (v${appVersion})` : ''} does not support creating assistants from connectors yet.`,
            'Ask the user to update Perssua to the latest version (Perssua menu → Check for Updates, or download it from https://perssua.com), open it once, and retry.',
            'Tip: start_session still works — it opens a session with an existing assistant.',
          ],
          { isError: true },
        );
      }

      const { payload, warnings } = buildHandoffPayload({
        // Keep name/instructions/category as the permanent v1 projection.
        // Older Electron builds ignore the additive native prompt fields.
        newAssistant: { name, instructions, category, realtimePrompt, followUpPrompt, emailPrompt, requireCertainty },
        prompt: sessionScopedPrompt,
        context: knowledge,
        sessionGoal,
        files,
        autoSubmit: autoSubmit !== false,
        source: effectiveSource,
      });

      if (!payload.newAssistant) {
        return textResult(
          [`Could not build the assistant: ${warnings.join('; ') || 'name and instructions are required'}`],
          { isError: true },
        );
      }

      let handoffPath;
      try {
        handoffPath = writeHandoffFn(bridge.handoffDir, payload);
      } catch (error) {
        return textResult(
          [`Could not write the assistant handoff: ${error.message}`],
          { isError: true },
        );
      }

      const deepLink = buildHandoffDeepLink(payload.id);
      let launched = false;
      let launchError = null;
      if (allowLaunch) {
        try {
          launched = await openDeepLinkFn(deepLink);
        } catch (error) {
          launchError = error.message;
        }
      }

      return textResult([
        launched
          ? `Perssua is creating the assistant "${payload.newAssistant.name}" and opening a session with it.`
          : `Handoff written to ${handoffPath}, but the app was not launched${launchError ? ` (${launchError})` : ''}.`,
        `Instructions: ${payload.newAssistant.instructions.length} chars`,
        payload.context ? `Knowledge text: ${payload.context.length} chars` : null,
        payload.files ? `Knowledge files: ${payload.files.map((file) => file.name).join(', ')}` : null,
        payload.prompt ? `First prompt: ${payload.prompt.length} chars${payload.autoSubmit ? ' (auto-submits)' : ' (prefilled for review)'}` : null,
        warnings.length > 0 ? `Warnings: ${warnings.join('; ')}` : null,
        !launched ? `The user can open this link manually: ${deepLink}` : null,
      ]);
    },
  );

  server.registerPrompt(
    'new_assistant',
    {
      title: 'Create a new Perssua assistant (guided)',
      description:
        'Interview the user about the assistant they need, then create it in Perssua and start the first session.',
      argsSchema: {
        goal: z
          .string()
          .optional()
          .describe('What the user already said they want the assistant for, if anything.'),
      },
    },
    ({ goal }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              'I want to create a new custom assistant in Perssua. Guide me through it as a short interview — one question at a time, in my language:',
              '',
              '1. Goal: what should this assistant help me with? What kind of sessions will I use it in (meetings, interviews, studying, sales calls, ...)?',
              goal ? `   (I already said: ${goal} — confirm and refine instead of re-asking.)` : null,
              '2. Style: how should it respond? Tone, format (bullets vs prose), language, and how concise.',
              '3. Knowledge: what background should it always carry? Ask me for notes or local text files to attach. Keep the first-session goal separate.',
              '4. Optional native behavior: should it have a Notch realtime prompt, follow-up suggestions, an email/summary prompt, or require certainty?',
              '5. Kickoff: what should the first session start with?',
              '',
              'Then: write a strong system prompt from my answers (goal, behavior, tone, format, language), draft each requested native prompt separately, show the name, system prompt, optional native prompts, permanent knowledge, session goal, and first prompt for a quick OK, and call create_assistant. Keep the interview tight — skip questions I already answered.',
            ].filter((line) => line !== null).join('\n'),
          },
        },
      ],
    }),
  );

  server.registerTool(
    'create_session_link',
    {
      title: 'Create a Perssua session link',
      description:
        'Build a perssua:// deep link (and, when configured, an https launcher link) that starts a Perssua session with an assistant, prompt, and context when the user clicks it. ' +
        'Use this from hosted/remote connectors (ChatGPT, Grok, web chats) where this server cannot reach the user\'s machine. ' +
        'Inline links never auto-submit — the user reviews the prefilled prompt in Perssua.',
      annotations: {
        title: 'Create a Perssua session link',
        readOnlyHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        assistant: z
          .string()
          .max(200)
          .optional()
          .describe('Assistant to activate, by name or id.'),
        prompt: z
          .string()
          .max(4000)
          .optional()
          .describe('Initial user message (prefilled, not auto-submitted).'),
        context: z
          .string()
          .max(8000)
          .optional()
          .describe('Short background context injected into the session.'),
        source: z
          .string()
          .max(32)
          .optional()
          .describe('Calling product, e.g. "chatgpt" or "grok".'),
      },
    },
    async ({ assistant, prompt, context, source }) => {
      const deepLink = buildInlineDeepLink({
        assistant,
        prompt,
        context,
        source: source || process.env.PERSSUA_MCP_SOURCE || 'link',
      });
      const launcherUrl = buildLauncherUrl(deepLink);

      return textResult([
        'Share this link with the user — clicking it opens Perssua with the session prefilled:',
        launcherUrl || deepLink,
        launcherUrl ? `Direct app link (if the launcher page is unreachable): ${deepLink}` : null,
        'Note: the user must have Perssua installed (https://perssua.com).',
      ]);
    },
  );

  return server;
};
