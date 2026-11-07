import { Suspense } from "react";
import { ExploreView } from "../components/explore-view";
import { RootSplash } from "../components/root-splash";

export default function HomePage() {
  return <RootSplash><Suspense fallback={null}><ExploreView presentationOnly /></Suspense></RootSplash>;
}
