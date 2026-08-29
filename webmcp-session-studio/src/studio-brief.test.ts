import { describe, expect, it } from "vitest";
import {
  buildStudioHandoff,
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
    expect(params.has("assistant")).toBe(false);
    expect(params.has("autoSubmit")).toBe(false);
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
