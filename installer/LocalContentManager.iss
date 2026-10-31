#ifndef AppVersion
  #error AppVersion must be supplied by the build script.
#endif
#ifndef SourceRoot
  #error SourceRoot must be supplied by the build script.
#endif
#ifndef OutputDir
  #error OutputDir must be supplied by the build script.
#endif

[Setup]
AppId={{1DC5010B-1BA2-4796-A67C-C87CF0E5621D}
AppName=LocalContentManager
AppVersion={#AppVersion}
AppVerName=LocalContentManager {#AppVersion}
AppPublisher=LocalContentManager
AppPublisherURL=https://github.com/
DefaultDirName={localappdata}\Programs\LocalContentManager
DefaultGroupName=LocalContentManager
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir={#OutputDir}
OutputBaseFilename=LocalContentManager-Setup-{#AppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\.runtime\electron.exe
UninstallDisplayName=LocalContentManager
MinVersion=10.0.17763
CloseApplications=force
RestartApplications=no
SetupLogging=yes

[Files]
Source: "{#SourceRoot}\.runtime\*"; DestDir: "{app}\.runtime"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#SourceRoot}\src\*"; DestDir: "{app}\src"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#SourceRoot}\node_modules\*"; DestDir: "{app}\node_modules"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#SourceRoot}\package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceRoot}\README.md"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\LocalContentManager"; Filename: "{app}\.runtime\electron.exe"; Parameters: """{app}"""; WorkingDir: "{app}"; Comment: "LocalContentManager {#AppVersion}"

[Run]
Filename: "{app}\.runtime\electron.exe"; Parameters: """{app}"""; WorkingDir: "{app}"; Description: "Launch LocalContentManager"; Flags: nowait postinstall skipifsilent

[Code]
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  PowerShellPath: String;
  ScriptPath: String;
  TargetPath: String;
  EscapedTargetPath: String;
  Script: String;
  ResultCode: Integer;
begin
  Result := '';
  TargetPath := ExpandConstant('{app}\.runtime\electron.exe');
  if not FileExists(TargetPath) then
    Exit;

  PowerShellPath := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
  ScriptPath := ExpandConstant('{tmp}\close-localcontentmanager.ps1');
  EscapedTargetPath := TargetPath;
  StringChangeEx(EscapedTargetPath, '''', '''''', True);
  Script :=
    '$ErrorActionPreference = ''Stop''' + #13#10 +
    '$target = [IO.Path]::GetFullPath(''' + EscapedTargetPath + ''')' + #13#10 +
    '$matching = Get-CimInstance Win32_Process -Filter "Name = ''electron.exe''" | ' +
      'Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq $target }' + #13#10 +
    '$matching | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }' + #13#10 +
    'Start-Sleep -Milliseconds 750' + #13#10 +
    '$remaining = Get-CimInstance Win32_Process -Filter "Name = ''electron.exe''" | ' +
      'Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq $target }' + #13#10 +
    'if ($remaining) { exit 1 }';

  if not SaveStringToFile(ScriptPath, Script, False) then
  begin
    Result := 'Setup could not prepare the application upgrade.';
    Exit;
  end;
  if not Exec(
    PowerShellPath,
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + ScriptPath + '"',
    '',
    SW_HIDE,
    ewWaitUntilTerminated,
    ResultCode
  ) or (ResultCode <> 0) then
    Result := 'LocalContentManager is still running. Close it and retry the installation.';
end;
