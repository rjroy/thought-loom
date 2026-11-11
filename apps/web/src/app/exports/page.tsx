import type { Metadata } from "next";
import { ExportsView } from "../../components/exports-view";

export const metadata: Metadata = { title: "Exports" };
export default function ExportsPage() { return <ExportsView />; }
