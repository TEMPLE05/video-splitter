# Video Splitter

A local tool for dealing with a pile of videos saved off TikTok, Instagram and X.

You copy them from your phone into one folder. This sorts that folder into
buckets, then lets you go back into a bucket and cut the clips down.

Nothing is uploaded anywhere. The server runs on your machine and only ever
touches the folder you point it at.

## Getting it

```bash
git clone https://github.com/TEMPLE05/video-splitter.git
cd video-splitter
```

Or use the green **Code** button on GitHub and pick **Download ZIP**, then
unzip it somewhere you can find again.

## Starting it

**On Windows**, double-click **`Video Splitter.bat`**. On macOS or Linux there
is no launcher yet, so use the terminal commands further down.

It starts the server, waits until it is actually answering, then opens your
browser. Leave the black window open while you work. Closing it stops the app.

Double-click it again while it is already running and it just reopens the tab
rather than complaining about a busy port.

### A desktop shortcut and a taskbar pin

Double-click **`Create Shortcut.bat`** once. It puts a **Video Splitter**
shortcut on your desktop with the app's own icon.

To pin it, right-click that shortcut and choose **Pin to taskbar**. On Windows
11 you may need **Show more options** first. **Pin to Start** works the same
way.

Windows will not pin a `.bat` file, and it will not pin a shortcut that points
straight at one either. That is why the shortcut targets `cmd.exe` and passes
the batch file as an argument: to Windows it is then a shortcut to a program,
which it is willing to pin and which can carry a custom icon.

Windows 11 also blocks pinning to the taskbar from a script, so that last
right-click is yours to do. Nothing can automate it.

### Starting it automatically

The server does not survive a restart, so after shutting down your PC the app
icon will report that it is not running. Double-click **`Start with Windows.bat`**
once and the server starts quietly at every login from then on, with no console
window. Run it again to turn that back off.

To stop the server without rebooting, double-click **`Stop Video Splitter.bat`**.
It only stops the process holding this app's port, so other Node programs are
left alone.

### Installing it as an app

Once it is running, open the browser menu and choose **Install Video Splitter**
(Edge calls it "Install this site as an app"). It then gets its own window with
no tabs or address bar, its own icon, and a proper Start menu entry that pins
cleanly.

The server still has to be running for it to do anything. Launch it the usual
way first. If you open the installed app on its own, it will tell you the
server is not running and offer a Retry button rather than showing a browser
error page.

If the Install option does not appear straight away, that is the browser, not
the app. Edge and Chrome wait until you have actually used a page before
offering to install it. You do not have to wait: open the browser menu and pick
Install directly.

Installing needs Edge or Chrome. Firefox does not support installing desktop
web apps. On a Mac, Safari calls it Add to Dock.

The first launch installs dependencies, which is the one step that needs
internet. After that it runs offline.

### Running it from a terminal

Works on any platform, and is the only route on macOS and Linux.

```bash
npm install     # first time only, needs internet
npm start       # build once, then serve everything from 5174
npm run dev     # hot reload: API on 5174, interface on 5173
```

Then open http://127.0.0.1:5174 (or 5173 in dev).

### Requirements

- **Node.js**, from https://nodejs.org. The launcher checks for it and tells
  you if it is missing.
- **FFmpeg** on your PATH, only for cutting and removing audio. Sorting works
  without it, and the launcher warns rather than refusing to start. Get it from
  https://ffmpeg.org, or on Windows with `winget install Gyan.FFmpeg`.
- **Windows** for the double-click launcher and the shortcut. Everything else
  is platform independent.

## Working offline

**Offline does not mean always on.** The app needs no internet, but it does need
its own server running on your machine, because a web page on its own cannot
read your folders or run FFmpeg. Shutting down your PC stops that server, and
nothing restarts it unless you ask it to. See "Starting it automatically" above.

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

Pick a source folder. The picker offers shortcuts to the usual places
(Downloads, Videos, Desktop) with a count of how many videos each holds, a
breadcrumb you can click any level of, and a box to paste a path into. Folders
containing videos show the count, so you can find the right one without opening
each in turn.

Every video sitting directly in that folder becomes the queue. Create buckets,
and each one is made as a real subfolder inside it. Filing a video moves it
into that subfolder.

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

### Changing or clearing the folder

Click the folder button in the top right to open the picker again. The folder
currently in use is shown at the top with a **Stop** button, which unselects it
and takes you back to an empty picker. Nothing on disk is touched, so you can
pick it again later and your buckets will still be there.

Press `Esc` to back out of the picker without changing anything.

### Removing a bucket

Hover a bucket and click the small x, either on the sorting screen or on a
folder tile in the library. Removing is not deleting. Any videos inside move
back to your main folder and rejoin the queue, and only the empty folder goes.

Before offering the button, the app checks everything inside the bucket. It
refuses, and touches nothing, if the bucket holds pulled audio, exported clips,
any folder of your own with something in it, or files that are not videos. The
confirmation says exactly what it found. Empty leftover folders and files
Windows creates on its own, such as `desktop.ini`, do not count.

