; Inno Setup script for Offset Aware's Windows installer.
;
; Build the payload first, then compile this against it:
;
;   pwsh deploy\windows\build.ps1
;   ISCC.exe deploy\windows\portal.iss
;
; The payload and the installer therefore cannot drift: there is one build,
; and this only wraps it.
;
; This replaces a zip containing setup.bat, which asked permission to install
; Node 24 on the machine - replacing whatever Node every other program there
; was using - and then ran npm install, so installing needed internet access
; and what the customer ran was whatever npm resolved that day. Now it brings
; its own Node and its own dependencies, like the other Offset products.
;
; UNSIGNED. Windows will show "Windows protected your PC" and the person
; installing has to choose More info -> Run anyway. That is expected until a
; code signing certificate exists. To sign later, add
;   SignTool=offset
; below. No other change is needed.

#define Display "Offset Aware"
; Offset Aware was called the ISO Training Portal. The data folder, the
; registry key, the Windows service and the firewall rule keep that name, so
; an upgrade finds everything where the last version left it.
#define Legacy "ISO Training Portal"
#define Folder "OffsetTrainingPortal"
#ifndef AppVersion
  #define AppVersion "1.0.6"
#endif
#define Payload "..\..\dist\windows\" + Folder
#define DataDir "{commonappdata}\Offset Security\" + Legacy

