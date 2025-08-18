# MegaMan DuelBot (MEE6-integrated)

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
- `/forfeit` to end a duel early.
- `/navi_stats` to view stats.

### Notes
- **Crits** = exact `×1.5` (integer-safe for your damage values).
- **Dodge** uses defender's `%` to avoid the incoming hit.
- **Barrier** retroactively restores the last damage you took and clears that memory (no stacking).
- One duel per channel at a time.

### Persistence
SQLite DB at `./data/data.sqlite`. If hosting on Railway/Render/VPS, ensure this path is persisted (volume/disk).
