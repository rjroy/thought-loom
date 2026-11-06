import type { Metadata } from "next";
import { CaptureForm } from "../../components/capture-form";

export const metadata: Metadata = { title: "Capture" };

export default function CapturePage() {
  return (
    <section className="capture-workspace" aria-labelledby="capture-heading">
      <CaptureForm />
    </section>
  );
}
