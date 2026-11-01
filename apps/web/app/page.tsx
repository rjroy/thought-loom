import CaptureForm from "./ui/capture-form";

export default function HomePage() {
  return (
    <main id="main" className="workspace capture-workspace" aria-label="Capture" tabIndex={-1}>
      <CaptureForm />
    </main>
  );
}
