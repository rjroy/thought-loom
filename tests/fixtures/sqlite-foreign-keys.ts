import type { Database } from "bun:sqlite";

export interface ForeignKeyPart {
  readonly seq: number;
  readonly table: string;
  readonly from: string;
  readonly to: string | null;
  readonly on_update: string;
  readonly on_delete: string;
  readonly match: string;
}
interface ForeignKeyRow extends ForeignKeyPart { readonly id: number }

export function orderForeignKeyGroups(groups: readonly (readonly ForeignKeyPart[])[]): readonly (readonly ForeignKeyPart[])[] {
  const key = (group: readonly ForeignKeyPart[]) => JSON.stringify(group.map(part =>
    [part.seq,part.table,part.from,part.to,part.on_update,part.on_delete,part.match]));
  return groups.map(group => [...group].sort((left,right) => left.seq-right.seq))
    .sort((left,right) => key(left).localeCompare(key(right)));
}

/** SQLite can renumber FK ids after an additive ALTER. Keep composite grouping, component order and every semantic field. */
export function foreignKeyGroups(db: Database, table: string): readonly (readonly ForeignKeyPart[])[] {
  const groups = new Map<number,ForeignKeyPart[]>(), quoted = `"${table.replaceAll('"','""')}"`;
  for (const {id,...part} of db.query<ForeignKeyRow, []>(`PRAGMA foreign_key_list(${quoted})`).all()) {
    const group = groups.get(id) ?? [];
    group.push(part); groups.set(id,group);
  }
  return orderForeignKeyGroups([...groups.values()]);
}
