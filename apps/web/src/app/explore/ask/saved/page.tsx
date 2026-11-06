import type { Metadata } from "next";
import { SavedSearchesView } from "../../../../components/agentic-search-sessions";

export const metadata: Metadata = { title: "Saved searches" };
export default function SavedSearchesPage() { return <SavedSearchesView />; }
