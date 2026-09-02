import {
  buildPerssuaSessionDeepLinkStrict,
  PERSSUA_SESSION_PARAM_LIMITS,
  PERSSUA_SESSION_URL_MAX_CHARACTERS,
} from "./launch-link";

export const STUDIO_FIELD_LIMITS = {
  assistantName: PERSSUA_SESSION_PARAM_LIMITS.assistantName,
  assistantInstructions: PERSSUA_SESSION_PARAM_LIMITS.assistantInstructions,
  assistantCategory: PERSSUA_SESSION_PARAM_LIMITS.assistantCategory,
  realtimePrompt: PERSSUA_SESSION_PARAM_LIMITS.assistantRealtimePrompt,
  followUpPrompt: PERSSUA_SESSION_PARAM_LIMITS.assistantFollowUpPrompt,
  emailPrompt: PERSSUA_SESSION_PARAM_LIMITS.assistantEmailPrompt,
  sessionGoal: 2_000,
  knowledgeNotes: PERSSUA_SESSION_PARAM_LIMITS.context,
  openingPrompt: PERSSUA_SESSION_PARAM_LIMITS.prompt,
  appendedNote: 2_000,
} as const;

const SESSION_GOAL_PREFIX = "Session goal: ";
const OPENING_MESSAGE_PREFIX = "Opening message:\n";
const PROMPT_SECTION_SEPARATOR = "\n\n";

export type StudioFlowStep = 1 | 2 | 3 | 4 | 5;

export type StudioSetup = {
  assistantName: string;
  assistantInstructions: string;
  assistantCategory: string;
  realtimePrompt: string;
  followUpPrompt: string;
  emailPrompt: string;
  requireCertainty: boolean;
  sessionGoal: string;
  knowledgeNotes: string;
  openingPrompt: string;
};

export type StudioSetupField = keyof StudioSetup;
export type StudioTextField = Exclude<StudioSetupField, "requireCertainty">;
export type StudioTrackedField = StudioSetupField | "studioStep";
export type StudioAgentPatch = Partial<Pick<StudioSetup, StudioTextField>> &
  Pick<Partial<StudioSetup>, "requireCertainty">;

export type StudioAgentChange = {
  id: number;
  timestamp: string;
  toolName: string;
  changes: Array<{
    field: StudioTrackedField;
    before: string;
    after: string;
  }>;
};

export type StudioSnapshot = {
  setup: StudioSetup;
  revision: number;
  agentChanges: StudioAgentChange[];
  currentStep: StudioFlowStep;
  highestStep: StudioFlowStep;
};

export type StudioHandoffResult =
  | {
      ok: true;
      deepLink: string;
      encodedLength: number;
      contextLength: number;
      promptLength: number;
    }
  | {
      ok: false;
      code:
        | "incomplete"
        | "context_too_long"
        | "prompt_too_long"
        | "field_too_long"
        | "url_too_long";
      error: string;
      field?: string;
      encodedLength?: number;
    };

export const EMPTY_STUDIO_SETUP: StudioSetup = {
  assistantName: "",
  assistantInstructions: "",
  assistantCategory: "",
  realtimePrompt: "",
  followUpPrompt: "",
  emailPrompt: "",
  requireCertainty: false,
  sessionGoal: "",
  knowledgeNotes: "",
  openingPrompt: "",
};

export function normalizeStudioField(
  field: StudioTextField,
  value: string,
): string {
  return value.replace(/\r\n?/g, "\n").slice(0, STUDIO_FIELD_LIMITS[field]);
}

export function compileStudioContext(setup: StudioSetup): {
  context: string;
  length: number;
  overLimit: boolean;
} {
  // Assistant context is permanent. The first-session goal belongs only in
  // the first prompt so a later session cannot inherit a one-off objective.
  const context = setup.knowledgeNotes.trim();

  return {
    context,
    length: context.length,
    overLimit: context.length > PERSSUA_SESSION_PARAM_LIMITS.context,
  };
}

export function compileStudioPrompt(setup: StudioSetup): {
  prompt: string;
  length: number;
  overLimit: boolean;
} {
  const sections = [
    `${SESSION_GOAL_PREFIX}${setup.sessionGoal.trim()}`,
    `${OPENING_MESSAGE_PREFIX}${setup.openingPrompt.trim()}`,
  ];
  const prompt = sections.join(PROMPT_SECTION_SEPARATOR);
  return {
    prompt,
    length: prompt.length,
    overLimit: prompt.length > PERSSUA_SESSION_PARAM_LIMITS.prompt,
  };
}

export function getOpeningPromptLimit(sessionGoal: string): number {
  const fixedLength =
    SESSION_GOAL_PREFIX.length +
    sessionGoal.trim().length +
    PROMPT_SECTION_SEPARATOR.length +
    OPENING_MESSAGE_PREFIX.length;
  return Math.max(0, PERSSUA_SESSION_PARAM_LIMITS.prompt - fixedLength);
}

