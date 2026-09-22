# Kodub weekly and permanent events

The Community track menu contains four independent Events cards: Kodub weekly,
our weekly event, our daily event, and permanent Rolling Hills Racer. Community
version navigation below the cards is full width. A version change does not hide
Events.

Kodub uses its official end time, independently of our daily/weekly reset cycle.
Its current track is mirrored through the Worker with strict asset identity and
bounded downloads. Current event runs use the event leaderboard and Event RP.
An expired Kodub event can be opened for unranked practice without reopening its
scoring period. The previous local capture is only a fallback while still valid.

Rolling Hills Racer is permanent and earns both normal RP and Event RP from
server-verified runs. It does not reset. Its current contribution can change as
verified standings change. Pending recordings may be watched but do not receive
verified rewards.

## Release components

The static site, Cloudflare Worker, and Firestore rules are separate releases.
Pushing the website does not deploy the Worker. Run the Worker tests before
`npm run deploy --prefix workers/ranked`. Keep existing Worker secrets private.
Do not restart migration to publish routine event or menu updates.

The browser reads `/v1/kodub-weekly`, `/v1/events/catalog`, event snapshots and
hash-bound replay/track endpoints. Requests require an allowed site Origin.
Cloudflare upstream fetches use manual redirects and reject redirect responses.

Archive standings reuse bounded cached snapshots. Winner and participant labels
must distinguish unavailable data from a genuine empty event. Permanent Rolling
Hills belongs in live events, not past events.
