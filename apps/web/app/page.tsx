import CaptureForm from "./ui/capture-form";

export default function HomePage() {
  return (
    <main id="main" className="workspace capture-workspace" tabIndex={-1}>
      <div className="page-intro">
        <h1>Capture a thought</h1>
        <p>A fragment is enough.</p>
      </div>
      <CaptureForm />
    </main>
  );
}
