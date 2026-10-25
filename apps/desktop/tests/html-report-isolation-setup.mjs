// Isolated real-worker HTML/report acceptance inputs. No credentials or old runtime copied.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {DesktopHost} from '../src/main/host.mjs';
import {git} from './desktop-frozen-workflow.fixture.mjs';
const base=path.join(os.homedir(),'.cache','nozeli-smokes');await fs.mkdir(base,{recursive:true});
const root=await fs.mkdtemp(path.join(base,'nozeli-html-report-live-'));
const project=path.join(root,'offline-checklist'),profile=path.join('/home/bfly/.Nozeli/acceptance-profiles',path.basename(root));
await fs.mkdir(path.join(project,'materials'),{recursive:true});await fs.mkdir(profile,{recursive:true});
const facts='# 离线检查清单素材\n\n页面必须呈现且只呈现以下三项：核对材料来源、检查版本差异、确认验证范围。初始均未勾选，完成数为0；用户勾选任意项后显示真实勾选数量/3。数据由site/data.json读取；HTML、CSS、浏览器ES module均为本地文件，不请求外网或启动服务。没有性能测量数据，报告不得编造性能指标。\n';
await fs.writeFile(path.join(project,'materials/source-facts.md'),facts);
await fs.writeFile(path.join(project,'README.md'),'# HTML报告与离线网页真实验收\n这是隔离合成项目，不含用户论文。交付只允许site/；素材只读。图示通过宿主图形工具生成并直接嵌入正式报告HTML，不落独立图示文件。正式报告通过受管发布存储，不在项目复制报告正文。\n');
await git(project,['init','--initial-branch=main']);await git(project,['add','.']);await git(project,['commit','-m','Freeze synthetic offline checklist inputs']);
const host=new DesktopHost(profile),entry=await host.registerDirectory(project);
const immutableInputs={};for(const rel of ['materials/source-facts.md','README.md'])immutableInputs[rel]=createHash('sha256').update(await fs.readFile(path.join(project,rel))).digest('hex');
const setup={root,project,profile,projectId:entry.id,immutableInputs,scope:'New synthetic project/profile; no settings, secrets, old jobs or native threads copied. Real model execution requires zero-model security gates first.',task:'制作一个可离线使用的三项检查清单网页，具体素材读materials/source-facts.md。只创建site/index.html、site/styles.css、site/app.js、site/data.json，不改素材或README，不安装依赖、不联网、不启动dev server，不创建独立图示文件。用浏览器ES module从本地JSON加载三项，初始0/3，勾选后统计正确；页面清晰可读并支持浅深和窄屏。用Nozeli提供的Archify图形工具生成一张有意义的页面、事件处理、统计呈现关系图并直接嵌入正式报告。按Worker报告技能发布正式HTML图文报告，结论先行、验证与未测明确，不编造运行或性能数据；所有实际新增/改动项目文件列入发布清单，不自动采用或结束Work。'};
await fs.writeFile(path.join(root,'setup.json'),JSON.stringify(setup,null,2));console.log(JSON.stringify(setup));
