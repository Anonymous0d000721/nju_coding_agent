export class CliError extends Error {
  constructor(message: string, readonly exitCode: number) {
    super(message);
    this.name = 'CliError';
  }

  static from(error: unknown): CliError {
    if (error instanceof CliError) return error;
    if (error instanceof Error) return new CliError(error.message, 1);
    return new CliError(String(error), 1);
  }
}