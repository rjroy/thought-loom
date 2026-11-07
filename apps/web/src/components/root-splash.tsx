"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { RootSplashScene } from "./root-splash-scene";
import styles from "./root-splash.module.css";

export function RootSplash({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [phase, setPhase] = useState<"intro" | "dissolve" | "finished">("intro");
  const overlay = useRef<HTMLDivElement>(null);
  const scene = useRef<SVGSVGElement>(null);
  const complete = useRef<SVGImageElement>(null);
  const skip = useRef<HTMLButtonElement>(null);
  const leave = useRef<() => void>(() => {});

  useEffect(() => {
    let active = true;
    let done = false;
    const animations: Animation[] = [];
    const timers: ReturnType<typeof setTimeout>[] = [];
    const cancel = () => { animations.forEach(animation => animation.cancel()); timers.forEach(clearTimeout); };
    const finish = () => {
      if (!active || done) return;
      done = true;
      cancel();
      setPhase("finished");
      router.replace("/explore", { scroll: false });
    };
    leave.current = finish;
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const onMotion = () => { if (motion.matches) finish(); };
    const onKey = (event: KeyboardEvent) => {
      if (done) return;
      if (event.key === "Escape") { event.preventDefault(); finish(); }
      if (event.key === "Tab") { event.preventDefault(); skip.current?.focus(); }
    };
    document.addEventListener("keydown", onKey);
    motion.addEventListener("change", onMotion);
    if (motion.matches) finish();
    else {
      router.prefetch("/explore");
      // Failed/stalled assets must never trap entry; ordinary playback is 2400ms.
      timers.push(setTimeout(finish, 3500));
      const prepare = async () => {
        await Promise.all([
          document.fonts.ready,
          ...["/backgrounds/splash-landscape.webp", "/backgrounds/splash-complete.webp"].map(async src => {
            const image = new window.Image(); image.src = src; await image.decode();
          }),
        ]);
        if (!active || done || !scene.current || !overlay.current) return;
        for (const element of scene.current.querySelectorAll<SVGElement>("[data-start]")) {
          const timing = { delay: Number(element.dataset.start) * 1000, duration: Number(element.dataset.duration) * 1000, fill: "both" as const };
          if (element instanceof SVGPathElement) {
            const length = element.getTotalLength();
            element.style.strokeDasharray = `${length} ${length}`;
            animations.push(element.animate([
              { strokeDashoffset: length, opacity: 0 },
              { strokeDashoffset: length * .98, opacity: 1, offset: .04 },
              { strokeDashoffset: 0, opacity: 1 },
            ], { ...timing, easing: "linear" }));
          } else {
            animations.push(element.animate([{ opacity: 0 }, { opacity: 1 }], {
              ...timing, easing: element.dataset.center ? "ease-in-out" : "cubic-bezier(0.16, 1, 0.3, 1)",
            }));
          }
        }
        const dissolve = overlay.current.animate([{ opacity: 1 }, { opacity: 0 }], {
          delay: 1950, duration: 450, fill: "both", easing: "ease-in-out",
        });
        animations.push(dissolve);
        const clock = document.timeline.currentTime;
        animations.forEach(animation => { animation.startTime = clock; });
        timers.push(setTimeout(() => { if (active && !done) complete.current?.removeAttribute("mask"); }, 1650));
        timers.push(setTimeout(() => { if (active && !done) setPhase("dissolve"); }, 1950));
        dissolve.finished.then(finish).catch(() => { /* Cancellation on skip/unmount is expected. */ });
      };
      void prepare().catch(finish);
    }
    return () => {
      active = false;
      leave.current = () => {};
      cancel();
      document.removeEventListener("keydown", onKey);
      motion.removeEventListener("change", onMotion);
    };
  }, [router]);

  return (
    <div className={styles.landing} data-root-splash={phase}>
      <div inert={phase !== "finished"} aria-hidden={phase !== "finished" ? true : undefined}>{children}</div>
      {phase !== "finished" && <div className={styles.overlay} ref={overlay}>
        <div className={styles.sceneArea} aria-hidden="true">
          <RootSplashScene sceneRef={scene} completeRef={complete} className={styles.scene} onError={() => leave.current()} />
        </div>
        <div className={styles.exit}>
          <button ref={skip} className={styles.skip} type="button" onClick={() => leave.current()}>Skip intro</button>
          <noscript>
            <style>{`[data-root-splash] button { display: none; } [data-root-splash] .${styles.overlay} { display: grid; }`}</style>
            <a className={styles.fallback} href="/explore">Open Explore</a>
          </noscript>
        </div>
      </div>}
    </div>
  );
}
