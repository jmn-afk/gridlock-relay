# Gridlock City multiplayer relay

This small server lets up to 4 players share a session using a 4-letter room code. It has no dependencies (Node 18 or newer) and doesn't store anything: rooms disappear when their last player leaves.

## Run it locally

```
node server.js              # listens on port 8080
curl http://localhost:8080/health
```

## Put it online (Render, free tier)

1. Create a GitHub repository containing these three files: `server.js`, `package.json` and this README.
2. On render.com, choose **New → Web Service** and connect that repository.
3. Use these settings:
   - **Runtime:** Node
   - **Build command:** `npm install` (there is nothing to install, but Render wants a command)
   - **Start command:** `node server.js`
   - **Instance type:** Free is fine for testing. Free instances sleep after 15 minutes with nobody connected; the game wakes it automatically and shows "Waking up the multiplayer server…" for up to a minute. For release, a paid "Starter" instance stays awake.
4. Optional: add an environment variable `ALLOWED_ORIGINS` so only your game pages can connect, for example:
   `https://www.crazygames.com,https://*.crazygames.com,https://*.itch.zone,https://*.hwcdn.net`
   Leave it unset while testing.
5. Deploy. Render gives you an address like `https://gridlock-relay.onrender.com`. Open `/health` on it and you should see `{"ok":true,...}`.
6. Give the game that address with `wss://` in front instead of `https://`, e.g. `wss://gridlock-relay.onrender.com`. It goes in `GL_CFG.server` at the top of `index.html` in both the CrazyGames and itch.io builds.

Fly.io, Railway or any small VPS work the same way. They only need to run `node server.js` and allow WebSockets.

## Limits built in

- 4 players per room. A fifth player gets `full`, and the game shows "That session is full (4 players)".
- Room codes use letters and numbers that can't be confused (no O/0, I/1, L).
- Each player's update is capped at 32 KB (world snapshots from the host), with about 40 player updates and 40 world broadcasts per second.
- Silent connections are dropped after about 40 seconds, so a closed laptop frees its slot.
