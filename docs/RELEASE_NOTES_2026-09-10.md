# PolyTrack update: September 10

## Fixed
- Setting a PB no longer reopens Ranked over your race.
- Waiting runs are sorted by time, including your own run in the verified filter.
- A Firestore-only refresh keeps a verified checkmark only for the exact approved replay. A new PB never inherits an old checkmark.
- Smaller phone footer, clearer Studio controls, and a viewport-safe track-status panel.
- Waiting uses a clock and text, not color alone.

## Added
- Rolling Hills Racer by Histioth x StaticQuasar931, in Community tracks.
- Genuine native-physics replay review, with a private audit trail and bounded retries. PBs remain saved if review is unavailable.

## Important
Automatic scheduled review needs the GitHub Actions setup documented in tools/verifier/README.md. Known tracks up to five minutes are currently supported. Other runs remain waiting, not deleted. Verification checks replay physics, not replay authorship or whether inputs were tool-assisted.

Ranked remains open to new players. There is no new browsing lock, RP reset, or permanent track bonus in this update.
