export type LogLevel = "info" | "debug";

export class Logger {
  constructor(private readonly debugEnabled: boolean) {}

  info(message: string, ...args: unknown[]): void {
    console.log(`[INFO] ${message}`, ...args);
  }

  debug(message: string, ...args: unknown[]): void {
    if (!this.debugEnabled) {
      return;
    }
    console.log(`[DEBUG] ${message}`, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    console.error(`[ERROR] ${message}`, ...args);
  }
}
