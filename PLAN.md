# Plan: build Claude into Reckoning

Based on reckoning-claude-handoff.md, checked against index.html (lines 440–592 and the closing tags),
dropbox-sync.js and ride-export.js at commit 52823ce.

## Files, in build order

| Step | File | Change |
|------|------|--------|
| a | `supabase/functions/claude/index.ts` | **New.** Edge Function (handoff §1). No keys in the file: it reads ANTHROPIC_API_KEY, ALLOWED_EMAILS and CLAUDE_MODEL from Supabase secrets. |
| a | Supabase dashboard | You create the function, paste the code in, set the 3 secrets, and turn "Verify JWT" off. I'll give you one step at a time. |
| b | `claude-chat.js` | **New.** Chat card, system prompt, tool loop, 4 tools, ride hook (handoff §2). |
| b | `dropbox-sync.js` | **One line added** right after `await writeRides(added);` (line 332): `window.dispatchEvent(new CustomEvent('reckoning:rides', { detail: added }));` |
| c | `index.html` | **One line added** after line 1385 (`ride-export.js`): `<script src="claude-chat.js"></script>` |
| — | git | Commit locally; you push. (This session can't push to the repo, so you have to.) |

`node --check` gets run on both JS files in step b.

## How claude-chat.js writes data (same pattern as writeRides in dropbox-sync.js)
wait while `_syncRunning` → set it true → write to Supabase through `chk()` → only after that succeeds, update
`state` and `localStorage[KEY]` → redraw the screen → finally set `_syncRunning` false and call `scheduleSync()`
if `_syncQueued`. It never calls `save()` or `pushState()`. Every error shows in red in the chat (`#e5484d`, the
same red dropbox-sync.js and ride-export.js use).

## Where the handoff doesn't match the code (and what I'll do)
1. **`sleep` isn't global.** It's defined privately inside dropbox-sync.js (line 271), so claude-chat.js
   needs its own copy.
2. **The state field names are different from the tool names.** Food items in state are `{name,kcal,p,c,f}`
   and the database columns are `protein/carbs/fat`; the tools say `protein_g/carbs_g/fat_g`. I'll convert
   between them. FTP is `state.ftp[].w`, baseline burn is `state.config.baseline`, and the plan is
   `state.plan[date] = {what, where}`, saved in the `where_` column.
3. **Rides in state have no row id.** pullState doesn't keep it, so `annotate_ride` has to find the row by
   user_id + date (+ title if given). If 2+ rows match and no title was given, it fails in red rather than
   guessing. The update uses `.select()` and fails if 0 rows changed, as the handoff says. Then the matching
   ride in `state.rides` gets updated.
4. **Ride hook placement.** The dispatch goes right after `await writeRides(added);` and before the existing
   redraw line, so it only fires when the save succeeded.
5. **Card placement.** `#cardStack` exists (index.html line 108); the chat card goes just above it, as the
   handoff says.
6. **Skipped as instructed:** the handoff's "known bug" (archiveAndTrim no longer deletes food, as confirmed
   at line 582) and the main-page filename note (it's already index.html).

Everything else in the handoff matches: `state, sb, chk, KEY, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY,
TARGET, todayKey, dateShift, latest, sortByDate, dayFood, dayBurn, _syncRunning, _syncQueued, scheduleSync`
and all the render functions it lists are defined.

## Done when (from the handoff)
- `node --check claude-chat.js` passes; the index.html diff is exactly one line.
- A typed food line shows in the Food card and survives a reload.
- A deliberately broken call shows a red error in the chat.
- A signed-in account not in ALLOWED_EMAILS gets 403.
