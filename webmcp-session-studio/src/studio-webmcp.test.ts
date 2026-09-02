import { describe, expect, it } from "vitest";
import {
  getOpeningPromptLimit,
  StudioSetupStore,
} from "./studio-brief";
import {
  createStudioTools,
  STUDIO_TOOL_NAMES,
  STUDIO_TOOL_OUTPUT_MAX_CHARACTERS,
  STUDIO_TOOL_SCHEMAS,
} from "./studio-webmcp";

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

  it("stages native assistant extensions and advances a complete proposal only to visible human review", async () => {
    const store = new StudioSetupStore();
    const define = createStudioTools(store).find((tool) => tool.name === "define_assistant");
    if (!define) throw new Error("Missing define_assistant");
    const result = JSON.parse(await define.execute({
      assistantName: "Research partner",
      assistantInstructions: "Ask one question at a time.",
      realtimePrompt: "Suggest one concise next sentence.",
      followUpPrompt: "Offer three questions.",
      emailPrompt: "Summarize decisions.",
      requireCertainty: true,
      sessionGoal: "Find the unmet need",
    }));
    expect(result).toMatchObject({ ok: true, advancedToStep: 2, currentStep: 2 });
    expect(store.getSnapshot().agentChanges[0].changes).toContainEqual({
      field: "studioStep", before: "1", after: "2",
    });
    expect(store.getSnapshot().setup).toMatchObject({
      realtimePrompt: "Suggest one concise next sentence.",
      followUpPrompt: "Offer three questions.",
      emailPrompt: "Summarize decisions.",
      requireCertainty: true,
    });
  });

  it("rejects non-boolean certainty and unknown native fields", async () => {
    await expect(call("define_assistant", { requireCertainty: "true" }))
      .resolves.toMatchObject({ ok: false });
    await expect(call("define_assistant", { nativeVersion: "2" }))
      .resolves.toMatchObject({ ok: false });
  });

  it("rejects removed existing-assistant input and never opens or submits", async () => {
    await expect(call("define_assistant", { existingAssistant: "assistant_123" }))
      .resolves.toMatchObject({ ok: false });
    const staged = await call("prepare_first_session", { openingPrompt: "Draft the first question" });
    expect(staged).toMatchObject({ ok: true, staged: true });
    expect(staged).not.toHaveProperty("opened");
    expect(staged).not.toHaveProperty("submitted");
  });

  it("rejects an opening prompt beyond the budget left by the session goal", async () => {
    const store = new StudioSetupStore();
    store.updateHuman("sessionGoal", "Find the unmet need");
    const prepare = createStudioTools(store).find(
      (tool) => tool.name === "prepare_first_session",
    );
    if (!prepare) throw new Error("Missing prepare_first_session");
    const available = getOpeningPromptLimit("Find the unmet need");
    const output = JSON.parse(await prepare.execute({
      openingPrompt: "p".repeat(available + 1),
    }));
    expect(output).toMatchObject({ ok: false });
    expect(output.error).toContain(available.toLocaleString());
    expect(store.getSnapshot().setup.openingPrompt).toBe("");
  });

  it("paginates JSON-escaped text within the tool output budget", async () => {
    const store = new StudioSetupStore();
    store.updateHuman("knowledgeNotes", "\n".repeat(900));
    const inspect = createStudioTools(store).find((tool) => tool.name === "inspect_studio_setup");
    if (!inspect) throw new Error("Missing inspect_studio_setup");
    const output = await inspect.execute({ section: "knowledgeNotes" });
    const parsed = JSON.parse(output);
    expect(output.length).toBeLessThanOrEqual(STUDIO_TOOL_OUTPUT_MAX_CHARACTERS);
    expect(parsed.value.length).toBeLessThan(900);
    expect(parsed.nextOffset).toBe(parsed.value.length);
  });
});
