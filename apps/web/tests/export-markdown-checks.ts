import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ExportMarkdown } from "../src/components/export-markdown";

export function renderStructure(): string {
  const markdown = "# Heading\n\n## Subheading\n\nA **strong** idea and `inline code`.\n\n- First item\n- Second item\n\n```text\ncode <literal>\n```";
  return renderToStaticMarkup(createElement(ExportMarkdown, { markdown }));
}

export function renderHostileContent(): string {
  const markdown = [
    "# Safe heading",
    "[Useful external label](https://evil.invalid/track)",
    "[Body forgery](/ideas/forged)",
    "[Unsafe action](javascript:alert%281%29)",
    "![Owned image alternative](https://evil.invalid/pixel.png)",
    '<script>alert("owned-script-sentinel")</script>',
    '<img src="https://evil.invalid/raw.png" onerror="alert(1)">',
    '<svg onload="alert(1)"><circle /></svg>',
  ].join("\n\n");
  return renderToStaticMarkup(createElement(ExportMarkdown, { markdown }));
}
