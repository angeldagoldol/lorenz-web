// Dagoldol Phase 2 shared helpers.
// This file contains browser-independent logic so the accessibility and
// animation behavior can be regression-tested without a build system.

export function shouldAnimateLiquidChrome({
  documentHidden = false,
  reducedMotion = false,
  userPaused = false
} = {}) {
  return !documentHidden && !reducedMotion && !userPaused;
}

export function getNextTabIndex(currentIndex, key, count) {
  if (!Number.isInteger(count) || count <= 0) return -1;

  const safeIndex = Number.isInteger(currentIndex)
    ? Math.min(Math.max(currentIndex, 0), count - 1)
    : 0;

  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (safeIndex + 1) % count;
    case 'ArrowLeft':
    case 'ArrowUp':
      return (safeIndex - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return safeIndex;
  }
}
