import type { Metadata } from "next";
import Image from "next/image";
import { CaptureForm } from "../../components/capture-form";
import styles from "../../components/capture.module.css";

export const metadata: Metadata = { title: "Capture" };

export default function CapturePage() {
  return (
    <div className={styles.workspace}>
      <div className={styles.canopy} aria-hidden="true">
        <Image src="/backgrounds/capture-canopy.png" alt="" aria-hidden="true"
          width={392} height={588} unoptimized loading="eager" draggable={false}
          className={styles.canopyImage} />
      </div>
      <section className="capture-workspace" aria-labelledby="capture-heading">
        <CaptureForm />
      </section>
    </div>
  );
}
