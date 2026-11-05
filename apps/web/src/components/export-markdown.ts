import { createElement } from "react";
import Markdown from "react-markdown";

export interface ExportMarkdownProps { readonly markdown: string; }

export function ExportMarkdown({ markdown }: ExportMarkdownProps) {
  return createElement(Markdown, {
    skipHtml: true,
    components: {
      a: ({ children }) => createElement("span", null, children),
      img: ({ alt }) => createElement("span", null, alt),
    },
    children: markdown,
  });
}
