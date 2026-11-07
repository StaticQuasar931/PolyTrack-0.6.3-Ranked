import {isDeepStrictEqual} from 'node:util';
import {assertTrustedPublishedEventTotalsBaseline} from './published-event-totals-baseline.mjs';

/** Pairing-only envelope for the published rebase path. This is NOT a pristine
 * Worker source and must never feed projectNativeEventTotals. Rebase scoring
 * uses the independently branded baseline, not this envelope's scores. Keep the
 * old overlay inside explicit provenance rather than erasing its history.
 */
export function publishedEventPairingTotals(baseline,candidateTotals){
  const published=assertTrustedPublishedEventTotalsBaseline(baseline);
  if(!isDeepStrictEqual(candidateTotals,published.totals))throw Error('Published pairing requires exact trusted totals');
  return {updatedAt:published.totals.updatedAt,entries:structuredClone(published.totals.entries),
    complete:true,totalEntries:published.totals.entries.length,source:'trusted-published-pairing-only',
    publishedPairing:{provenance:structuredClone(published.provenance),
      originalNativeEventOverlay:structuredClone(published.totals.nativeEventOverlay??null)}};
}
