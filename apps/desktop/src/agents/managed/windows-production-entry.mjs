// Default Windows production managed entry. When the desktop host runs on the
// registered Windows profile/selected-project storage with the default
// Controller.open composition, ManagedProjects selects the registered native
// workspace I/O and the registered native owner-launch factory here — the same
// adapters the explicit qualification suites exercise, now wired through the
// ordinary default connect path instead of test-only fixture options.
//
// No global capability selector is flipped by this module: the native adapters
// keep their own frozen qualification facts, existing legacy platforms keep the
// legacy workspace I/O, and any host that injects its own openController or
// sessionFactory composition stays responsible for its own wiring.
//
// Owner-launch approval only ever binds to existing verified runtime
// provenance: explicit supervisor-supplied digests, the packaged Node
// executable manifest verified by readBundledNode, the Pi runtime manifest
// digest-verified by the bundled resolver, or — unpackaged development only —
// the resolver-allowed running executable pinned once per process. The native
// launch re-hashes and pins the actual executable/entry bytes against these
// approved baselines before every spawn; changed bytes are never re-approved.
import path from 'node:path';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createWindowsDesktopWorkspaceIO} from '../../platform/windows/experimental-workspace-io.mjs';
import {createExperimentalPiOwnerLaunch} from '../../platform/windows/experimental-pi-owner-launch.mjs';
import {createOwnerLaunchRegistry} from '../../main/owner-launch-registry.mjs';
import {managedStorageLocation} from '../../platform/windows/managed-storage-scope.mjs';
import {defineWorkspaceIO} from './workspace-io.mjs';
import {createOwnerConfigurationSource} from '../../platform/windows/owner-configuration-source.mjs';
import {defineRegisteredOwnerLaunch} from './prepared-owner-launch.mjs';

const hex64=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)?value:null;
const refusal=(code,message)=>({code,message});
// Unpackaged development: the bundled runtime resolver allows exactly the
// running executable as Node. That command is digest-pinned once per process
// and never re-pinned for changed bytes in the same session; the native launch
// still re-hashes the actual executable before every spawn, so a mid-session
// replacement is refused, not re-approved. Any other command without explicit
// supervisor-approved digests (for example a NOZELI_PI_NODE override) has no
// provenance here and is refused before any spawn.
const devCommandPins=new Map();
export const approvedCommandDigest=async piRuntime=>{
  const explicit=hex64(piRuntime.commandSha256);
  if(explicit)return explicit;
  const packaged=hex64(piRuntime?.manifest?.node?.sha256Executable);
  if(packaged)return packaged;
  if(piRuntime?.manifest?.node)return refusal('PI_RUNTIME_UNAVAILABLE','打包 Node 运行清单缺少已核准的可执行摘要');
  const command=piRuntime.command;
  if(typeof command!=='string'||command.toLowerCase()!==process.execPath.toLowerCase())
    return refusal('PI_RUNTIME_INVALID','未获来源核准的 Windows owner 启动可执行文件');
  let pinned=devCommandPins.get(command);
  if(pinned===undefined){
    pinned=createHash('sha256').update(await fs.readFile(command)).digest('hex');
    if(!hex64(pinned))return refusal('PI_RUNTIME_INVALID','当前可执行文件摘要无法核定');
    devCommandPins.set(command,pinned);
  }
  return pinned;
};

// Exact registered desktop production storage (the DesktopHost default on
// Windows): the profile-rooted native scope with separately selected projects.
export function windowsProductionManagedStorage(storage){
  return process.platform==='win32'&&process.arch==='x64'
    &&storage?.experimentalWindowsRoot===undefined
    &&storage?.io?.qualification?.scope==='profile-and-selected-projects';
}

