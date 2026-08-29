import {
  buildStudioHandoff,
  isAssistantDefinitionReady,
  STUDIO_FIELD_LIMITS,
  type StudioSetupStore,
  type StudioTextField,
} from "./studio-brief";

export const STUDIO_TOOL_NAMES = [
  "inspect_studio_setup",
  "define_assistant",
  "append_knowledge_note",
  "prepare_first_session",
  "reset_studio_setup",
] as const;

export type StudioToolName = (typeof STUDIO_TOOL_NAMES)[number];

export const STUDIO_TOOL_OUTPUT_MAX_CHARACTERS = 1_500;
export const STUDIO_INSPECT_SECTIONS = [
  "summary",
  "assistantName",
  "assistantInstructions",
  "assistantCategory",
  "sessionGoal",
  "knowledgeNotes",
  "openingPrompt",
  "ledger",
] as const;

type StudioInspectSection = (typeof STUDIO_INSPECT_SECTIONS)[number];

const STUDIO_INSPECT_TEXT_CHUNK_CHARACTERS = 900;
const STUDIO_INSPECT_LEDGER_PAGE_SIZE = 5;
const STUDIO_INSPECT_MAX_OFFSET = 1_000_000;

export type WebMcpTool = {
  name: StudioToolName;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    untrustedContentHint: boolean;
  };
  execute(
    input: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<string> | string;
};

export type WebMcpModelContext = {
  registerTool(
    tool: WebMcpTool,
    options: { signal: AbortSignal },
  ): Promise<unknown> | unknown;
};

export const STUDIO_TOOL_SCHEMAS = {
  inspect_studio_setup: {
    type: "object",
    properties: {
      section: {
        type: "string",
        enum: STUDIO_INSPECT_SECTIONS,
        description: "Read a summary, one setup field, or ledger receipts.",
      },
      offset: {
        type: "integer",
        minimum: 0,
        maximum: STUDIO_INSPECT_MAX_OFFSET,
        description: "Zero-based offset for a field chunk or ledger page.",
      },
    },
    additionalProperties: false,
  },
  define_assistant: {
    type: "object",
    minProperties: 1,
    properties: {
      assistantName: {
        type: "string",
        maxLength: STUDIO_FIELD_LIMITS.assistantName,
        description: "Proposed new assistant name for the only Studio path: create a new Perssua assistant.",
      },
      assistantInstructions: {
        type: "string",
        maxLength: STUDIO_FIELD_LIMITS.assistantInstructions,
        description: "Proposed system instructions for the new assistant.",
      },
      assistantCategory: {
        type: "string",
        maxLength: STUDIO_FIELD_LIMITS.assistantCategory,
        description: "Optional proposed category for the new assistant.",
      },
      sessionGoal: {
        type: "string",
        maxLength: STUDIO_FIELD_LIMITS.sessionGoal,
        description: "The visible goal for the first session.",
      },
    },
    additionalProperties: false,
  },
  append_knowledge_note: {
    type: "object",
    properties: {
      note: {
        type: "string",
        minLength: 1,
        maxLength: STUDIO_FIELD_LIMITS.appendedNote,
        description:
          "One note to append after existing human-authored knowledge.",
      },
    },
    required: ["note"],
    additionalProperties: false,
  },
  prepare_first_session: {
    type: "object",
    properties: {
      openingPrompt: {
        type: "string",
        minLength: 1,
        maxLength: STUDIO_FIELD_LIMITS.openingPrompt,
        description:
          "First message staged for human review; never submitted automatically.",
      },
    },
    required: ["openingPrompt"],
    additionalProperties: false,
  },
  reset_studio_setup: {
    type: "object",
    properties: {
      confirm: {
        type: "boolean",
        enum: [true],
        description: "Must be true because reset clears every setup field and returns Studio to its first step.",
      },
    },
    required: ["confirm"],
    additionalProperties: false,
  },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw (
      signal.reason ??
      new DOMException("Tool execution was cancelled.", "AbortError")
    );
  }
}

function setupReceipt(store: StudioSetupStore) {
  const snapshot = store.getSnapshot();
  const handoff = buildStudioHandoff(snapshot.setup);
  return {
    revision: snapshot.revision,
    assistantReady: isAssistantDefinitionReady(snapshot.setup),
    sessionStartReady: handoff.ok,
    currentStep: snapshot.currentStep,
    highestStep: snapshot.highestStep,
    fieldLengths: {
      assistantName: snapshot.setup.assistantName.length,
      assistantInstructions: snapshot.setup.assistantInstructions.length,
      assistantCategory: snapshot.setup.assistantCategory.length,
      sessionGoal: snapshot.setup.sessionGoal.length,
      knowledgeNotes: snapshot.setup.knowledgeNotes.length,
      openingPrompt: snapshot.setup.openingPrompt.length,
    },
    agentChangeCount: snapshot.agentChanges.length,
  };
}

