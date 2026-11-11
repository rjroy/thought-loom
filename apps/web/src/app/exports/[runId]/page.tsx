import type { Metadata } from "next";
import { ExportDetailView } from "../../../components/exports-detail";

export const metadata: Metadata = { title: "Export" };
export default async function ExportPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  return <ExportDetailView key={runId} id={runId} />;
}
