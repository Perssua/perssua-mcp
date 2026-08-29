import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  App,
  CapabilityNotice,
  STUDIO_SESSION_START_CTA_COPY,
  STUDIO_STEPS,
} from "./App";

describe("Studio wizard fallback and permission boundary", () => {
  it("keeps the complete wizard available without WebMCP", () => {
    render(<CapabilityNotice status="unsupported" />);
    expect(screen.getByText("Manual mode")).toBeDefined();
    expect(screen.getByText(/complete wizard still works/i)).toBeDefined();
  });

  it("announces the exact registered tool count", () => {
    render(<CapabilityNotice status="active" />);
    expect(screen.getByText("WebMCP connected")).toBeDefined();
    expect(screen.getByText(/Five scoped tools/)).toBeDefined();
  });

  it("starts with a create-only proposal form and no launch action", () => {
    render(<App />);
    expect(screen.getByText("Draft your new assistant")).toBeDefined();
    expect(screen.getByLabelText("Assistant name")).toBeDefined();
    expect(screen.getByText("Start the session")).toBeDefined();
    expect(screen.queryByText("Use an existing assistant")).toBeNull();
    expect(
      screen.queryByText("Create assistant and start session"),
    ).toBeNull();
  });

  it("uses session-start language for the final create-only handoff", () => {
    expect(STUDIO_STEPS.at(-1)).toEqual({
      id: 5,
      title: "Start the session",
      short: "Start",
    });
    expect(STUDIO_SESSION_START_CTA_COPY).toBe("Create assistant and start session");
  });
});
