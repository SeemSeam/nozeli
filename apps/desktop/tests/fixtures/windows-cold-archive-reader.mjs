import {ProjectStorage} from '../../src/main/project-storage.mjs';
import {reconcileWindowsManagedColdArchive} from '../../src/platform/windows/managed-cold-checkpoint.mjs';

const [profile,projectId,operationId]=process.argv.slice(2);
const storage=new ProjectStorage(profile,{windowsDesktopProjects:true});
try{
 const result=await reconcileWindowsManagedColdArchive({storage,projectId,operationId});
 console.log(JSON.stringify({result}));
}catch(error){
 console.log(JSON.stringify({code:error.code,message:error.message,cause:error.cause?.code??error.cause?.message}));
}finally{await storage.db.close();}
