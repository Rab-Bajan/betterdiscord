import { AppError } from '../../core/errors/AppError.ts';

/** A refused sweepers request; the (Hungarian) message goes to the client in the ack. */
export class SweepersError extends AppError {
  static readonly CODE = 'SWEEPERS_REFUSED';
  /** A throttled `miskolc:join_room`: the client may retry after ~600 ms. */
  static readonly RATE_LIMITED_CODE = 'SWEEPERS_RATE_LIMITED';

  constructor(message: string, details?: Record<string, unknown>, code: string = SweepersError.CODE) {
    super(code, message, details);
  }
}

/** Client-facing refusal messages. */
export const SWEEPERS_ERRORS = Object.freeze({
  notLoggedIn: 'Előbb jelentkezz be.',
  unknownChannel: 'Ismeretlen hangszoba.',
  notInRoom: 'Nem vagy ebben a világban.',
  shuttingDown: 'A szerver éppen leáll, próbáld újra később.',
  roomNotLoaded: 'Ez a világ nincs betöltve.',
  tooManyRequests: 'Túl gyorsan próbálkozol, várj egy kicsit.'
});
