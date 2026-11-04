import type { Metadata } from "next";
import { EvolveView } from "../../components/evolve-view";
import { evolveThoughtId } from "../../features/evolve/location";

export const metadata: Metadata = { title: "Evolve" };

export default async function EvolvePage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, item);
  }
  const id = evolveThoughtId(query);
  return <EvolveView key={id ?? "invalid"} thoughtId={id ?? null} />;
}
