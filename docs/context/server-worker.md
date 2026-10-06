# Server and Worker: agent context brief

Scope: the Node server (`server/index.js`, `net.js`, `lobby.js`, `shared/protocol.js`), the Cloudflare Worker (`worker/**`, `wrangler.jsonc`, `tools/build-worker.mjs`, `tools/build-replay.mjs`), the two client transports (`public/js/net.js`, `public/js/room-net.js`) and their tests. Written 2026-10-06 by reading this worktree (node v22.22.0, app 0.1.3, protocol 1). `file:line` cites this tree and drifts: re-grep before editing. UNVERIFIED = read, not run or proved. Run while writing: `test/worker/*.test.js` 147/147 (108 s); lobby, lobby-kick, lobby-loadout, protocol-capacity, worker-build, matchmaking, worker-client, worker/matchmaker all pass. A minimal Miniflare self-host of the production bundle was run end to end (section 8).

## 1. Facts agents get wrong

1. **One rules engine, two platform adapters.** Rules live in `server/` (`Lobby`, `Network`, `Match`) and `shared/`; `worker/` only adapts them (worker/room-runtime.js:1-2). Node: one `Lobby` holds every room (server/index.js:638). Worker: one Durable Object per room code, each with a one-room `Lobby` (`maxRooms: 1`, worker/room-runtime.js:135). Fix rules in `server/`; never re-implement them in `worker/`.
2. **The Node server has no `/api`, no accounts, no login.** Only static files, `GET /healthz`, `/ws` (server/index.js:665-706; DEPLOY.md:136). All `/api/*` is Worker-only.
3. **Account-mode `room.create` / `room.join` are not the Node ones.** create needs a reservation (`POST /api/rooms`) first, else `NOT_HOST 'reservation required'` (worker/room-runtime.js:227-228); join needs a host-approved application ticket, else `APPLICATION_EXPIRED` (:209-214). The page's `request('room.join')` only files an HTTP application (public/js/room-net.js:141, 230-234). You cannot join a Worker room by code over the socket.
4. **Matchmaking (匹配) exists twice.** Node: `queue.join` over the socket (server/lobby.js:470). Worker: `POST /api/queue` polled every 1.5 s into the `Matchmaker` DO (worker/rooms/queue-routes.js, worker/matchmaker.js). `queue.join` on a Worker room socket is refused: the room's `Lobby` gets `queueTickMs: 0` (room-runtime.js:135), so it answers BAD_MSG 'matchmaking is not available here' (lobby.js:473; no test covers this refusal).
5. **The queue's "lazy clock" (Node).** `Lobby.queueTimer` is created by `queueJoin` (lobby.js:479, 527-533), `unref`'d, and stopped by the tick that finds the queue empty (:586) or by `shutdown` (:451): an idle lobby has no timer. The Worker `MatchQueue` has no timer at all: every call runs `tick(now)` first (matchmaker.js:36, 159). Both queues are memory only (matchmaker.js:12-13; `LobbyRuntime.snapshot` has no queue, worker/lobby-gateway.js:248-264).
6. **The two queues use different numbers.** Silent drop: Node 45 s (`queueSilentMs`, lobby.js:110) vs Worker 6 s (`silentMs`, matchmaker.js:27); the "10 s" in the room-net.js:54 comment is stale. The grace runs from the last arrival of the WHOLE Node queue (lobby.js:571) but of the GROUP in the Worker (matchmaker.js:187). A matched room is always a 4-seat co-op room (`DEFAULT_SEATS`, lobby.js:563; status `seats: 4`, :513).
7. **AI seats of a matched room are filled by the HOST'S PAGE, not the server** (public/js/screens/room.js:273-338; DESIGN.md:2342-2387). Node marks matched humans ready itself (lobby.js:599-602); in the Worker each member sends `room.ready` (DESIGN.md §28.2 'Readiness and start').
8. **Spectating differs.** Node: `room.spectate {code}` takes one of `MAX_SPECTATORS` = 2 spectator seats of any co-op room (lobby.js:724; shared/constants.js:27). Worker: `room.spectate` (no code) is intercepted (room-runtime.js:200) by `Spectators.join` (worker/rooms/spectators.js:107): public running co-op match only, no seat, 2 sockets per account (room-runtime.js:25).
9. **Worker co-op rooms are public by default** (`publicRoom = msg.mode === 'coop'`, room-runtime.js:232): listed in `SiteDirectory` and spectatable until the host calls `POST /api/rooms/CODE/visibility {public:false}` (worker/rooms/routes.js:50-59).
10. **Names and tokens.** The Worker ignores the hello `name` (room-runtime.js:41-45): the session is named after the account display name `昵称#NNNN` (up to 17 chars) read at the upgrade (worker/index.js:182-185); the client still sends <= 12 chars (public/js/names.js; public/js/main.js:389-412). Node token = 32 hex (server/net.js:123); Worker welcome token = `CODE.<32 hex>` (room-runtime.js:73-75), one session per account per room (:51, 70-71), a takeover rotates it (:64-69).
11. **`commandId` is dead.** RoomNet adds a UUID to every request (room-net.js:572); nothing in `server/`, `worker/` or `shared/` reads it (room-runtime.js:254 "former per-session command store").
12. **`/healthz` has three shapes.** Node `{ok, version: PROTOCOL_VERSION, app, uptimeSec, build: hash of public/, sockets, sessions, ...stats incl. queued}` (server/index.js:665-673). Worker account mode `{ok, runtime:'cloudflare', version: APP_VERSION, build: commit sha}` (worker/index.js:125-126), so `version` means a different thing. NODE_COMPAT answers Node's shape (:76-77).
13. **NODE_COMPAT is not production config.** No var, no `LOBBY` binding and no migration for `LobbyGatewayDurableObject` in wrangler.jsonc:18-67; only tests enable it (test/worker/gateway-compat.test.js:22-29). CLOUDFLARE.md:72 "Worker 只有账号模式" is true of the shipped config, yet the branch exists (worker/index.js:105). Its page build is `SP_NODE_CLIENT=1` (tools/build-worker.mjs:94-96). How it is deployed: UNVERIFIED (no doc, no config).
14. **Deploy only through `npm run deploy:worker`** = `node tools/build-replay.mjs --release && wrangler deploy` (package.json:41). `--release` exits 1 on a dirty tree or right after minting a new rules version: commit `replay-versions.json` + the new `replay-versions/<id>.json.gz`, run again (tools/build-replay.mjs:135-155). Any CI (`CI` or `WORKERS_CI` set) never mints and FAILS on an unarchived version (:40, 107-110); outside CI a plain build only warns (build-worker.mjs:167-169). CLOUDFLARE.md:38 says do not wire auto-build CI, yet wrangler.jsonc:22-23 keeps `previews: {}` for Workers Builds: which is intended is UNVERIFIED.
15. **Rules version = hash of the two engine bundles** (build-replay.mjs:70-89), not a git sha or semver; docs, Worker HTTP code and build scripts never mint one. Dev builds are `'development-v1'` with no retained engines (shared/rules-version.js:1; worker/match-versions.js:6-8). The Worker embeds recovery engines for the current + 3 older versions (`RECOVERY_RETAINED`, build-replay.mjs:33); every archived replay engine stays published (build-worker.mjs:179-186). 14 versions archived now (replay-versions.json).
16. **Migrations are append-only** (wrangler.jsonc:61-67; ACCOUNTS-HISTORY.md:48). `AdmissionDurableObject` was deleted by `v3-ratelimits`; rate limiting is now CF `ratelimits` bindings.
17. **Rate limits are per minute, per network, nothing stored**, one binding per route family (table in 5.1). `/api/admin/*` bypass them (worker/index.js:107-110 run before :111). `productionLimits` in tests is a manual copy of wrangler.jsonc:40-51 (test/worker/helpers/account-harness.js:10-21): edit both; no test asserts parity.
18. **No timers in a room DO.** `AlarmLobby` turns lobby-grace `setTimeout`s into `deadlines` + a storage alarm (room-runtime.js:78-111); matches run on a virtual scheduler (`RecordedMatch`) pumped inside each event (worker/index.js:352-367; server/match/checkpoint.js:66-100). `Date.now()` at module top level is frozen in workerd (worker/index.js:68-70). `Network` runs with `autoTimers:false` (room-runtime.js:246).
19. **`RecordedMatch` logs** `start/handle/onDisconnect/onReconnect/onLeave/setLoadout/setPicks` (server/match/checkpoint.js): picks survive a restore; `addSpectator` / `removeSpectator` still bypass the log.
20. **Close codes overlap.** 1001 is Node's shutdown (server/net.js:70) and the Worker's idle-socket close (worker/close-codes.js:24). The browser acts only on 4001/4003/4004 (close-codes.js:2-4; room-net.js:460-466). A refused Worker upgrade is a 101 that closes at once (`refuseSocket`, close-codes.js:30-35) because browsers cannot read upgrade HTTP statuses.
21. **Heavy-intent bucket** (2/s, burst 6) = `g.watch`, `room.loadout`, `room.spectate` only (server/net.js:67); `room.pick` is not in it. `room.pick` has no `test/lobby*.test.js` coverage (only test/match/waiguan.test.js, test/ui/loadout.test.js).
22. **`GET /api/me` signed out is 200 `{user:null,...}`**, not 401 (worker/accounts/routes.js:93-96); other `/api/me/*` are 401 LOGIN_REQUIRED (:98).
23. **`node --test test/worker/` FAILS on Node 22** ("Cannot find module .../test/worker": a directory is not recursed). Use a glob: `node --test "test/worker/*.test.js"`.
24. **Miniflare needs `run_worker_first: true` + `routerConfig {has_user_worker, invoke_user_worker_ahead_of_assets}`**; the wrangler.jsonc array form alone gives 500 "Fetch for user worker without having a user worker binding" (account-harness.js:42; reproduced).

