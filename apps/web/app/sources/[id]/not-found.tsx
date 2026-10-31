import Link from "next/link";

export default function SourceNotFound() {
  return (
    <main id="main" className="workspace" tabIndex={-1}>
      <h1>Original not found</h1>
      <p className="recovery-copy">There is no saved source at this address. Check the full link, or capture a new thought.</p>
      <Link className="button primary" href="/">Capture a thought</Link>
    </main>
  );
}
