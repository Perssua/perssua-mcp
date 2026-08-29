import { describe, expect, it } from "vitest";
import { StudioSetupStore } from "./studio-brief";
import { createStudioTools, STUDIO_TOOL_NAMES, STUDIO_TOOL_SCHEMAS } from "./studio-webmcp";

async function call(name: (typeof STUDIO_TOOL_NAMES)[number], input: unknown) {
  const tool = createStudioTools(new StudioSetupStore()).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing ${name}`);
  return JSON.parse(await tool.execute(input));
}

describe("Studio WebMCP create proposal boundary", () => {
  it("exposes five narrow tools and no assistant-selection path", () => {
    expect(STUDIO_TOOL_NAMES).toEqual([
      "inspect_studio_setup",
      "define_assistant",
      "append_knowledge_note",
      "prepare_first_session",
      "reset_studio_setup",
    ]);
    expect(STUDIO_TOOL_SCHEMAS.define_assistant.properties).not.toHaveProperty("existingAssistant");
  });

  it("advances a complete proposal only to visible human review", async () => {
    const store = new StudioSetupStore();
    const define = createStudioTools(store).find((tool) => tool.name === "define_assistant");
    if (!define) throw new Error("Missing define_assistant");
    const result = JSON.parse(await define.execute({
      assistantName: "Research partner",
      assistantInstructions: "Ask one question at a time.",
      sessionGoal: "Find the unmet need",
    }));
    expect(result).toMatchObject({ ok: true, advancedToStep: 2, currentStep: 2 });
    expect(store.getSnapshot().agentChanges[0].changes).toContainEqual({
      field: "studioStep", before: "1", after: "2",
    });
  });

  it("rejects removed existing-assistant input and never opens or submits", async () => {
    await expect(call("define_assistant", { existingAssistant: "assistant_123" }))
      .resolves.toMatchObject({ ok: false });
    const staged = await call("prepare_first_session", { openingPrompt: "Draft the first question" });
    expect(staged).toMatchObject({ ok: true, staged: true });
    expect(staged).not.toHaveProperty("opened");
    expect(staged).not.toHaveProperty("submitted");
  });
});
