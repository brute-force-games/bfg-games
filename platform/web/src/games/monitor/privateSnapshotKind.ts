import { BINGO_PRIVATE_KIND } from '../bingo/engine';
import { GOFISH_PRIVATE_KIND } from '../gofish/engine';
import { HANGMAN_PRIVATE_KIND } from '../hangman/engine';

/** HKDF `kind` string used when encrypting `gameStatePrivate` encrypted rows (per engine). */
export function guessPrivateSnapshotKind(gameType: string): string | null {
  switch (gameType) {
    case 'gofish':
      return GOFISH_PRIVATE_KIND;
    case 'bingo':
      return BINGO_PRIVATE_KIND;
    case 'hangman':
      return HANGMAN_PRIVATE_KIND;
    default:
      return null;
  }
}
