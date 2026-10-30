import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {packageRelease, validateRelease} from './local-release.mjs';
import {installationRoot, withInstallationLock, activateRelease, retainReleases} from './release-retention.mjs';
if(process.platform!=='linux')throw Error('This installer targets Linux user-level installs only. Windows/macOS installation is not supported.');
const args=process.argv.slice(2);
if(args.length && (args.length!==2 || args[0]!=='--existing-release'))throw Error('usage: node tools/install-local.mjs [--existing-release <label-or-absolute-path>]');
const source=path.resolve(import.meta.dirname,'..'),home=os.homedir(),root=installationRoot(),version=new Date().toISOString().replace(/[:.]/g,'-');
const existing=args[1];
if(existing && !path.isAbsolute(existing) && !/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(existing))throw Error('Invalid release label');
const release=existing ? (path.isAbsolute(existing)?path.resolve(existing):path.join(root,'releases',existing)) : path.join(root,'releases',version);
await withInstallationLock(root,async()=>{
if(!existing){
 execFileSync(process.execPath,[path.join(source,'tools/build-renderer.mjs')],{cwd:source,stdio:'inherit'});
 await packageRelease({root,release,source});
}
const {application}=await validateRelease(root,release);
const current=path.join(root,'current');
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const bin=path.join(home,'.local/bin/nozeli');await fs.mkdir(path.dirname(bin),{recursive:true});
await fs.writeFile(bin,`#!/bin/sh
unset ELECTRON_RUN_AS_NODE NOZELI_TEST_PICK NOZELI_TEST_INSTANCE NOZELI_AGENT_FIXTURE NOZELI_AGENT_FIXTURE_REPLY NOZELI_HIDDEN NOZELI_EDITOR_LAB
PATH="$HOME/.local/bin:$PATH"
export PATH
if [ -n "$DISPLAY" ]; then
  exec ${quote(path.join(current,'nozeli'))} --ozone-platform=x11 "$@"
elif [ -n "$WAYLAND_DISPLAY" ]; then
  exec ${quote(path.join(current,'nozeli'))} --ozone-platform=wayland "$@"
else
  exec ${quote(path.join(current,'nozeli'))} "$@"
fi
`,{mode:0o755});await fs.chmod(bin,0o755);
const apps=path.join(home,'.local/share/applications'),icons=path.join(home,'.local/share/icons/hicolor/256x256/apps');await fs.mkdir(apps,{recursive:true});await fs.mkdir(icons,{recursive:true});await fs.copyFile(path.join(application,'assets/nozeli.png'),path.join(icons,'nozeli-paired-tabs.png'));
await fs.rm(path.join(home,'.local/share/icons/hicolor/scalable/apps/nozeli.svg'),{force:true});
const desktop=`[Desktop Entry]
Version=1.0
Type=Application
Name=Nozeli
Comment=Read, edit and annotate documents with AI collaboration
Comment[zh_CN]=代码与文档编辑器 · 阅读、批注和 AI 协作
Exec="${bin.replaceAll('"','\\"')}" %F
TryExec=${bin}
Icon=${path.join(icons,'nozeli-paired-tabs.png')}
Terminal=false
StartupNotify=false
StartupWMClass=Nozeli
Categories=Office;Development;
MimeType=application/pdf;text/plain;text/markdown;text/x-tex;text/x-bibtex;text/x-csrc;text/x-c++src;text/x-python;application/json;image/png;image/jpeg;image/webp;image/gif;image/bmp;image/avif;application/vnd.openxmlformats-officedocument.wordprocessingml.document;application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;application/vnd.openxmlformats-officedocument.presentationml.presentation;
Keywords=PDF;Markdown;TeX;Code;阅读;批注;
`;
const entry=path.join(apps,'io.nozeli.Nozeli.desktop');await fs.writeFile(entry,desktop);execFileSync('desktop-file-validate',[entry]);
let desktopDir;try{desktopDir=execFileSync('xdg-user-dir',['DESKTOP'],{encoding:'utf8'}).trim();}catch{desktopDir=path.join(home,'Desktop');}await fs.mkdir(desktopDir,{recursive:true});const shortcut=path.join(desktopDir,'Nozeli.desktop');await fs.writeFile(shortcut,desktop,{mode:0o755});await fs.chmod(shortcut,0o755);
try{execFileSync('gio',['set',shortcut,'metadata::trusted','true'],{stdio:'ignore'});}catch{}
// Archive only the known source-linked development shortcuts, keeping their profile intact.
for(const previous of [path.join(apps,'nozeli-dev.desktop'),path.join(desktopDir,'Nozeli-dev.desktop')]){try{const text=await fs.readFile(previous,'utf8');if(!text.includes('tools/start.mjs'))continue;const backup=path.join(root,'previous-shortcuts',version,path.basename(previous));await fs.mkdir(path.dirname(backup),{recursive:true});await fs.rename(previous,backup);}catch(e){if(e.code!=='ENOENT')throw e;}}
execFileSync('update-desktop-database',[apps]);
await activateRelease(root,release);
const retention=await retainReleases({root});
console.log(JSON.stringify({release,current,bin,entry,shortcut,userData:path.join(home,'.Nozeli/desktop'),retention},null,2));
});
