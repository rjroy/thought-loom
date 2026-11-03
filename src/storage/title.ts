import type { Database } from "bun:sqlite";
import { TitleConflictError, TitleNotFoundError, type TitleRecord, type TitleRepository, type TitleTransaction } from "../domain/title";

/** Internal title persistence; consumers use TitleService. */
export class SqliteTitleRepository implements TitleRepository {
  constructor(private readonly db: Database) {}
  transaction<T>(action: (tx: TitleTransaction) => T): T {
    console.info("[title storage] transaction attempt");
    try {
      const result = this.db.transaction(() => action({
        get: id => {
          const row = this.db.query(`SELECT m.title, m.title_author AS titleAuthor,
            EXISTS(SELECT 1 FROM rejected_thoughts r WHERE r.thought_id = m.thought_id) AS rejected
            FROM thought_titles m WHERE m.thought_id = ?`).get(id) as { title: string | null; titleAuthor: TitleRecord["titleAuthor"]; rejected: number } | null;
          return row ? { title: row.title, titleAuthor: row.titleAuthor, rejected: row.rejected !== 0 } : null;
        },
        set: (id, state) => {
          if (state.titleAuthor === "ai") {
            const result = this.db.run(`UPDATE thought_titles SET title = ?, title_author = 'ai'
              WHERE thought_id = ? AND title IS NULL AND NOT EXISTS
              (SELECT 1 FROM rejected_thoughts WHERE thought_id = ?)`, [state.title, id, id]);
            if (result.changes !== 1) throw new TitleConflictError();
          } else {
            const result = this.db.run("UPDATE thought_titles SET title = ?, title_author = ? WHERE thought_id = ?", [state.title, state.titleAuthor, id]);
            if (result.changes !== 1) throw new TitleNotFoundError();
          }
        },
      })).immediate();
      console.info("[title storage] transaction succeeded");
      return result;
    } catch (error) {
      console.error("[title storage] transaction failed");
      throw error;
    }
  }
}
