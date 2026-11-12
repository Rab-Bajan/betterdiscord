import { AppError } from '../../core/errors/AppError.ts';

/** A refused sweepers request; the (Hungarian) message goes to the client in the ack. */
export class SweepersError extends AppError {
  static readonly CODE = 'SWEEPERS_REFUSED';

  constructor(message: string, details?: Record<string, unknown>) {
    super(SweepersError.CODE, message, details);
  }
}

/** Client-facing refusal messages. */
export const SWEEPERS_ERRORS = Object.freeze({
  notLoggedIn: 'Előbb jelentkezz be.',
  unknownChannel: 'Ismeretlen hangszoba.',
  notInRoom: 'Nem vagy ebben a világban.',
  shuttingDown: 'A szerver éppen leáll, próbáld újra később.'
});
