// This process consumes its own opaque token, starts real residents and is
// abruptly terminated by the parent. No token crosses a process boundary.
import fs from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {ProjectStorage} from '../../src/main/project-storage.mjs';
import {openWindowsManagedColdInspection,prepareWindowsManagedColdHandoff} from '../../src/platform/windows/managed-cold-checkpoint.mjs';
import {openColdController} from './windows-cold-controller.mjs';
const i=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
const storage=new ProjectStorage(i.profile,{windowsDesktopProjects:true});
const binding={storage,projectId:i.projectId,inspectJournals:true,inspectBusinessReceipts:true};
const inspection=await openWindowsManagedColdInspection(binding);
const token=await prepareWindowsManagedColdHandoff(inspection,binding);
const {controller,budget}=await openColdController(i,storage,token);
inspection.close();await controller.start();
if(controller.sessions.size!==2||budget.used!==2)throw Error('Real cold adopter residents did not start');
await fs.writeFile(i.adopterReady,JSON.stringify({pid:process.pid,sessions:controller.sessions.size}));
for(;;)await delay(1000);
