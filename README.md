# MegaMan DuelBot (MEE6-integrated)

This bot watches for **MEE6** `/use` messages and resolves combat between two players in any channel with an active duel. It also applies **HP Memory / Code Refinement / Lucky Data** upgrades whenever MEE6 posts them.

## Prereqs
- Node.js 18+
- Toggle **MESSAGE CONTENT INTENT** for your bot in the Discord Developer Portal.

## Setup
1. Copy `.env.example` to `.env` and fill:
   - `DISCORD_TOKEN` = your bot token
   - `APPLICATION_ID` = your application (client) ID
   - `GUILD_ID` = your server ID (for fast command registration)
2. Install deps:
   ```
   npm install
   ```
3. Deploy slash commands to your guild:
   ```
   npm run deploy:commands
   ```
4. Start the bot:
   ```
   npm start
   ```

## Use
- `/navi_register` once per user.
- `/duel @opponent` in a channel to start a duel in that channel.
- Players then use MEE6 `/use` items (Spreader1, Vulcan1, Cannon1, Sword, Widesword, ElecSword, Longsword, ElecMan1, TorchMan1, Barrier).
- `/forfeit` to end a duel early.
- `/navi_stats` to view stats.

### Notes
- **Crits** = exact `×1.5` (integer-safe for your damage values).
- **Dodge** uses defender's `%` to avoid the incoming hit.
- **Barrier** retroactively restores the last damage you took and clears that memory (no stacking).
- One duel per channel at a time.

### Persistence
SQLite DB at `./data/data.sqlite`. If hosting on Railway/Render/VPS, ensure this path is persisted (volume/disk).