import { describe, expect, it } from "vitest";

import { buildEditorHtmlFromPlainText, normalizeDraftHtmlForEditor } from "@/components/RichTextEditor";

describe("RichTextEditor draft formatting", () => {
  it("preserves exactly one blank line between paragraphs", () => {
    const html = buildEditorHtmlFromPlainText("a\n\nb");

    expect(html).toBe("<p>a</p><p></p><p>b</p>");
  });

  it("preserves single line breaks inside the same paragraph", () => {
    const html = buildEditorHtmlFromPlainText("a\nb");

    expect(html).toBe("<p>a<br />b</p>");
  });

  it("normalizes plain-text drafts with one blank line without collapsing or doubling it", () => {
    const html = normalizeDraftHtmlForEditor("a\n\nb");

    expect(html).toBe("<p>a</p><p></p><p>b</p>");
  });

  it("keeps blank lines containing spaces when converting plain text", () => {
    const html = buildEditorHtmlFromPlainText("a\n   \n b");

    expect(html).toBe("<p>a</p><p></p><p> b</p>");
  });
});
