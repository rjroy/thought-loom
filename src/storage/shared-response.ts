import { createLogger, type Logger } from "../logging";
import type { Database } from "bun:sqlite";
import { createSharedResponse, type SharedResponse } from "../domain/shared-response";
import { nonEmpty } from "../domain/validation";

/** Internal persistence; save includes response, ordered links and seal atomically. */
export class SqliteSharedResponses {
  constructor(private readonly db: Database, private readonly logger: Logger = createLogger()) {}
  save(input: SharedResponse): void {
    this.logger.verbose("[response storage] save attempt");
    try {
      const response = createSharedResponse(input);
      this.db.transaction(() => {
        this.db.run("INSERT INTO responses (id, text, role, state) VALUES (?, ?, ?, ?)",
          [response.id, response.text, response.role, response.state]);
        const insert = this.db.query("INSERT INTO response_thoughts (response_id, thought_id, position) VALUES (?, ?, ?)");
        response.thoughtIds.forEach((id, index) => insert.run(response.id, id, index));
        this.db.run("INSERT INTO response_seals (response_id) VALUES (?)", [response.id]);
      }).immediate();
      this.logger.verbose("[response storage] save succeeded");
    } catch (error) {
      this.logger.verbose("[response storage] save failed");
      throw error;
    }
  }
  get(id: string): SharedResponse | null {
    this.logger.verbose("[response storage] get attempt");
    try {
      nonEmpty(id, "id");
      const result = this.db.transaction(() => {
        const row = this.db.query("SELECT id, text, role, state FROM responses WHERE id = ?").get(id);
        if (!row) return null;
        const links = this.db.query("SELECT thought_id AS id FROM response_thoughts WHERE response_id = ? ORDER BY position").all(id) as { id: string }[];
        return createSharedResponse({ ...row, thoughtIds: links.map(link => link.id) });
      })();
      this.logger.verbose("[response storage] get succeeded");
      return result;
    } catch (error) {
      this.logger.verbose("[response storage] get failed");
      throw error;
    }
  }
}
