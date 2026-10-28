import {createHash} from 'node:crypto';
import {HostError} from './host.mjs';
import {managedReportSource} from '../agents/managed-report-source.mjs';

// Reports remain external immutable objects. Export only creates a separate
// format-matched file at the registered project root; never accepts renderer text.
export class ManagedReportExporter {
  constructor({host, managedAgents, beforeOperation}) {
    Object.assign(this, {host, managedAgents, beforeOperation});
  }

  export(payload) { return this.host.track(this.exportNow(payload)); }
  exportArtifact(payload) { return this.host.track(this.exportArtifactNow(payload)); }
  async exportArtifactNow(payload) {
    if (!payload || Object.keys(payload).some(k => !['projectId','objectId','sourcePath','relPath'].includes(k))) throw new HostError('INVALID_PAYLOAD','成果另存参数无效。');
    const {projectId,objectId,sourcePath,relPath}=payload;
    if (!/^[0-9a-f-]{36}$/i.test(objectId||'') || typeof sourcePath!=='string' || typeof relPath!=='string') throw new HostError('INVALID_PAYLOAD','成果身份无效。');
    if (Buffer.byteLength(relPath)>200 || !/^[^\x00-\x1f\x7f/\\:*?"<>|. ][^\x00-\x1f\x7f/\\:*?"<>|]*\.(?:md|markdown)$/i.test(relPath) || /[. ]\.(?:md|markdown)$/i.test(relPath) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(relPath)) throw new HostError('BAD_PATH','请输入项目根目录中的 Markdown 文件名（.md 或 .markdown）。');
    if(!/\.(?:md|markdown)$/i.test(sourcePath))throw new HostError('BAD_PATH','此入口仅另存冻结 Markdown 成果。');
    const artifact=await this.managedAgents.artifactRead(projectId,{objectId,relPath:sourcePath});
    if(artifact.availability==='absent'||typeof artifact.base64!=='string')throw new HostError('ARTIFACT_UNAVAILABLE','冻结成果文件不可用，未另存。');
    const bytes=Buffer.from(artifact.base64,'base64'),project=await this.host.requireProject(projectId);
    const check=async()=>{const current=await this.host.requireProject(projectId);if(current.root!==project.root)throw new HostError('PROJECT_ROOT_MISSING','项目目录已变化，未另存。');const target=await this.host.resolveFile(current,relPath);if(!target.missing)throw new HostError('CONFLICT','此名称已存在，请使用其他名称；原成果未覆盖。');const draft=await this.host.readDraftRecord(projectId,relPath);if(draft)throw new HostError('UNSAVED','此名称有保留的编辑副本，请使用其他名称。');return target;};
    await check();
    let release;
    try{
      if(typeof this.beforeOperation!=='function')throw new HostError('NOT_READY','编辑保护尚未接通，未另存。');
      release=await this.beforeOperation({projectId,relPath,hold:true});
      return await this.host.fileLock(projectId,relPath)(async()=>{
        const target=await check();
        await this.host.replaceFile(target.abs,bytes,{createOnly:true,beforeCommit:async()=>{
          await check();
          const current=await this.managedAgents.artifactRead(projectId,{objectId,relPath:sourcePath});
          if(current.base64!==artifact.base64)throw new HostError('ARTIFACT_CHANGED','冻结成果已变化，未另存。');
        }});
        return {projectId,objectId,sourcePath,relPath,byteLength:bytes.length,digest:createHash('sha256').update(bytes).digest('hex'),copied:true};
      });
    }catch(error){
      if(error.code==='EEXIST')throw new HostError('CONFLICT','此名称被其他操作占用，请使用其他名称；原成果未覆盖。');
      throw error;
    }finally{await release?.();}
  }

  async exportNow(payload) {
    if (!payload || Object.keys(payload).some(k => !['projectId','objectId','relPath'].includes(k)))
      throw new HostError('INVALID_PAYLOAD', '报告另存参数无效。');
    const {projectId, objectId, relPath} = payload;
    if (!/^[0-9a-f-]{36}$/i.test(objectId || ''))
      throw new HostError('INVALID_PAYLOAD', '报告身份无效。');
    // Portable basename only. No internal metadata paths, device names or ADS.
    if (typeof relPath !== 'string' || Buffer.byteLength(relPath) > 200 ||
        !/^[^\x00-\x1f\x7f/\\:*?"<>|. ][^\x00-\x1f\x7f/\\:*?"<>|]*\.(?:md|html)$/i.test(relPath) ||
        /[. ]\.(?:md|html)$/i.test(relPath) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(relPath))
      throw new HostError('BAD_PATH', '请输入项目根目录中的报告文件名（.html 或 .md）。');
    const project = await this.host.requireProject(projectId);
    // Production uses the registered runtime capability. Small injected live
    // adapters retain their controller source; errors never trigger fallback.
    const report = typeof this.managedAgents.reportSource === 'function'
      ? await this.managedAgents.reportSource(projectId, objectId)
      : await (async () => {
        const controller = this.managedAgents.controller(projectId);
        if (!controller.store.state.receipts.some(r => r.objectId === objectId))
          throw new HostError('REPORT_MISSING', '当前项目没有这份历史报告，未另存。');
        return managedReportSource({project, runtime:controller.store.root, objectId, controller});
      })();
    const extension = report.report.format === 'html-static' ? '.html' : report.report.format === 'markdown' ? '.md' : null;
    if (!extension || !relPath.toLowerCase().endsWith(extension))
      throw new HostError('BAD_PATH', `这份报告只能另存为 ${extension || '受支持格式'} 文件。`);
    const readReport = () => report.read();
    const check = async () => {
      const current = await this.host.requireProject(projectId);
      if (current.root !== project.root) throw new HostError('PROJECT_ROOT_MISSING', '项目目录已变化，未另存。');
      const draft = await this.host.readDraftRecord(projectId, relPath);
      if (draft) throw new HostError('UNSAVED', '此名称有保留的编辑副本，请使用其他名称。');
      const target = await this.host.resolveFile(current, relPath);
      if (!target.missing) throw new HostError('CONFLICT', '此名称已存在，请使用其他名称；原文件未覆盖。');
      return target;
    };
    await check();
    // Freeze the verified original before staging a new copy.
    const bytes = await readReport();
    return (async () => {
      let release;
      try {
        if (typeof this.beforeOperation !== 'function') throw new HostError('NOT_READY', '编辑保护尚未接通，未另存。');
        // The renderer may flush through the same file lock. Synchronize first.
        release = await this.beforeOperation({projectId, relPath, hold:true});
        return await this.host.fileLock(projectId, relPath)(async () => {
          const target = await check();
          await this.host.replaceFile(target.abs, bytes, {createOnly:true, beforeCommit:async () => {
            await check();
            await readReport();
          }});
          return {projectId, objectId, relPath, byteLength:bytes.length,
            digest:createHash('sha256').update(bytes).digest('hex'), copied:true};
        });
      } catch (error) {
        if (error.code === 'EEXIST') throw new HostError('CONFLICT', '此名称被其他操作占用，请使用其他名称；原文件未覆盖。');
        throw error;
      } finally { await release?.(); }
    })();
  }
}
