import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { AssistantRemoteApiError, createAssistantRemoteApi } from './remoteApi.js';

export const REMOTE_SERVER_NAME = 'perssua-hosted';
export const REMOTE_SERVER_VERSION = '0.2.0';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const requestIdSchema = z.string().regex(REQUEST_ID_PATTERN);
const sourceSchema = z.string().max(32).optional();
const nonBlankString = (max) => z.string().min(1).max(max).refine((value) => value.trim().length > 0);
const patchSchema = z.object({
  name: nonBlankString(200).optional(),
  instructions: nonBlankString(32000).optional(),
  category: nonBlankString(64).nullable().optional(),
  realtimePrompt: nonBlankString(32000).nullable().optional(),
  followUpPrompt: nonBlankString(32000).nullable().optional(),
  emailPrompt: nonBlankString(32000).nullable().optional(),
  requireCertainty: z.boolean().optional(),
  knowledgeText: nonBlankString(128000).nullable().optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0, 'patch must not be empty');

const inputSchemas = {
  list_assistants: z.object({}).strict(),
  get_assistant: z.object({
    assistant: z.string().min(1).max(256),
    requestId: requestIdSchema,
    source: sourceSchema,
  }).strict(),
  update_assistant: z.object({
    assistantRef: z.string().min(1).max(256),
    expectedRevision: z.string().min(1).max(256),
    patch: patchSchema,
    requestId: requestIdSchema,
    source: sourceSchema,
  }).strict(),
  delete_assistant: z.object({
    assistantRef: z.string().min(1).max(256),
    expectedRevision: z.string().min(1).max(256),
    requestId: requestIdSchema,
    source: sourceSchema,
  }).strict(),
  get_operation: z.object({
    requestId: z.string().min(1).max(64),
  }).strict(),
};

const jsonObject = (properties = {}, required = []) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  ...(required.length ? { required } : {}),
});

const requestIdProperty = {
  type: 'string',
  pattern: '^[A-Za-z0-9_-]{8,64}$',
  description: 'Caller-generated idempotency key. Reuse it only for an exact retry.',
};

const sourceProperty = {
  type: 'string',
  maxLength: 32,
  description: 'Optional calling product label. It never changes account or authorization scope.',
};

const patchJsonSchema = jsonObject({
  name: { type: 'string', minLength: 1, maxLength: 200 },
  instructions: { type: 'string', minLength: 1, maxLength: 32000 },
  category: { anyOf: [{ type: 'string', minLength: 1, maxLength: 64 }, { type: 'null' }] },
  realtimePrompt: { anyOf: [{ type: 'string', minLength: 1, maxLength: 32000 }, { type: 'null' }] },
  followUpPrompt: { anyOf: [{ type: 'string', minLength: 1, maxLength: 32000 }, { type: 'null' }] },
  emailPrompt: { anyOf: [{ type: 'string', minLength: 1, maxLength: 32000 }, { type: 'null' }] },
  requireCertainty: { type: 'boolean' },
  knowledgeText: {
    anyOf: [{ type: 'string', minLength: 1, maxLength: 128000 }, { type: 'null' }],
    description: 'Free-text knowledge. Null explicitly clears it.',
  },
});

const oauth = (scope) => [{ type: 'oauth2', scopes: [scope] }];
const tool = ({ name, title, description, scope, inputSchema, annotations }) => ({
  name,
  title,
  description,
  inputSchema,
  securitySchemes: oauth(scope),
  // Older MCP schema versions preserve extension data only under _meta.
  _meta: { securitySchemes: oauth(scope) },
  annotations: { title, openWorldHint: false, ...annotations },
});

