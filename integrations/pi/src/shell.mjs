/**
 * Nozeli-authored. Native bash tool custody for the owner worker. The Windows
 * owner environment is fixed (no ambient ProgramFiles/PATH), so the SDK's own
 * bash discovery cannot run inside the worker: the host resolves a supported
 * Bash and pins it via NOZELI_PI_SHELL, and createWorkerBashToolDefinition
 * forwards that pin to the SDK's own bash tool definition — schema, prompt
 * contribution and rendering stay the SDK's. Without a verified shell the tool
 * stays callable and answers with the explicit device prerequisite instead of
 * failing session startup; reading and chat are unaffected.
 */
import {accessSync, constants} from 'node:fs';
import path from 'node:path';
import {createBashToolDefinition, defineTool} from '@earendil-works/pi-coding-agent';
import {Type} from 'typebox';

export const BASH_PREREQUISITE='Bash is unavailable on this device: Nozeli found no supported Bash. Install Git for Windows (bash.exe under its Git\\bin directory or on PATH), then restart Nozeli.';

/** The host-pinned verified shell, or null when the device has none. */
export function pinnedWorkerShell(env=process.env){
  const value=env.NOZELI_PI_SHELL;
  if(typeof value!=='string'||!value||!path.isAbsolute(value))return null;
  // Same existence rule as the SDK's shellPathExists (plain F_OK): the host
  // verified execution at launch; this guard covers removal since then.
  try{accessSync(value,constants.F_OK);}catch{return null;}
  return value;
}

/**
 * The bash tool definition the worker registers over the SDK built-in.
 * `shell` pins the SDK's own local bash operations to the host-verified
 * executable; without one (Windows device without Bash) the definition keeps
 * the native input contract and returns the explicit prerequisite.
 */
export function createWorkerBashToolDefinition({cwd,shell}={}){
  if(shell)return createBashToolDefinition(cwd,{shellPath:shell});
  return defineTool({
    name:'bash',
    label:'bash',
    description:'Execute bash commands (unavailable: this device has no supported Bash installed)',
    parameters:Type.Object({
      command:Type.String({description:'Shell command to execute'}),
      timeout:Type.Optional(Type.Number({description:'Timeout in seconds (optional, no default timeout)'})),
    }),
    executionMode:'sequential',
    execute:async()=>({content:[{type:'text',text:BASH_PREREQUISITE}],isError:true}),
  });
}
