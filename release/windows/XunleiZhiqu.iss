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
MinVersion=10.0
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64os
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
Name: "{group}\安装浏览器扩展"; Filename: "{app}\{#MyAppExeName}"; Parameters: "--install-extension auto"
Name: "{group}\安装 Chrome 扩展"; Filename: "{app}\{#MyAppExeName}"; Parameters: "--install-extension chrome"
Name: "{group}\安装 Edge 扩展"; Filename: "{app}\{#MyAppExeName}"; Parameters: "--install-extension edge"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "启动迅雷智取"; Flags: nowait postinstall skipifsilent
Filename: "{app}\{#MyAppExeName}"; Parameters: "--install-extension auto"; Description: "安装迅雷智取浏览器扩展（仍需在浏览器中确认一次）"; Flags: nowait postinstall skipifsilent
