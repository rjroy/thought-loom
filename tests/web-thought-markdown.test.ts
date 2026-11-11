import { describe, expect, test } from "bun:test";
import { renderThought } from "../apps/web/tests/thought-markdown-checks";

describe("thought Markdown reading", () => {
  test("renders semantic Markdown and GFM within the surrounding heading hierarchy", async () => {
    const html = await renderThought([
      "# Heading", "", "## Subheading", "", "A **strong** and *emphasized* `idea`.", "",
      "- First\n- Second", "", "> A quotation", "", "```text\ncode <literal>\n```", "",
      "| Name | Value |\n| --- | --- |\n| Alpha | Beta |",
    ].join("\n"), 3);
    expect(html).toMatch(/<h3\b[^>]*>Heading<\/h3>/);
    expect(html).toMatch(/<h4\b[^>]*>Subheading<\/h4>/);
    expect(html).toContain("<strong>strong</strong>");
    expect(html).toContain("<em>emphasized</em>");
    expect(html).toContain("<code>idea</code>");
    expect(html).toMatch(/<ul>\s*<li>First<\/li>\s*<li>Second<\/li>\s*<\/ul>/);
    expect(html).toMatch(/<blockquote>\s*<p>A quotation<\/p>\s*<\/blockquote>/);
    expect(html).toMatch(/<pre\b[^>]*><code\b[^>]*>code &lt;literal&gt;/);
    expect(html).toMatch(/<table>\s*<thead>[\s\S]*<th>Name<\/th>[\s\S]*<td>Beta<\/td>/);
  });

  test("keeps single plain-text newlines visible and blank lines as paragraph boundaries", async () => {
    const html = await renderThought("First line\nSecond line\n\nSeparate paragraph");
    expect(html).toMatch(/<p>First line<br\s*\/>\s*Second line<\/p>/);
    expect(html).toContain("<p>Separate paragraph</p>");
  });

  test("links Markdown and bare HTTP(S) with safe, announced new-tab behavior", async () => {
    const html = await renderThought("[External](https://example.com/path) and http://example.org/plain");
    const links = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)];
    expect(links).toHaveLength(2);
    for (const [index, url] of ["https://example.com/path", "http://example.org/plain"].entries()) {
      const link = links[index];
      expect(link?.[1]).toContain(`href="${url}"`);
      expect(link?.[1]).toContain('target="_blank"');
      expect(link?.[1]).toMatch(/rel="[^"]*\bnoopener\b[^"]*"/);
      expect(link?.[1]).toMatch(/rel="[^"]*\bnoreferrer\b[^"]*"/);
      expect(link?.[0]).toMatch(/opens in a new (?:tab|window)/i);
    }
  });

  test("leaves unsafe destinations and images inert and suppresses raw HTML", async () => {
    const html = await renderThought([
      "[Unsafe](javascript:alert%281%29)", "[Mail](mailto:test@example.com)", "[Relative](/internal)",
      "![Alternative](https://image.invalid/pixel.png)",
      '<script>ownedScriptSentinel()</script>', '<img src="https://image.invalid/raw.png" onerror="ownedError()">',
    ].join("\n\n"));
    expect(html).toContain("Unsafe");
    expect(html).toContain("Alternative");
    expect(html).not.toMatch(/<(?:a|img|script|iframe|svg)\b/i);
    expect(html).not.toMatch(/\s(?:href|src|srcset|onerror)\s*=/i);
    expect(html).not.toContain("image.invalid");
    expect(html).not.toContain("ownedScriptSentinel");
  });
});
