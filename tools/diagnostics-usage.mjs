import {summarizeClientUsage as summarizeStoredClientUsage} from './local-insights.mjs';
import {FIREBASE_USAGE_COVERAGE} from './firebase-usage.mjs';

// Retain the stored v1 counters and unknowns; export coverage even before the first sample.
export function summarizeClientUsage(value,at=Date.now()){
 return {
  ...summarizeStoredClientUsage(value,at),
  coverage:{...FIREBASE_USAGE_COVERAGE}
 };
}
