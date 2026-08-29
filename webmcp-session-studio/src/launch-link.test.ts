import { describe, expect, it } from "vitest";
import {
  buildLaunchDeepLink,
  buildPerssuaSessionDeepLinkStrict,
} from "./launch-link";

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
});
