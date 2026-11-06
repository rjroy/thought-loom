import Image from "next/image";
import type { SearchMaterialKind } from "../features/explore/query";
import styles from "./content-glyph.module.css";

type ContentCue = SearchMaterialKind | "full-reply" | "evolution" | "connection" | "used-as-source";
const files: Record<ContentCue, string> = {
  "captured-original": "captured-original.svg",
  "user-contribution": "user-contribution.svg",
  "ai-interpretation": "ai-interpretation.svg",
  "developing-idea": "developing-idea.svg",
  "imported-original": "imported-original.svg",
  "full-reply": "full-reply.svg",
  evolution: "evolution.svg",
  connection: "connection.png",
  "used-as-source": "used-as-source.png",
};
const sizes = { 16: styles.relationship, 20: styles.list, 24: styles.focus };

/** Visual companion only: the adjacent material/record/relationship words own meaning. */
export function ContentGlyph({ kind, size }: { kind: ContentCue; size: 16 | 20 | 24 }) {
  return <Image src={`/glyphs/${files[kind]}`} width={size} height={size}
    alt="" aria-hidden="true" unoptimized loading="eager" draggable={false}
    className={`${styles.glyph} ${sizes[size]}`} />;
}
