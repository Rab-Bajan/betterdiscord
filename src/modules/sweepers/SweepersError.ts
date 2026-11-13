import { AppError } from '../../core/errors/AppError.ts';

/** A refused sweepers request; the (Hungarian) message goes to the client in the ack. */
export class SweepersError extends AppError {
  static readonly CODE = 'SWEEPERS_REFUSED';
  /** A throttled `miskolc:join_room`: the client may retry after ~600 ms. */
  static readonly RATE_LIMITED_CODE = 'SWEEPERS_RATE_LIMITED';
  /** A use earlier than its cadence allows (or a stale seq): the client handles it silently. */
  static readonly TOO_FAST_CODE = 'SWEEPERS_TOO_FAST';

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
  tooManyRequests: 'Túl gyorsan próbálkozol, várj egy kicsit.',
  // Phase C (plan C.8).
  tooFar: 'Túl messze vagy ehhez.',
  notOwned: 'Ez az eszköz még nincs meg neked.',
  notEquipped: 'Nem ez az eszköz van a kezedben.',
  exhausted: 'Kifulladtál – pihenj egy kicsit!',
  tankFull: 'Tele a tartály.',
  packFull: 'Tele a hátizsák – borítsd ki (G).',
  tooHeavy: 'Ez túl nehéz vagy túl nagy a hátizsákodnak.',
  noFuel: 'Kifogyott a benzin – tankolj a MÉH műhelyben.',
  clogged: 'Eldugult a cső – fújd ki (jobb klikk)!',
  lockedDistrict: 'Ez a kerület még le van zárva.',
  notEnoughCash: 'Nincs elég pénzed: {price} Ft kell.',
  notAtWorkbench: 'Ezt csak a MÉH műhelyben veheted meg.',
  notAtKiosk: 'Frissítőt a büfében vagy a MÉH irodában vehetsz.',
  alreadyOwned: 'Ez már megvan.',
  maxLevel: 'Ez már a legmagasabb szint.',
  staleLevel: 'Közben változott a szinted, próbáld újra.',
  noRepairNeeded: 'Ez az eszköz nem szorul javításra.',
  emptyPack: 'Üres a hátizsák.',
  unknownItem: 'Ismeretlen tárgy.'
});

/** `notEnoughCash` with the price filled in (thousands grouped with a space: 1 500). */
export function notEnoughCash(price: number): string {
  const grouped = String(Math.round(price)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return SWEEPERS_ERRORS.notEnoughCash.replace('{price}', grouped);
}
