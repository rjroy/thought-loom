/** Invalid domain input at a data boundary. */
export class ValidationError extends Error {}

export function record(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ValidationError("Expected an object");
  }
  return input as Record<string, unknown>;
}

export function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${field} must be a non-empty string`);
  }
  return value;
}

export function nullableString(value: unknown, field: string): string | null {
  return value === null ? null : nonEmpty(value, field);
}

export function oneOf<const T extends readonly string[]>(value: unknown, field: string, choices: T): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) {
    throw new ValidationError(`${field} is invalid`);
  }
  return value as T[number];
}

export function references(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) throw new ValidationError(`${field} must be an array`);
  return Object.freeze(value.map((item: unknown) => nonEmpty(item, field)));
}
