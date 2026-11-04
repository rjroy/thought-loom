import type { Metadata } from "next";

export const metadata: Metadata = { title: "Explore" };

export default function ExplorePage() {
  return (
    <div className="workspace-intro">
      <h1>Explore</h1>
      <p>Search is not available in this client yet.</p>
    </div>
  );
}
