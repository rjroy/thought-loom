import type { Database } from "bun:sqlite";
import { RunConflictError } from "../domain/run";
import { parseAgentInstructions, type AgentInstructions, type AgentInstructionsRepository } from "../domain/agent-instructions";
import { createLogger, type Logger } from "../logging";
import { immediate } from "./transaction";

export function migrateAgentInstructions(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_instructions (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    weaver TEXT NOT NULL, evolve TEXT NOT NULL, search TEXT NOT NULL, export TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision>=1 AND revision<=9007199254740991)
  )`);
}

/** The absent singleton is the initial all-empty revision zero. */
export class SqliteAgentInstructions implements AgentInstructionsRepository {
  constructor(private readonly db: Database, private readonly logger: Logger = createLogger()) {}

  get(): AgentInstructions {
    this.logger.verbose("[agent instructions] read attempt");
    try {
      const row = this.db.query<AgentInstructions, []>("SELECT weaver,evolve,search,export,revision FROM agent_instructions WHERE singleton=1").get();
      const result = row ? parseAgentInstructions(row) : {weaver:"",evolve:"",search:"",export:"",revision:0};
      this.logger.verbose("[agent instructions] read succeeded");
      return result;
    } catch (error) { this.logger.warning("[agent instructions] read failed"); throw error; }
  }

  save(value: AgentInstructions): AgentInstructions {
    const input = parseAgentInstructions(value);
    this.logger.info("[agent instructions] save attempt");
    try {
      const result = immediate(this.db, () => {
        const current = this.get();
        if (current.revision !== input.revision || current.revision === Number.MAX_SAFE_INTEGER) throw new RunConflictError("Agent instructions revision conflict");
        const encoder = new TextEncoder();
        const text = agentText(input,encoder);
        this.db.run(`INSERT INTO agent_instructions(singleton,weaver,evolve,search,export,revision)
          VALUES (1,CAST(? AS TEXT),CAST(? AS TEXT),CAST(? AS TEXT),CAST(? AS TEXT),?)
          ON CONFLICT(singleton) DO UPDATE SET weaver=excluded.weaver,evolve=excluded.evolve,
          search=excluded.search,export=excluded.export,revision=excluded.revision`,
        [...text,current.revision+1]);
        return {...input,revision:current.revision+1};
      });
      this.logger.info("[agent instructions] save succeeded");
      return result;
    } catch (error) { this.logger.warning("[agent instructions] save failed"); throw error; }
  }
}

function agentText(input: AgentInstructions, encoder: TextEncoder): Uint8Array[] {
  return [input.weaver,input.evolve,input.search,input.export].map(value => encoder.encode(value));
}
