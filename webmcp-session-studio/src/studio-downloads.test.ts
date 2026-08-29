import { describe, expect, it } from "vitest";
import {
  STUDIO_COMPATIBLE_DOWNLOADS,
  STUDIO_MIN_DESKTOP_VERSION,
} from "./studio-downloads";

describe("pinned compatible desktop downloads", () => {
  it("publishes deterministic v0.27.0 links for every supported platform", () => {
    expect(STUDIO_COMPATIBLE_DOWNLOADS).toHaveLength(5);
    expect(new Set(STUDIO_COMPATIBLE_DOWNLOADS.map(({ href }) => href)).size).toBe(
      5,
    );
    for (const download of STUDIO_COMPATIBLE_DOWNLOADS) {
      expect(download.href).toContain(`Perssua-${STUDIO_MIN_DESKTOP_VERSION}`);
      expect(download.href).toMatch(/^https:\/\/downloads\.perssua\.com\//);
    }
  });
});