// Build the default production entry for one controller open. Returns
// {native:false} for every non-production composition so callers keep their
// existing behavior; a native entry carries the single-use workspace I/O, an
// owner-launch factory bound to the same storage/lease authority, and the
// per-project service list the caller must dispose with the controller.
export async function windowsProductionManagedEntry({storage,piRuntime,projectId,previousHostRelease=null,previousColdHandoff}={}){
  if(!windowsProductionManagedStorage(storage))return {native:false};
  if(typeof projectId!=='string'||!projectId)throw Object.assign(Error('Registered project identity required'),{code:'WORKSPACE_IO_INVALID'});
  const {root}=managedStorageLocation(storage,storage.catalog,{code:'WORKSPACE_IO_INVALID'});
  const selected=createWindowsDesktopWorkspaceIO({storage,previousHostRelease,previousColdHandoff});
  // Truthful selection fact, declared by this default entry only: the selected
  // adapter is production-selected, while every unqualified guarantee (cold
  // recovery in particular) stays exactly as the native adapter states it. No
  // global capability selector is consulted or flipped.
  const workspaceIO=defineWorkspaceIO({...selected,qualification:Object.freeze({
    ...selected.qualification,scope:'default-production-windows-managed',productionSelected:true,selectedBy:'default-production-windows-managed-entry'})});
  if(piRuntime&&typeof piRuntime.command==='string'&&path.isAbsolute(piRuntime.command)
     &&typeof piRuntime.entry==='string'&&path.isAbsolute(piRuntime.entry)){
    const approvedCommand=await approvedCommandDigest(piRuntime);
    const commandSha256=typeof approvedCommand==='string'?approvedCommand:null;
    const entrySha256=hex64(piRuntime.entrySha256)??hex64(piRuntime?.manifest?.pi?.files?.['src/owner.mjs']);
    if(commandSha256&&entrySha256){
      const runtime={command:piRuntime.command,commandSha256,entry:piRuntime.entry,entrySha256,
        ...(piRuntime.nativeTools!==undefined?{nativeTools:piRuntime.nativeTools}:{}),
        ...(piRuntime.toolPath!==undefined?{toolPath:piRuntime.toolPath}:{}),
        ...(piRuntime.shell?{shell:piRuntime.shell}:{})};
      const services=[];
      const ownerLaunchFactory=spec=>{
        const agentDir=path.join(spec.home,'config'),service=createExperimentalPiOwnerLaunch({
          root,home:spec.home,agentDir,runtime:{...runtime,agentDir},
          registry:createOwnerLaunchRegistry(storage,projectId,{hostLease:spec.hostLease}),
          target:spec.target,isCurrent:spec.isCurrent,supervise:true});
        if(piRuntime.agentDir){
          const sourceDirectory=path.resolve(piRuntime.agentDir),sourceRoot=path.dirname(sourceDirectory);
          const configuration=createOwnerConfigurationSource({sourceRoot,sourceDirectory,targetRoot:root,home:spec.home,agentDir});
          const original=service;
          const configured=defineRegisteredOwnerLaunch({...original,async initialize(){const facts=await original.initialize();await configuration.synchronize();return facts;},synchronizeConfiguration:configuration.synchronize});
          services.push(configured);return configured;
        }
        services.push(service);return service;
      };
      return {native:true,scope:'default-production-windows-managed',workspaceIO,ownerLaunchFactory,services,filesystem:workspaceIO.filesystem};
    }
    // Approved runtime provenance is missing (for example an unpackaged build
    // without supervisor-supplied digests): no owner may launch, and the lack
    // is surfaced as a structured refusal at resident start — never swallowed
    // into an unverified owner path. Local business stays available through
    // the native workspace.
    const refused=approvedCommand&&typeof approvedCommand==='object'?approvedCommand
      :commandSha256?{code:'PI_RUNTIME_INVALID',message:'runtime entry digest'}:{code:'PI_RUNTIME_UNAVAILABLE',message:'bundled executable digest'};
    const ownerLaunchFactory=()=>{throw Object.assign(Error('未获批准的 Windows owner 启动运行来源证：'+refused.message),{code:refused.code});};
    return {native:true,scope:'default-production-windows-managed',workspaceIO,ownerLaunchFactory,services:[],filesystem:workspaceIO.filesystem};
  }
  return {native:true,scope:'default-production-windows-managed',workspaceIO,ownerLaunchFactory:null,services:[],filesystem:workspaceIO.filesystem};
}
