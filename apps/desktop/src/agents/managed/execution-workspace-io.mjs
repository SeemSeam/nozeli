import fs from 'node:fs/promises';
import path from 'node:path';
import {atomicJson} from './workspace.mjs';
import {createExperimentalExecutionWorkspaceIO} from '../../platform/windows/experimental-execution-workspace.mjs';

export function createExecutionWorkspaceIO({experimentalWindowsRoot,windowsRootForPath,publicDirectory}={}){
 if(windowsRootForPath!==undefined){
  if(experimentalWindowsRoot!==undefined||typeof windowsRootForPath!=='function')throw new TypeError('Choose a registered path resolver or a single native root');
  return createExperimentalExecutionWorkspaceIO(windowsRootForPath,{publicDirectory});
 }
 if(experimentalWindowsRoot!==undefined)return createExperimentalExecutionWorkspaceIO(experimentalWindowsRoot,{publicDirectory});
 return Object.freeze({
  async readJson(file){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}},
  writeJson:atomicJson,
  ensureDirectory:directory=>fs.mkdir(directory,{recursive:true,mode:0o700}),
  copyFile:(source,destination)=>fs.copyFile(source,destination),
 });
}
