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
| `F` or `/` | Find any bucket by typing part of its name; `Enter` files into it |
| `Space` | Play / pause |
| `←` `→` | Seek 5 seconds |
| `M` | Sound on / off |
| `R` | Restart the clip |
| `S` | Skip, leave it in the queue |
| `B` | Back to the video before |
| `U` | Undo the last file |
| `L` | Open the library |
| `?` | Show the shortcut panel |

With many buckets the bar keeps to the lower part of the screen and scrolls,
so it never covers the video's top or the folder button. Only the first nine
buckets have number keys. With more than nine, a **Find**
bubble appears: press `F`, type a few letters, and the bar narrows to the
buckets that match. The arrow keys choose between them and `Enter` files.

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

## The library

Press `L` or the grid button to open the library. It works like File Explorer:
a page of folders, one per bucket, each showing a frame from its first clip.
Click a folder to open it on its own screen. `Esc`, `Backspace` or the
"Library" link at the top takes you back up a level.

Each card shows a still frame. Rest the pointer on one and it plays a preview.
Click it to open it in the editor. Coming back from the editor returns you to
the same folder at the same scroll position. Clips you have worked on carry an
**Edited** badge.

Thumbnails are small images made once per clip and kept in a `.cache` folder
next to the app, never inside your own folders. The first visit to a folder
makes them as you look, a few at a time; after that they appear instantly.

### Choosing clips: move or delete

The round tick in a card's corner selects it, or choose **Select clips** from
the **⋯** menu. `Ctrl`-click also selects, `Shift`-click selects everything
between, and `Ctrl`+`A` selects the whole folder. Once anything is
selected, the top bar shows how many, with buttons to:

- **Move to…** another bucket, or back to the sorting queue to be sorted again.
  Saved edits go with the clips.
- **Delete**, which asks first and names what will go. Clips go to the
  Windows **Recycle Bin** (the Trash on a Mac), where they can be restored.
  Nothing is deleted outright. Exports and pulled audio stay where they are.

`Delete` on the keyboard does the same, and `Esc` lets go of the selection.

### Projects: a video from pictures

A project is a video that starts from nothing rather than from one clip: say,
a set of pictures with a voice-over, transitions and captions. **New project**
is on the library's front page, above the folders. Give it a name
and a shape (tall 9:16, square, portrait 4:5 or wide 16:9), tick the pictures
and clips to start with, in the order you want them, or add pictures from your
computer, and choose how long each picture shows. The editor opens with
everything else there: sounds and voice-overs, transitions, text, captions and
templates.

Projects appear in their folder's **Projects** row, and pick up where you left
off. Exports go to that folder's `edits` folder under the project's name.
Deleting a project removes only its edit; the pictures, sounds and exports
stay.

### Pulling all the audio

**Pull all audio…**, in a folder's **⋯** menu, saves every clip's sound as its
own file in that folder's `audio` subfolder, for listening without the
picture: prayers, talks, songs. **MP3** plays anywhere; **Keep quality**
copies the sound out untouched. Clips already done are skipped, so it is safe
to run again after adding more.

### Tidying up the main folder

Phones save pictures, voice notes and documents next to the videos. When the
main folder has files that are not videos, the library offers **Tidy up**. It
moves them into one folder called `Other files`, sorted into Pictures, Audio,
Documents and Other, and **Put them back** undoes it. Nothing is deleted, and
`Other files` is never mistaken for a bucket.

## Editing

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
- **Move** a selected piece by dragging it along the timeline; a blue line
  shows where it will land. `Alt` + `←` `→` moves it one place.
- **Undo** and **redo** cover every change, a hundred steps back.

### Saved as you go

Every change is saved a moment after you make it, and once more as you leave,
so closing the editor, or the whole app, loses nothing. Opening the clip again
picks up exactly where you left off. **Start over** at the top goes back to the
whole clip untouched; it is an undoable step like any other.

Saves are small files in an `.edits` folder next to the app, never in your own
folders. A clip moved to another bucket keeps its edit.

### One video or separate parts

**Export** makes one finished video by default: every piece, in order, joined
into `<clip> edit.mp4`.

**Into parts** cuts the clip into any number of equal pieces, say five, and
switches the export to **separate parts**, one file per piece. A ten minute
video into five parts gives five two-minute files. If you had already made
cuts, it starts again from the whole clip; undo brings your cuts back. You can
switch between one video and separate parts in the export window at any time.

