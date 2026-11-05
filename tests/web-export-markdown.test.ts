import { describe, expect, test } from "bun:test";
import { renderHostileContent, renderStructure } from "../apps/web/tests/export-markdown-checks";

// Keep React resolution in the web workspace while the root test runner discovers this suite.
for (const method of ["Simple", "Agentic"] as const) {
  describe(`${method} Markdown preview`, () => {
    test("renders real document structure and text", () => {
      const html = renderStructure();
      expect(html).toMatch(/<h1(?:\s[^>]*)?>Heading<\/h1>/);
      expect(html).toMatch(/<h2(?:\s[^>]*)?>Subheading<\/h2>/);
      expect(html).toMatch(/<strong>strong<\/strong>/);
      expect(html).toMatch(/<ul(?:\s[^>]*)?>[\s\S]*<li>First item<\/li>[\s\S]*<li>Second item<\/li>[\s\S]*<\/ul>/);
      expect(html).toMatch(/<pre(?:\s[^>]*)?><code(?:\s[^>]*)?>code &lt;literal&gt;/);
    });
    test("renders link labels and image alternatives as inert text while dropping executable markup", () => {
      const html = renderHostileContent();
      expect(html).toContain("Safe heading");
      expect(html).toContain("Useful external label");
      expect(html).toContain("Body forgery");
      expect(html).toContain("Unsafe action");
      expect(html).toContain("Owned image alternative");
      expect(html).not.toMatch(/<(?:a|img|script|svg|iframe|object|embed|link)\b/i);
      expect(html).not.toMatch(/\s(?:href|src|srcset|onerror|onload)\s*=/i);
      expect(html).not.toContain("javascript:");
      expect(html).not.toContain("https://evil.invalid");
      expect(html).not.toContain("owned-script-sentinel");
    });
  });
}
