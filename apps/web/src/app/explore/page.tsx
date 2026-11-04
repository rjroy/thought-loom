import type { Metadata } from "next";
import { Suspense } from "react";
import { ExploreView } from "../../components/explore-view";

export const metadata: Metadata = { title: "Explore" };

export default function ExplorePage() {
  return (
    <Suspense fallback={
      <div className="workspace-intro">
        <h1>Explore</h1>
        <p>Loading search controls…</p>
      </div>
    }>
      <ExploreView />
    </Suspense>
  );
}