### Transitions, fades and more clips

- **Transitions.** Every cut has a small square on the timeline. Click it to
  pick Fade, Black, White, Slide, Wipe, Zoom, Circle or Blur, and how long it
  lasts; **Use on every cut** copies it to all of them. A transition borrows a
  little footage from just beyond the cut, so the edit keeps its length and
  your song, text and captions stay where you put them. If both pieces run to
  the very end of their clips at that cut, there is nothing to borrow, and the
  panel says so.
- **Fades.** The Transitions tool also fades the whole video in from black and
  out to black, picture and sound together.
- **Add clip** brings another clip from any bucket into the same edit, after
  the selected piece or at the end. Trim, split and move it like any other
  piece. A clip of a different shape is fitted into the frame with the blurred
  fill.

### Speed

**Speed** changes how fast a piece plays: select it on the timeline (or just
open Speed if the edit is one piece) and drag the slider, from 0.1x slow motion
to 10x. The middle is normal speed, and 0.5x and 2x sit the same distance
either side. The piece gets shorter or longer on the timeline to match, and
its label shows the speed.

- **Slow then fast** ramps the speed smoothly across the piece, from the
  **Starts at** speed to the **Ends at** speed. Split a ramped piece and each
  half carries on the same ramp.
- **Voice.** **Sounds normal** keeps voices sounding like themselves at any
  speed. **Chipmunk / deep** lets them go high when sped up and low when
  slowed down.
- **Smooth slow motion**, offered when a piece is slowed down, makes up
  in-between frames in the export so slow footage glides instead of
  stuttering. It makes exporting much slower, and the preview does not show
  it.
- **Use on every clip piece** copies the speed to all of them; **Normal
  speed** puts a piece back as it was filmed.

Captions listen to the edit at its speeds, so they stay in step.

### Blur

**Blur** hides part of the picture: a face, a name, a number plate. Pick
**Pencil** and paint over what to hide, or drag out a **Box** or an **Oval**.
It is blurred from the playhead to the end of the edit, and shows on the
timeline as a blue bar beside the texts: drag its ends to change when it shows,
or type the times in its panel. Click it to change how strong it is, paint more
of the picture into it, duplicate it or delete it.

On the picture, drag a blur to move it and a corner to size it. If the thing
it hides moves, use **marked spots**: press **+ Mark a spot here**, play on to
where the thing has gone, pause, and drag the blur onto it. A spot is marked
there too, and the blur glides from each spot to the next. Spots show as small
diamonds on the blur's bar and as times in its panel, where a click goes to
one and the × removes it.

### Sound, crop, canvas and pictures

- **Add sound** places a song or any sound file at the playhead. Pick one
  from the bucket (audio you pulled out of another clip is listed), or choose
  one from anywhere on your computer; it is copied into the bucket's `audio`
  folder. Add as many as you like, each at its own time: a song underneath, a
  sound effect at 0:04, a voice line later. Each is a green bar: drag it to
  move it, drag its ends to trim it, click it to set its volume, when it
  starts, and where in the file it starts playing from. A first sound that
  covers the whole edit turns the clip's own sound off, so it replaces it;
  **Clip sound** turns it back on to hear both.
- **Crop** shows the whole picture with a box over it. Drag the box, its
  corners or its edges; pulling the top and bottom edges in crops the height.
  The 9:16, 1:1, 4:5 and 16:9 buttons lock the box to that shape.
- **Canvas** sets the shape of the finished video. When the video does not
  fill it, the space around it is filled with a blurred copy of the picture,
  the way TikTok and Shorts do it, with black, or with a **picture** of your
  own, cropped to fill the frame.
- **Add picture** puts a still image after the selected piece, or at the end,
  for as many seconds as you choose. It is a piece like any other: drag its
  handles to change how long it shows, or delete it. Pictures from your
  computer are copied into the bucket's `images` folder.

### Text

**Text** adds a line of text at the playhead, showing for three seconds. A
second text added while another is showing goes underneath it rather than on
top. As in CapCut, every text and every sound sits in its own **lane** on the
timeline, one under another: drag a bar along to change when it plays, or up
and down to change lane, and use the **+ Sound** and **+ Text** buttons at the left of the lanes to add one.
In the text panel, **+ Text below** adds a line under the current one that
appears a second after it, and **Duplicate** (`D`) copies it, style and all,
to play right after it. The sound panel has **+ Sound after this**, which
starts the next sound when the current one ends. Type into the box; the tabs underneath set the rest:

