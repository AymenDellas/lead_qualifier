export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function publicError(error: unknown): { status: number; message: string } {
  if (error instanceof AppError) return { status: error.status, message: error.message };
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return {
      status: 504,
      message: 'The request timed out or was cancelled. Your saved work is safe. Please try again.',
    };
  }
  return {
    status: 500,
    message: 'Something went wrong. Your saved work is safe. Please try again.',
  };
}
