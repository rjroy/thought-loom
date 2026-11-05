import type { Metadata } from "next";
import { ExportView } from "../../components/export-view";

export const metadata: Metadata = { title: "Export" };

export default async function ExportPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const value = (await searchParams).thoughtId;
  const thoughtId = typeof value === "string" && value.trim() ? value : null;
  return <ExportView key={thoughtId ?? "missing"} thoughtId={thoughtId} />;
}
