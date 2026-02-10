type EndKind = 'SETTLED' | 'COLLAPSED_SINGLE' | 'COLLAPSED_TEN';

const STREAK_TRIGGER = 4;

let nonPrankCollapseStreak = 0;
let pityTokens = 0;
const pityGameIds = new Set<string>();

export function consumePityForNewGame(gameId: string) {
  if (pityTokens <= 0) return false;
  pityTokens -= 1;
  pityGameIds.add(gameId);
  return true;
}

export function isPityGame(gameId: string) {
  return pityGameIds.has(gameId);
}

export function markBlockStackGameEnded(gameId: string, endKind: EndKind) {
  pityGameIds.delete(gameId);

  if (endKind === 'SETTLED') {
    nonPrankCollapseStreak = 0;
    return;
  }

  if (endKind === 'COLLAPSED_TEN') {
    return;
  }

  nonPrankCollapseStreak += 1;
  if (nonPrankCollapseStreak >= STREAK_TRIGGER) {
    pityTokens += 1;
    nonPrankCollapseStreak = 0;
  }
}

export function getBlockStackPityDebugState() {
  return {
    nonPrankCollapseStreak,
    pityTokens,
    pityGameCount: pityGameIds.size,
  };
}