- **Font:** Clean, Heavy, Black, Narrow, Serif, Type, Hand and Script, plus
  any font you import. **Import font…** takes a `.ttf`, `.otf`, `.woff` or
  `.woff2` file, such as a free one from Google Fonts or DaFont; it is kept in
  a `.fonts` folder next to the app and offered for every clip from then on.
- **Style:** Outline, Box, Pill, Marker, Shadow, Lifted, Neon, Hollow and
  Plain.
- **Animation:** when the text shows, typed exactly (from 0:02 to 0:05, say),
  and three choices: how it arrives (**In**: Pop, Fade, Rise, Drop, Zoom,
  Typewriter), how it leaves (**Out**: Fade, Pop, Sink, Lift, Zoom), and what
  it does while showing (Wobble, Bounce, Pulse). Several texts with their own
  times make a sequence: one line, then the next. Hand lettering wobbles by
  default, a small shake eight times a second, like a line drawn by hand.
- **Colour**, and a size slider.

Drag the text on the picture to move it; it snaps to the middle. On the
timeline it is an amber bar: drag it to change when it shows, or drag its ends
to change how long. Text is drawn by the editor and laid over the video on
export, animation included, so the finished file looks exactly like the
preview.

### Auto captions

**Captions** listens to the speech in the edit and writes it out a few words
at a time, the way TikTok and CapCut show them. They are violet bars on the
timeline.

- **Make your cuts first.** Captions are timed to the edit as it is when you
  make them. If you split, delete, trim or move pieces afterwards, a notice
  says the captions may be out of step and offers to make them again.
- **Check them before you export.** Speech recognition gets names and unusual
  words wrong sometimes. Click any caption, on the picture or the timeline, to
  fix a word. Nothing is final until you export, and the export window reminds
  you.
- **Names and words to spell right** is a list, remembered between clips, such
  as `Messi, Inter Miami`. A heard word that is close to a listed name, like
  "Messy", is written the listed way.
- **Translate into English** turns speech in another language into English
  captions.
- **Listen to** chooses what is heard: the clips' own sound, the added sounds
  (a voice-over, say), or both. Leave a song out to caption only the voice.
- **Word by word** is an animation for captions: the word being spoken lights
  up in a second colour. **Use this look for all captions** copies one
  caption's font, style, colour, size, place and animation to every caption.

