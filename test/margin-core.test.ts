import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MARGIN_DRAW_COUNT, MAX_PARAGRAPH_CHARS, focusFrom, marginQuery, marginScore, parseFocusBody, parseMarginDrawBody,
} from "../src/margin-core";

describe("parseFocusBody", () => {
  it("takes a trimmed, non-empty paragraph", () => {
    expect(parseFocusBody({ text: "  a paragraph.  " })).toEqual({ text: "a paragraph." });
  });
  it.each([[null], [{}], [{ text: 7 }], [{ text: "   " }], [{ text: "x".repeat(MAX_PARAGRAPH_CHARS + 1) }]])(
    "rejects %j",
    (raw) => expect(parseFocusBody(raw)).toBeNull(),
  );
});

describe("parseMarginDrawBody", () => {
  it("keeps short strings, caps the list, and tolerates a missing body", () => {
    const b = parseMarginDrawBody({ visible: [...Array(60)].map((_, i) => `w${i}`).concat([7 as never, "x".repeat(65)]) });
    expect(b.visible).toHaveLength(40);
    expect(parseMarginDrawBody(null)).toEqual({ visible: [] });
    expect(parseMarginDrawBody({ visible: "nope" })).toEqual({ visible: [] });
  });
  it("asks for one field-sized burst per draw", () => {
    expect(MARGIN_DRAW_COUNT).toBeGreaterThanOrEqual(4);
    expect(MARGIN_DRAW_COUNT).toBeLessThanOrEqual(5);
  });
});

describe("focusFrom — the focus carries only the embedding", () => {
  it("keeps the vector and a timestamp, nothing else", () => {
    const f = focusFrom([0.1, 0.2], 42);
    expect(f).toEqual({ embedding: [0.1, 0.2], at: 42 });
    expect(Object.keys(f!).sort()).toEqual(["at", "embedding"]);
  });
  it("refuses a missing or broken vector, so a bad embed keeps the previous focus", () => {
    expect(focusFrom(undefined, 1)).toBeNull();
    expect(focusFrom([], 1)).toBeNull();
    expect(focusFrom([0.1, Number.NaN], 1)).toBeNull();
  });
});

describe("marginQuery", () => {
  const focus = { embedding: [1, 0], at: 1 };
  it("follows the focused paragraph once there is one", () => {
    expect(marginQuery(focus, [0, 1])).toEqual({ mode: "focus", query: [1, 0] });
  });
  it("falls back to the seed before any focus, and to nothing before the seed is embedded", () => {
    expect(marginQuery(null, [0, 1])).toEqual({ mode: "seed", query: [0, 1] });
    expect(marginQuery(null, null)).toBeNull();
  });
  it("ranks candidates by closeness to the query", () => {
    const s = marginScore([1, 0]);
    expect(s({ embedding: [1, 0.1] })).toBeGreaterThan(s({ embedding: [0.1, 1] }));
  });
});

describe("ephemerality: the DO shell never stores or logs the paragraph", () => {
  const src = readFileSync(new URL("../src/session-do.ts", import.meta.url), "utf8");
  const start = src.indexOf("async marginFocus(");
  const end = src.indexOf("\n  }\n", start);
  const body = start >= 0 && end > start ? src.slice(start, end) : "";
  it("has a marginFocus method to check", () => {
    expect(body.length).toBeGreaterThan(0);
  });
  it("writes nothing to storage and logs nothing", () => {
    expect(body).not.toMatch(/putMeta|storage|sql\.exec|console\./);
  });
  it("keeps only focusFrom's output", () => {
    expect(body).toMatch(/this\.marginFocusState = focus/);
    expect(body).not.toMatch(/marginFocusState = [^f]/);
  });
});
