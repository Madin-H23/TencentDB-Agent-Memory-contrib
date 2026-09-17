/**
 * Tests for PiProfile.splitByPiLabels XML-nesting awareness (#1411).
 *
 * Bug being pinned: `splitByPiLabels` opened a new top-level section on any
 * `Label:` line regardless of XML nesting. Pi's real system prompt nests
 * `<project_instructions path="...">` inside `<project_context>`, and files
 * carried by those blocks routinely contain label-shaped lines ("Guidelines:").
 * Because the slot map routes both `skills` and `rules` to "Guidelines", the
 * duplicated section key made the pipeline inject a memory block once per
 * matching segment — twice overall, with the second copy misplaced inside
 * the project instructions, and `<project_context>` truncated at the nested
 * label.
 */
import { describe, expect, it } from "vitest";
import { PiProfile, splitByPiLabels } from "../profile.js";

// The real Pi prompt shape quoted in #1411 (fixture of #1126), plus the
// top-level sections the slot map anchors against.
const NESTED_PROMPT = [
  "You are operating inside pi, a coding agent harness.",
  "",
  "<project_context>",
  "",
  "Project-specific instructions and guidelines:",
  "",
  '<project_instructions path="/example/AGENTS.md">',
  "# Example project instructions",
  "- Follow existing patterns in the codebase.",
  "Guidelines:",
  "- Keep changes minimal.",
  "</project_instructions>",
  "",
  "</project_context>",
  "",
  "Guidelines:",
  "- Be concise.",
  "",
  "Available tools:",
  "- read, write",
].join("\n");

describe("splitByPiLabels — XML nesting awareness (#1411)", () => {
  it("does not open sections from label-shaped lines inside an XML block", () => {
    const segments = splitByPiLabels(NESTED_PROMPT);
    const keys = segments.map((s) => s.key);
    // exactly one top-level Guidelines section — the nested "Guidelines:"
    // inside <project_instructions> must not create a second one
    expect(keys.filter((k) => k === "Guidelines").length).toBe(1);
    // the nested label did not split anything either
    expect(keys.some((k) => k?.startsWith("Project-specific"))).toBe(false);
  });

  it("keeps <project_context> intact through the nested block (no truncation)", () => {
    const segments = splitByPiLabels(NESTED_PROMPT);
    const ctx = segments.find((s) => s.key === "project_context");
    expect(ctx).toBeDefined();
    expect(ctx!.rawText).toContain('<project_instructions path="/example/AGENTS.md">');
    expect(ctx!.rawText).toContain("Keep changes minimal.");
    expect(ctx!.rawText).toContain("</project_instructions>");
    expect(ctx!.rawText).toContain("</project_context>");
  });

  it("applyAnchor injects the memory block exactly once per anchor key", () => {
    const profile = new PiProfile();
    expect(profile.detect(NESTED_PROMPT)).toBe(true);
    const segments = profile.parse(NESTED_PROMPT);
    expect(profile.resolveSlot("skills")).toBe("Guidelines");
    const injected = profile.applyAnchor(
      segments,
      { key: "Guidelines", relation: "before" },
      "[MEMORY BLOCK]",
    );
    const rebuilt = profile.rebuild(injected);
    expect(rebuilt.split("[MEMORY BLOCK]").length - 1).toBe(1);
    // the misplaced copy must not appear inside the project instructions
    const ctxSegment = injected.find((s) => s.key === "project_context");
    expect(ctxSegment?.rawText).not.toContain("[MEMORY BLOCK]");
  });

  it("rebuild stays lossless when nothing is injected", () => {
    const profile = new PiProfile();
    const segments = profile.parse(NESTED_PROMPT);
    expect(profile.rebuild(segments)).toBe(NESTED_PROMPT);
  });
});

describe("splitByPiLabels — behavior preserved for prompts without nesting", () => {
  it("still splits top-level labels into sections", () => {
    const prompt = ["Preamble.", "", "Available tools:", "- a", "", "Guidelines:", "- b"].join("\n");
    const segments = splitByPiLabels(prompt);
    expect(segments.map((s) => s.key)).toEqual([null, "Available tools", "Guidelines"]);
  });

  it("a top-level attribute-bearing open tag stays plain body (unchanged), but still guards nesting", () => {
    const prompt = [
      '<project_instructions path="/x/AGENTS.md">',
      "Guidelines:",
      "- inside",
      "</project_instructions>",
      "",
      "Guidelines:",
      "- top level",
    ].join("\n");
    const segments = splitByPiLabels(prompt);
    // the attr-open does not open a section (unchanged), but its "Guidelines:"
    // body line is now correctly guarded by the depth tracker
    expect(segments.filter((s) => s.key === "Guidelines").length).toBe(1);
    expect(segments[0].key).toBeNull();
    expect(segments[0].rawText).toContain("- inside");
  });

  it("stray close tags never drive depth negative", () => {
    const prompt = ["</orphan>", "", "Guidelines:", "- ok"].join("\n");
    const segments = splitByPiLabels(prompt);
    expect(segments.map((s) => s.key)).toEqual([null, "Guidelines"]);
  });
});