## 2. Where to look

| Question | Where |
|---|---|
| Node boot, static server, `/healthz`, upgrade refusals, shutdown | server/index.js:614-743 (`startServer`), header 1-29 |
| Frame pipeline, rate buckets, hello/welcome, heartbeat, admission, client address | server/net.js:577-636 (`onFrame`), 648-687, 718-748, 546-553, 462-471 |
| Rooms, seats, host, bots, ready/start, kick, capacity | server/lobby.js:648-883; header rules 4-84 |
| Loadout / 外援 picks | lobby.js:889-945; shared/protocol.js:82-150; server/match/Match.js:598-640 |
| 匹配 (Node) | lobby.js:98-111, 463-642; test/matchmaking.test.js; DESIGN.md:2342-2370 |
| Message catalogue, validators, ERR codes | shared/protocol.js:307-426; shared/constants.js:134-157; DESIGN.md:416-444 (§8) |
| Worker routing and limits | worker/index.js:46-189; wrangler.jsonc:27-51 |
| One-room runtime, alarms, sockets, snapshot | worker/room-runtime.js:23-111, 113-614; worker/index.js:208-720; worker/do-storage.js |
| Accounts, sessions, GitHub OAuth | worker/accounts/auth.js, routes.js, github.js, directory.js, account.js; ACCOUNTS-HISTORY.md |
| Join applications, public lobby, spectators | worker/rooms/routes.js:1-126, applications.js, spectators.js; accounts/directory.js:233-256 |
| 匹配 (Worker) | worker/matchmaker.js:23-228; worker/rooms/queue-routes.js; public/js/room-net.js:236-371; DESIGN.md:2371-2387 |
| Match archive, history, backups, admin | worker/archive/*, worker/storage/backup.js, worker/accounts/admin.js; tools/archive-backup.mjs, reset-password.mjs |
| NODE_COMPAT lobby gateway | worker/lobby-gateway.js; worker/index.js:61-90 |
| Build, assets, bundle, resource pack | tools/build-worker.mjs; worker/pack.js; worker/media.js; tools/resource-pack.mjs |
| Rules versions, replay engines, archive | tools/build-replay.mjs; replay-versions.json; shared/rules-version.js; worker/match-versions.js |
| Client transports | public/js/net.js, room-net.js, worker-entry.js, account.js |
| Deploy docs | docs/CLOUDFLARE.md, DEPLOY.md, ACCOUNTS-HISTORY.md (maps in section 9); regenerate docs/context/DOC-INDEX.md with `node tools/doc-index.mjs` |

## 3. Node vs Worker at a glance

| | Node server | Worker (account mode) |
|---|---|---|
| Entry | `npm start` -> server/index.js | worker/entry.js:1-7 bundled to `dist/worker/index.mjs` (wrangler.jsonc:5) |
| Rooms | all in one `Lobby` (<= 1000, lobby.js:100) | one DO per code: `ROOMS.idFromName(code)`, hint apac (worker/index.js:31) |
| Identity | anonymous name + token | cookie `__Host-sp_session` (worker/accounts/auth.js:10) -> account |
| Match class | `Match` (lobby.js:301) | `RecordedMatch` (room-runtime.js:135): event log + checkpoint |
| Timers / state | setTimeout, in memory; restart ends matches (DEPLOY.md:18) | alarms + DO storage; matches restore after deploys |
| Per-client caps | 40 msg/s, 64 sockets/addr, 16 rooms/addr, 8 matches/addr | `ROOM_LIMITS` (room-runtime.js:23-25) + CF ratelimit bindings |
| Frame cap | 64 KB (server/index.js:52) | 65,536 B, close 1009 (room-runtime.js:23, 490) |
| `room.state` | `Room.toState` (lobby.js:263) | same + per-seat `avatarUrl`, `spectatorCount`, `spectating` (worker/rooms/spectators.js:63-72) |

## 4. Node server

### 4.1 Boot (server/index.js)
- `startServer(opts)` returns `{port, host, url, server, wss, lobby, network, registry, close}` (:742); tests call `startServer({port:0, quiet:true, ...overrides})` (header :28). Env `PORT` 3000, `HOST` 0.0.0.0, `TRUST_PROXY` auto|1|0 (:583), `DEBUG`.
- Overrides: Net `reconnectWindowMs heartbeatMs helloTimeoutMs ratePerSec rateBurst maxConnections abuseDropsPerSec maxConnectionsPerAddr heavyPerSec heavyBurst trustProxy` (:626); Lobby `lobbyGraceMs maxRooms maxRoomsPerAddr maxMatchesPerAddr resyncMinGapMs soloReconnectWindowMs queueTickMs queueMinSeats queueGraceMs queueTimeoutMs queueSilentMs` (:633-637).
- WS: `/ws` only, `maxPayload` 64 KB, no deflate (:686); upgrade refusals 404 other path, 429 per-address, 503 shutdown/full (:690-699). Shutdown: `lobby.shutdown('shutdown')` + `network.close()`, sockets get 1001 (:727-740).
- `buildTag()` = sha1 of size+mtime under `public/index.html|js|css`, computed once per process (:136-181), exposed as `/healthz.build`.

### 4.2 Session layer (server/net.js)
- `NET_DEFAULTS` (:44-60): 40 msg/s burst 40; > 400 drops/s closes 1008; heartbeat 30 s (a socket silent for a full interval is terminated); hello timeout 30 s -> 4002 (checked at heartbeats, so 30-60 s); reconnect window 10 min; `b.snap` dropped above 1 MiB queued, socket terminated above 16 MiB (:267-277); 2000 sockets, 64 per `limitKey`; 20,000 sessions (evict oldest disconnected roomless, :147, 204); heavy bucket 2/s burst 6.
- `onFrame` (:577) order: closing -> token bucket -> RATE (rid peeked from frames <= 2048 B, :505) -> binary / bad JSON / unknown `t` / `validateC2S` = BAD_MSG -> `ping` => `pong {c, s}` -> `hello` -> 'hello required' -> heavy bucket -> `routeGame` for `b.*` (:623) else `handler.onMessage`; answer `ok {rid}` or `error {code,msg,rid?,detail?}` (:635, 322).
- `onHelloMsg` (:648): wrong `version` = BAD_MSG; `helloName` (:643; `sanitizeName` <= 12 code points, :359); a known token resumes (old socket closed 4001, :664, 690) else new session `p_`+10 hex (:149); sends `welcome {playerId, token, name, serverNow, version, resumed}` (:679) then `handler.onHello(session, {resumed, repeat})`.
- A session lives `windowOf` = 10 min; the lobby may only lengthen it per session (:181); sweep every clamp(window/4, 20 ms, 15 s) (:532). `clientAddress` (:462) trusts CF-Connecting-IP / X-Real-IP / rightmost X-Forwarded-For only from loopback/private peers under `'auto'`; local peers without a forwarded address get key null = never limited. Handler contract: header :30-36 (`onHello onMessage routeGame onDisconnect onExpire`).

### 4.3 Protocol (shared/protocol.js)
- `C2S` (:307) maps `t` to field validators; unknown extra fields are ignored; `rid` is an int 0..2^31 (:417). Families: `hello{name,token?,version?}`, `ping{c}`; `room.create{mode:'solo'|'coop',difficulty,capacity?}`, `join{code}`, `leave`, `ready{ready}`, `setDifficulty`, `setCapacity`, `addBot`, `removeBot{seat}`, `kick{seat,playerId}`, `start`, `loadout{entries}`, `pick{picks}`, `spectate{code?}`, `removeSpectator{playerId}`; `queue.join{difficulty}`, `queue.leave`; `g.*` match intents; `b.progress`, `b.result` (client-side combat reports).
- `S2C` (:392): `welcome ok error pong room.state room.closed queue.status queue.matched m.public m.private m.field m.toast m.ticker m.emote m.result m.unitStats b.start b.pool b.end b.snap b.ev`.
- Constants (shared/constants.js:3-31): `PROTOCOL_VERSION` 1, `MAX_SEATS` 8, `DEFAULT_SEATS` 4, `MAX_SPECTATORS` 2, `ROOM_CODE_LEN` 4, `NAME_MAX_LEN` 12, `DIFFICULTIES` FUNNY|NORMAL|HARD|ABYSS.
- New message: validator in `C2S`, case in `Lobby.onMessage` (lobby.js:393), name in `S2C`, DESIGN §8; if the Worker must treat it differently, intercept in `handler.onMessage` (room-runtime.js:199).

### 4.4 Lobby (server/lobby.js)
- Codes: 4 letters of `ABCDEFGHJKLMNPQRSTUVWXYZ` (:95); join is case-insensitive (:678). Solo = 1 seat, no bots; co-op capacity 4..8 (`coopCapacity` :125; `resize` :239). Bots `ai_`+8 hex, names from `BOT_NAMES` (:122, 821).
- Host-only: `setDifficulty` (un-readies others), `setCapacity` (lobby only, never below occupied), `addBot`, `removeBot`, `kick` (`{seat,playerId}`; target gets `room.closed {kicked}`; no ban; :841), `start` (:864: every other human connected and ready else NOT_READY; solo needs exactly 1 human; <= 8 matches per network, :878). Host migrates to the lowest-seat connected human (:1266); no humans = room disposed (:1247).
- Lobby disconnect keeps the seat 60 s (`lobbyGraceMs` :99, `startGrace` :1274) then `room.closed {timeout}` on next resume; in a match the seat is kept (:430); a dropped solo run resumes for 24 h (`soloResumeWindowMs` :1192, set at :424). A repeated `hello` is a full resync throttled to 1/s per session (`resync` :1082); result replay after a match (:1050-1074).
- `startMatch` (:951) builds `seats[]` with loadout/picks, seed, `matchNo`; `onMatchEnd` (:1004) returns the room to LOBBY and un-readies humans. Per-network caps: 16 rooms -> RATE 'too many rooms from your network' (:653-659).
- `room.loadout` (:889): `checkLoadout` against game data plus the player's own picks, kept on session and seat, forwarded to `match.setLoadout` (only INFO_CHECK accepts, else WRONG_PHASE).
- `room.pick` (:922): `checkWaiguanPicks` (shared/protocol.js:110), <= 4 slots `diy5a diy5b diy6a diy6b`, stored on session and seat; `room.state.picks` shows only the viewer's own (:263-277); `Match.setPicks` accepts LOBBY / INFO_CHECK / BAND_CHECK only.

### 4.5 Node queue (lobby.js)
- `LOBBY_DEFAULTS` (:98-111): tick 1000 ms, minSeats 2, grace 3000, timeout 20,000, silent 45,000. `queueTick` (:545-587) drops entries that left, disconnected, sit in a room or went silent (:550); group = oldest entry + later same-difficulty entries up to 4; ready when 4 members, or >= 2 and `now - lastArrival >= grace`, or the head waited >= timeout (:572-574).
- `startQueuedMatch` (:595) creates a co-op room (`create` + `placePlayer`), sets `room.matched`, marks humans ready, sends `queue.matched {code, difficulty, seated}` (:637); an unseatable member returns to the queue front. `queue.leave` always answers `queue.status` (:491-497); entering a room or disconnecting removes the session (:421, 1231).
- `queue.join` while seated in a LOBBY room answers ok and is dropped by the immediate tick (:480, 550): code-read, UNVERIFIED.

## 5. Cloudflare Worker

### 5.1 Routing and limits (worker/index.js:92-189, in this order)
- `/stronghold-resources.zip` -> `servePack`, `/media/*` -> `serveMedia` (:98-99, before NODE_COMPAT) -> `env.NODE_COMPAT` -> `compatRoute` (:105) -> `/api/admin/backup*` (ARCHIVE_EXPORT_TOKEN for GET, ARCHIVE_IMPORT_TOKEN for POST; storage/backup.js:160-166) -> `/api/admin/accounts/password` (ACCOUNT_ADMIN_TOKEN; accounts/admin.js:14) -> `apiLimit` for all other `/api/*` (:111) -> `handleAuth`, `handleGithub`, `handleAccountRoutes`, `handleLobbyRoutes`, `handleQueueRoutes`, `handleHistoryRoutes` (:112-124) -> `/healthz` (:125) -> `/_*` is 404 (:128) -> `POST /api/rooms` (:129-154: Origin must equal origin, up to 12 random codes, 409 ALREADY_SEATED, returns an unused reservation again) -> `GET /api/rooms/XXXX` status (:155) -> `/ws` (:162-186) -> ASSETS (:188). Writes require `Origin === url.origin` (accounts/auth.js:22). The exported `fetch` wraps `route` (:36-43); `errorResponse` (worker/http.js:37) answers an `AccountError` with its own code and status, a retryable/overloaded DO with 503 UNAVAILABLE, anything else 500 INTERNAL.
- `/ws?room=CODE[&ticket=32hex]`: valid code else `refuseSocket(4004)`; CONNECT_LIMIT per network; login cookie else 4003; CONNECT_LIMIT per account; `getProfile()`; forward to the room DO with X-Room-IP, X-Account-ID, X-Session-ID, X-Session-Expires, X-Account-Name (URL-encoded), X-Avatar-URL (:165-185).

| Binding (wrangler.jsonc:40-51) | Limit /min | Counts |
|---|---|---|
| RESERVE_LIMIT 1001 | 8 | `POST /api/rooms` per network |
| CONNECT_LIMIT 1002 | 40 | `/ws` per network, then per account |
| STATUS_LIMIT 1003 | 120 | `GET /api/rooms`, `/api/rooms/XXXX`, `GET .../applications` |
| AUTH_LIMIT 1004 | 10 | `/api/auth/github/start` only |
| APPLICATION_LIMIT 1005 | 30 | `POST .../applications` per network and per account (rooms/routes.js:18) |
| API_LIMIT 1006 | 600 | every other `/api/*` (`/api/me*`, `/api/matches*`, `.../visibility`, register/login/logout, OAuth callback) |
| REGISTER_LIMIT 1007 / LOGIN_LIMIT 1008 | 3 / 10 | per network (accounts/auth.js:71, 80) |
| USERNAME_LIMIT 1009 | 5 | per `username@network` (auth.js:51, 84) |
| QUEUE_LIMIT 1010 | 600 | `/api/queue` (worker/index.js:54) |

Key = `net:` + IPv4 or IPv6 /64 of `CF-Connecting-IP` (worker/http.js:14-20); over limit = 429 `{error:'RATE'}` + `Retry-After: 10` (:29). `namespace_id` must be unique per CF account (CLOUDFLARE.md:44). In NODE_COMPAT only `/ws` is limited, per network (worker/index.js:82).

### 5.2 Objects, bindings, migrations
| Binding | Class | Instance name | Storage |
|---|---|---|---|
| ROOMS | RoomDurableObject (worker/index.js:208) | 4-letter code | KV snapshot parts + SQL `match_events`, `archive_outbox`, `archive_chunks` |
| SITES | SiteDirectory (accounts/directory.js:11) | `'directory'` | SQL users, auth_records, rooms, archives, local_users, display_names, provider_status |
| ACCOUNTS | AccountDurableObject (accounts/account.js:18) | accountId | KV profile / registration / preferences / activeSeat / application + SQL `history` |
| MATCH_ARCHIVES | MatchArchive (archive/archive.js:8) | matchId | SQL chunks, archive_meta (created on first write) |
| MATCHMAKER | Matchmaker (matchmaker.js:208) | `'queue'` | none (memory) |

Plus `ASSETS` (static; `run_worker_first` for `/api/* /ws /healthz /stronghold-resources.zip /media/*`, wrangler.jsonc:27-33), vars `AUTH_ORIGIN`, `GITHUB_CLIENT_ID` (:18-21), compat date 2026-10-01 + `nodejs_compat` (:6-7), observability (:13-17). Secrets, not in the file: `GITHUB_CLIENT_SECRET`, `ACCOUNT_ADMIN_TOKEN`, `ARCHIVE_EXPORT_TOKEN`, `ARCHIVE_IMPORT_TOKEN` (admin tokens >= 32 chars, accounts/auth.js:27-30; ACCOUNTS-HISTORY.md:44-54). Migrations: v1 (RoomDurableObject, AdmissionDurableObject), v2-accounts (SiteDirectory, AccountDurableObject, MatchArchive), v3-ratelimits (delete AdmissionDurableObject), v4-matchmaker (Matchmaker). `worker/entry.js:2-7` exports `default` (the fetch handler) + `RoomDurableObject` (from index.js), `LobbyGatewayDurableObject`, `SiteDirectory`, `AccountDurableObject`, `MatchArchive`, `Matchmaker`; the gateway class is bound nowhere. Logs: `worker/log.js` writes one object per line with an `event` field (table: CLOUDFLARE.md:84-97).

### 5.3 Room DO and RoomRuntime (worker/index.js, worker/room-runtime.js)
- Every entry (fetch, socket message/close/error, alarm, in-memory timer) goes through `event()` (index.js:352): `blockConcurrencyWhile` -> pump due match steps -> handle -> pump -> `sweep` -> `commit` (:371). Output frames are queued in `SocketAdapter` and flushed only after the commit (do-storage.js:21-33); an error resets the DO to its last commit.
- Snapshot JSON is cut into 16,000-char KV parts `snapshot-meta` + `snapshot-N` (do-storage.js:11; index.js:447-452), `lastSeen` rounded to 30 s when diffing (do-storage.js:13-14). A running match = checkpoint + SQL log (index.js:194, 415-420). An empty room runs `deleteAll` (index.js:397-407; `isEmpty` room-runtime.js:381).
- Wake (`load` index.js:241): sockets rebound from `serializeAttachment`, then `restoreMatch` (:295-319): unknown rules version -> interrupted 'rollback'; a second unfinished attempt -> 'restart' (counted durably before replay); `prepareMatchVersion` lazily initializes a retained engine.
- `schedule()` (:467-483): in-memory timer (<= `AWAKE_MS` 60 s, :206) while someone is connected to a running match or a step is near, else a storage alarm. The auto-response pair `{"t":"ping","c":0}` / `{"t":"pong","c":0}` (:229) keeps hibernating sockets alive; `refreshAutoResponses` (:341).
- Jobs after each commit (`startJobs` :500): archive publish with backoff 30 s -> 1 h (:201, 508-534); public listing lease refreshed every 20 s, hidden by the directory after 60 s (:203, 576); login re-check every 60 s closes revoked sockets with 4003 (:593; room-runtime.js:24, 562).
- Internal routes (index.js:637-687): `/_reserve` (POST; ticket; reservation 120 s, room-runtime.js:24), `/_account` (GET/POST/DELETE), `/_applications`, `/_visibility`, `/_status`, `/_ws`.
- `ROOM_LIMITS` (room-runtime.js:23-25): 16 sockets / 8 per IP for a 4-seat room (`socketLimits` :33-37: members reserve seats + 1, strangers share 11, 3 per address), 32 sessions, 64 KiB frames, idle 90 s, hello 30 s, observers 2 msg/s burst 10. Adapters: `RoomNetwork` (:40-76), `AlarmLobby` (:78-111), handler wiring (:178-243), archive hook (:156-177), snapshot (:601-613).

### 5.4 Room lifecycle over the API
1. `POST /api/rooms` reserves a code (RoomDO `/_reserve`, 201 `{code, ticket, generation}`) and claims the account seat (worker/index.js:129-154).
2. `/ws?room=CODE&ticket=` -> hello -> `welcome` (token `CODE.hex`) -> `room.create {mode, difficulty, capacity?}` consumes the reservation (room-runtime.js:227-235).
3. Others: `POST /api/rooms/CODE/applications {action:'apply'}` (pending 120 s, <= 20 per room: rooms/applications.js:39) -> host `approve` (32-hex ticket, valid 120 s) -> applicant opens `/ws` with the ticket and sends `room.join`, which consumes it (room-runtime.js:209-217). A seat held elsewhere = ALREADY_SEATED (rooms/routes.js:22-27); approved applicants reserve seats against `addBot` / `setCapacity` (room-runtime.js:220-226); ended items stay listed 10 min (applications.js:9-17).
4. Resume: `POST /api/me/resume` -> `{code, generation, ticket, join, reserved}` (the room stores a 30 s takeover ticket, room-runtime.js:367-375); the page reconnects with its saved room token. The account's seat is a pointer the room confirms (`seatOf`, accounts/routes.js:43-61): a 404 from the room releases it.
5. Public lobby: `GET /api/rooms` -> `SiteDirectory.listRooms` (directory.js:243); visible = public and (humans connected or in match) (:233-235).

### 5.5 Accounts and auth (worker/accounts/*)
- Cookie `__Host-sp_session` = 64 hex; the directory stores only its SHA-256, 30-day life (auth.js:10, 32-45; shared/account-protocol.js:2). Passwords PBKDF2-SHA256, 100,000 iterations (CF cap; local workerd does not enforce it), unknown users still derive (passwords.js:7, 29-43). Username `^[A-Za-z0-9_]{3,20}$`, password 8-128, nickname <= 12 (account-protocol.js:24-30); display name `昵称#NNNN` allocated by `SiteDirectory.claimName` (directory.js:105-138). Registration spans AccountDO and SiteDirectory and finishes on next read (accounts/account.js:66-112).
- GitHub OAuth (S256 PKCE, `__Host-sp_oauth` state cookie) is offered only when `GITHUB_CLIENT_ID` + secret are set and `AUTH_ORIGIN` is a bare https origin (github.js:25-26); credential verdict cached 24 h valid / 1 h invalid / 5 min unknown (:22, 58-67).
- Admin: `/api/admin/accounts/password` (CLI `npm run accounts:reset-password -- --origin URL --username NAME [--generate]`, env `SP_ACCOUNT_ADMIN_TOKEN`); `/api/admin/backup/{catalog,archive,profile}`, import <= 32 MiB, dry-run by default (backup.js:20, 183-184; CLI `npm run archives:backup`).

### 5.6 Matchmaker and archive
- `POST /api/queue {action:'join'|'poll'|'leave'|'hosted', difficulty?, code?}`, body <= 512 B, same-origin, signed in; `join` refused when seated in a live room, `hosted` only for the room the host sits in (rooms/queue-routes.js:23-32). `join` = the click (starts over), `poll` keeps the place (matchmaker.js:220-221). `QUEUE` (:23-31): minSeats 2, graceMs 3000, timeoutMs 20,000, silentMs 6000, hostMs 20,000, groupMs 120,000, leftMs 5000.
- The group's first member hosts: it opens a room the normal way and reports `hosted {code}`; members get `matched {role:'member', code}` and apply; the host's page approves only its group, for 60 s (room-net.js:350-371).
- Archive: finished match -> `archive_outbox` -> `publishArchive` (archive/outbox.js:24): chunks, `finalize` (hash-checked manifest), `registerArchive`, `applyMatch` per participant. `MatchArchive` chunk <= 64,000 chars, index <= 10,000 (archive.js:30-32), readable only by participants (:62-67). Routes `GET /api/matches/:id[/replay/:n]`, `/api/me/matches|stats` (archive/routes.js:3-27).

### 5.7 NODE_COMPAT lobby gateway (worker/lobby-gateway.js)
The upstream `Lobby`/`Network` in ONE DO (`LobbyGatewayDurableObject` :274, instance `'lobby'`, worker/index.js:61) for the APK's Node-protocol client: one `/ws` without a room code, hello + `room.*`. KV-only storage (`lobby-meta`, `lobby-N`, `matchlog:<id>:<seq8>`, :12, 32); limits :29-30 (256 sockets, 32 per address, 20,000 sessions, 64 KiB, idle 90 s). `GatewayLobby` keeps the default queue options, so a Node `queue.join` would start a real `setInterval` clock there and the queue is not snapshotted: UNVERIFIED, untested.

### 5.8 Common edits
- New DO class: export it in `worker/entry.js`, add `durable_objects.bindings`, APPEND a migration (`new_sqlite_classes`), add it to `createWorld` in test/worker/helpers/world.js:179-181.
- New rate limit: new `ratelimits` entry with a unique `namespace_id`, copy it into `productionLimits` (account-harness.js:10-21), call `within(env.X, key)` (worker/http.js:23).
- Any change inside the engines (anything bundled from `worker/replay-engine.js` or `worker/recovery-engine.js`) mints a new rules version at the next release: follow fact 14.

## 6. Client transports
| | `public/js/net.js` (Node) | `public/js/room-net.js` (Worker) |
|---|---|---|
| Class | `Net` (:142); singleton `net` (:867); `configureTransport(factory)` (:870, before first connect) | `RoomNet extends Net` (:68); `configureRoomNet()` from `worker-entry.js:1-4` |
| Selected by | `public/index.html:102` loads `/js/main.js` | build rewrites it to `/js/worker-entry.js` + `<html data-sp-runtime="cloudflare">` unless `SP_NODE_CLIENT=1` (build-worker.mjs:94-96); `main.js:373-374` runs `loadAccount()` only then |
| Socket | one `/ws`; `hello{name,token,version}` once a name is known (:393-401) | none in the menu; `/ws?room=CODE[&ticket=]` only inside a room (:432-436); states menu / entering / room / lost (:75-76) |
| Identity | `sp.name`, sessionStorage `sp.token`, localStorage `sp.tokens`; `identity.init()` asks other tabs over BroadcastChannel (:679-760) | account cookie; per-room token saved at welcome and resumed by `restore()` (:128-131) |
| Timing | request 8 s, hello 8 s, ping 4 s, dead 15 s, backoff 500 ms x2 <= 10 s +-20% (:35-39) | adds ENTER 12 s, DRAIN 5 s, APPLICATION_POLL 3 s, QUEUE_POLL 1.5 s, QUEUE_APPROVE 60 s (:44-57); idle pings become `{"t":"ping","c":0}` (:573-576) |
| Close codes | 4001 stops reconnecting (:339) | 4001/4003/4004 end the route (:460-466); 1013 and everything else reconnect with backoff |
| Rooms / queue | WS `room.*`, `queue.*` | create = `POST /api/rooms` then WS `room.create` (:392-411); join = HTTP application -> approval -> WS (:200-234); `request('queue.join')` polls `/api/queue` (:138-139, 238-346) and re-emits Node-shaped `queue.status` / `queue.matched` |

Both validate outgoing requests with `validateC2S` (net.js:463, 500). `enter()` intents: create, join, joinApproved, resume, spectate (room-net.js:100-102).

## 7. Build and deploy (tools/build-worker.mjs, tools/build-replay.mjs)
- `npm run build:worker` (also wrangler `build.command`, wrangler.jsonc:26) -> `buildWorker` (:154): `vendor()`; if `data/assets.json` references missing files it runs `tools/fetch-assets.mjs` unless `SP_SKIP_ASSETS=1` (:159-164) and still throws when `public/assets` is empty (:172-174); `buildReplayVersions` (warns when the current version is unarchived, :167-169); `buildResourceManifest`; `copyRuntimeAssets` -> `dist/client`; `writePackParts`; copies every archived `replay-engines/<id>/engine.js` (:179-186); `bundleWorker` -> `dist/worker/index.mjs`.
- `copyRuntimeAssets` (:55-134): `public/` minus dev|assets|fonts, manifest files, `data/*.json`, `shared/*.js`, `server/sim` as `/sim`, a `/data.js` shim, `_headers`; fails on a file > 25 MiB or > 100,000 files. `SP_NODE_CLIENT=1` keeps the plain Node client page (:94-96).
- `bundleWorker` (:241-316): esbuild, ESM, platform neutral, externals `node:*` `cloudflare:*`, minified; swaps `server/data-node.js` and `server/sim/nodeData.js` for worker/data-loader.js / sim-data-loader.js; generates the build's `worker/match-versions.js`; throws if `node:fs` leaks into the bundle (:312-314); `buildWorker` throws when `dist/worker/index.mjs` is > 64 MiB (:191-194). `writePackParts` (:208-239) cuts the resource ZIP (cached in `.cache/`) into 24 MiB parts + `/pack/index.json`; the Worker concatenates them with Range support (worker/pack.js:67). `/media/<x>` maps extension-less audio to `/assets/audio/<x>.<ext>` (worker/media.js:9). `buildId` = first 7 chars of `WORKERS_CI_COMMIT_SHA` or `git rev-parse HEAD`, else `local` (:46-49).
- Rules versions: `currentEngines` (build-replay.mjs:70) bundles `worker/replay-engine.js` and `worker/recovery-engine.js` with a placeholder id and hashes them (20 hex); `unpackArchives` (:52-64) verifies sha256 before unpacking into `.replay-engines/<id>/`. Mint only via `--release` (`mint: !isCI()`, :147); `replay-versions/<id>.json.gz` never change (:9-13).
- Commands: `npm ci`; `npm run setup`; `npm run build:worker`; `npm run dev:worker` (= `wrangler dev`); `npm run deploy:worker`; `node tools/build-replay.mjs --release`. Stop `dev:worker` before deploying on Windows (CLOUDFLARE.md:30).

## 8. Self-hosting the Worker build with Miniflare
No doc describes how to run it: DEPLOY.md is Node-only, and Miniflare is named only as a test runtime (CLOUDFLARE.md:112; ACCOUNTS-HISTORY.md:7, 102). Verified recipe (scratch script, production bundle, ran green): `bundleWorker({outfile})` from tools/build-worker.mjs, then `new Miniflare(convertV4MiniflareOptions({workers:[{name, scriptPath, modules:true, compatibilityDate:'2026-10-01', compatibilityFlags:['nodejs_compat'], ratelimits, bindings:{AUTH_ORIGIN,...}, assets:{directory, binding:'ASSETS', run_worker_first:true, routerConfig:{has_user_worker:true, invoke_user_worker_ahead_of_assets:true}}, durableObjects:{ROOMS:{className:'RoomDurableObject',useSQLite:true}, SITES:'SiteDirectory', ACCOUNTS:'AccountDurableObject', MATCH_ARCHIVES:'MatchArchive', MATCHMAKER:'Matchmaker'}}]}))` (same shape as account-harness.js:32-61 and world.js:174-183); set `options.resourcePersistencePath` to keep DO storage across restarts.
- Observed: `/healthz` 200 `{runtime:'cloudflare',...}`, `/api/me` 200 `user:null`, `POST /api/auth/register` 201 + cookie, `POST /api/rooms` 201 `{code,ticket,generation}` (Origin header = the Miniflare origin).
- `ratelimits` needs all ten bindings (copy `productionLimits`); Miniflare windows align to wall-clock minutes (account-harness.js:22-30). GitHub sign-in stays off unless `AUTH_ORIGIN` is https and the secret is set. Browser use over plain http: UNVERIFIED (the e2e harness proxies everything through the fixed origin `https://game.example`, test/ui/password-accounts.e2e.test.js:20-31; the cookie is `Secure` + `__Host-`).
- A real site also needs `dist/client` for `assets.directory` (`npm run build:worker`, needs game assets). `wrangler dev` (CLOUDFLARE.md:22-30) does the same from wrangler.jsonc; not run here.
- NODE_COMPAT pattern: DO `LOBBY` -> `LobbyGatewayDurableObject` + binding `NODE_COMPAT:'1'` (gateway-compat.test.js:22-29).

## 9. Doc section maps (line ranges verified 2026-10-06; they drift; full index: docs/context/DOC-INDEX.md)
**docs/CLOUDFLARE.md** (112 lines)
| Lines | Section |
|---|---|
| 1-8 | intro: Workers Paid, entry stronghold.lunar.ag, 4-20 friends |
| 9-17 | 为什么这样分配 (DO per room, static assets, no R2) |
| 18-47 | 构建和部署: Node 22, `npm ci / setup / build:worker / dev:worker`; account_id and no routes (30); `deploy:worker` clean-commit rule (38); domains (40); ratelimits + migrations (44); what dist publishes (46) |
| 48-67 | 资源包: manifest, `/stronghold-resources.zip`, three ways to get the ZIP, Cache Storage |
| 68-73 | 对局与更新限制: reconnect and close codes (70), restore after deploy, rollback warning (72) |
| 74-79 | 公开对局观战 |
| 80-98 | 运行日志 (event table 84-97) |
| 99-112 | 验证 (test commands 101-110) |

**docs/DEPLOY.md** (261 lines; Node self-hosting; line 3 points to CLOUDFLARE.md)
| Lines | Section |
|---|---|
| 1-7 | intro |
| 8-19 | 0 资源需求 (stateless server, 18) |
| 20-21 / 22-40 | 1 Windows / 1.1 install |
| 41-53 / 54-57 | 1.2 firewall / 1.3 fixed LAN IP |
| 58-94 / 95-108 | 1.4 autostart service / 1.5 update |
| 109-110 / 111-118 | 2 remote friends / 2.1 Tailscale, ZeroTier |
| 119-127 | 2.2 cloudflared (`TRUST_PROXY=auto`, 126) |
| 128-137 | 2.3 port forwarding (no accounts, 136) |
| 138-178 | 2.4 reverse proxy + HTTPS (Caddy, Nginx; trust notes 177) |
| 179-207 | 3 Docker |
| 208-232 | 4 macOS / Linux systemd |
| 233-246 | 5 troubleshooting (reconnect windows, 245) |
| 247-261 | 6 local client assets |

Related: ACCOUNTS-HISTORY.md 5-14 login, 15-20 lobby and applications, 21-33 admin reset, 44-54 config and first release, 55-71 persistence, 89-103 rules versions and capacity, 104-123 backups. DESIGN.md 416-444 §8 protocol, 2309-2341 §27 外援, 2342-2387 §28 匹配 (28.1 Node :2348, 28.2 Worker :2371).

## 10. Tests and commands
Runner `node --test` (package.json:28); `npm run test:fast` sets `MATCH_SEEDS=3` (tools/test-fast.mjs). CI (`.github/workflows/ci.yml`) runs `node --test` on ubuntu + windows, Node 22 and 24, with `SP_E2E=0 SP_REAL_E2E=0 RENDER_E2E=0`; it never runs `build:worker`. Browser e2e is opt-in (`SP_E2E`, `SP_ACCOUNTS_E2E`, `SP_SPECTATORS_E2E`, `SP_RESOURCES_E2E` = 1, plus `CHROME_PATH`).
```
node --test "test/worker/*.test.js"                          # 147 tests, ~108 s, Miniflare/workerd (verified)
node --test test/worker/matchmaker.test.js test/matchmaking.test.js test/worker-client.test.js test/lobby-kick.test.js   # 64, ~4 s (verified)
node --test test/lobby.test.js test/lobby-kick.test.js test/lobby-loadout.test.js test/protocol-capacity.test.js test/worker-build.test.js   # 87, ~25 s (verified)
node --test test/worker/miniflare.test.js                    # one workerd test, ~8 s
node --test test/worker-client.test.js test/worker-build.test.js "test/worker/*.test.js" "test/resources/*.test.js"   # CLOUDFLARE.md:103
SP_ACCOUNTS_E2E=1 CHROME_PATH=/path/chrome node --test test/ui/password-accounts.e2e.test.js
```
| File | Covers |
|---|---|
| test/lobby.test.js (68) | static server, WS lobby, timers / match interface, solo resume, result replay, per-network limits, heartbeat / shutdown; boots `startServer({port:0})` with test/helpers/wsClient.js |
| test/lobby-kick.test.js (5), lobby-loadout.test.js (4), protocol-capacity.test.js (6) | `room.kick`; `room.loadout`; 4..8 capacity and result-map caps |
| test/matchmaking.test.js (9) | Node queue with shortened timings (`queueTickMs: 30` ...), healthz `queued` |
| test/worker-client.test.js (38) | `RoomNet` with fake WS, fake `fetch`, virtual timers: entering, applications, queue polling, hand-over, close codes |
| test/worker-build.test.js (3) | `copyRuntimeAssets` tree, `_headers`, `missingAssets` |
| test/worker/helpers/world.js, account-harness.js | production bundle in Miniflare with all five DOs; `TestObject` extends `SiteDirectory`; `/__test/*` room hooks; `createWorld(t)`, `world.seed/api/restart` |
| test/worker/rooms, room-capacity, seats, sleep, match-recovery, restore-failure, large-snapshot, websocket-close, spectators, applications, names, commands | `RoomRuntime` with fake sockets and Miniflare: reservations, 4..8 seats and socket caps, takeover, hibernation / alarms, restore, close codes, spectators |
| test/worker/auth, passwords, password-accounts, account-*, github-*, logins, preferences, http, media, pack | accounts, OAuth (mocked), limits, error mapping, `/media`, resource pack ranges |
| test/worker/matchmaker (12), matchmaking | `MatchQueue` rules; workerd queue -> host opens -> member approved |
| test/worker/archive, archive-outbox, backup, versions, retained-recovery | archive publish / read, backups, rules-version minting and retention |
| test/worker/gateway, gateway-compat | NODE_COMPAT lobby (`LobbyRuntime`, workerd) |

## 11. UNVERIFIED / open
- Whether CI-based deploys (Workers Builds) are intended: wrangler.jsonc:22-23 vs CLOUDFLARE.md:38.
- How NODE_COMPAT is deployed and whether its queue works (no config, no test): section 5.7.
- Restore correctness after a mid-match `room.pick` / spectator change (fact 19).
- Plain-http browser sessions against a self-hosted Miniflare (section 8); `npm run dev:worker` was not run.
- `queue.join` from inside a lobby room and the Worker-socket `queue.join` refusal: read, not run.
