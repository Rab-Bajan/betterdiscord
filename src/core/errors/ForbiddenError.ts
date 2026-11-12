import { AppError } from './AppError.ts';

/** The caller is known but is not allowed to perform the action. */
export class ForbiddenError extends AppError {
  static readonly CODE = 'FORBIDDEN';

  constructor(message: string, details?: Record<string, unknown>, clientFields?: Record<string, unknown>) {
    super(ForbiddenError.CODE, message, details, clientFields);
  }
}