function result(value: Record<string, unknown>): string {
  const serialized = JSON.stringify(value);
  if (serialized.length > STUDIO_TOOL_OUTPUT_MAX_CHARACTERS) {
    throw new Error("Studio tool output exceeded its safe character budget.");
  }
  return serialized;
}

function inspectSetup(
  store: StudioSetupStore,
  section: StudioInspectSection,
  offset: number,
): Record<string, unknown> {
  const snapshot = store.getSnapshot();

  if (section === "summary") {
    const latestChange = snapshot.agentChanges[0];
    return {
      ok: true,
      section,
      ...setupReceipt(store),
      latestAgentChange: latestChange
        ? {
            id: latestChange.id,
            toolName: latestChange.toolName,
            changedFields: latestChange.changes.map(({ field }) => field),
          }
        : null,
    };
  }

  if (section === "ledger") {
    const changes = snapshot.agentChanges
      .slice(offset, offset + STUDIO_INSPECT_LEDGER_PAGE_SIZE)
      .map((change) => ({
        id: change.id,
        timestamp: change.timestamp,
        toolName: change.toolName,
        changedFields: change.changes.map(({ field }) => field),
      }));
    const nextOffset = offset + changes.length;
    return {
      ok: true,
      section,
      revision: snapshot.revision,
      offset,
      totalChanges: snapshot.agentChanges.length,
      changes,
      nextOffset:
        nextOffset < snapshot.agentChanges.length ? nextOffset : null,
    };
  }

  const text = snapshot.setup[section];
  let nextOffset = Math.min(offset + STUDIO_INSPECT_TEXT_CHUNK_CHARACTERS, text.length);
  let value = text.slice(offset, nextOffset);
  let response = {
    ok: true,
    section,
    revision: snapshot.revision,
    offset,
    totalLength: text.length,
    value,
    nextOffset: nextOffset < text.length ? nextOffset : null,
  };

  // JSON escaping can make 900 visible characters exceed the tool budget.
  // Shrink the page before returning instead of throwing from result().
  while (value && JSON.stringify(response).length > STUDIO_TOOL_OUTPUT_MAX_CHARACTERS) {
    nextOffset -= 1;
    value = text.slice(offset, nextOffset);
    response = {
      ...response,
      value,
      nextOffset: nextOffset < text.length ? nextOffset : null,
    };
  }

  return response;
}

const ASSISTANT_PROPOSAL_FIELDS: StudioTextField[] = [
  "assistantName",
  "assistantInstructions",
  "assistantCategory",
  "sessionGoal",
];

