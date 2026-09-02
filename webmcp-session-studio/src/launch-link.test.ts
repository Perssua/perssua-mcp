import { describe, expect, it } from "vitest";
import {
  buildLaunchDeepLink,
  buildPerssuaSessionDeepLinkStrict,
} from "./launch-link";

/** Frozen model of an Electron v1 intake: it accepts only the original keys
 * and deliberately ignores any additive query parameter. */
function parseFrozenLegacyCreateLink(deepLink: string) {
  const url = new URL(deepLink);
  const params = url.searchParams;
  if (
    url.protocol !== "perssua:" ||
    `${url.hostname}${url.pathname}` !== "session/start" ||
    params.get("mode") !== "create" ||
    !params.get("assistantName")?.trim() ||
    !params.get("assistantInstructions")?.trim()
  ) {
    return null;
  }
  return {
    mode: "create",
    assistantName: params.get("assistantName"),
    assistantInstructions: params.get("assistantInstructions"),
    assistantCategory: params.get("assistantCategory"),
    prompt: params.get("prompt"),
    context: params.get("context"),
    source: params.get("source"),
  };
}

describe("create-only launch-link contract", () => {
  it("keeps only the create proposal allowlist", () => {
    const link = buildLaunchDeepLink(encodeURIComponent(
      "perssua://session/start?mode=create&assistantName=Research+partner&assistantInstructions=Ask+one+question&assistantCategory=Research&prompt=Begin&context=Known+facts&source=webmcp&autoSubmit=true&assistant=old&files=secret.txt&redirect=https%3A%2F%2Fevil.test",
    ));
    expect(link).toEqual({
      ok: true,
      deepLink: "perssua://session/start?mode=create&assistantName=Research+partner&assistantInstructions=Ask+one+question&assistantCategory=Research&prompt=Begin&context=Known+facts&source=webmcp",
    });
  });

  it("rejects non-create, incomplete, over-limit, and oversized proposals", () => {
    expect(buildLaunchDeepLink(encodeURIComponent("perssua://session/start?assistant=Coach")))
      .toMatchObject({ ok: false });
    expect(buildLaunchDeepLink(encodeURIComponent("perssua://session/start?mode=create&assistantName=Coach")))
      .toMatchObject({ ok: false });
    expect(buildPerssuaSessionDeepLinkStrict({
      mode: "create",
      assistantName: "n".repeat(201),
      assistantInstructions: "Be precise",
    })).toMatchObject({ ok: false, code: "field_too_long", field: "assistantName" });
    expect(buildPerssuaSessionDeepLinkStrict({
      mode: "create",
      assistantName: "Coach",
      assistantInstructions: "Detailed instructions",
    }, 40)).toMatchObject({ ok: false, code: "url_too_long" });
  });

  it("keeps an extended proposal valid for a frozen v1 Electron parser", () => {
    const serialized = buildPerssuaSessionDeepLinkStrict({
      mode: "create",
      assistantName: "Research partner",
      assistantInstructions: "Ask one question at a time.",
      assistantCategory: "Research",
      assistantRealtimePrompt: "Suggest one concise next sentence.",
      assistantFollowUpPrompt: "Offer three follow-up questions.",
      assistantEmailPrompt: "Summarize owners and decisions.",
      assistantRequireCertainty: "true",
      sessionGoal: "Find the unmet need",
      prompt: "Session goal: Find the unmet need\n\nOpening message:\nBegin.",
      context: "Permanent terminology only.",
      source: "webmcp",
    });
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;

    expect(new URL(serialized.deepLink).searchParams.has("version")).toBe(false);
    expect(parseFrozenLegacyCreateLink(serialized.deepLink)).toEqual({
      mode: "create",
      assistantName: "Research partner",
      assistantInstructions: "Ask one question at a time.",
      assistantCategory: "Research",
      prompt: "Session goal: Find the unmet need\n\nOpening message:\nBegin.",
      context: "Permanent terminology only.",
      source: "webmcp",
    });
  });

  it("accepts old links in the new model and drops unknown extensions", () => {
    const oldLink = "perssua://session/start?mode=create&assistantName=Coach&assistantInstructions=Be+clear&prompt=Hello&context=Permanent+notes&source=webmcp";
    expect(buildLaunchDeepLink(encodeURIComponent(oldLink))).toEqual({ ok: true, deepLink: oldLink });

    const extended = `${oldLink}&assistantRealtimePrompt=Listen&futureExtension=ignored`;
    const rebuilt = buildLaunchDeepLink(encodeURIComponent(extended));
    expect(rebuilt).toEqual({
      ok: true,
      deepLink: `${oldLink}&assistantRealtimePrompt=Listen`,
    });
    expect(parseFrozenLegacyCreateLink(extended)).toMatchObject({
      assistantName: "Coach",
      assistantInstructions: "Be clear",
    });
  });

  it("validates every optional extension without silently truncating it", () => {
    expect(buildPerssuaSessionDeepLinkStrict({
      mode: "create",
      assistantName: "Coach",
      assistantInstructions: "Be clear",
      assistantRealtimePrompt: "x".repeat(4_001),
    })).toMatchObject({
      ok: false,
      code: "field_too_long",
      field: "assistantRealtimePrompt",
    });
    expect(buildPerssuaSessionDeepLinkStrict({
      mode: "create",
      assistantName: "Coach",
      assistantInstructions: "Be clear",
      assistantRequireCertainty: "maybe",
    })).toMatchObject({
      ok: false,
      code: "invalid_parameter",
      field: "assistantRequireCertainty",
    });
    for (const value of ["true", "false", "1", "0"]) {
      expect(buildPerssuaSessionDeepLinkStrict({
        mode: "create",
        assistantName: "Coach",
        assistantInstructions: "Be clear",
        assistantRequireCertainty: value,
      })).toMatchObject({ ok: true });
    }
  });

  it("rejects a full set of individually valid fields when the encoded URL exceeds 24,000 characters", () => {
    expect(buildPerssuaSessionDeepLinkStrict({
      mode: "create",
      assistantName: "Research partner",
      assistantInstructions: "i".repeat(4_000),
      assistantRealtimePrompt: "r".repeat(4_000),
      assistantFollowUpPrompt: "f".repeat(4_000),
      assistantEmailPrompt: "e".repeat(4_000),
      assistantRequireCertainty: "1",
      sessionGoal: "g".repeat(2_000),
      prompt: "p".repeat(4_000),
      context: "c".repeat(8_000),
      source: "webmcp",
    })).toMatchObject({ ok: false, code: "url_too_long" });
  });
});
