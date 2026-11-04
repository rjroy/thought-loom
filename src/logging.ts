export type LogLevel = "error" | "warning" | "info" | "verbose";
export interface LogRecord {
  readonly level: LogLevel;
  readonly message: string;
  readonly context?: Readonly<Record<string, unknown>>;
}
export type LogSink = (record: LogRecord) => void;
export interface Logger {
  error(message: string, context?: Readonly<Record<string, unknown>>): void;
  warning(message: string, context?: Readonly<Record<string, unknown>>): void;
  info(message: string, context?: Readonly<Record<string, unknown>>): void;
  verbose(message: string, context?: Readonly<Record<string, unknown>>): void;
}

/** Each logger owns its immutable threshold and sink. */
export function createLogger(level: LogLevel = "info", sink: LogSink = record => {
  const output = record.level === "error" ? console.error : record.level === "warning" ? console.warn : console.info;
  if (record.context === undefined) output(record.message); else output(record.message, record.context);
}): Logger {
  const ranks: Record<LogLevel, number> = { error: 0, warning: 1, info: 2, verbose: 3 };
  const emit = (kind: LogLevel, message: string, context?: Readonly<Record<string, unknown>>) => {
    if (ranks[kind] <= ranks[level]) sink({ level: kind, message, ...(context === undefined ? {} : { context }) });
  };
  const logger: Logger = { error: (message, context) => emit("error", message, context), warning: (message, context) => emit("warning", message, context),
    info: (message, context) => emit("info", message, context), verbose: (message, context) => emit("verbose", message, context) };
  return Object.freeze(logger);
}
