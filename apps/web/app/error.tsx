"use client";

import Link from "next/link";

export default function WorkspaceError({ reset }: { reset: () => void }) {
  return <main id="main" className="workspace" tabIndex={-1}><h1>This page could not be opened</h1><p className="recovery-copy" role="alert">The workspace could not load. Try again, or return to capture.</p><div className="recovery-actions"><button className="button primary" onClick={reset}>Try again</button><Link className="text-link" href="/">Return to capture</Link></div></main>;
}