The folder itself is only ever removed once it is empty, so even a file that
appears at the last moment stops the removal rather than being lost.

## Editing

Press `L` or the grid button to open the library. It works like File Explorer:
a page of folders, one per bucket, each showing a frame from its first clip.
Click a folder to open it on its own screen. `Esc`, `Backspace` or the
"Library" link at the top takes you back up a level.

Each card shows a still frame. Rest the pointer on one and it plays a preview.
Click it to open it in the editor. Coming back from the editor returns you to
the same folder at the same scroll position.

Thumbnails are small images made once per clip and kept in a `.cache` folder
next to the app, never inside your own folders. The first visit to a folder
makes them as you look, a few at a time; after that they appear instantly. Only
three load at once, so the rest of the app stays responsive while they do.

The editor is laid out like CapCut on a phone: the picture on top, the timeline
under it, the tools along the bottom. The playhead stays in the middle and the
clip slides underneath it, shown as a strip of its own frames with its sound
drawn as a waveform below.

The edit is a row of **pieces**. A clip starts as one piece covering the whole
thing. What you see playing is exactly what the export will be: deleted pieces
are skipped, and the gap they leave closes up.

- **Scrub** by dragging the timeline left or right, or with the mouse wheel.
  `Ctrl` + wheel, or the `−` and `+` buttons, zoom in and out. Click the time
  ruler to jump.
- **Split** cuts the piece under the playhead in two, with `S` or the Split
  button. It cuts on the frame you are looking at, even while playing.
- **Split at…** takes a typed time, as `1:15` or as plain seconds. The time is
  a position on the timeline, so it matches the clock beside the play button.
- **Select** a piece by clicking it. It gets a white frame with a handle at
  each end. **Drag a handle** to trim that end; the preview shows the frame you
  are trimming to. **Delete** removes the selected piece.
- **Undo** and **redo** cover every change, a hundred steps back.
- **Sound on / off** turns the clip's own sound off, for the preview and the
  export, so you can lay your own audio over it.

### One video or separate parts

**Export** makes one finished video by default: every piece, in order, joined
into `<clip> edit.mp4`.

**Into parts** cuts the clip into any number of equal pieces, say five, and
switches the export to **separate parts**, one file per piece. A ten minute
video into five parts gives five two-minute files. If you had already made
cuts, it starts again from the whole clip; undo brings your cuts back. You can
switch between one video and separate parts in the export window at any time.

### Pulling the audio out

**Extract audio** writes the clip's whole soundtrack to its own file in an
`audio` subfolder beside the bucket. The video is not modified.

**Keep quality** copies the existing audio straight out into an `.m4a`. It is
instant and bit for bit identical, because nothing is re-encoded. **As mp3**
converts instead, which more players accept but does lose a little quality to
the second encode. A whole bucket can be done at once from its library page.

### Where exports go

Into an `edits` subfolder inside the bucket the clip came from. Originals are
never modified, and the export window shows the full path after it finishes.

```
<your folder>/
  Clips/
    long clip.mp4              the original, untouched
    edits/
      long clip edit.mp4       one finished video
      long clip part 1.mp4     or one file per piece
      long clip part 2.mp4
```

Nothing is ever overwritten: a name that is already taken becomes `… (2).mp4`.

| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `S` or `Ctrl`+`B` | Split at the playhead |
| `Delete` | Delete the selected piece |
| `Ctrl`+`Z` | Undo |
| `Ctrl`+`Shift`+`Z` or `Ctrl`+`Y` | Redo |
| `←` `→` | One frame back or forward, hold `Shift` for a second |
| `Home` `End` | Start or end of the edit |
| `+` `−` | Zoom in or out |
| `M` | Mute the preview only |
| `Esc` | Deselect, then back to the library |

### Accurate versus fast

Exports re-encode, which makes every cut land on the exact frame you chose. It
takes a few seconds for a short clip.

When exporting separate parts, a "fast cut" option stream-copies instead. It is
close to instant, but a stream copy can only start on a keyframe, so a part can
begin a few seconds before the point you chose. One finished video is always
re-encoded, since joining stream-copied pieces glitches at every cut.

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

`.cache` holds the library's thumbnails and the editor's frame strips and
waveforms. It is safe to delete at any time; they are simply made again as
needed. It is gitignored too.

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
src/Library.jsx       Folder page and clip grid, File Explorer style
src/Thumb.jsx         Thumbnail loader, capped at three requests at once
src/ConfirmRemove.jsx Checks a bucket's contents before allowing removal
src/Editor.jsx        The editor screen, its tools and the export window
src/editor/model.js   The edit as a list of pieces, and the operations on it
src/editor/Timeline.jsx  Canvas timeline: frames, waveform, trimming, scrubbing
src/editor/usePlayback.js  Plays the edit, swapping between two videos at cuts
src/SourcePicker.jsx  Server-side folder browser
src/icons.jsx         Inline SVG icon set
src/api.js            Fetch wrappers
src/styles.css        All styling
```
