# Mac desktop relay

This is a separate Cloudflare Worker, `schafferai-desktop`. It does not alter the existing Hermes bridge. It uses a single SQLite-backed Durable Object, which is available on Workers Free. No plan upgrade, VM, D1 database, cron, or saved frame store is required. Free-plan quotas can interrupt access; this project does not enable paid overages or change the account plan.

The owner explicitly requested a public desktop portal with no visitor authentication. Anyone able to reach `/viewer` from the permitted site (or emulate its Origin header) can control the connected desktop. Origin checks are browser policy, **not authentication**. `AGENT_KEY` only prevents strangers from impersonating the Mac producer; it does not identify or restrict visitors.

## Endpoints

* `GET /health`: uncached JSON with `available`, `ready`, `state`, `message`, `width`, `height`, `screenRecording`, `accessibility`, `connected`, and `viewers`. Available means an accepted producer socket plus heartbeat within 35 seconds. Ready additionally requires the native agent to report `ready:true`.
* `GET /agent`: WebSocket upgrade with `Authorization: Bearer <AGENT_KEY>`. Exactly one fixed Mac; reconnection replaces its previous producer socket. `AGENT_KEY` must be at least 32 characters. Use a randomly generated value, store it as a Worker secret and in the native agent's private configuration, and never commit or send it to browsers.
* `GET /viewer`: WebSocket upgrade. No login, cookie, password, or token. The browser Origin must be `https://schafferai.com`, `https://www.schafferai.com`, or an HTTP loopback origin for QA. At most two connected viewers. No target query parameters are accepted.

## Wire protocol

Native producer sends JSON `{type:"hello"|"status"|"heartbeat",ready:boolean,width:number,height:number,state:"ready"|"paused"|"locked"|"permissions_required"|"error",screenRecording:boolean,accessibility:boolean,message?:string}`. Send a heartbeat at least every 15 seconds. All fields except `type` are optional on later updates. `ready` defaults to false when a new producer connects. Only these status fields are retained in socket metadata; additional native hello fields such as display scale are not published.

Producer sends raw JPEG binary messages while viewers are connected. The relay sends `{type:"viewers",count:0|1|2}` on producer/viewer connect or viewer disconnect so the agent can capture only on demand. Max JPEG is 2 MiB, at most 8 JPEGs/second; excess frames are dropped. No screenshot is cached for later viewers or written to storage. Hibernation attachments contain only connection/status/rate metadata.

Viewer sends `{type:"input",event:...}`. Accepted events:

```js
{type:"pointer",action:"move"|"down"|"up",x:0.0,y:0.0,button:0}
// Coordinates normalized 0..1, button 0..2.
{type:"scroll",deltaX:0,deltaY:100} // each -3000..3000
{type:"key",action:"down"|"up",key:"a",code:"KeyA",modifiers:["Shift"]}
// modifiers: Shift/Control/Alt/Meta; key <=40 chars, code alphanumeric <=32
{type:"text",text:"hello"} // 1..2000 characters
{type:"release"} // release all held keys/buttons
```

The relay forwards only the validated event inside `{type:"input",event}` to the one producer. Unknown event keys/types are rejected; there are no shell, file, launch, URL, or arbitrary-target commands. This does not restrict what a visitor can do using ordinary desktop input. Viewer JSON is capped at 16 KiB and 120 messages/second. `{type:"ping"}` returns a current status. Every viewer disconnect also sends a release event to prevent stuck input.

Producer status is sent to viewers as `{type:"status",...healthFields}`. Binary messages are JPEGs. The viewer must report unavailable/not-ready when the heartbeat expires and must not mistake a last-rendered frame for a live connection.

## Validate and deploy

Run `npm test` (Node 20+). The unit suite exercises the Worker and Durable Object handlers with a mocked platform WebSocketPair, including the intentionally open viewer, producer rejection, fixed-target input filtering, hibernation restoration, quotas, stale/offline status, and absence of frame storage. It does not claim an end-to-end macOS or Cloudflare production test.

Wrangler is pinned to the already installed version in `package.json` and requires Node 22+. Use `npm install` when installation is needed, then `npm run deploy` with a supported Node. The account id comes from the existing Hermes Wrangler configuration. The system-default Node 20 can run the unit tests but cannot launch this Wrangler. On this Mac, the bundled Node 24 runtime and Wrangler's direct entry point work without installation:

```sh
/Users/chris/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --no-warnings /Users/chris/Documents/Codex/2026-11-01/the-user-requested-a-separate-chat/sites/hermes-cloud/coordinator/bridge/node_modules/wrangler/wrangler-dist/cli.js deploy --config wrangler.jsonc
/Users/chris/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --no-warnings /Users/chris/Documents/Codex/2026-11-01/the-user-requested-a-separate-chat/sites/hermes-cloud/coordinator/bridge/node_modules/wrangler/wrangler-dist/cli.js secret put AGENT_KEY --config wrangler.jsonc
```

Wrangler's existing OAuth configuration reference is `/Users/chris/Library/Preferences/.wrangler/config/default.toml`; do not print or copy its credential values. `secret put` accepts the producer key through hidden stdin. Keep the returned actual deployment origin as the website's `relayUrl` and native agent endpoint. Do not infer successful deployment from the configured Worker name.

This directory contains no real producer secret. Deployment is a separate action; the existence of this source is not proof that the relay or desktop is available.

## Official references

* [Hibernating WebSockets, attachment restoration, and SQLite migration](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
* [Durable Objects availability on Workers Free and quotas](https://developers.cloudflare.com/durable-objects/platform/pricing/)

## Rollback

Disconnect/stop the native producer first to make desktop access unavailable immediately. Revert the website's relay configuration or remove its portal link. Delete only the dedicated `schafferai-desktop` Worker if permanently removing this relay; preserve every existing Hermes Worker/database and its production history. No archived frames need deletion because none are stored.
