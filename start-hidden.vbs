' Starts the Video Splitter server with no console window.
'
' Used by the Start with Windows option. A plain batch file would leave a black
' console sitting in the taskbar after every login, and PowerShell's hidden
' window style still flashes on screen. WScript.Shell.Run with a window style
' of 0 is the only way to start it genuinely invisibly.

Dim shell, fso, projectDir
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' The project folder is wherever this script lives.
projectDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = projectDir

' 0 = hidden window, False = do not wait for it to finish.
shell.Run "cmd /c node server\index.js", 0, False
