import { AppError } from './AppError.ts';

/** The requested entity (session, user, message, ...) does not exist. */
export class NotFoundError extends AppError {
  static readonly CODE = 'NOT_FOUND';

  constructor(message: string, details?: Record<string, unknown>, clientFields?: Record<string, unknown>) {
    super(NotFoundError.CODE, message, details, clientFields);
  }
}