[Setup]
AppId={{B7E41D92-3C8A-4F15-9D62-OFFSETTRAINING}
AppName={#Display}
AppVersion={#AppVersion}
AppVerName={#Display} {#AppVersion}
AppPublisher=Offset Security
AppPublisherURL=https://offsetsecurity.net
DefaultDirName={autopf}\Offset Security\{#Display}
DefaultGroupName=Offset Security
DisableDirPage=auto
DisableProgramGroupPage=yes
; Inno 6 hides the welcome page by default. Ours says what this puts on the
; machine - its own Node, nothing added to Windows - which is the question an
; administrator has before letting it run.
DisableWelcomePage=no
; Task choices are otherwise restored from the previous install, so a default
; changed here would never reach anyone upgrading.
UsePreviousTasks=no
OutputDir=..\..\dist\windows
OutputBaseFilename=OffsetAware-{#AppVersion}-setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
ArchitecturesAllowed=x64compatible
; The service, the firewall rule and Program Files all need it.
PrivilegesRequired=admin
UninstallDisplayName={#Display}
UninstallDisplayIcon={app}\offset.ico
SetupLogging=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "{#Payload}\node.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Payload}\*"; DestDir: "{app}"; Excludes: "node.exe"; \
  Flags: ignoreversion recursesubdirs createallsubdirs
Source: "offset.ico"; DestDir: "{app}"; Flags: ignoreversion

[Dirs]
; The data lives outside Program Files, which an uninstall or a repair is
; entitled to empty. These are somebody's training records, so the folder is
; then closed to everybody but Windows and administrators (SecureFolders, below):
; it holds the staff list, the password hashes and the certificate's private key.
Name: "{#DataDir}"
Name: "{#DataDir}\uploads"
Name: "{#DataDir}\certs"
Name: "{#DataDir}\logs"

[Icons]
; What everything points at: the portal in a browser. The service is already
; running, so there is nothing to start and no window to close.
Name: "{group}\{#Display}"; Filename: "wscript.exe"; \
  Parameters: """{app}\open.vbs"""; WorkingDir: "{app}"; \
  Comment: "Open the {#Display}"; IconFilename: "{app}\offset.ico"
Name: "{group}\{#Display} documents"; Filename: "{app}\docs"
; For somebody locked out of the administrator account. It asks for
; administrator rights itself, because the database is only writable by them.
Name: "{group}\Reset administrator password"; Filename: "{app}\reset_admin_password.bat"; \
  WorkingDir: "{app}"; Comment: "Set a new password for an administrator account"
Name: "{group}\{#Display} data folder"; Filename: "{#DataDir}"
Name: "{group}\{#Display} logs"; Filename: "{#DataDir}\logs"; \
  Comment: "Open the folder to send to support"
Name: "{group}\Uninstall {#Display}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#Display}"; Filename: "wscript.exe"; \
  Parameters: """{app}\open.vbs"""; WorkingDir: "{app}"; Tasks: desktopicon; \
  IconFilename: "{app}\offset.ico"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"

[Run]
; Register and start the Windows service, using the Node that ships here.
Filename: "{app}\node.exe"; Parameters: "install_service.js"; \
  WorkingDir: "{app}"; StatusMsg: "Setting {#Display} to start with Windows..."; \
  Flags: runhidden waituntilterminated
Filename: "wscript.exe"; Parameters: """{app}\open.vbs"""; \
  WorkingDir: "{app}"; Description: "Open {#Display} now"; \
  Flags: postinstall nowait skipifsilent

[UninstallRun]
; Take the service away before the files it points at go, and ignore any
; failure: it may never have been installed.
Filename: "{app}\node.exe"; Parameters: "uninstall_service.js"; \
  WorkingDir: "{app}"; Flags: runhidden waituntilterminated; \
  RunOnceId: "RemovePortalService"
; And the hole it opened in the firewall. Leaving a port open for something
; that is no longer there is the kind of thing an audit finds.
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -Command ""Get-NetFirewallRule -DisplayName '{#Legacy}*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue"""; \
  Flags: runhidden waituntilterminated; RunOnceId: "RemovePortalFirewall"

[InstallDelete]
; Shortcuts from before the rename, so an upgrade does not leave two of each.
Type: files; Name: "{group}\{#Legacy}.lnk"
Type: files; Name: "{group}\{#Legacy} documents.lnk"
Type: files; Name: "{group}\{#Legacy} data folder.lnk"
Type: files; Name: "{group}\{#Legacy} logs.lnk"
Type: files; Name: "{group}\Uninstall {#Legacy}.lnk"
Type: files; Name: "{autodesktop}\{#Legacy}.lnk"
Type: files; Name: "{commondesktop}\{#Legacy}.lnk"

[UninstallDelete]
; The application only. The training records, the uploads and the certificate
; are deliberately left behind - an uninstaller that silently deleted somebody's
; compliance evidence would be indefensible. The final message says where.
Type: filesandordirs; Name: "{app}\node_modules"
Type: filesandordirs; Name: "{app}\public"
Type: filesandordirs; Name: "{app}\docs"
Type: filesandordirs; Name: "{app}\daemon"
Type: files; Name: "{app}\node.exe"
Type: files; Name: "{app}\*.js"
Type: files; Name: "{app}\*.bat"
Type: files; Name: "{app}\.env"
Type: files; Name: "{app}\env.template"
Type: files; Name: "{app}\open.vbs"

[Registry]
; The shortcut reads the address from here, so it follows the port that was
; actually chosen rather than guessing 3000.
Root: HKLM; Subkey: "SOFTWARE\Offset Security\{#Legacy}"; \
  ValueType: string; ValueName: "Url"; ValueData: "{code:PortalUrl}"; \
  Flags: uninsdeletekey

[Messages]
WelcomeLabel2=This installs {#Display}, security awareness training for your staff, on your own server.%n%nIt brings its own copy of Node.js, inside its own folder. Nothing is added to Windows, no other software is needed, and the Node.js any other program on this server uses is left alone.%n%nIt answers on one port, which you choose in a moment. Your training records are kept outside Program Files, in ProgramData, so they survive an uninstall.%n%nThe internet is needed for one step only: downloading the training videos you choose. After that, {#Display} runs entirely on this server.
FinishedLabel=Setup has installed {#Display}.%n%nYour training records are kept in:%n{#DataDir}%n%nBack up that folder to back up everything. Only administrators of this server can open it.

[Code]
const
  { Where the training videos are downloaded from, one file per module. }
  CoursesUrl = 'https://github.com/offsetsecurity/offset-aware/releases/download/courses-1/';
  { The course packs: one zip per framework, each holding every course's video,
    subtitles, quiz and one-page summary. Items 0 to 3 are the packs; 4 to 8
    are the five original modules, which the packs replace. }
  PacksUrl = 'https://github.com/offsetsecurity/offset-aware/releases/download/courses-2/';
  PackCount = 4;
  ModuleCount = 9;

var
  PortPage: TInputQueryWizardPage;
  ModulePage: TWizardPage;
  ModuleList: TNewCheckListBox;
  ModulesPrepared: Boolean;
  DownloadPage: TDownloadWizardPage;

{ —— The training modules ————————————————————————————————————————————
  The videos are not inside this installer, which keeps it small however many
  courses there are. The administrator ticks the modules they want and only
  those are downloaded, each checked against its SHA-256 before it is used.
  This is the only time Offset Aware uses the internet, and the page says so. }

function IsPack(I: Integer): Boolean;
begin
  Result := I < PackCount;
end;

function ModUrl(I: Integer): String;
begin
  if IsPack(I) then Result := PacksUrl else Result := CoursesUrl;
end;

function ModAsset(I: Integer): String;
begin
  case I of
    0: Result := 'pack-iso27001.zip';
    1: Result := 'pack-hipaa.zip';
    2: Result := 'pack-sama.zip';
    3: Result := 'pack-sama-finance.zip';
    4: Result := 'infosec.mp4';
    5: Result := 'phishing.mp4';
    6: Result := 'privacy.mp4';
    7: Result := 'incident.mp4';
    8: Result := 'secure-coding.mp4';
  end;
end;

{ The name the application looks for, which is the name earlier versions
  shipped the videos under, so an upgrade finds the ones already there. For a
  pack, one file it always holds: if that is here, so is the pack. }
function ModFile(I: Integer): String;
begin
  case I of
    0: Result := 'iso-t01.quiz.json';
    1: Result := 'hipaa-r01.quiz.json';
    2: Result := 'sama-01.quiz.json';
    3: Result := 'sama-fc-01.quiz.json';
    4: Result := 'Infosec.mp4';
    5: Result := 'Phising.mp4';
    6: Result := 'Data Privacy.mp4';
    7: Result := 'Incident Reporting.mp4';
    8: Result := 'Secure_Coding_(OWASP).mp4';
  end;
end;

function ModTitle(I: Integer): String;
begin
  case I of
    0: Result := 'ISO 27001 pack: 13 courses (5 for all staff, 8 by role)';
    1: Result := 'HIPAA pack, for vendors (business associates): 7 courses (1 for all staff, 6 by role)';
    2: Result := 'SAMA pack, for banks: 19 courses (8 for all staff, the rest by role)';
    3: Result := 'SAMA pack, for finance companies: 7 courses (5 for all staff, 2 by role)';
    4: Result := 'Older course: Information Security Awareness & AUP';
    5: Result := 'Older course: Phishing & Social Engineering';
    6: Result := 'Older course: Data Privacy & Handling';
    7: Result := 'Older course: Incident Reporting';
    8: Result := 'Older course: Secure Coding (OWASP)';
  end;
end;

{ The packs' lines are written by the script that builds them. }
function ModSha(I: Integer): String;
begin
  case I of
    0: Result := '5ad8671f55c40199d18614a62d5f6cd3c4cefc03fc7db58bdf98c610d00f1c37';
    1: Result := '1d87fa2c58872663ea3b77b5838d6cdc05a5d04db0b9e2f798d7279dc14c2d80';
    2: Result := '57db1702b7efbbc9f52a6c84a7e277963b454f58c2d9c95c4ff5f6ff8d438c59';
    3: Result := '988fbf257d3a3b76edcd1c76808f724e4665be5984bf3f2da9630a9b71c0d9f4';
    4: Result := 'a6e37988c29d1b0984e292412ac6c0d395a6640248e6dd75e4f19a7d362555fc';
    5: Result := 'e76235542bf9925d120348079feb9df889283686ba1ecc1b6d146b2c15fb8ded';
    6: Result := 'd0529c47b92039d2163915e32e8f3f630f205e3481796d9871e196894d7ccc68';
    7: Result := '704973256a230d21e1871affe0994c5653f0b58b8a32e24d91c222d5b14c15a7';
    8: Result := '30691f2ee3ad8975478cf9eeb91f1304efae9be750751cfb7f9259f53eb9a5eb';
  end;
end;

function ModSizeMB(I: Integer): Integer;
begin
  case I of
    0: Result := 189;
    1: Result := 133;
    2: Result := 402;
    3: Result := 58;
    4: Result := 11;
    5: Result := 18;
    6: Result := 12;
    7: Result := 14;
    8: Result := 12;
  end;
end;

{ Ticked to begin with: the ISO 27001 pack. The other packs are for the
  organisations they name, and the older courses are replaced by the packs. }
function ModDefault(I: Integer): Boolean;
begin
  Result := I = 0;
end;

function ModuleOnServer(I: Integer): Boolean;
begin
  Result := FileExists(ExpandConstant('{app}\public\training\') + ModFile(I));
end;

{ A quiet install takes /MODULES=iso27001 (the default), /MODULES=all,
  /MODULES=none, or a list such as /MODULES=iso27001,sama. The older courses
  are infosec, phishing, privacy, incident and secure_coding. }
function SilentWants(I: Integer): Boolean;
var
  Wanted, Id: String;
begin
  Wanted := ',' + Lowercase(ExpandConstant('{param:modules|iso27001}')) + ',';
  Id := ChangeFileExt(ModAsset(I), '');
  if IsPack(I) then Id := Copy(Id, 6, Length(Id));   { pack-sama -> sama }
  if Id = 'secure-coding' then Id := 'secure_coding';
  Result := (Wanted = ',all,') or (Pos(',' + Id + ',', Wanted) > 0) or
            ((Id = 'secure_coding') and (Pos(',secure-coding,', Wanted) > 0));
end;

function WantModule(I: Integer): Boolean;
begin
  if ModuleOnServer(I) then
    Result := False
  else if WizardSilent() then
    Result := SilentWants(I)
  else
    Result := ModuleList.Checked[I];
end;

function OnDownloadProgress(const Url, FileName: String; const Progress, ProgressMax: Int64): Boolean;
begin
  if (ProgressMax > 0) and (Progress = ProgressMax) then
    Log('Downloaded ' + FileName);
  Result := True;
end;

procedure CreateModulePage();
var
  Warn, Info, Note: TNewStaticText;
  I: Integer;
begin
  ModulePage := CreateCustomPage(PortPage.ID, 'Training modules',
    'Which training videos should Offset Aware download?');

  Warn := TNewStaticText.Create(ModulePage);
  Warn.Parent := ModulePage.Surface;
  Warn.WordWrap := True;
  Warn.Width := ModulePage.SurfaceWidth;
  Warn.Font.Style := [fsBold];
  Warn.Caption := 'The internet is needed for this step. This is the only time ' +
    'Offset Aware uses the internet.';

  Info := TNewStaticText.Create(ModulePage);
  Info.Parent := ModulePage.Surface;
  Info.WordWrap := True;
  Info.Width := ModulePage.SurfaceWidth;
  Info.Top := Warn.Top + Warn.Height + ScaleY(6);
  Info.Caption := 'The videos are not inside this installer. The modules you tick are ' +
    'downloaded from Offset Security''s release page on github.com when you click ' +
    'Install, and each one is checked before it is used. After setup, Offset Aware ' +
    'runs entirely on this server, and nothing about your staff or their training ' +
    'is ever sent anywhere.';

  ModuleList := TNewCheckListBox.Create(ModulePage);
  ModuleList.Parent := ModulePage.Surface;
  ModuleList.Top := Info.Top + Info.Height + ScaleY(8);
  ModuleList.Width := ModulePage.SurfaceWidth;
  ModuleList.Height := ScaleY(170);
  for I := 0 to ModuleCount - 1 do
    ModuleList.AddCheckBox(ModTitle(I), IntToStr(ModSizeMB(I)) + ' MB', 0, ModDefault(I), True, False, False, nil);

  Note := TNewStaticText.Create(ModulePage);
  Note.Parent := ModulePage.Surface;
  Note.WordWrap := True;
  Note.Width := ModulePage.SurfaceWidth;
  Note.Top := ModuleList.Top + ModuleList.Height + ScaleY(6);
  Note.Caption := 'No internet on this server? Untick them all. You can add the videos ' +
    'later by running this installer again, or by copying them in: Settings in ' +
    'Offset Aware explains how.';

  DownloadPage := CreateDownloadPage('Downloading training modules',
    'Fetching the videos you chose. This is the only time Offset Aware uses the internet.',
    @OnDownloadProgress);
end;

{ On an upgrade, the videos already here are shown as installed and are not
  downloaded again. }
procedure PrepareModuleList();
var
  I: Integer;
begin
  if ModulesPrepared then exit;
  ModulesPrepared := True;
  for I := 0 to ModuleCount - 1 do
    if ModuleOnServer(I) then
    begin
      ModuleList.ItemCaption[I] := ModTitle(I) + ' - already on this server';
      ModuleList.Checked[I] := True;
      ModuleList.ItemEnabled[I] := False;
    end;
end;

{ Downloads the ticked modules into the temporary folder. A failure does not
  have to stop the install: the person is asked, and can go on without them. }
function DownloadModules(): Boolean;
var
  I, N: Integer;
  Reason: String;
begin
  Result := True;
  DownloadPage.Clear;
  N := 0;
  for I := 0 to ModuleCount - 1 do
    if WantModule(I) then
    begin
      DownloadPage.Add(ModUrl(I) + ModAsset(I), ModAsset(I), ModSha(I));
      N := N + 1;
    end;
  if N = 0 then exit;

  DownloadPage.Show;
  try
    try
      DownloadPage.Download;
    except
      if DownloadPage.AbortedByUser then
        Reason := 'The download was stopped.'
      else
        Reason := GetExceptionMessage;
      Log('Training module download failed: ' + Reason);
      Result := SuppressibleMsgBox('The training videos could not be downloaded.' +
        Chr(13) + Chr(10) + Chr(13) + Chr(10) + Reason + Chr(13) + Chr(10) + Chr(13) + Chr(10) +
        'Install Offset Aware without them? Any that did download are still installed. ' +
        'You can add the rest later: Settings in Offset Aware explains how.',
        mbConfirmation, MB_YESNO, IDYES) = IDYES;
    end;
  finally
    DownloadPage.Hide;
  end;
end;

{ A quiet install has no pages, so it downloads here, file by file, and logs
  what it could not get rather than stopping. }
procedure DownloadModulesSilently();
var
  I: Integer;
begin
  for I := 0 to ModuleCount - 1 do
    if WantModule(I) then
      try
        DownloadTemporaryFile(ModUrl(I) + ModAsset(I), ModAsset(I), ModSha(I), @OnDownloadProgress);
      except
        Log('Training module ' + ModAsset(I) + ' not downloaded: ' + GetExceptionMessage);
      end;
end;

{ Puts every downloaded video in place, after checking it once more. }
procedure InstallModules();
var
  I, ResultCode: Integer;
  Src, Dst, Sha: String;
begin
  ForceDirectories(ExpandConstant('{app}\public\training'));
  for I := 0 to ModuleCount - 1 do
  begin
    Src := ExpandConstant('{tmp}\') + ModAsset(I);
    if not FileExists(Src) then continue;
    try
      Sha := Lowercase(GetSHA256OfFile(Src));
    except
      Sha := '';
    end;
    if Sha <> ModSha(I) then
    begin
      Log('Training module ' + ModAsset(I) + ' failed its check and was not installed.');
      continue;
    end;
    if IsPack(I) then
    begin
      { A pack is unzipped into the training folder, where the application
        finds its courses by their file names. }
      if Exec('powershell.exe',
              '-NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath ''' + Src +
              ''' -DestinationPath ''' + ExpandConstant('{app}\public\training') + ''' -Force"',
              '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0) then
        Log('Installed course pack ' + ModAsset(I))
      else
        Log('Could not unpack course pack ' + ModAsset(I));
      continue;
    end;
    Dst := ExpandConstant('{app}\public\training\') + ModFile(I);
    if CopyFile(Src, Dst, False) then
      Log('Installed training module ' + ModFile(I))
    else
      Log('Could not copy training module to ' + Dst);
  end;
end;

function DataFolder(): String;
begin
  Result := ExpandConstant('{#DataDir}');
end;

{ An upgrade already has a port, chosen at the first install and possibly
  changed since. Asking again invites an answer that does not match the one
  everybody has bookmarked. }
function AlreadyConfigured(): Boolean;
begin
  Result := FileExists(ExpandConstant('{app}\.env'));
end;

{ The first port from Start upward that nothing is listening on.

  Inno has no sockets, so Windows is asked through PowerShell and answers into
  a file. }
function FirstFreePort(Start: Integer): Integer;
var
  ResultCode: Integer;
  Answer: AnsiString;
  Path: String;
begin
  Result := Start;
  Path := ExpandConstant('{tmp}\portal-port.txt');
  DeleteFile(Path);
  if Exec('powershell.exe',
          '-NoProfile -ExecutionPolicy Bypass -Command "' +
          '$p = ' + IntToStr(Start) + '; ' +
          'while ($p -lt 65535 -and (Get-NetTCPConnection -LocalPort $p -State Listen ' +
          '-ErrorAction SilentlyContinue)) { $p++ }; ' +
          'Set-Content -Path \"' + Path + '\" -Value $p -Encoding ascii"',
          '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    if LoadStringFromFile(Path, Answer) then
      Result := StrToIntDef(Trim(String(Answer)), Start);
end;

function PortIsFree(Port: Integer): Boolean;
begin
  Result := FirstFreePort(Port) = Port;
end;

{ The port the first run should write into .env: from the page when somebody
  answered it, from /PORT= for an unattended install, 3000 otherwise. }
function ChosenPort(): String;
begin
  if (PortPage <> nil) and (Trim(PortPage.Values[0]) <> '') then
    Result := Trim(PortPage.Values[0])
  else
    Result := ExpandConstant('{param:port|3000}');
end;

{ The port this install actually answers on: from .env on an upgrade, because
  that is the address staff have. }
function InstalledPort(): String;
var
  Lines: TArrayOfString;
  I: Integer;
begin
  Result := '';
  if LoadStringsFromFile(ExpandConstant('{app}\.env'), Lines) then
    for I := 0 to GetArrayLength(Lines) - 1 do
      if Pos('PORT=', Lines[I]) = 1 then
        Result := Trim(Copy(Lines[I], 6, Length(Lines[I])));
  if Result = '' then
    Result := ChosenPort();
end;

function PortalUrl(Param: String): String;
begin
  Result := 'https://localhost:' + InstalledPort();
end;

procedure InitializeWizard();
begin
  PortPage := CreateInputQueryPage(wpSelectTasks,
    'Network port',
    'Which port should the portal answer on?',
    'The portal answers on one port on this server, and staff reach it at that ' +
    'address. 3000 is the usual one, and the box below is already filled in ' +
    'with the first port nothing else is using - so you can accept it, or type ' +
    'any other port you prefer.');
  PortPage.Add('Port:', False);
  CreateModulePage();
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := (PageID = PortPage.ID) and AlreadyConfigured();
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  { Filled here rather than in InitializeWizard: asking Windows what is free
    takes a moment, and doing it while the first page draws makes the
    installer look stuck before it has said anything. }
  if (CurPageID = PortPage.ID) and (Trim(PortPage.Values[0]) = '') then
    PortPage.Values[0] := IntToStr(FirstFreePort(3000));

  if CurPageID = ModulePage.ID then
    PrepareModuleList();

  if CurPageID = wpFinished then
    WizardForm.FinishedLabel.Caption := WizardForm.FinishedLabel.Caption +
      Chr(13) + Chr(10) + Chr(13) + Chr(10) + 'It answers on ' + PortalUrl('') +
      '  -  the shortcut opens it for you.';
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Port, Free: Integer;
begin
  Result := True;
  { Install was clicked: fetch the training videos that were ticked. }
  if (CurPageID = wpReady) and not WizardSilent() then
  begin
    Result := DownloadModules();
    exit;
  end;
  if CurPageID <> PortPage.ID then exit;

  Port := StrToIntDef(Trim(PortPage.Values[0]), 0);
  if (Port < 1024) or (Port > 65535) then
  begin
    SuppressibleMsgBox('Enter a port between 1024 and 65535.' + Chr(13) + Chr(10) + Chr(13) + Chr(10) +
                       'Ports below 1024 are reserved for Windows itself.',
                       mbError, MB_OK, IDOK);
    Result := False;
    exit;
  end;

  if not PortIsFree(Port) then
  begin
    Free := FirstFreePort(Port);
    Result := SuppressibleMsgBox('Something is already listening on port ' + IntToStr(Port) + '.' +
                       Chr(13) + Chr(10) + Chr(13) + Chr(10) +
                       'The portal would install and then fail to start. Port ' +
                       IntToStr(Free) + ' is free.' + Chr(13) + Chr(10) + Chr(13) + Chr(10) +
                       'Use ' + IntToStr(Port) + ' anyway?',
                       mbConfirmation, MB_YESNO, IDNO) = IDYES;
    if not Result then PortPage.Values[0] := IntToStr(Free);
  end;
end;

{ Stops a running copy so its files can be replaced.

  The service holds node.exe open, and an installer that warns about that and
  then tries anyway fails on a locked file - silently, on a quiet install,
  which is how an IT department deploys this. }
procedure StopRunningCopy();
var
  ResultCode: Integer;
begin
  Exec('powershell.exe',
       '-NoProfile -ExecutionPolicy Bypass -Command "' +
       '$ErrorActionPreference = ''SilentlyContinue''; ' +
       'Stop-Service -Name ''isotrainingportal.exe'' -Force; ' +
       '$dir = ''' + ExpandConstant('{app}') + '''; ' +
       'Get-Process -Name node -ErrorAction SilentlyContinue | ' +
       'Where-Object { $_.Path -and $_.Path.StartsWith($dir) } | ' +
       'Stop-Process -Force; ' +
       'Start-Sleep -Seconds 2; ' +
       // Removed, not left alone: node-windows will not re-register a service
       // that exists, so an upgrade would keep a service pointing at the
       // machine's Node - the one this version stops needing.
       'sc.exe delete ''isotrainingportal.exe'' | Out-Null; ' +
       // A deleted service is not gone until every handle to it closes, and
       // recreating one before that fails with "marked for deletion".
       '$gone = (Get-Date).AddSeconds(30); ' +
       'while ((Get-Date) -lt $gone -and (Get-Service -Name ''isotrainingportal.exe'' ' +
       '-ErrorAction SilentlyContinue)) { Start-Sleep -Seconds 1 }; ' +
       // And node-windows asks its own folder, not Windows, whether a service
       // exists. Left behind, these files make it report "already installed"
       // and do nothing - while exiting 0, so nobody notices.
       'Remove-Item -LiteralPath (Join-Path $dir ''daemon'') -Recurse -Force -ErrorAction SilentlyContinue"',
       '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if WizardSilent() then
    DownloadModulesSilently();
  StopRunningCopy();
end;

{ Writes .env on a first install: the chosen port, the address, and a session
  secret unique to this machine. An upgrade leaves it exactly as it is. }
procedure WriteSettings();
var
  Template: TArrayOfString;
  I: Integer;
  Secret: String;
  ResultCode: Integer;
  Answer: AnsiString;
  Path, Port: String;
begin
  if AlreadyConfigured() then exit;
  if not LoadStringsFromFile(ExpandConstant('{app}\env.template'), Template) then exit;

  Port := ChosenPort();

  { 48 random bytes as hex, from Windows' cryptographic generator. Generated
    per install, so no two share a key. }
  Secret := '';
  Path := ExpandConstant('{tmp}\portal-secret.txt');
  DeleteFile(Path);
  if Exec('powershell.exe',
          '-NoProfile -ExecutionPolicy Bypass -Command "' +
          '$b = New-Object byte[] 48; ' +
          '[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); ' +
          'Set-Content -Path \"' + Path + '\" -Encoding ascii -Value ' +
          '([System.BitConverter]::ToString($b).Replace(''-'','''')).ToLower()"',
          '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    if LoadStringFromFile(Path, Answer) then
      Secret := Trim(String(Answer));
  DeleteFile(Path);

  for I := 0 to GetArrayLength(Template) - 1 do
  begin
    if Pos('PORT=', Template[I]) = 1 then
      Template[I] := 'PORT=' + Port;
    if Pos('PORTAL_URL=', Template[I]) = 1 then
      Template[I] := 'PORTAL_URL=https://' + GetComputerNameString + ':' + Port;
    if Pos('SESSION_SECRET=', Template[I]) = 1 then
      Template[I] := 'SESSION_SECRET=' + Secret;
  end;
  SaveStringsToFile(ExpandConstant('{app}\.env'), Template, False);
end;

{ Closes the data folder and the settings file to everybody but Windows and
  administrators. The service did this for the data folder when it was
  registered; the settings file did not exist yet. See secure_folders.js. }
procedure SecureFolders();
var
  ResultCode: Integer;
begin
  if Exec(ExpandConstant('{app}\node.exe'), 'secure_folders.js', ExpandConstant('{app}'),
          SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0) then
    Log('Data folder and settings file restricted to administrators.')
  else
    Log('Could not restrict the data folder and settings file.');
end;

{ Lets staff on the network reach it. The portal always serves HTTPS, so this
  opens a port that is encrypted, not a plain one. }
procedure OpenFirewall(Port: String);
var
  ResultCode: Integer;
begin
  Exec('powershell.exe',
       '-NoProfile -ExecutionPolicy Bypass -Command "' +
       '$ErrorActionPreference = ''SilentlyContinue''; ' +
       'Get-NetFirewallRule -DisplayName ''ISO Training Portal*'' | Remove-NetFirewallRule; ' +
       'New-NetFirewallRule -DisplayName ''ISO Training Portal (TCP ' + Port + ')'' ' +
       '-Direction Inbound -LocalPort ' + Port + ' -Protocol TCP -Action Allow"',
       '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

{ The service is registered by install_service.js, which asks Windows to start
  it and then exits. That request is not always carried out, and when it was
  not, the portal sat installed and stopped while the installer opened a
  browser at nothing. So this waits, and starts it itself if it has to. }
procedure EnsureServiceRunning();
var
  ResultCode: Integer;
begin
  Exec('powershell.exe',
       '-NoProfile -ExecutionPolicy Bypass -Command "' +
       '$deadline = (Get-Date).AddSeconds(60); ' +
       'while ((Get-Date) -lt $deadline) { ' +
       '  $s = Get-Service -Name ''isotrainingportal.exe'' -ErrorAction SilentlyContinue; ' +
       '  if ($s -and $s.Status -eq ''Running'') { break }; ' +
       '  if ($s -and $s.Status -eq ''Stopped'') { Start-Service -Name ''isotrainingportal.exe'' -ErrorAction SilentlyContinue }; ' +
       '  Start-Sleep -Seconds 2 }"',
       '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  LogFolder: String;
begin
  if CurStep = ssPostInstall then
  begin
    InstallModules();
    WriteSettings();
    SecureFolders();
    OpenFirewall(InstalledPort());
    EnsureServiceRunning();

    { The zip installer wrote its own entry in Settings -> Apps, and this
      installer owns that now. Two entries for one product - one of them
      pointing at a script that is no longer how it is removed - is worse
      than none. }
    RegDeleteKeyIncludingSubkeys(HKEY_LOCAL_MACHINE,
      'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\ISOTrainingPortal');

    { Keep the installer's own transcript beside the application's logs. Inno
      writes it to the temporary folder, which Windows eventually clears, and
      a person asked for "the install log" will not go looking there. }
    LogFolder := ExpandConstant('{#DataDir}\logs');
    if ForceDirectories(LogFolder) then
      CopyFile(ExpandConstant('{log}'), LogFolder + '\install.log', False);
  end;
end;