Captions are worked out on this computer by [whisper.cpp](https://github.com/ggml-org/whisper.cpp);
nothing is uploaded. The first time anyone asks for captions, the app offers a
one-time download into a `.tools` folder next to it: the program (8 MB) and a
language model, **Quick** (148 MB) or **Better** (488 MB). After that it works
offline. A short clip takes a few seconds; a nine-minute episode about a
minute. On macOS and Linux, install whisper.cpp so `whisper-cli` is on your
PATH and the app uses that instead.

### Templates

A template is a saved crop, shape and fill, caption style and fades, under a
name such as "TikTok vertical". In **Templates**, type a name at the top, tick
the parts to include and save; the list below puts a saved template on any
clip in one go. A template can also make the captions straight away, in its
saved style.

A crop saved on a tall clip still works on a wide one: it keeps the same output
shape and the same centre. Using a template is one undo step.

### Pulling the audio out

**Extract audio** writes the clip's whole soundtrack to its own file in an
`audio` subfolder beside the bucket. The video is not modified.

**Keep quality** copies the existing audio straight out into an `.m4a`. It is
instant and bit for bit identical, because nothing is re-encoded. **As mp3**
converts instead, which more players accept but does lose a little quality to
the second encode. A whole bucket can be done at once from its library page.

### Exporting

Exports go into an `edits` subfolder inside the bucket the clip came from.
Originals are never modified, and the export window shows the full path after
it finishes.

```
<your folder>/
  Clips/
    long clip.mp4              the original, untouched
    edits/
      long clip edit.mp4       one finished video
      long clip edit.srt       its captions as a subtitle file, if asked for
      long clip part 1.mp4     or one file per piece
      long clip part 2.mp4
```

The export window offers:

- **Video (MP4)** or **GIF**. A GIF is a small looping picture with no sound,
  up to a minute long.
- **Quality:** High (best picture, bigger file), Standard, or Small (at most
  1280 pixels tall, for sending on).
- **Also save the captions as a subtitle file**, an `.srt` beside the video.

A progress bar shows how far along it is, and **Stop** ends it part way;
nothing half-written is left behind. Nothing is ever overwritten: a name that
is already taken becomes `… (2).mp4`, even for two exports started together.

| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `S` or `Ctrl`+`B` | Split at the playhead |
| `Delete` | Delete the selected piece or text |
| `Alt` + `←` `→` | Move the selected piece one place |
| `Ctrl`+`Z` | Undo |
| `Ctrl`+`Shift`+`Z` or `Ctrl`+`Y` | Redo |
| `←` `→` | One frame back or forward, hold `Shift` for a second |
| `Home` `End` | Start or end of the edit |
| `+` `−` | Zoom in or out |
| `M` | Mute the preview only |
| `Esc` | Close a panel, deselect, then back to the library |

### Accurate versus fast

Exports re-encode, which makes every cut land on the exact frame you chose. It
takes a few seconds for a short clip.

When exporting separate parts with nothing added, a "fast cut" option
stream-copies instead. It is close to instant, but a stream copy can only start
on a keyframe, so each part starts on the keyframe at or before the point you
chose. The export window says exactly where each part really starts. The file
holds only what plays: no hidden footage before the start.

Text subtitles already inside a clip (SRT, ASS, WebVTT) are kept, retimed to
the edit: lines in pieces you cut out disappear, and the rest move with their
pieces. Picture subtitles from Blu-ray or DVD rips cannot go into an mp4 and
are left out.

## Safety

- Filing moves files, never copies, and never overwrites. A name collision
  becomes `clip (2).mp4`.
- Every filing is undoable for the whole session.
- Removing a bucket only removes it from the bar. The folder and the videos
  already filed into it stay on disk.
- Deleting clips from the library sends them to the Recycle Bin after asking,
  never deletes them outright.
- Tidying up only moves files, into one folder, and can be put back.
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
source folder, the bucket list and your saved looks. Delete it to start clean.
It is gitignored.

`.edits` holds your saved edits. Deleting it loses the cuts you have not
exported yet, so leave it unless you mean to.

`.cache` holds the library's thumbnails and the editor's frame strips,
waveforms and captions. It is safe to delete at any time; they are simply made
again as needed.

`.tools` holds whisper.cpp and its language model, once downloaded for
captions. Deleting it just means downloading them again next time.

`.fonts` holds the fonts you imported for text.

All five are gitignored.

## Layout

```
server/index.js       API: scans folders, streams video, moves files, renders exports
server/captions.js    Downloads whisper.cpp on first use and transcribes the edit
server/edits.js       Saves each clip's edit as you work
server/library.js     Recycle Bin, moving clips between buckets, tidying up
server/fonts.js       Fonts imported for text
server/projects.js    Projects: videos started from pictures, kept in .edits/projects
server/speed.js       Speed and slow-then-fast ramps for the picture and the sound
src/Projects.jsx      Project cards and the New project window
src/App.jsx           Switches between sorting, library and editor
src/Sorter.jsx        The sorting screen, owns its keyboard handling
src/Player.jsx        Video stage and transport for sorting
src/Library.jsx       Folder page and clip grid, File Explorer style, selection
src/Thumb.jsx         Thumbnail loader, capped at three requests at once
src/ConfirmRemove.jsx Checks a bucket's contents before allowing removal
src/Editor.jsx        The editor screen and its tools
src/editor/model.js   The edit as a list of pieces, and the operations on it
src/editor/Timeline.jsx    Canvas timeline: frames, waveform, trimming, moving, cuts
src/editor/usePlayback.js  Plays the edit: two players, clips, pictures, transitions, song
src/editor/Stage.jsx  The picture as exported: crop, canvas, fill, blends, text
src/editor/text.js    Draws and animates text, the same for preview and export
src/editor/blur.js    Blurs: their shapes, marked spots and the masks the export uses
src/editor/frame.js   Size of the finished frame, matching the server
src/editor/fonts.js   Loads imported fonts into the browser
src/editor/panels.jsx Panels under the timeline: text, sound, transitions, splitting
src/editor/sheets.jsx Windows: export, captions, looks, adding clips and media
src/SourcePicker.jsx  Server-side folder browser
src/icons.jsx         Inline SVG icon set
src/api.js            Fetch wrappers
src/styles.css        All styling
```
