# Video Splitter

A local tool for dealing with a pile of videos saved off TikTok, Instagram and X.

You copy them from your phone into one folder. This sorts that folder into
buckets, then lets you go back into a bucket and cut the clips down.

Nothing is uploaded anywhere. The server runs on your machine and only ever
touches the folder you point it at.

## Starting it

Double-click **`Video Splitter.bat`**.

It starts the server, waits until it is actually answering, then opens your
browser. Leave the black window open while you work. Closing it stops the app.

Double-click it again while it is already running and it just reopens the tab
rather than complaining about a busy port.

To get it onto your desktop, right-click the file, choose **Send to**, then
**Desktop (create shortcut)**.

The first launch installs dependencies, which is the one step that needs
internet. After that it runs offline.

### Running it from a terminal

```bash
npm run dev     # API on 5174, interface on 5173, hot reload
npm start       # build once and serve everything from 5174
```

### Requirements

- **Node.js**, from https://nodejs.org. The launcher checks for it and tells
  you if it is missing.
- **FFmpeg** on your PATH, only for cutting and removing audio. Sorting works
  without it, and the launcher warns rather than refusing to start.

## Working offline

It runs with no internet connection. Everything is local: the server, the
interface, your files and FFmpeg.

There are no fonts, scripts or stylesheets loaded from a CDN, and the app
never calls out to any service. Loading the page and using every screen
produces requests only to `127.0.0.1`.

The server also binds to `127.0.0.1` specifically, not `0.0.0.0`, so it is
reachable from this machine and nothing else. Other devices on your network
cannot see it, which also means you cannot open it from your phone.

The one step that needs a connection is `npm install`, and only the first
time. Once `node_modules` exists you can stay offline indefinitely. Delete it
or clone the repo somewhere new and you will need to be online for that one
command again.

## Sorting

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

| Key | Action |
| --- | --- |
| `1`–`9` | File the current video into that bucket |
| `Space` | Play / pause |
| `←` `→` | Seek 5 seconds |
| `M` | Sound on / off |
| `R` | Restart the clip |
| `S` | Skip, leave it in the queue |
| `U` | Undo the last file |
| `L` | Open the library |
| `?` | Show the shortcut panel |

Videos start muted, because browsers block autoplay with sound until you
interact with the page. Press `M` once and sound stays on.

## Editing

Press `L` or the grid button to open the library. Pick a bucket along the top
and its clips appear as a grid. Each card plays a preview on hover. Click one
to open it in the editor.

The editor works on **parts**. A clip starts as one part covering the whole
thing. Split it wherever you like, then choose which parts to keep.

- **Split** at the playhead with `S` or the Split button. Each split adds a
  cut point.
- **Drag a cut point** along the timeline to move it, or type an exact
  timestamp in the list below. Both `1:23.45` and plain seconds are accepted.
- **Drop a part** with the eye icon, or double-click it on the timeline.
  Dropped parts stay visible so you can bring them back.
- **Merge** two parts by removing the cut between them.
- **Remove the sound** with the checkbox. This writes a silent video so you
  can lay your own audio over it.

Export writes one file per kept part into an `edits` subfolder inside the
bucket. Originals are never modified.

| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `←` `→` | Seek 1 second, hold `Shift` for 0.1 |
| `S` | Split at the playhead |
| `K` | Keep or drop the part under the playhead |
| `M` | Sound on / off |
| `R` | Back to the start |
| `Esc` | Back to the library |

### Accurate versus fast

Exports re-encode by default, which makes every cut land on the exact frame
you chose. It takes a few seconds for a short clip.

The "fast cut" option stream-copies instead. It is close to instant, but a
stream copy can only cut on keyframes, so the result can drift a second or two
from where you put the marker. On a 15 second clip that is a tenth of the video
in the wrong place, which is why it is not the default.

## Safety

- Filing moves files, never copies, and never overwrites. A name collision
  becomes `clip (2).mp4`.
- Every move is undoable for the whole session.
- Removing a bucket only removes it from the bar. The folder and the videos
  already filed into it stay on disk.
- Moves fall back to copy-then-delete when a bucket is on another drive.
- Exports are written alongside the original, never over it.
- Every path the server touches is checked to resolve inside the source
  folder.

## Formats

`.mp4`, `.m4v`, `.mov` and `.webm` preview in the browser. `.mkv` and `.avi`
appear in the queue and can still be filed, but show a placeholder instead of
a preview, because browsers cannot decode them.

## Configuration

`videosplitter.config.json` is written next to `package.json` and holds the
source folder and bucket list. Delete it to start clean. It is gitignored.

## Still to come

**Publishing.** Upload a finished clip straight to YouTube. This needs a Google
Cloud project, OAuth consent and the YouTube Data API, and unverified apps are
capped at private uploads until review. Worth treating as optional.

**Export progress.** FFmpeg currently runs to completion before the interface
hears anything back. Short clips finish in seconds, so this only starts to
matter on long videos.

## Layout

```
server/index.js       API: scans folders, streams video, moves files, runs FFmpeg
src/App.jsx           Switches between sorting, library and editor
src/Sorter.jsx        The sorting screen, owns its keyboard handling
src/Player.jsx        Video stage and transport for sorting
src/Library.jsx       Bucket browser and clip grid
src/Editor.jsx        Splitting, part selection and export
src/SourcePicker.jsx  Server-side folder browser
src/icons.jsx         Inline SVG icon set
src/api.js            Fetch wrappers
src/styles.css        All styling
```
