import type { Metadata } from "next";
import { CaptureForm } from "../../components/capture-form";

export const metadata: Metadata = { title: "Capture" };

export default function CapturePage() {
  return (
    <section className="capture-workspace" aria-labelledby="capture-heading">
      <header className="workspace-intro capture-heading">
        <h1 id="capture-heading">Capture</h1>
        <p>Write or paste a thought.</p>
      </header>
      <CaptureForm />
    </section>
  );
}
