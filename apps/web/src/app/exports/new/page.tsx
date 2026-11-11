import type { Metadata } from "next";
import { NewExportView } from "../../../components/exports-view";

export const metadata: Metadata = { title: "New export" };
export default function NewExportPage() { return <NewExportView />; }
