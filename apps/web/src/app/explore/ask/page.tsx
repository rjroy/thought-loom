import type { Metadata } from "next";
import { AgenticSearchEntry } from "../../../components/agentic-search-view";

export const metadata: Metadata = { title: "Ask your library" };
export default function SearchEntryPage() { return <AgenticSearchEntry />; }
