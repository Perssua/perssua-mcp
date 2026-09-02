/**
 * Official Perssua MCP server.
 *
 * Exposes tools that let MCP clients (Claude Desktop / Claude Code, ChatGPT
 * developer-mode connectors, Grok connectors, and any other MCP-capable app)
 * start a Perssua session with a chosen assistant and context.
 *
 * Local mode (stdio): writes a single-use handoff file into the app's
 * external-handoffs directory and opens perssua://session/start?handoff=<id>.
 * Remote mode (HTTP): tools still work, but `create_session_link` is the
 * primary surface — it returns links the user clicks on their own machine.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { bridgeSupports, getAppStatus, readAssistantsRoster, resolveBridge } from './bridge.js';
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
export const SERVER_VERSION = '0.1.0';

const textResult = (lines, { isError = false } = {}) => ({
  isError,
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
      const selected = roster.selectedAssistantId === assistant.id ? ' (currently selected)' : '';
      return `- ${assistant.name || '(unnamed)'} — id: ${assistant.id}${selected}`;
    }),
    roster.updatedAt ? `Last synced: ${roster.updatedAt}` : null,
  ];
};

/**
 * Create the MCP server instance. `options` lets tests inject fs/spawn-free
 * implementations; production callers use the defaults.
 */
export const createPerssuaMcpServer = ({
  resolveBridgeFn = resolveBridge,
  getAppStatusFn = getAppStatus,
  readRosterFn = readAssistantsRoster,
  writeHandoffFn = writeHandoffFile,
  openDeepLinkFn = openDeepLink,
  allowLaunch = true,
} = {}) => {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

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
        "List the user's configured Perssua assistants (name and id) so a session can be started with the right one.",
      inputSchema: {},
      annotations: { title: 'List Perssua assistants', readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const roster = readRosterFn();
      return textResult(describeAssistants(roster));
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
        realtimePrompt: z.string().max(HANDOFF_LIMITS.assistantRealtimePromptChars).optional().describe('Optional complete Notch realtime prompt. Blank uses Perssua’s fallback.'),
        followUpPrompt: z.string().max(HANDOFF_LIMITS.assistantFollowUpPromptChars).optional().describe('Optional prompt for clickable follow-up suggestions. Blank uses the default.'),
        emailPrompt: z.string().max(HANDOFF_LIMITS.assistantEmailPromptChars).optional().describe('Optional prompt for summaries and end-of-session overview. Blank uses the default.'),
        requireCertainty: z.boolean().optional().describe('Only reply when sufficiently certain.'),
        knowledge: z
          .string()
          .max(128000)
          .optional()
          .describe('Free-text knowledge stored with the assistant (background, notes, decisions).'),
        sessionGoal: z.string().max(HANDOFF_LIMITS.sessionGoalChars).optional().describe('Goal only for this first session; it is not stored on the assistant.'),
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
