/**
 * PiProfile — AgentProfile for the Pi coding agent (earendil-works
 * pi-coding-agent). Pi's system prompt uses `Label:` lines (not markdown
 * headings like Claude Code, not XML tags like CodeBuddy). This profile
 * splits on label lines into PromptSegments and maps semantic slots to
 * those labels, falling back to coarse injection points when a label is
 * absent (so Pi prompt drift never breaks injection — only moves its
 * anchor). Lossless parse→rebuild (join "\n", no trimming), matching the
 * ClaudeCodeProfile safety guarantee.
 */
import type { AgentProfile, PromptSegment, ResolvedAnchor } from "../interface.js";
import type { SemanticSlot } from "../../types.js";

const PI_SLOT_MAP: Record<string, string | null> = {
  persona: null,                   // preamble (plain) → fallback to coarse point
  tools: "Available tools",         // skill tools land before the tools section
  skills: "Guidelines",            // no dedicated skills section; anchor at Guidelines
  memory: null,                     // no memory section → system.suffix
  knowledge: null,                  // no knowledge section → fallback
  rules: "Guidelines",             // behavioral rules live in Guidelines
  task_context: "project_context", // the <project_context> block
};

// Label lines Pi emits: "Available tools:", "Guidelines:", "Pi documentation ...:"
const LABEL_RE = /^([A-Z][A-Za-z ]*):\s*$/;
// XML block sections: <project_context> ... </project_context>
const XML_OPEN_RE = /^<([a-z_]+)>\s*$/;
// Depth tracking only (never opens a section by itself): also recognizes
// attribute-bearing opens like <project_instructions path="..."> and any
// close tag, so label-shaped lines INSIDE an XML block stay in the
// enclosing section's body (#1411).
const XML_OPEN_WITH_ATTRS_RE = /^<([a-z_]+)(?:\s[^>]*)?>\s*$/;
const XML_CLOSE_RE = /^<\/([a-z_]+)>\s*$/;

export function splitByPiLabels(systemText: string): PromptSegment[] {
  const lines = systemText.split("\n");
  const segments: PromptSegment[] = [];
  let index = 0;
  let buffer: string[] = [];
  let currentKey: string | null = null;
  let currentKind: "plain" | "markdown_section" = "plain";
  let xmlDepth = 0;

  const flush = () => {
    if (buffer.length === 0) return;
    const rawText = buffer.join("\n");
    if (rawText.length === 0) {
      buffer = [];
      return;
    }
    if (currentKey === null) {
      segments.push({
        id: `plain-${index}`,
        kind: "plain",
        key: null,
        rawText,
        innerText: rawText,
        index: index++,
      });
    } else {
      const innerText =
        currentKind === "markdown_section" ? buffer.slice(1).join("\n") : rawText;
      segments.push({
        id: `section-${currentKey}`,
        kind: currentKind,
        key: currentKey,
        rawText,
        innerText,
        index: index++,
      });
    }
    buffer = [];
  };

  for (const line of lines) {
    // Split decision uses the depth BEFORE this line: a top-level bare open
    // tag still opens its section, while any line at nesting depth > 0
    // (label-shaped, or a nested tag) stays in the enclosing section's body.
    // Files carried by blocks like <project_instructions path="..."> routinely
    // contain "Guidelines:"-style lines; without the depth check they split
    // the enclosing section and duplicated anchor keys, which made the
    // pipeline inject a memory block once per bogus matching segment (#1411).
    const labelMatch = xmlDepth === 0 ? LABEL_RE.exec(line) : null;
    const xmlMatch = xmlDepth === 0 ? XML_OPEN_RE.exec(line) : null;
    if (labelMatch || xmlMatch) {
      flush();
      currentKey = labelMatch ? labelMatch[1].trim() : xmlMatch![1];
      currentKind = "markdown_section";
    }
    if (XML_OPEN_WITH_ATTRS_RE.test(line)) {
      xmlDepth++;
    } else if (XML_CLOSE_RE.test(line)) {
      xmlDepth = Math.max(0, xmlDepth - 1);
    }
    buffer.push(line);
  }
  flush();
  return segments;
}

export function applyPiAnchor(
  segments: PromptSegment[],
  resolved: ResolvedAnchor,
  text: string,
): PromptSegment[] {
  const result: PromptSegment[] = [];
  for (const seg of segments) {
    const isTarget = seg.key === resolved.key;
    if (isTarget && resolved.relation === "before") {
      result.push({
        id: `injected-before-${resolved.key}`,
        kind: "plain",
        key: null,
        rawText: text,
        innerText: text,
        index: seg.index - 0.5,
      });
      result.push(seg);
      continue;
    }
    if (isTarget && resolved.relation === "inside_prepend") {
      const lines = seg.rawText.split("\n");
      const heading = lines[0] ?? "";
      const body = lines.slice(1).join("\n");
      result.push({
        ...seg,
        rawText: [heading, text, body].filter((s) => s.length > 0).join("\n"),
        innerText: [text, seg.innerText].filter((s) => s.length > 0).join("\n"),
      });
      continue;
    }
    if (isTarget && resolved.relation === "inside_append") {
      result.push({
        ...seg,
        rawText: `${seg.rawText}\n${text}`,
        innerText: [seg.innerText, text].filter((s) => s.length > 0).join("\n"),
      });
      continue;
    }
    result.push(seg);
    if (isTarget && resolved.relation === "after") {
      result.push({
        id: `injected-after-${resolved.key}`,
        kind: "plain",
        key: null,
        rawText: text,
        innerText: text,
        index: seg.index + 0.5,
      });
    }
  }
  return result;
}

export class PiProfile implements AgentProfile {
  readonly id = "pi";
  readonly protocol = "openai" as const;

  detect(systemText: string): boolean {
    return (
      systemText.includes("operating inside pi") &&
      systemText.includes("coding agent harness")
    );
  }

  parse(systemText: string): PromptSegment[] {
    return splitByPiLabels(systemText);
  }

  resolveSlot(slot: SemanticSlot): string | null {
    return PI_SLOT_MAP[slot] ?? null;
  }

  applyAnchor(
    segments: PromptSegment[],
    resolved: ResolvedAnchor,
    text: string,
  ): PromptSegment[] {
    return applyPiAnchor(segments, resolved, text);
  }

  rebuild(segments: PromptSegment[]): string {
    return segments
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((s) => s.rawText)
      .join("\n");
  }
}
