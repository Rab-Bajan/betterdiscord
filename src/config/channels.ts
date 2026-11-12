// Static channel definitions, copied verbatim from the legacy state.js.

/** A text channel. */
export interface TextChannel {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

/** A voice channel with a member cap. */
export interface VoiceChannel {
  readonly id: string;
  readonly name: string;
  readonly userLimit: number;
}

/** Text channels, in display order. */
export const textChannels: readonly TextChannel[] = Object.freeze([
  Object.freeze({ id: 'altalanos', name: 'általános', description: 'Általános beszélgetés minden témáról' }),
  Object.freeze({ id: 'gaming', name: 'gaming', description: 'Játék megbeszélések, mémek és stratégiák' }),
  Object.freeze({ id: 'zene', name: 'zene-és-klipek', description: 'Kedvenc zenék és videók megosztása' }),
  Object.freeze({ id: 'fejlesztes', name: 'fejlesztés', description: 'Kódolás, technológia és projektek' })
]);

/** Voice channels, in display order. */
export const voiceChannels: readonly VoiceChannel[] = Object.freeze([
  Object.freeze({ id: 'hang-altalanos', name: 'Általános Hang', userLimit: 10 }),
  Object.freeze({ id: 'hang-gaming-1', name: 'Gaming 1 (Squad)', userLimit: 5 }),
  Object.freeze({ id: 'hang-chill', name: 'Chill & Dumcsi', userLimit: 15 })
]);
