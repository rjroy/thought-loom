"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createBackgroundClient } from "../features/background-work/request";
import styles from "./background-work.module.css";

/** Independent from the instruction form: a summary failure must not disable Settings. */
export function BackgroundWorkEntry() {
  const [count, setCount] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void createBackgroundClient().summary().then(result => {
      if (!active) return;
      setCount(result.kind === "found" ? result.value["needs-attention"] : null);
      setFailed(result.kind === "error");
    });
    return () => { active = false; };
  }, []);

  return <section id="background-work" tabIndex={-1} className={styles.entry} aria-labelledby="background-entry-heading">
    <div>
      <h2 id="background-entry-heading">Background work <span className={styles.entryCount}>
        {failed ? "Status unavailable" : count === null ? "Checking status…" : count === 0 ? "Nothing needs attention" : `${count} ${count === 1 ? "needs" : "need"} attention`}
      </span></h2>
      <p>Review unfinished AI work across your library.</p>
    </div>
    <Link className={styles.textAction} href="/settings/background-work" prefetch={false}>Review background work</Link>
  </section>;
}
