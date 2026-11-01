import type { InquiryView, ThoughtTitle } from "@thoughtloom/contracts";
import { titleEntityKey, titleTargetKey, type TitleTarget, type TitleView } from "./title-client";

export type TitleMetadata = { target: TitleTarget; title: ThoughtTitle | null };
export type TitleObservation = { readonly owner: symbol; readonly generation: number; readonly entity: string | null };
type Entity = {
  generation: number; writing: boolean; views: Map<string, ThoughtTitle | null>;
  userTitle?: ThoughtTitle; head?: string | null;
};
export function titleMetadataIdentity(title: ThoughtTitle | null | undefined): string {
  return title ? JSON.stringify([title.revisionId, title.author, title.text]) : "null";
}
export function inquiryTitleMetadata(view: InquiryView): TitleMetadata[] {
  return [
    { target: { kind: "source" }, title: view.source.title ?? null },
    ...view.items.map((item): TitleMetadata => ({ target: { kind: "item", itemId: item.id, versionId: item.current.id }, title: item.title ?? null })),
    ...(view.selectedTarget ? [{ target: { kind: "item" as const, itemId: view.selectedTarget.id, versionId: view.selectedTarget.versionId }, title: view.selectedTarget.title ?? null }] : []),
  ];
}

// Owned by one mounted root. Generations order request starts, never UUIDs or
// response arrivals. Inquiry reads share this clock with dedicated head reads.
export class TitleState {
  private readonly owner = Symbol();
  private generation = 0;
  private inquiryGeneration = 0;
  private readonly entities = new Map<string, Entity>();
  private readonly seeds = new Map<string, Set<string>>();
  constructor(initial: readonly TitleMetadata[] = []) {
    for (const metadata of initial) this.store(metadata);
  }
  private entity(target: TitleTarget): Entity {
    const key = titleEntityKey(target);
    let entity = this.entities.get(key);
    if (!entity) { entity = { generation: 0, writing: false, views: new Map() }; this.entities.set(key, entity); }
    return entity;
  }
  private remember({ target, title }: TitleMetadata): boolean {
    const key = titleTargetKey(target), identity = titleMetadataIdentity(title);
    let seen = this.seeds.get(key);
    if (!seen) { seen = new Set(); this.seeds.set(key, seen); }
    const known = seen.has(identity); seen.add(identity); return known;
  }
  private store(metadata: TitleMetadata) {
    const entity = this.entity(metadata.target);
    entity.views.set(titleTargetKey(metadata.target), metadata.title);
    if (metadata.title?.author === "user") entity.userTitle = metadata.title;
    this.remember(metadata);
  }
  display(target: TitleTarget): ThoughtTitle | undefined {
    const entity = this.entities.get(titleEntityKey(target));
    return entity?.userTitle ?? entity?.views.get(titleTargetKey(target)) ?? undefined;
  }
  head(target: TitleTarget): string | null | undefined { return this.entities.get(titleEntityKey(target))?.head; }
  // Changed unsequenced props are hints to revalidate, not a newer authority.
  seed(metadata: TitleMetadata): boolean {
    return !this.remember(metadata) && titleMetadataIdentity(this.display(metadata.target)) !== titleMetadataIdentity(metadata.title);
  }
  begin(target?: TitleTarget): TitleObservation {
    const generation = ++this.generation;
    if (target) this.entity(target).generation = generation;
    else this.inquiryGeneration = generation;
    return { owner: this.owner, generation, entity: target ? titleEntityKey(target) : null };
  }
  current(observation: TitleObservation, target: TitleTarget): boolean {
    const entity = this.entity(target);
    return observation.owner === this.owner && !entity.writing
      && (observation.entity === null || observation.entity === titleEntityKey(target))
      && observation.generation >= Math.max(this.inquiryGeneration, entity.generation);
  }
  accept(observation: TitleObservation, metadata: TitleMetadata, view?: TitleView): boolean {
    if (!this.current(observation, metadata.target)) return false;
    const entity = this.entity(metadata.target), key = titleTargetKey(metadata.target);
    const changed = !entity.views.has(key) || titleMetadataIdentity(entity.views.get(key)) !== titleMetadataIdentity(metadata.title);
    // A projection cannot supply a CAS head. Preserve other versions' generated
    // labels, but invalidate an editor's head when its observed metadata changes.
    if (!view && changed) entity.head = undefined;
    this.store(metadata); entity.generation = observation.generation;
    if (view) entity.head = view.headRevisionId;
    return true;
  }
  beginWrite(target: TitleTarget) { this.begin(target); this.entity(target).writing = true; }
  endWrite(target: TitleTarget) { this.entity(target).writing = false; }
}
