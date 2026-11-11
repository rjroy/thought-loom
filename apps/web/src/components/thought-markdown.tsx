import { createElement, type ComponentProps } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import styles from "./thought-markdown.module.css";

type HeadingLevel = 2 | 3 | 4 | 5 | 6;
export interface ThoughtMarkdownProps {
  readonly text: string;
  readonly className?: string;
  /** First content heading, below the surrounding screen or record heading. */
  readonly headingLevel?: HeadingLevel;
}

function externalHttpUrl(url: string): string | undefined {
  if (!/^https?:\/\//i.test(url)) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : undefined;
  } catch { return undefined; }
}

function readingComponents(firstLevel: HeadingLevel): Components {
  const heading = (depth: number) => ({ children }: ComponentProps<"h2">) =>
    createElement(`h${Math.min(firstLevel + depth - 1, 6)}`, {
      className: styles.heading, "data-depth": depth,
    }, children);
  return {
    h1: heading(1), h2: heading(2), h3: heading(3),
    h4: heading(4), h5: heading(5), h6: heading(6),
    a: ({ href, children }) => href && externalHttpUrl(href)
      ? <a href={href} target="_blank" rel="noopener noreferrer" title="Opens in a new tab">{children}<span className={styles.srOnly}> (opens in a new tab)</span></a>
      : <span>{children}</span>,
    img: ({ alt }) => <span>{alt}</span>,
    pre: ({ children }) => <>
      <p className={styles.scrollHelp}>Code keeps its line breaks. Scroll within the code block for long lines.</p>
      <pre tabIndex={0} role="region" aria-label="Code block, horizontally scrollable">{children}</pre>
    </>,
    table: ({ children }) => <>
      <p className={styles.scrollHelp}>Wide tables scroll here, not across the page.</p>
      <div className={styles.tableScroll} tabIndex={0} role="region" aria-label="Table, horizontally scrollable"><table>{children}</table></div>
    </>,
  };
}

// Stable component identities retain focused links when a reader's parent refreshes.
const components: Record<HeadingLevel, Components> = {
  2: readingComponents(2), 3: readingComponents(3), 4: readingComponents(4),
  5: readingComponents(5), 6: readingComponents(6),
};
const plugins = [remarkGfm, remarkBreaks];

/** Thought-reading policy. Export previews deliberately keep their separate inert renderer. */
export function ThoughtMarkdown({ text, className, headingLevel = 2 }: ThoughtMarkdownProps) {
  return <div className={`${styles.markdown}${className ? ` ${className}` : ""}`}>
    <Markdown skipHtml remarkPlugins={plugins} urlTransform={url => externalHttpUrl(url) ?? ""}
      components={components[headingLevel]}>{text}</Markdown>
  </div>;
}
