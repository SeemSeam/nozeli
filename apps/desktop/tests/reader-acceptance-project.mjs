// Self-owned, cross-project reader acceptance corpus. No internal Nozeli state,
// credentials, user papers, model answers or pre-seeded annotations are written.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const quote='The cache expires after 60 seconds.';
const write=(file,value)=>fs.writeFile(file,value,{flag:'wx'});
function paper(marker,ttl){
  const sections=Array.from({length:36},(_,i)=>{
    const n=String(i+1).padStart(2,'0');
    return `## ${i+1}. 可复核段落 ANCHOR_${n}\n\n${marker}：这是合成论文的第${i+1}节。观察身份、版本和选区来源必须由应用保留，而不是让模型补写。缓存命中率与端到端延迟是不同指标；样本量相同也不意味着分布相同。这里同时包含中文、English、emoji 😀 和组合字符 é，用于检查选区、复制和重定位是否破坏字符边界。\n\n本节明确限制：不得将本项目的数字套用到另一个同名项目，不得根据对话框打开或标签折叠推断任务完成。引用时指出文件与章节；不确定的信息应说明缺失。\n\n`;
  }).join('');
  return `# ${marker}：缓存与尾延迟的合成研究\n\n> 只用于 Nozeli 验收，不是真实论文或真实实验。\n\n## 研究背景\n\n第一处 FIRST_OCCURRENCE：${quote} 这里讨论的是浏览器本地缓存，不是服务器连接超时。\n\n第二处 SECOND_OCCURRENCE：${quote} 这里讨论的是实验配置中的服务端缓存；连接超时为30秒。当前项目默认 TTL 为${ttl}秒。两处相同引文的来源、位置和讨论必须保持独立。\n\n## 可核对的事实\n\n项目标记是 **${marker}**。数值证据位于 \`data/measurements.json\`，参考文献位于 \`refs.bib\`。表格中的 p50 和 p95 不能相互替代。\n\n行内公式 $H=h/n$；显示公式：\n\n$$\n\\Delta H = H_B-H_A\n$$\n\n\`\`\`python\nfrom fractions import Fraction\nhit_rate = Fraction(58, 100)\nassert hit_rate == Fraction(29, 50)\n\`\`\`\n\n| 条件 | 命中数 | 请求数 | p50 / ms | p95 / ms |\n|---|---:|---:|---:|---:|\n| A | 42 | 100 | 84 | 310 |\n| B | 58 | 100 | 96 | 128 |\n\nB 的命中率高16个百分点，p95降低182ms，但p50增加12ms；不能因此宣称所有延迟都降低。\n\n${sections}## 原始问题与边界\n\n保留原引文，不随新版本悄悄替换。保存批注本身不启动模型。只有用户显式发送，才把所见材料固定到对应会话。\n`;
}
function pdfFixture(marker){
  const stream=`BT /F1 15 Tf 36 740 Td (${marker} - owned PDF selection fixture) Tj 0 -28 Td (FIRST: ${quote}) Tj 0 -28 Td (SECOND: ${quote}) Tj 0 -28 Td (Timeout is 30 seconds. Data is synthetic.) Tj ET`;
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let text='%PDF-1.4\n',offsets=[0];
  for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(text));text+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
  const xref=Buffer.byteLength(text);text+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return text;
}
export async function createReaderAcceptanceProject(root){
  if(!path.isAbsolute(root))throw Error('An absolute owned acceptance root is required');
  await fs.mkdir(root,{recursive:true});
  const projectA=path.join(root,'project-a'),projectB=path.join(root,'project-b');
  await fs.mkdir(projectA);await fs.mkdir(projectB);
  const files={paper:'paper.md',pdf:'paper.pdf',quote,secondQuotePrefix:'SECOND_OCCURRENCE',markerA:'READER_ALPHA',markerB:'READER_BETA',measurements:'data/measurements.json',references:'refs.bib'};
  for(const [dir,marker,ttl] of [[projectA,files.markerA,60],[projectB,files.markerB,600]]){
    await fs.mkdir(path.join(dir,'data'));await fs.mkdir(path.join(dir,'notes'));
    await write(path.join(dir,'paper.md'),paper(marker,ttl));
    await write(path.join(dir,'paper.pdf'),pdfFixture(marker));
    await write(path.join(dir,'paper.tex'),'\\documentclass{article}\n\\usepackage{fontspec}\n\\setmainfont{Noto Serif CJK SC}\n\\begin{document}\n'+marker+'：真实工具链编译用的合成研究。$H=h/n$。\n\\section{Evidence}Median and tail latency must be compared independently.\n\\end{document}\n');
    await write(path.join(dir,'data','measurements.json'),JSON.stringify({marker,cacheTtlSeconds:ttl,connectionTimeoutSeconds:30,conditions:[{id:'A',hits:42,requests:100,p50Ms:84,p95Ms:310},{id:'B',hits:58,requests:100,p50Ms:96,p95Ms:128}],limitations:['synthetic data','no causal generalization','same filename does not mean same project']},null,2)+'\n');
    await write(path.join(dir,'refs.bib'),Array.from({length:24},(_,i)=>`@article{synthetic${String(i+1).padStart(2,'0')},\n  title={Synthetic ${marker} evidence ${i+1}},\n  author={Owned Acceptance},\n  year={2026},\n  note={Fixture only; not a published paper}\n}\n`).join('\n'));
    await write(path.join(dir,'notes','questions.md'),'# 本地问题草稿\n\n这里的内容默认不发送给任何模型。\n');
    await write(path.join(dir,'README.md'),`# ${marker} 合成阅读工程\n\n同名文件隔离标记：${marker}；本项目 TTL=${ttl} 秒，连接超时=30 秒。\n\n- paper.md：36节、重复引文、公式、代码和比较表。\n- paper.pdf：程序生成的真实PDF阅读夹具，不冒称TeX编译产物。\n- paper.tex：独立真实编译输入。\n- data/measurements.json：数值真值。\n- refs.bib：24条明确标注为合成的参考文献。\n\n标签必须通过真实应用创建；本工程不预写内部状态、不包含账号或真实用户论文。\n`);
  }
  const questions={
    explain:'只解释当前所选第二处缓存引文：它讨论的对象是什么？与30秒连接超时是什么关系？明确指出这是第二处而非第一处；不得把另一个项目的TTL带进来。不修改文件、不转后台。',
    readable:'基于当前项目paper.md、data/measurements.json和refs.bib的实际内容，写一份结构清晰的中文分析：使用三级标题、对比表、行内公式与显示公式、一段可运行Python示例，区分命中率、p50、p95以及不能推出的结论。明确计算命中率百分点变化和两种延迟的绝对差，引用实际文件和章节，不编造参考文献。请充分说明而不是只给结论；不修改文件、不调用其他Agent、不使用网络。',
    followup:'沿用本标签的原始第二处引文和上轮上下文，解释为什么p95改善不能写成“所有请求都更快”；保留原引用身份，指出命中率变化是百分点还是相对百分比。当前文件若有新前缀，不要因此改写旧引文。不修改文件。'
  };
  const cases=[
    {level:'L0',name:'本地标签密度与零派工',question:'在ANCHOR_01至ANCHOR_12各保存一条本地备注，折叠其中部分，保留一条未提交编辑。',observe:['12个不同标签身份','保存0模型请求/0业务job','无视口溢出','折叠与草稿跨项目切换保留']},
    {level:'L1',name:'重复引文精确归属',question:questions.explain,observe:['真实选择第二处','冻结原文件版本/位置','单个发送准入','真实回答引用正确对象']},
    {level:'L2',name:'可读长回答',question:questions.readable,observe:['表格数值42/58/84/96/310/128准确','16个百分点/-182ms/+12ms','公式与代码真实渲染','每任务一个气泡','工具原文折叠可读','用户向上阅读不被抢滚动']},
    {level:'L3',name:'跨文件和新旧版本讨论',question:questions.followup,observe:['原标签不静默改绑','重复引文与手动重定位正确','同名项目隔离','旧历史保持原文','主草稿和标签草稿独立']},
    {level:'L4',name:'隔离工作流与任务排队',question:'明确新建两个独立后台工作：一个核对缓存数值与结论，另一个核对24条参考文献的一致性。各自在独立工作目录产生Markdown报告，不修改不相关源文件，完成后等待用户采用或丢弃。',observe:['真实Work身份与工作树隔离','并发/排队额度准确','同线程续改','GUI与原生终端输入唯一job','冻结Diff可读','采用/丢弃不覆盖原有暂存和未保存编辑']},
    {level:'L5',name:'有实际时间证据的长任务',question:'在既定任务范围运行至少180秒的真实顺序计算/分段验证，保留带实际时间戳的阶段结果，不能伪造时间或后台脱离后提前报告。',observe:['实际CLI仍连接','周期文件证据与墙钟一致','界面可阅读/切换/编辑草稿','结果最终持久化且只显示一轮回复']},
    {level:'L6',name:'显式恢复与不重放',question:'测试人员在自有长任务中注入原生进程退出、渲染崩溃和应用崩溃。恢复后先核查真实文件与原线程，再明确发新补充；不得自动重放原执行。',observe:['原输入/会话/Work继承','已持久化草稿恢复','原生owner有退出证明','HTTP/job零自动重放','不伪称仅存内存输入可恢复','原文件/暂存区/回退成果保持']}
  ];
  await write(path.join(root,'test-cases.json'),JSON.stringify({files,questions,cases},null,2)+'\n');
  await write(path.join(root,'test-plan.md'),'# Nozeli复杂阅读与协作验收工程\n\n'+cases.map(c=>`## ${c.level} ${c.name}\n\n${c.question}\n\n验收观察：\n${c.observe.map(v=>'- '+v).join('\n')}\n`).join('\n')+'\n所有内容均为自有合成材料。脚本测试不冒称真实模型；真实模型请求必须由独立准入账记录。产品缺陷、测试工程问题、能力边界和上游/环境故障分别记录，不能用隐藏错误或放宽断言换取通过。\n');
  return {projectA,projectB,files,questions,cases};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await createReaderAcceptanceProject(path.resolve(process.argv[2])),null,2));
