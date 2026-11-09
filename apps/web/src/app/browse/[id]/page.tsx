import type { Metadata } from "next";
import { Suspense } from "react";
import { decodeBrowseMapLocation } from "../../../features/browse/query";
import { BrowseMapView } from "../../../components/browse-map-view";

export const metadata: Metadata = { title: "Browse map" };

export default async function BrowseMapPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const values = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) for (const item of value) values.append(key, item);
    else if (value !== undefined) values.set(key, value);
  }
  return <Suspense fallback={<div className="workspace-intro"><h1>Browse map</h1><p>Loading linked ideas…</p></div>}>
    <BrowseMapView location={decodeBrowseMapLocation(id, values) ?? null} />
  </Suspense>;
}
