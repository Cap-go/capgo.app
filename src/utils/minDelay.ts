/** Ensure at least `minMs` elapsed since `startTime` before continuing (spinner UX). */
export async function ensureMinDelay(startTime: number, minMs = 300) {
  const elapsed = Date.now() - startTime
  if (elapsed < minMs)
    await new Promise(resolve => setTimeout(resolve, minMs - elapsed))
}