export function createStudioTools(
  store: StudioSetupStore,
  onToolUsed: (name: StudioToolName) => void = () => undefined,
): WebMcpTool[] {
  const run = (
    name: StudioToolName,
    execute: (input: unknown) => Record<string, unknown>,
  ) => async (input: unknown, options?: { signal?: AbortSignal }) => {
    throwIfAborted(options?.signal);
    onToolUsed(name);
    const output = execute(input);
    throwIfAborted(options?.signal);
    return result(output);
  };

  return [
    {
      name: "inspect_studio_setup",
      title: "Inspect Studio setup",
      description:
        "Read a compact setup summary, one paginated field, or paginated agent-change receipts. This never changes the page.",
      inputSchema: STUDIO_TOOL_SCHEMAS.inspect_studio_setup,
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: run("inspect_studio_setup", (input) => {
        if (!isRecord(input) || !hasOnlyKeys(input, ["section", "offset"])) {
          return {
            ok: false,
            error: "Use only optional section and offset fields.",
          };
        }
        const section = input.section ?? "summary";
        const offset = input.offset ?? 0;
        if (
          typeof section !== "string" ||
          !STUDIO_INSPECT_SECTIONS.includes(section as StudioInspectSection) ||
          typeof offset !== "number" ||
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          offset > STUDIO_INSPECT_MAX_OFFSET
        ) {
          return {
            ok: false,
            error:
              "Choose a supported section and non-negative integer offset.",
          };
        }
        return inspectSetup(store, section as StudioInspectSection, offset);
      }),
    },
    {
      name: "define_assistant",
      title: "Define assistant",
      description:
        "Populate the visible proposal for a new Perssua assistant. A complete proposal advances Studio to human review; it never opens Perssua or confirms creation.",
      inputSchema: STUDIO_TOOL_SCHEMAS.define_assistant,
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: run("define_assistant", (input) => {
        if (
          !isRecord(input) ||
          Object.keys(input).length === 0 ||
          !hasOnlyKeys(input, ASSISTANT_PROPOSAL_FIELDS) ||
          Object.values(input).some((value) => typeof value !== "string") ||
          ASSISTANT_PROPOSAL_FIELDS.some(
            (field) =>
              typeof input[field] === "string" &&
              input[field].length > STUDIO_FIELD_LIMITS[field],
          )
        ) {
          return {
            ok: false,
            error: `Provide only in-range strings for: ${ASSISTANT_PROPOSAL_FIELDS.join(", ")}.`,
          };
        }

        const patch: Partial<Record<StudioTextField, string>> = {};
        for (const field of ASSISTANT_PROPOSAL_FIELDS) {
          if (typeof input[field] === "string") patch[field] = input[field];
        }
        const proposedSetup = { ...store.getSnapshot().setup, ...patch };
        const change = store.updateFromAgent(
          "define_assistant",
          patch,
          isAssistantDefinitionReady(proposedSetup) ? 2 : undefined,
        );
        return {
          ok: true,
          changedFields: change?.changes.map(({ field }) => field) ?? [],
          changeId: change?.id ?? null,
          advancedToStep: store.getSnapshot().currentStep,
          ...setupReceipt(store),
        };
      }),
    },
    {
      name: "append_knowledge_note",
      title: "Append knowledge note",
      description:
        "Append one note after existing knowledge. Human-authored text is never replaced or removed.",
      inputSchema: STUDIO_TOOL_SCHEMAS.append_knowledge_note,
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: run("append_knowledge_note", (input) => {
        if (
          !isRecord(input) ||
          !hasOnlyKeys(input, ["note"]) ||
          typeof input.note !== "string" ||
          !input.note.trim() ||
          input.note.length > STUDIO_FIELD_LIMITS.appendedNote
        ) {
          return {
            ok: false,
            error: `Provide one non-empty note up to ${STUDIO_FIELD_LIMITS.appendedNote.toLocaleString()} characters.`,
          };
        }
        const appended = store.appendKnowledgeNote(
          "append_knowledge_note",
          input.note,
        );
        if (appended.error) return { ok: false, error: appended.error };
        return {
          ok: true,
          appended: Boolean(appended.change),
          changeId: appended.change?.id ?? null,
          ...setupReceipt(store),
        };
      }),
    },
    {
      name: "prepare_first_session",
      title: "Prepare first session",
      description:
        "Stage the visible first message for human review. This never submits a message, opens Perssua, or advances the wizard.",
      inputSchema: STUDIO_TOOL_SCHEMAS.prepare_first_session,
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: run("prepare_first_session", (input) => {
        if (
          !isRecord(input) ||
          !hasOnlyKeys(input, ["openingPrompt"]) ||
          typeof input.openingPrompt !== "string" ||
          !input.openingPrompt.trim() ||
          input.openingPrompt.length > STUDIO_FIELD_LIMITS.openingPrompt
        ) {
          return {
            ok: false,
            error: `Provide one non-empty openingPrompt up to ${STUDIO_FIELD_LIMITS.openingPrompt.toLocaleString()} characters.`,
          };
        }
        const change = store.updateFromAgent("prepare_first_session", {
          openingPrompt: input.openingPrompt,
        });
        return {
          ok: true,
          staged: Boolean(change),
          changeId: change?.id ?? null,
          ...setupReceipt(store),
        };
      }),
    },
    {
      name: "reset_studio_setup",
      title: "Reset Studio setup",
      description:
        "Destructive: clear every field and return Studio to step 1. Call only after explicit human approval with confirm=true. The reset remains visible in the ledger.",
      inputSchema: STUDIO_TOOL_SCHEMAS.reset_studio_setup,
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: run("reset_studio_setup", (input) => {
        if (
          !isRecord(input) ||
          !hasOnlyKeys(input, ["confirm"]) ||
          input.confirm !== true
        ) {
          return {
            ok: false,
            error:
              "Reset is destructive and requires confirm=true after human approval.",
          };
        }
        const change = store.resetFromAgent("reset_studio_setup");
        return {
          ok: true,
          reset: Boolean(change),
          changeId: change?.id ?? null,
          ...setupReceipt(store),
        };
      }),
    },
  ];
}

export function registerStudioTools(
  modelContext: WebMcpModelContext,
  store: StudioSetupStore,
  onToolUsed?: (name: StudioToolName) => void,
): { cleanup: () => void; registered: Promise<void>; signal: AbortSignal } {
  const controller = new AbortController();
  const tools = createStudioTools(store, onToolUsed);
  const registered = Promise.all(
    tools.map((tool) =>
      Promise.resolve().then(() =>
        modelContext.registerTool(tool, { signal: controller.signal }),
      ),
    ),
  )
    .then(() => undefined)
    .catch((error: unknown) => {
      controller.abort(error);
      throw error;
    });

  return {
    cleanup: () => controller.abort(),
    registered,
    signal: controller.signal,
  };
}
