import type { Database } from "bun:sqlite";
import { createThought, type Thought } from "../domain/thought";
import { createConnection, type Connection } from "../domain/connection";
import { ValidationError } from "../domain/validation";
import { captureWeaveIntent } from "../domain/weave-scheduling";
import type { Logger } from "../logging";
import { admitWeave, type WeaveSources } from "./weave-admission";

/** Narrow knowledge writer shared by the store and run aggregate, without depending on the store facade. */
export class SqliteKnowledgeWriter {
  constructor(private readonly db: Database, private readonly logger: Logger, private readonly scheduling?: WeaveSources) {}
  private boundary(operation: string, action: () => void): void {
    this.logger.verbose(`[storage] ${operation} attempt`);
    try { action(); this.logger.verbose(`[storage] ${operation} succeeded`); }
    catch (error) { this.logger.verbose(`[storage] ${operation} failed`); throw error; }
  }
  saveThought(input: Thought): void {
    this.boundary("save thought", () => {
      const thought = createThought(input);
      if (thought.kind === "media-original" || thought.author === "source" || thought.kind === "imported-original") throw new ValidationError("Imported originals require the dedicated import writer");
      this.db.transaction(() => {
        // Bun string binding consumes an initial U+FEFF; bind exact UTF-8 bytes and let SQLite cast them to TEXT.
        this.db.run("INSERT INTO thoughts (id, text, author, kind, created_at, origin, parent_id) VALUES (?, CAST(? AS TEXT), ?, ?, ?, ?, ?)",
          [thought.id, new TextEncoder().encode(thought.text), thought.author, thought.kind, thought.createdAt, thought.origin, thought.parentId]);
        this.db.run("INSERT INTO thought_titles (thought_id, title, title_author) VALUES (?, ?, ?)",
          [thought.id, thought.title, thought.title === null ? null : thought.titleAuthor ?? thought.author]);
        const insert = this.db.query("INSERT INTO thought_sources (thought_id, position, source_id) VALUES (?, ?, ?)");
        thought.sourceIds.forEach((id, index) => insert.run(thought.id, index, id));
        this.db.run("INSERT INTO thought_source_seals (thought_id) VALUES (?)", [thought.id]);
        const intent = captureWeaveIntent(thought);
        if (this.scheduling && intent) admitWeave(this.db,this.scheduling,intent);
      }).immediate();
    });
  }
  saveConnection(input: Connection): void {
    this.boundary("save connection", () => {
      const connection = createConnection(input);
      this.db.transaction(() => {
        this.db.run("INSERT INTO connections (id, from_id, to_id, category, proposed_by, explanation) VALUES (?, ?, ?, ?, ?, ?)",
          [connection.id, connection.fromId, connection.toId, connection.category, connection.proposedBy, connection.explanation]);
        const insert = this.db.query("INSERT INTO connection_sources (connection_id, position, source_id) VALUES (?, ?, ?)");
        connection.sourceIds.forEach((id, index) => insert.run(connection.id, index, id));
      })();
    });
  }
}
