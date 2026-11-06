import type { Metadata } from "next";
import { Suspense } from "react";
import { ImportView } from "../../components/import-view";

export const metadata: Metadata = { title: "Import Markdown" };
export default function ImportPage() {
  return <Suspense fallback={<p role="status">Loading import workspace…</p>}><ImportView /></Suspense>;
}
