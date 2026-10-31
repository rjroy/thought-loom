import CaptureForm from "./ui/capture-form";

export default function HomePage() {
  return (
    <main id="main" className="workspace" tabIndex={-1}>
      <div className="page-intro">
        <h1>Capture a thought</h1>
        <p>A fragment is enough. Keep the original before following where it leads.</p>
      </div>
      <CaptureForm />
      <section className="scope-note" aria-labelledby="scope-heading">
        <h2 id="scope-heading">An original, kept intact.</h2>
        <p>Save your words, then search for an original or explore its recorded notes. Weaving needs your own configured agent; dialogue is not available yet.</p>
      </section>
    </main>
  );
}