export const REMOTE_TOOLS = [
  tool({
    name: 'list_assistants',
    title: 'List Perssua assistants',
    description: 'List account-scoped Perssua assistant metadata and opaque revisions. Prompts, knowledge, and credentials are not returned.',
    scope: 'assistants.read',
    inputSchema: jsonObject(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }),
  tool({
    name: 'get_assistant',
    title: 'Read a Perssua assistant',
    description: 'Read one account-scoped assistant definition, revision, permissions, knowledge-file metadata, and redacted MCP connection metadata.',
    scope: 'assistants.read',
    inputSchema: jsonObject({
      assistant: { type: 'string', minLength: 1, maxLength: 256 },
      requestId: requestIdProperty,
      source: sourceProperty,
    }, ['assistant', 'requestId']),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }),
  tool({
    name: 'update_assistant',
    title: 'Update a Perssua assistant',
    description: 'Queue a revision-checked assistant patch for explicit confirmation in the signed-in Perssua desktop app. Omitted fields stay unchanged; null clears nullable fields.',
    scope: 'assistants.write',
    inputSchema: jsonObject({
      assistantRef: { type: 'string', minLength: 1, maxLength: 256 },
      expectedRevision: { type: 'string', minLength: 1, maxLength: 256 },
      patch: patchJsonSchema,
      requestId: requestIdProperty,
      source: sourceProperty,
    }, ['assistantRef', 'expectedRevision', 'patch', 'requestId']),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  }),
  tool({
    name: 'delete_assistant',
    title: 'Delete a Perssua assistant',
    description: 'Queue a revision-checked custom-assistant deletion for explicit confirmation in the signed-in Perssua desktop app. Built-ins cannot be deleted.',
    scope: 'assistants.write',
    inputSchema: jsonObject({
      assistantRef: { type: 'string', minLength: 1, maxLength: 256 },
      expectedRevision: { type: 'string', minLength: 1, maxLength: 256 },
      requestId: requestIdProperty,
      source: sourceProperty,
    }, ['assistantRef', 'expectedRevision', 'requestId']),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  }),
  tool({
    name: 'get_operation',
    title: 'Get a Perssua assistant operation',
    description: 'Read one account- and OAuth-connection-scoped update or delete operation. Pass the operationId returned by update_assistant or delete_assistant as requestId.',
    scope: 'assistants.write',
    inputSchema: jsonObject({
      requestId: {
        type: 'string',
        minLength: 1,
        maxLength: 64,
        description: 'The operationId returned by update_assistant or delete_assistant.',
      },
    }, ['requestId']),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }),
];

const textResult = (structuredContent) => ({
  content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
  structuredContent,
});

const errorResult = (error) => {
  const structuredContent = {
    version: 1,
    status: 'failed',
    error: {
      code: error instanceof AssistantRemoteApiError ? error.code : 'internal_error',
      message: error instanceof Error ? error.message : 'The hosted Perssua MCP request failed.',
      retryable: !(error instanceof AssistantRemoteApiError)
        || error.status === 429
        || error.status >= 500,
    },
  };
  return {
    ...textResult(structuredContent),
    isError: true,
    ...(error instanceof AssistantRemoteApiError && error.challenge
      ? { _meta: { 'mcp/www_authenticate': [error.challenge] } }
      : {}),
  };
};

export const createPerssuaRemoteMcpServer = ({
  bearerToken,
  remoteApi,
  apiUrl,
  fetchFn,
} = {}) => {
  const api = remoteApi || createAssistantRemoteApi({ bearerToken, apiUrl, fetchFn });
  const server = new Server(
    { name: REMOTE_SERVER_NAME, version: REMOTE_SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: REMOTE_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArguments = {} } = request.params;
    const schema = inputSchemas[name];
    if (!schema) return errorResult(new Error(`Unknown hosted tool: ${name}`));
    const parsed = schema.safeParse(rawArguments);
    if (!parsed.success) return errorResult(new Error(`Invalid ${name} input: ${parsed.error.message}`));
    const args = parsed.data;
    try {
      if (name === 'list_assistants') return textResult(await api.listAssistants());
      if (name === 'get_assistant') return textResult(await api.getAssistant(args.assistant, args.requestId));
      if (name === 'update_assistant') return textResult(await api.updateAssistant(args));
      if (name === 'delete_assistant') return textResult(await api.deleteAssistant(args));
      return textResult(await api.getOperation(args.requestId));
    } catch (error) {
      return errorResult(error);
    }
  });

  return server;
};
