import type { Metadata } from "next";
import { IdeaView } from "../../../components/idea-view";
import { decodeIdeaLocation } from "../../../features/idea/location";

export const metadata: Metadata = { title: "Idea" };

export default async function IdeaPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const values = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      values.append(key, item);
    }
  }
  const location = decodeIdeaLocation(id, values);
  return <IdeaView key={`${id}?${values}`} location={location ?? null} />;
}
