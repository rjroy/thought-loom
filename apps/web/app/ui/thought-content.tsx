import type { ReactNode } from "react";

// Reading order only. The owning source, formulation or exchange keeps its
// semantic container, identity, navigation and command state.
export default function ThoughtContent({ title, body, metadata, actions }: { title?: ReactNode; body: ReactNode; metadata?: ReactNode; actions?: ReactNode }) {
  return <>{title}{body}{metadata && <div className="thought-reading-meta">{metadata}</div>}{actions && <div className="thought-reading-actions">{actions}</div>}</>;
}
