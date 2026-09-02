import { describe, expect, it } from "vitest";
import {
  buildStudioHandoff,
  compileStudioContext,
  compileStudioPrompt,
  EMPTY_STUDIO_SETUP,
  StudioSetupStore,
} from "./studio-brief";

const completeSetup = {
  ...EMPTY_STUDIO_SETUP,
  assistantName: "Interview partner",
  assistantInstructions: "Ask one focused question at a time.",
  sessionGoal: "Reach a clear research finding",
  openingPrompt: "Help me prepare the first interview question.",
};

describe("create-only Studio setup", () => {
  it("serializes only an untrusted create proposal", () => {
    const handoff = buildStudioHandoff(completeSetup);
    expect(handoff.ok).toBe(true);
    if (!handoff.ok) return;
    const params = new URL(handoff.deepLink).searchParams;
    expect(params.get("mode")).toBe("create");
    expect(params.get("assistantName")).toBe("Interview partner");
    expect(params.get("assistantRequireCertainty")).toBe("false");
    expect(params.get("sessionGoal")).toBe("Reach a clear research finding");
    expect(params.has("assistant")).toBe(false);
    expect(params.has("autoSubmit")).toBe(false);
    expect(params.has("version")).toBe(false);
  });

  it("keeps sessionGoal out of permanent context and carries it in the legacy prompt", () => {
    const setup = {
      ...completeSetup,
      sessionGoal: "Decide the research direction",
      knowledgeNotes: "Permanent glossary: TAM means total addressable market.",
      openingPrompt: "Start with the highest-risk assumption.",
      realtimePrompt: "Suggest one concise next sentence.",
      followUpPrompt: "Offer three questions.",
      emailPrompt: "Summarize decisions.",
      requireCertainty: true,
    };
    expect(compileStudioContext(setup).context).toBe(
      "Permanent glossary: TAM means total addressable market.",
    );
    expect(compileStudioPrompt(setup).prompt).toBe(
      "Session goal: Decide the research direction\n\nOpening message:\nStart with the highest-risk assumption.",
    );

    const handoff = buildStudioHandoff(setup);
    expect(handoff.ok).toBe(true);
    if (!handoff.ok) return;
    const params = new URL(handoff.deepLink).searchParams;
    expect(params.get("context")).not.toContain("Decide the research direction");
    expect(params.get("sessionGoal")).toBe("Decide the research direction");
    expect(params.get("prompt")).toContain("Decide the research direction");
    expect(params.get("assistantRealtimePrompt")).toBe("Suggest one concise next sentence.");
    expect(params.get("assistantFollowUpPrompt")).toBe("Offer three questions.");
    expect(params.get("assistantEmailPrompt")).toBe("Summarize decisions.");
    expect(params.get("assistantRequireCertainty")).toBe("true");
  });

  it("rejects an oversized combined first-session prompt instead of truncating it", () => {
    const handoff = buildStudioHandoff({
      ...completeSetup,
      sessionGoal: "g".repeat(2_000),
      openingPrompt: "p".repeat(4_000),
    });
    expect(handoff).toMatchObject({
      ok: false,
      code: "prompt_too_long",
      field: "openingPrompt",
    });
  });

  it("keeps human edits out of the ledger and makes reset auditable", () => {
    const store = new StudioSetupStore();
    store.updateHuman("assistantName", "Research partner");
    expect(store.getSnapshot().agentChanges).toEqual([]);
    store.advanceToNextStepFromHuman();
    const reset = store.resetFromAgent("reset_studio_setup");
    expect(reset?.changes).toContainEqual({ field: "studioStep", before: "2", after: "1" });
    expect(store.getSnapshot()).toMatchObject({ currentStep: 1, highestStep: 1 });
  });
});
