// An installed development candidate owns a dedicated profile, never the
// account's daily profile. Environment selection alone is not ownership proof.
import path from 'node:path';
import {realUserHome} from '../../agents/managed/omp-system-source.mjs';
import {createWindowsDesktopProfileIO} from './desktop-profile.mjs';
const fail=()=>{throw Object.assign(Error('Isolated Windows installation profile is not bound to its original private installation'),{code:'CONFIG_ROOT_INVALID'});};
const overlaps=(a,b)=>{const relative=path.relative(a,b);return !relative||!path.isAbsolute(relative)&&!relative.split(path.sep).includes('..');};
export function selectedWindowsInstallProfile(env=process.env,home=realUserHome()){
 const value=env.NOZELI_WINDOWS_INSTALL_PROFILE;
 if(value===undefined||process.platform!=='win32')return null;
 if(typeof value!=='string'||!value||env.NOZELI_TEST_INSTANCE==='1'||env.NOZELI_CONFIG_ROOT||env.NOZELI_USER_DATA||
    !path.isAbsolute(value)||path.resolve(value)!==value||path.basename(value)!=='profile'||
    path.dirname(path.dirname(value))===path.dirname(value)||
    overlaps(path.join(home,'.Nozeli'),value)||overlaps(value,path.join(home,'.Nozeli')))fail();
 return value;
}
export async function verifyWindowsInstallProfile(profile){
 const installRoot=path.dirname(profile),io=createWindowsDesktopProfileIO(installRoot);
 const parse=async relative=>{
  const observed=await io.read(path.join(installRoot,relative),{maxBytes:16384});
  if(!observed.bytes)fail();
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(observed.bytes));}catch{fail();}
 };
 const owner=await parse('WINDOWS-INSTALL.json'),binding=await parse('profile/WINDOWS-PROFILE.json');
 if(owner?.schema!==1||owner.application!=='Nozeli'||owner.kind!=='windows-isolated-install'||owner.root!==installRoot||owner.profile!==profile||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(owner.installationId??'')||
    binding?.schema!==1||binding.application!=='Nozeli'||binding.kind!=='windows-isolated-profile'||
    binding.installationId!==owner.installationId||binding.installRoot!==installRoot)fail();
 return {profile,installRoot,installationId:owner.installationId};
}
