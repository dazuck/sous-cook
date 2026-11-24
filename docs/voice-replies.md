# Voice replies

When a cook speaks a command to Sous, the cook page answers with a sound, and now and then a short spoken confirmation. The rules live in `app/src/lib/kitchen/voice-ack.ts`, the sounds and clips in `app/src/lib/kitchen/ack-audio.ts`, and the list of clips in `app/src/lib/kitchen/ack-clips.ts`.

## The setting

The cook page's More menu has a row for it, per device, and a press moves it on to the next setting:

| Setting | What the cook hears |
| --- | --- |
| Off | Nothing. |
| Sounds (the default) | Two soft rising notes for a command understood or a question handed to Ask; two lower falling notes for anything not understood or refused. Only for speech, never for a tap. |
| Sounds and voice (only in a build with the clips, below) | The same sounds, and after a spoken command whose result can't be seen from across the kitchen (starting or setting a timer, flagging the screen), sometimes a recorded confirmation: "Yes, chef.", "Timer's on.", "On it.", "Flagged.", or a timer's length read back ("Ten minutes."). At most three in one cook. |

The sounds are made in the browser (WebAudio); they need no files. Like the timer's chime, they wait for the page's first tap, as browsers only start audio after one.

## The clips are not in this repository

The spoken confirmations are 17 short audio files, served from `app/public/sounds/sue/<name>.mp3`, one per name in `CLIP_TEXT` (`ack-clips.ts`). This repository ships without them.

Whether a build has them is decided once, when the app is built: `next.config.ts` asks `sueClipsInBuild` (`app/src/lib/kitchen/ack-clips-build.ts`) whether every one of the 17 files is there, and bakes the answer into the app, where `sueClipsShipped()` (`ack-clips.ts`) reads it. Nothing looks for the files while the app runs.

In a build without them (the repository as it ships):

- The More menu offers Off and Sounds only; a press goes Sounds, Off, Sounds.
- A device that chose "Sounds and voice" under a build that had the clips reads as Sounds, without a word in the console. Its stored choice is left alone, so a later build with the clips picks it up again.
- Neither the cook page nor the service worker asks for a clip.

In a build with them, the setting works as the table above says, and each cook page asks the service worker to keep every clip for offline use. If a file goes missing from the server after such a build, the page says so once per clip on the console and plays the notes alone; the missing clip doesn't count toward the three.

## Making the clips

`app/scripts/generate-sue-clips.ts` makes the whole set with Google's speech model: one voice and one style line for every clip (`app/scripts/sue-clips.ts`), three takes of "Yes, chef." that differ in pace, each clip trimmed, levelled and measured. It needs `ffmpeg` and `ffprobe` on the `PATH` and `GOOGLE_AI_API_KEY` in the environment, and it records what it made in `app/scripts/data/sue-clips.json`.

```sh
cd app
GOOGLE_AI_API_KEY=... npx tsx scripts/generate-sue-clips.ts --dry-run   # what it would make, and the most it could cost
GOOGLE_AI_API_KEY=... npx tsx scripts/generate-sue-clips.ts
```

Build the app again afterwards (or restart `pnpm dev`): the build is what notices them. It makes only the clips that are missing unless given `--force`. A full set is about 20 calls and costs well under a cent at the listed price. Listen to the clips before you use them: the script measures them, but it can't hear them.

Any MP3 per name works as well, if you would rather record your own.
