# DanceNow — Cast Receiver (TV app)

The Google Cast **custom web receiver** for [DanceNow](https://github.com/shayzluf/DanceNow).
When a phone casts a routine, this is what runs on the Chromecast / Google TV: it plays the
song (acting as the authoritative clock the phone syncs to), renders the coach figure from the
streamed pose timeline, and mirrors the live feedback (tier tones, voice callouts, edge-glow,
rating words, scoreboard).

> **Source of truth:** this folder lives in the main repo at
> [`receiver/`](https://github.com/shayzluf/DanceNow/tree/main/receiver). This public repo is a
> deploy mirror so GitHub Pages can serve it over HTTPS (Cast receivers must be HTTPS).

## Files

| File | Role |
|------|------|
| `index.html` | receiver shell — `<audio>` clock, coach `<canvas>`, glow/word/scoreboard, loads the CAF SDK |
| `receiver.js` | renders the coach, plays the song, handles the `urn:x-cast:com.dancenow.sync` channel, beacons its playhead |
| `styles.css` | TV layout |

## Preview in a browser (no Chromecast)

Add `?mock=1` to play a synthetic routine with feedback firing every ~1.3s:

```
https://shayzluf.github.io/DanceReciever/index.html?mock=1
```

(Click once to enable sound — browsers block audio until a user gesture.)

## Register as a Cast receiver

1. **Cast Developer Console** → <https://cast.google.com/publish> → add a **Custom Receiver**
   pointing at the Pages URL above (no `?mock=1`).
2. Register your Google TV's serial as a **test device** (unpublished receivers only load on
   registered devices; allow ~15 min + reboot the TV).
3. Put the resulting **Application ID** in the iOS app:
   `App/DanceNow/Info.plist` and `project.yml` — `GCKReceiverApplicationID` **and** the
   `_<APPID>._googlecast._tcp` Bonjour entry (replacing the `CC1AD845` testing default).

See [`docs/cast-sync.md`](https://github.com/shayzluf/DanceNow/blob/main/docs/cast-sync.md) for
the sync protocol and full registration steps.

## Redeploy

From the main repo, after editing `receiver/`:

```bash
git subtree push --prefix=receiver dancereceiver main
```
