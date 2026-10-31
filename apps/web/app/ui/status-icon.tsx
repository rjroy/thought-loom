export default function StatusIcon({ kind }: { kind: "saved" | "queued" | "error" }) {
  return (
    <svg aria-hidden="true" className={`status-icon ${kind}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      {kind === "saved" ? <path d="m8 12 3 3 5-6" /> : kind === "queued" ? <path d="M12 7v5l3 2" /> : <path d="m9 9 6 6m0-6-6 6" />}
    </svg>
  );
}
