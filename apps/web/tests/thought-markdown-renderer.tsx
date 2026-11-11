import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ThoughtMarkdown } from "../src/components/thought-markdown";
import type { RenderThought } from "./thought-markdown-checks";

export const renderThought: RenderThought = (text, headingLevel) =>
  renderToStaticMarkup(createElement(ThoughtMarkdown, { text, headingLevel }));
