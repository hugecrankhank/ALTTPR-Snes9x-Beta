# Crowd effects (TikTok LIVE)

Viewers' gifts, likes, follows and shares change your game: hearts, magic,
rupees, bombs, arrows, inverted controls, no sword and more. The ROM is never
changed; any seed works.

```
TikTok LIVE ──► bridge.mjs (your PC) ──ws://localhost:21213──► game page ──► Snes9x RAM / buttons
```

- `effects.js` runs in the game page. It queues effects and applies them only
  in normal play (not in menus, text boxes or screen transitions), about
  0.75 s apart, and shows a small feed on the game picture.
- `bridge/bridge.mjs` runs on the PC you stream from. It joins your LIVE and
  forwards events using `bridge/mapping.json`.

## Setup

1. Install Node.js 20 or newer.
2. In `crowd/bridge`: `npm install`
3. Edit `mapping.json`: set `username` (no @), and map gifts to effects.
4. `npm start` (or `node bridge.mjs`). Go live on TikTok; the bridge retries
   every 30 s until it finds your LIVE.
5. In the game on the **same PC**: ⋯ menu → **Crowd effects** → turn on.
   The status line should say *connected*. If the browser asks to allow
   access to devices on your local network, allow it.

Every gift that arrives is printed in the bridge window with its exact name,
even unmapped ones, so you can copy names into `mapping.json`. The file
reloads by itself when you save it.

## Testing without going live

- `npm run test-mode`, then type `gift Rose 3`, `like 600`, `follow`, or an
  effect id like `invert`.
- Or use the test buttons in ⋯ menu → Crowd effects (no bridge needed).

## Effects

| id | effect | | id | effect (timed) |
|---|---|---|---|---|
| `heal_full` | Full heal | | `invert` | Inverted D-pad, 20 s |
| `heal_1` | +1 heart | | `no_sword` | No sword, 20 s |
| `hurt_2` | −2 hearts (never kills) | | `no_item` | No Y item, 20 s |
| `hp_1` | Down to 1 heart | | `swap_by` | B and Y swapped, 20 s |
| `magic_full` / `magic_drain` | Refill / drain magic | | `one_hit` | One-heart mode, 30 s |
| `rupees_plus` / `rupees_minus` | ±50 rupees | | `no_magic` | Magic locked, 30 s |
| `bombs_plus` / `bombs_none` | +10 / lose all bombs | | | |
| `arrows_plus` / `arrows_none` | +10 / lose all arrows | | | |

**App rolls** (use the app's own buttons):

| id | effect |
|---|---|
| `sprite_roll` | Random sprite from the whole library (changes Link right away) |
| `sprite_fav` | Random sprite from your ★ favourites |
| `msu_roll` | Random MSU-1 pack from your ★ favourite packs |
| `seed_roll` | **New seed** with the current Randomizer settings — ends the current game |

`seed_roll` is off until you check **Allow seed reroll** in ⋯ menu → Crowd
effects. When it fires, the feed counts down 10 seconds, and a **Cancel new
seed** button appears in that menu. If a roll can't happen (no favourites
yet, no packs), the feed says so instead of popping up a dialog.

Timed effects count only time spent in play and stack (a second gift adds
time). They only filter buttons or hold a value each frame, so save states,
resets and reloads can't leave the game stuck changed.

## mapping.json

- `gifts`: gift name (any case) or gift id → effect id.
- `likes`: `{ "every": 300, "effect": "heal_1" }` fires once per 300 likes.
- `follow`, `share`: effect id; once per viewer per 10 minutes.
- `maxPerGift`: cap for a gift streak (e.g. 20 Roses still gives 5 heals).
- `signApiKey`: optional Euler Stream key (see below).
- `allowedOrigins`: pages allowed to connect to the bridge.

## Good to know

- **Phone play:** a page on `https://` can only reach `ws://localhost`, so the
  game must run on the PC with the bridge. To play on a phone, put the bridge
  behind an `https` tunnel (for example
  `cloudflared tunnel --url http://localhost:21213`) and set the menu's bridge
  address to the `wss://…` address it prints, and add the game's origin to
  `allowedOrigins` if you open it from somewhere else.
- **TikTok connection:** `tiktok-live-connector` is an unofficial library. It
  signs its TikTok connection through the Euler Stream service; if you hit
  rate limits, a free key from eulerstream.com goes in `signApiKey`. TikTok
  changes can break it until the library updates (`npm update`).
- Not for races: this changes the game mid-run.
