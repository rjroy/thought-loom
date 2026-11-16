import type { Metadata } from "next";
import { BackgroundWorkView } from "../../../components/background-work-view";

export const metadata: Metadata = { title: "Background work" };

export default function BackgroundWorkPage() {
  return <BackgroundWorkView />;
}
