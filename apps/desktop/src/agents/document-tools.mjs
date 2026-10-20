import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { agentActor } from '../domain/document-changes.mjs';

// Capabilities are issued by the host, never by the model or renderer. This is
// a local managed write path, not an interceptor for arbitrary shell writes.
export async function startDocumentTools(host, { beforeOperation = async () => () => {} } = {}) {
  const grants = new Map();
  const server = createServer(async (req,res) => {
    const send = (status,value) => { const raw=JSON.stringify(value);res.writeHead(status,{'content-type':'application/json','content-length':Buffer.byteLength(raw)});res.end(raw); };
    if (req.method !== 'POST' || req.url !== '/document') return send(404,{ok:false,error:{code:'NOT_FOUND',message:'unknown document tool'}});
    const token = String(req.headers.authorization || '').replace(/^Bearer /,'');
    const grant = grants.get(token);
    if (!grant) return send(401,{ok:false,error:{code:'GRANT_REJECTED',message:'document capability was revoked or is invalid'}});
    let release=()=>{};
    try {
      const chunks=[];let size=0;
      for await (const chunk of req) { size+=chunk.length;if(size>20*1024*1024)return send(413,{ok:false,error:{code:'TOO_LARGE',message:'document tool payload is too large'}});chunks.push(chunk); }
      let body;try { body=JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(400,{ok:false,error:{code:'INVALID_PAYLOAD',message:'invalid document JSON'}}); }
      if(!body||typeof body!=='object'||Array.isArray(body))return send(400,{ok:false,error:{code:'INVALID_PAYLOAD',message:'document payload must be an object'}});
      const allowed = body.op==='read' ? ['op','relPath'] : body.op==='apply' ? ['op','readHandle','edits','operationId'] : [];
      if (!allowed.length || Object.keys(body).some(key=>!allowed.includes(key))) return send(400,{ok:false,error:{code:'INVALID_PAYLOAD',message:'use read or apply; actor and project are host-bound'}});
      if (body.op==='apply' && !grant.canWrite) return send(403,{ok:false,error:{code:'READONLY',message:'this agent was configured without document write permission'}});
      const read = body.op==='apply' ? host.documentReads.get(body.readHandle) : null;
      if (body.op==='apply' && (!read || read.projectId!==grant.projectId || read.actorId!==grant.actor.id || read.sessionInstance!==grant.actor.sessionInstance)) return send(403,{ok:false,error:{code:'READ_HANDLE_REJECTED',message:'read again in this agent session'}});
      const relPath = body.op==='read' ? body.relPath : read.relPath;
      release = await beforeOperation({projectId:grant.projectId,relPath,hold:body.op==='apply'});
      if (!grants.has(token)) return send(401,{ok:false,error:{code:'GRANT_REJECTED',message:'agent session ended'}});
      const value = body.op==='read' ? await host.readDocument(grant.projectId,relPath,grant.actor) : await host.applyDocument(grant.projectId,grant.actor,body);
      send(200,{ok:true,value});
    } catch (error) { send(409,{ok:false,error:{code:error.code || 'DOCUMENT_FAILED',message:error.message,details:error.details || {}}}); }
    finally { release?.(); }
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  server.unref();
  return {
    url:`http://127.0.0.1:${server.address().port}/document`,
    issue({projectId,role,provider,permissionMode,sessionId=null}) {
      const token=randomBytes(32).toString('hex'),actor=agentActor(projectId,role,{provider,sessionId,sessionInstance:randomUUID()});
      grants.set(token,{projectId,actor,canWrite:permissionMode==='full'});
      return {token,actor};
    },
    setSession(token,sessionId) { const grant=grants.get(token);if(grant){if(grant.actor.sessionId&&grant.actor.sessionId!==sessionId)grant.actor.sessionInstance=randomUUID();grant.actor.sessionId=sessionId;} },
    revoke(token) { grants.delete(token); },
    close:()=>new Promise(resolve=>{grants.clear();server.close(resolve);server.closeIdleConnections?.();}),
  };
}
