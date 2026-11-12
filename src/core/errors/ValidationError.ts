import { AppError } from './AppError.ts';

/** An untrusted payload was malformed (wrong type, out of range, missing field). */
export class ValidationError extends AppError {
  static readonly CODE = 'VALIDATION_ERROR';

  constructor(message: string, details?: Record<string, unknown>, clientFields?: Record<string, unknown>) {
    super(ValidationError.CODE, message, details, clientFields);
  }
}
