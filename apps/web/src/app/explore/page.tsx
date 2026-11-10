import type { Metadata } from "next";
import { connection } from "next/server";
import { ExploreView } from "../../components/explore-view";

export const metadata: Metadata = { title: "Explore" };

export default async function ExplorePage() {
  // Keep the revealed root presentation until the request-rendered destination is ready.
  await connection();
  return <ExploreView />;
}