export function isAssistantDefinitionReady(setup: StudioSetup): boolean {
  return Boolean(
    setup.assistantName.trim() &&
    setup.assistantInstructions.trim() &&
    setup.sessionGoal.trim(),
  );
}

export function buildStudioHandoff(setup: StudioSetup): StudioHandoffResult {
  if (!isAssistantDefinitionReady(setup) || !setup.openingPrompt.trim()) {
    return {
      ok: false,
      code: "incomplete",
      error:
        "Complete the assistant, session goal, and first message before opening Perssua.",
    };
  }

  const compiledContext = compileStudioContext(setup);
  if (compiledContext.overLimit) {
    return {
      ok: false,
      code: "context_too_long",
      field: "knowledgeNotes",
      error: `The permanent knowledge is ${compiledContext.length.toLocaleString()} characters. Reduce the knowledge notes to stay within ${PERSSUA_SESSION_PARAM_LIMITS.context.toLocaleString()}; nothing was truncated.`,
    };
  }

  const compiledPrompt = compileStudioPrompt(setup);
  if (compiledPrompt.overLimit) {
    return {
      ok: false,
      code: "prompt_too_long",
      field: "openingPrompt",
      error: `The first-session goal plus opening message is ${compiledPrompt.length.toLocaleString()} characters. Reduce them to stay within ${PERSSUA_SESSION_PARAM_LIMITS.prompt.toLocaleString()}; nothing was truncated.`,
    };
  }

  const strict = buildPerssuaSessionDeepLinkStrict({
    mode: "create",
    assistantName: setup.assistantName.trim(),
    assistantInstructions: setup.assistantInstructions.trim(),
    assistantCategory: setup.assistantCategory.trim() || undefined,
    assistantRealtimePrompt: setup.realtimePrompt.trim() || undefined,
    assistantFollowUpPrompt: setup.followUpPrompt.trim() || undefined,
    assistantEmailPrompt: setup.emailPrompt.trim() || undefined,
    assistantRequireCertainty: String(setup.requireCertainty),
    sessionGoal: setup.sessionGoal.trim(),
    prompt: compiledPrompt.prompt,
    context: compiledContext.context,
    source: "webmcp",
  });

  if (!strict.ok) {
    return {
      ok: false,
      code: strict.code === "url_too_long" ? "url_too_long" : "field_too_long",
      field: strict.field,
      encodedLength: strict.encodedLength,
      error:
        strict.code === "url_too_long"
          ? `The encoded proposal is too large. Reduce the assistant instructions or knowledge notes to stay within ${PERSSUA_SESSION_URL_MAX_CHARACTERS.toLocaleString()} characters; nothing was truncated.`
          : strict.error,
    };
  }

  return {
    ok: true,
    deepLink: strict.deepLink,
    encodedLength: strict.encodedLength,
    contextLength: compiledContext.length,
    promptLength: compiledPrompt.length,
  };
}

export function buildStudioHttpsLaunchLink(
  setup: StudioSetup,
  launcherUrl = "https://perssua.com/launch",
): string {
  const handoff = buildStudioHandoff(setup);
  if (!handoff.ok) throw new Error(handoff.error);

  const launcher = new URL(launcherUrl);
  if (launcher.protocol !== "https:") {
    throw new Error("The Perssua launcher must use HTTPS.");
  }
  launcher.search = "";
  launcher.hash = encodeURIComponent(handoff.deepLink);
  return launcher.toString();
}

export class StudioSetupStore {
  private snapshot: StudioSnapshot;
  private listeners = new Set<() => void>();
  private nextChangeId = 1;

  constructor(
    initialSetup: StudioSetup = EMPTY_STUDIO_SETUP,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.snapshot = {
      setup: { ...initialSetup },
      revision: 0,
      agentChanges: [],
      currentStep: 1,
      highestStep: 1,
    };
  }

  getSnapshot = (): StudioSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  updateHuman(field: StudioTextField, value: string): string {
    const normalized = normalizeStudioField(field, value);
    if (this.snapshot.setup[field] === normalized) return normalized;
    this.commit({ ...this.snapshot.setup, [field]: normalized });
    return normalized;
  }

