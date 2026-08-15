#ifndef SourceDir
  #define SourceDir "..\..\artifacts\build\dist\XunleiZhiqu"
#endif
#ifndef OutputDir
  #define OutputDir "..\..\artifacts\release"
#endif
#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif

#define MyAppName "迅雷智取"
#define MyAppExeName "XunleiZhiqu.exe"

[Setup]
AppId={{4E6D5675-5B44-4B7A-90C5-4E5B8E84B7F1}
AppName={#MyAppName}
AppVersion={#AppVersion}
AppPublisher=迅雷智取
DefaultDirName={localappdata}\Programs\XunleiZhiqu
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename=XunleiZhiqu-Setup-x64
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#MyAppName}
UsePreviousAppDir=yes
CloseApplications=yes
RestartApplications=no

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "其他选项："; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "启动迅雷智取"; Flags: nowait postinstall skipifsilent
