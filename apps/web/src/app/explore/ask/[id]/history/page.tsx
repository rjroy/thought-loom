import type { Metadata } from "next";
import { AgenticSearchView } from "../../../../../components/agentic-search-view";
import { safeSearchReturn } from "../../../../../features/agentic-search/location";

export const metadata: Metadata = { title: "Search history" };
export default async function SearchHistoryPage({ params }: { readonly params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!safeSearchReturn(`/explore/ask/${id}/history`)) return <section className="workspace-intro"><h1>Search link not valid</h1><p>Open a search from Saved searches.</p></section>;
  return <AgenticSearchView key={`${id}:history`} id={id} history />;
}
