export type RenderThought = (text: string, headingLevel?: 2 | 3 | 4 | 5 | 6) => string;

// Root TypeScript has no JSX setting. The web workspace typechecks the TSX
// renderer helper, which stays outside the root compiler's static graph.
export async function renderThought(text: string, headingLevel?: 2 | 3 | 4 | 5 | 6): Promise<string> {
  const path = "./thought-markdown-renderer";
  const helper: { renderThought: RenderThought } = await import(path);
  return helper.renderThought(text, headingLevel);
}