  updateFromAgent(
    toolName: string,
    patch: StudioAgentPatch,
    advanceToStep?: StudioFlowStep,
  ): StudioAgentChange | null {
    const nextSetup = { ...this.snapshot.setup };
    const changes: StudioAgentChange["changes"] = [];

    for (const field of Object.keys(patch) as StudioTextField[]) {
      const value = patch[field];
      if (typeof value !== "string") continue;
      const normalized = normalizeStudioField(field, value);
      if (normalized === nextSetup[field]) continue;
      changes.push({ field, before: nextSetup[field], after: normalized });
      nextSetup[field] = normalized;
    }

    if (typeof patch.requireCertainty === "boolean" && patch.requireCertainty !== nextSetup.requireCertainty) {
      changes.push({
        field: "requireCertainty",
        before: String(nextSetup.requireCertainty),
        after: String(patch.requireCertainty),
      });
      nextSetup.requireCertainty = patch.requireCertainty;
    }

    const nextStep = advanceToStep && advanceToStep > this.snapshot.currentStep
      ? advanceToStep
      : this.snapshot.currentStep;
    const nextHighestStep = Math.max(
      this.snapshot.highestStep,
      nextStep,
    ) as StudioFlowStep;
    if (nextStep !== this.snapshot.currentStep) {
      changes.push({
        field: "studioStep",
        before: String(this.snapshot.currentStep),
        after: String(nextStep),
      });
    }

    return this.commitAgentChange(
      toolName,
      nextSetup,
      changes,
      nextStep,
      nextHighestStep,
    );
  }

  appendKnowledgeNote(
    toolName: string,
    note: string,
  ): { change: StudioAgentChange | null; error?: string } {
    const normalizedNote = note.replace(/\r\n?/g, "\n").trim();
    if (!normalizedNote) return { change: null, error: "The note is empty." };
    if (normalizedNote.length > STUDIO_FIELD_LIMITS.appendedNote) {
      return {
        change: null,
        error: `The note exceeds ${STUDIO_FIELD_LIMITS.appendedNote.toLocaleString()} characters.`,
      };
    }

    const before = this.snapshot.setup.knowledgeNotes;
    const after = before.trim()
      ? `${before.trimEnd()}\n\n${normalizedNote}`
      : normalizedNote;
    if (after.length > STUDIO_FIELD_LIMITS.knowledgeNotes) {
      return {
        change: null,
        error:
          "The note would exceed the knowledge limit. Ask the human to shorten the existing notes first.",
      };
    }

    return {
      change: this.commitAgentChange(
        toolName,
        { ...this.snapshot.setup, knowledgeNotes: after },
        [{ field: "knowledgeNotes", before, after }],
      ),
    };
  }

  resetFromAgent(toolName: string): StudioAgentChange | null {
    const changes: StudioAgentChange["changes"] = [];
    for (const field of Object.keys(EMPTY_STUDIO_SETUP) as StudioSetupField[]) {
      const before = this.snapshot.setup[field] ?? "";
      const after = EMPTY_STUDIO_SETUP[field] ?? "";
      if (before !== after) changes.push({ field, before: String(before), after: String(after) });
    }
    if (this.snapshot.currentStep !== 1) {
      changes.push({
        field: "studioStep",
        before: String(this.snapshot.currentStep),
        after: "1",
      });
    }
    return this.commitAgentChange(
      toolName,
      { ...EMPTY_STUDIO_SETUP },
      changes,
      1,
      1,
    );
  }

  advanceToNextStepFromHuman(): void {
    if (this.snapshot.currentStep === 5) return;
    const nextStep = (this.snapshot.currentStep + 1) as StudioFlowStep;
    this.commit(
      this.snapshot.setup,
      this.snapshot.agentChanges,
      nextStep,
      Math.max(this.snapshot.highestStep, nextStep) as StudioFlowStep,
    );
  }

  updateHumanRequireCertainty(value: boolean): void {
    if (this.snapshot.setup.requireCertainty === value) return;
    this.commit({ ...this.snapshot.setup, requireCertainty: value });
  }

  goToStepFromHuman(step: StudioFlowStep): void {
    if (step > this.snapshot.highestStep || step === this.snapshot.currentStep) return;
    this.commit(this.snapshot.setup, this.snapshot.agentChanges, step);
  }

  private commitAgentChange(
    toolName: string,
    setup: StudioSetup,
    changes: StudioAgentChange["changes"],
    currentStep = this.snapshot.currentStep,
    highestStep = this.snapshot.highestStep,
  ): StudioAgentChange | null {
    if (changes.length === 0) return null;
    const agentChange: StudioAgentChange = {
      id: this.nextChangeId++,
      timestamp: this.now(),
      toolName,
      changes,
    };
    this.commit(
      setup,
      [agentChange, ...this.snapshot.agentChanges],
      currentStep,
      highestStep,
    );
    return agentChange;
  }

  private commit(
    setup: StudioSetup,
    agentChanges = this.snapshot.agentChanges,
    currentStep = this.snapshot.currentStep,
    highestStep = this.snapshot.highestStep,
  ) {
    this.snapshot = {
      setup,
      revision: this.snapshot.revision + 1,
      agentChanges,
      currentStep,
      highestStep,
    };
    for (const listener of this.listeners) listener();
  }
}
