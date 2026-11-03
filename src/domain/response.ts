import { nonEmpty, oneOf, record } from "./validation";

/** A full response associated with one thought; shared-response association is not specified. */
export interface ResponseRecord {
  readonly id: string;
  readonly thoughtId: string;
  readonly text: string;
  readonly role: "addendum" | "fallback";
}

export function createResponse(input: unknown): ResponseRecord {
  const data = record(input);
  return Object.freeze({
    id: nonEmpty(data.id, "id"),
    thoughtId: nonEmpty(data.thoughtId, "thoughtId"),
    text: nonEmpty(data.text, "text"),
    role: oneOf(data.role, "role", ["addendum", "fallback"]),
  });
}
