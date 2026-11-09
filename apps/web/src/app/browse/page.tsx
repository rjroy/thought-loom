import type { Metadata } from "next";
import { Suspense } from "react";
import { BrowseView } from "../../components/browse-view";

export const metadata: Metadata = { title: "Browse" };

export default function BrowsePage() {
  return <Suspense fallback={<div className="workspace-intro"><h1>Browse</h1><p>Loading ideas…</p></div>}>
    <BrowseView />
  </Suspense>;
}
