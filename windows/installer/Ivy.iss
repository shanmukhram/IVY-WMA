; IVY Windows installer (Inno Setup).
;
; This wraps a self-contained .NET publish of Ivy.App into a single per-user
; setup .exe. Because the publish is self-contained and the app is built with
; WindowsAppSDKSelfContained=true, the target PC needs no preinstalled .NET
; runtime and no separately installed Windows App SDK. The one external piece
; is the WebView2 Evergreen runtime (used by the locked-window cover surface),
; which this installer checks for and installs if missing (see [Code]).
;
; Build it with windows/tools/build-installer.ps1, which passes:
;   /DMyAppVersion=<version from Ivy.App.csproj>
;   /DPublishDir=<the self-contained publish folder>
; Do not run ISCC on this file by hand without those defines.

#ifndef MyAppVersion
  #error MyAppVersion is not defined. Pass /DMyAppVersion=<version> (the build script does this).
#endif
#ifndef PublishDir
  #error PublishDir is not defined. Pass /DPublishDir=<publish folder> (the build script does this).
#endif

#define MyAppName "IVY"
#define MyAppExeName "Ivy.App.exe"
#define MyAppPublisher "IVY"

[Setup]
; Fixed AppId (hardcoded GUID): upgrades are recognised across versions, and the
; uninstaller finds the prior install. Never change this GUID.
AppId={{70908647-1188-4161-AE68-063D39DF0282}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
VersionInfoVersion={#MyAppVersion}

; Per-user install: no admin rights, installs under the user's profile.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
DefaultDirName={localappdata}\Programs\IVY
DefaultGroupName={#MyAppName}

; This is a single fixed per-user app; the install location is not meant to be
; changed, so the directory-selection page is hidden. The program-group page is
; hidden too (one fixed Start menu entry).
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=no

; Output: IVY-Setup-<version>.exe. OutputDir is overridden on the ISCC command
; line by the build script (/O...), which writes to windows/installer/out.
OutputBaseFilename=IVY-Setup-{#MyAppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible

; CloseApplications is OFF on purpose. IVY hides to the tray on window close and
; never exits, so the Restart Manager's *graceful* close only hides the window
; while the process keeps running and keeps the install-dir files locked, which
; made a silent upgrade over a running instance abort with exit code 5. Instead
; we force-terminate Ivy.App.exe in PrepareToInstall (see [Code]) before any file
; is copied. A force stop is exactly ending IVY from Task Manager, the documented
; way to stop it, and the upload queue is crash-safe, so nothing is lost.
CloseApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
; Everything from the self-contained publish folder.
Source: "{#PublishDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion
; The WebView2 Evergreen bootstrapper, bundled but not copied to {app}: it is
; extracted to a temp dir and run only when the runtime is missing (see [Code]).
Source: "redist\MicrosoftEdgeWebView2Setup.exe"; Flags: dontcopy

[Icons]
; Start menu entry only. We deliberately do NOT create a Run-at-login (startup)
; entry here: the app writes its own per-user HKCU\...\Run key itself on a paired
; start (see Ivy.App/Platform/StartupRegistration.cs and PLAN decision 15), and
; manages/repoints it. Adding one here would duplicate and fight that.
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"

[UninstallDelete]
; Intentionally empty. Uninstall removes the program files ({app}) and the Start
; menu entry only. It must NOT touch the user's data: the archive, DPAPI key
; store, upload queue and logs live in %LOCALAPPDATA%\IVY, which this installer
; never created and never removes. The owner keeps their backup and pairing
; across an uninstall or a reinstall. The app's own HKCU Run key is also left as
; the app manages it.

[Code]
// --- WebView2 Evergreen runtime detection and install ---------------------
//
// The locked-window cover surface hosts a WebView2. On a clean Windows 11 PC
// the Evergreen runtime is usually present, but not guaranteed. We detect it by
// reading the runtime's "pv" (product version) value under the Evergreen client
// GUID {F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}, in all four places it can appear
// (HKLM and HKCU, each in the WOW6432Node and native views). If none has a
// non-empty version, we run the bundled Evergreen bootstrapper silently.

const
  WebView2ClientGuid = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

function RegHasWebView2Version(RootKey: Integer; const SubKey: string): Boolean;
var
  Pv: string;
begin
  Result := RegQueryStringValue(RootKey, SubKey, 'pv', Pv) and
            (Pv <> '') and (Pv <> '0.0.0.0');
end;

function WebView2Installed(): Boolean;
var
  WowKey, NativeKey: string;
begin
  WowKey := 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\' + WebView2ClientGuid;
  NativeKey := 'SOFTWARE\Microsoft\EdgeUpdate\Clients\' + WebView2ClientGuid;
  // Per-machine (HKLM) install, and per-user (HKCU) install, each view.
  Result := RegHasWebView2Version(HKLM, WowKey) or
            RegHasWebView2Version(HKLM, NativeKey) or
            RegHasWebView2Version(HKCU, WowKey) or
            RegHasWebView2Version(HKCU, NativeKey);
end;

procedure InstallWebView2();
var
  ExtractedPath: string;
  ResultCode: Integer;
begin
  // Extract the dontcopy'd bootstrapper to a temp dir and run it silently. The
  // Evergreen bootstrapper decides per-user vs per-machine itself and downloads
  // the current runtime; /silent /install is its unattended switch.
  ExtractTemporaryFile('MicrosoftEdgeWebView2Setup.exe');
  ExtractedPath := ExpandConstant('{tmp}\MicrosoftEdgeWebView2Setup.exe');
  if not Exec(ExtractedPath, '/silent /install', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    // Could not launch it at all. Let the install continue; the app degrades to
    // a neutral blank cover surface when WebView2 is absent, so IVY still runs.
    MsgBox('IVY could not start the WebView2 runtime installer. IVY will still' + #13#10 +
           'install and run; the locked-window dashboard stays blank until the' + #13#10 +
           'Microsoft Edge WebView2 Runtime is installed.', mbInformation, MB_OK);
end;

// --- Stop a running IVY before copying files ------------------------------
//
// PrepareToInstall runs after the wizard, before any file is copied. IVY hides
// to the tray on close and never exits, so a graceful close would only hide it
// while it keeps the install-dir files locked (the cause of the exit-code-5
// abort on upgrade). We force-terminate it here instead. /F force-kills, /T also
// kills child processes (the msedgewebview2 host of the cover surface). A
// non-zero result just means nothing was running, so we ignore it. The short
// sleep lets Windows release the file handles before the copy begins. A force
// stop is the same as ending IVY from Task Manager, the documented way to stop
// it, and the upload queue is crash-safe, so nothing is lost. Returning '' (an
// empty string) tells Inno to proceed.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Exec('taskkill.exe', '/F /IM Ivy.App.exe /T', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Sleep(1500);
  Result := '';
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then
  begin
    if not WebView2Installed() then
      InstallWebView2();
  end;
end;
