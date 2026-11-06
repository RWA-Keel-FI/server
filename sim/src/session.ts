// Reuses the CRE workflow's calendar so the simulation and the workflow agree on when the US session is open.
export { getSessionState, nyLocal, nyOffsetSeconds, daysFromCivil } from '../../cre/deviation-workflow/src/session.ts'
export type { SessionState, Phase } from '../../cre/deviation-workflow/src/session.ts'
import { daysFromCivil, nyLocal, nyOffsetSeconds } from '../../cre/deviation-workflow/src/session.ts'

/** First instant at or after `afterSec` whose New York local time is the given weekday and hh:mm. */
export function nextNyStart(afterSec: number, weekday: number, hour: number, minute: number): number {
  for (let k = 0; k < 9; k++) {
    const probe = afterSec + k * 86400
    const nl = nyLocal(probe)
    if (nl.weekday !== weekday) continue
    const localSec = daysFromCivil(nl.y, nl.m, nl.d) * 86400 + hour * 3600 + minute * 60
    let utc = localSec + 18000
    utc = localSec - nyOffsetSeconds(utc)
    if (utc >= afterSec) return utc
  }
  throw new Error('no start found')
}
