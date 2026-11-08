import type { Metadata } from "next";
import { MediaImportView } from "../../../components/media-import-view";

export const metadata: Metadata = { title: "Import image or PDF" };
export default function MediaImportPage() { return <MediaImportView />; }
