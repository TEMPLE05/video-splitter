# Video Splitter

A local tool for dealing with a pile of videos saved off TikTok, Instagram and X.

You copy them from your phone into one folder. This sorts that folder into
buckets, fast, with the keyboard.

Nothing is uploaded anywhere. The server runs on your machine and only ever
touches the folder you point it at.

## Running it

```bash
npm install
npm run dev
```

That starts the API on port 5174 and the UI on port 5173, and opens the
browser. For a single-port version with no hot reload:

```bash
npm start
```

## How it works

Pick a source folder. Every video sitting directly in it becomes the queue.
Create buckets, and each one is made as a real subfolder inside that source
folder. Filing a video moves it into that subfolder.

Because buckets are just folders, the tool picks up a layout you already have.
Point it at a folder that already contains subfolders and those become buckets
on sight.

The buckets float over the video as translucent pills, so you can file with a
click without leaving the clip. After a few seconds of stillness the rest of
the interface fades out and only the video and the bucket bar remain. Any
mouse movement or keypress brings it back.

### Keyboard

| Key | Action |
| --- | --- |
| `1`–`9` | File the current video into that bucket |
| `Space` | Play / pause |
| `←` `→` | Seek 5 seconds |
| `M` | Sound on / off |
| `R` | Restart the clip |
| `S` | Skip, leave it in the queue |
| `U` | Undo the last file |
| `?` | Show the shortcut panel |

Videos start muted, because browsers block autoplay with sound until you
interact with the page. Press `M` once and sound stays on.

### Safety

- Files are moved, never copied and never overwritten. A name collision
  becomes `clip (2).mp4`.
- Every move is undoable for the whole session.
- Removing a bucket only removes it from the sidebar. The folder and the
  videos already filed into it stay on disk.
- Moves fall back to copy-then-delete when a bucket is on another drive.

### Formats

`.mp4`, `.m4v`, `.mov` and `.webm` preview in the browser. `.mkv` and `.avi`
appear in the queue and can still be filed, but show a placeholder instead of
a preview, because browsers cannot decode them.

## Configuration

`videosplitter.config.json` is written next to `package.json` and holds the
source folder and bucket list. Delete it to start clean. It is gitignored.

## Roadmap

Phase 1, sorting, is what exists today. The rest is the plan.

**Phase 2, editing.** Open a bucket, pick a video, and cut it. Split by
specific timestamps, keep or drop the ranges, and strip the audio track so a
new soundtrack can be laid over the silent result. FFmpeg is already installed
on this machine and does the work. Dropping audio is a single flag, so that
part is nearly free once the cutting UI exists.

One thing that matters for this phase: cutting without re-encoding is instant
but can only land on keyframes, which drift by a second or two. On a 15 second
clip that is badly wrong. Re-encoding is frame-accurate and, at these file
sizes, takes seconds. Re-encode should be the default, with stream-copy as an
opt-in for speed.

**Phase 3, publishing.** Upload a finished clip straight to YouTube. This needs
a Google Cloud project, OAuth consent, and the YouTube Data API, and unverified
apps are capped at private uploads until review. Worth doing last, and worth
treating as optional.

## Layout

```
server/index.js   API: scans folders, streams video, moves files
src/App.jsx       Picks between the folder picker and the sorter
src/Sorter.jsx    The sorting screen, owns all keyboard handling
src/Player.jsx    Video stage and transport bar
src/SourcePicker.jsx  Server-side folder browser
src/api.js        Fetch wrappers
src/styles.css    All styling
```
