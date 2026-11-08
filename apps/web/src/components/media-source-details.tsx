import type { MediaDescriptor } from "../features/idea/media";
import styles from "./idea.module.css";

const labels: Record<string, string> = { "image/png": "PNG image", "image/jpeg": "JPEG image", "image/gif": "GIF image", "image/webp": "WebP image", "application/pdf": "PDF" };
function byteLabel(bytes: number) {
  const format = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${format.format(bytes / 1024)} KB` : `${format.format(bytes / (1024 * 1024))} MB`;
}

/** A descriptor and separately attributed wording, never substitute thought text. */
export function MediaSourceDetails({ source, compact = false }: { source: MediaDescriptor; compact?: boolean }) {
  return <div className={compact ? styles.compactSource : styles.sourceDetails}>
    <p className={styles.sourceDescription}>{labels[source.mimeType] ?? source.mimeType} · {byteLabel(source.byteLength)} · Original authorship unverified</p>
    {source.clarification !== null ? <section className={styles.sourceClarification}>
      {compact ? <p className={styles.clarificationLabel}>Your clarification</p> : <h2>Your clarification</h2>}
      <p className={styles.clarificationText}>{source.clarification}</p>
    </section> : <p className={styles.metadata}>No user clarification was supplied. A summary was requested.</p>}
  </div>;
}
