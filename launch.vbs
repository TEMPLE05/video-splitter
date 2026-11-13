' One click to open Video Splitter: starts the server if it is not already
' running (hidden, no console window), waits until it answers, then opens the
' app. The installed app's own icon cannot do this, because it is a web page
' and web pages may not start programs.
'
' The desktop shortcut made by "Create Shortcut.bat" runs this.

Dim shell, fso, dir, port, url, i, app
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = dir

port = shell.Environment("PROCESS")("PORT")
If port = "" Then port = "5174"
url = "http://127.0.0.1:" & port

Function Answers()
  Dim h
  On Error Resume Next
  Set h = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  h.setTimeouts 500, 500, 500, 1500
  h.open "GET", url & "/api/state", False
  h.send
  Answers = (Err.Number = 0)
  If Answers Then Answers = (h.status = 200)
  Err.Clear
  On Error GoTo 0
End Function

If Not Answers() Then
  ' A first run still needs its one-time install and build, and a missing
  ' Node needs explaining: the batch file does both, in a window.
  If Not fso.FolderExists(dir & "\node_modules") Or Not fso.FileExists(dir & "\dist\index.html") Then
    shell.Run "cmd /c """ & dir & "\Video Splitter.bat""", 1, False
    WScript.Quit
  End If
  shell.Run "cmd /c node server\index.js", 0, False
  For i = 1 To 50
    If Answers() Then Exit For
    WScript.Sleep 300
  Next
  If Not Answers() Then
    shell.Run "cmd /c """ & dir & "\Video Splitter.bat""", 1, False
    WScript.Quit
  End If
End If

' The installed app if there is one (its own window), else the browser.
app = shell.SpecialFolders("Programs") & "\Chrome Apps\Video Splitter.lnk"
If port = "5174" And fso.FileExists(app) Then
  shell.Run """" & app & """", 1, False
Else
  shell.Run url, 1, False
End If
