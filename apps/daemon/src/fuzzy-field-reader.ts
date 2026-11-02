import type { MatcherStep } from "./fuzzy-matcher";
import type { ProjectionChunk, ProjectionField } from "./fuzzy-projection";
import type { FuzzySearchWork } from "./fuzzy-search-work";

// The owner keeps the read transaction alive across every yield. Abrupt exit
// closes the underlying SQLite generator before the connection is released.
export async function* readFieldChunks(field: ProjectionField, work: FuzzySearchWork): AsyncGenerator<ProjectionChunk> {
  const iterator = field.chunks[Symbol.iterator]();
  try {
    while (true) {
      await work.yield();
      const next = iterator.next();
      if (next.done) return;
      work.chunks++;
      yield next.value;
    }
  } finally { iterator.return?.(); }
}

type FieldConsumer = { append(text: string, final: boolean): void; step(maxUpdates: number): MatcherStep };

export async function consumeField(field: ProjectionField, consumer: FieldConsumer, work: FuzzySearchWork): Promise<void> {
  async function drain(): Promise<void> {
    while (true) {
      const step = consumer.step(work.remainingUpdates);
      const due = work.record(step.updates);
      if (due) await work.yield();
      if (step.done) return;
    }
  }
  for await (const chunk of readFieldChunks(field, work)) {
    consumer.append(chunk.text, chunk.ordinal === field.chunkCount - 1);
    await drain();
  }
  if (field.chunkCount === 0) {
    consumer.append("", true);
    await drain();
  }
}
