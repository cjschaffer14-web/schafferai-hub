# SchafferAI permanent desktop relay

Dedicated public HTTP transport for https://schafferai.com/desktop/. This Site has no visitor sign-in. A server-side AGENT_KEY authenticates the fixed Mac producer only.

The Worker uses D1 for short viewer leases, current readiness, and an expiring input queue. R2 holds only the latest JPEG for the current producer epoch, overwritten as frames arrive. Frames are served only while a viewer lease and fresh ready Mac exist; stale/closed/paused/disconnected sessions clear the cache. No historical desktop recording is created. Input expires after two seconds and is removed after acknowledgement. Content and credentials are not logged.

Schema is defined in db/schema.ts and generated migrations in drizzle/. Runtime bindings are DB and BUCKET; the producer secret belongs in Sites environment settings, never source. Native Sites tools own source publication and the stable deployment origin.

Validation: npm test; npm run build; npm run validate. Native Mac and browser clients live in cjschaffer14-web/schafferai-hub/desktop. Live deployment must be verified through public health and a real screen/input session.
