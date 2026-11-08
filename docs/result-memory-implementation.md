# 稳定结果记忆：首版接入与验证

Date: 2026-11-07
Status: 源码基线`fe24f1c`后追加原文交付及版本语义澄清修复，当前安装`2026-11-08T01-38-35-481Z`；真实项目/模型/Worker续接与安装版实际工具语义复测通过，详见末节。追加修复未提交/推送，不迁移日常项目；历史“未安装／未提交”保留为当时取证状态。整体方向见[Plantree主合同](plantree-result-memory-design.md)。

## 已接入的最小闭环

- 复用现有任务账本、冻结报告对象和Plantree归档链接，不建立第二份报告正文或另一套任务状态。
- `ended`且`closure.phase === 'complete'`并明确`accept`的结果默认可查；`includeHistory:true`另含完整关闭的丢弃/取消最终报告。不是所有中间发布、未采用候选或最新消息的全文历史搜索。
- 报告按closure归档digest关联原receipt，来源使用`{projectId,workId,objectId,digest}`，不以标题/名称或“最新”替代。宿主终止记录没有receipt时不会伪造Worker报告，覆盖诊断明确缺少可读报告来源。
- Frontdesk/Orchestrator按需使用`nozeli_memory_search`，再用`nozeli_memory_read`按`nextOffset`读取精确版本；无默认预加载、无强制每任务检索。
- Orchestrator每次派发/补充可选择至多4个`memorySources`；宿主校验、在原串行mutation内复核并持久绑定。Worker可读取本Work各次输入已绑定的确切来源；当前导航列表清空/替换不是撤销早期依据，其他Work未绑定来源仍拒绝。
- Worker初始交接和压缩后投影提供当前身份及`memorySourceManifest.readRef`；用`nozeli_history_read`按需读取完整输入绑定目录。目录身份带内容版本，同回合旧票据继续原快照，跨回合目录变化拒绝旧偏移并要求重读新目录。不将回合临时readRef用作跨Agent协议，不重写用户原始任务，不将历史正文当授权。
- 搜索结果返回摘要片段、报告结局、来源、作者主张边界和独立的实际采用effect；报告候选内容与人工审校后实际采用版本不混为同一件事。

## 用户如何使用

现有任务经用户采用并完成收尾后，无需再点击“记住”。在当前项目提出“参考上次的某方案/核验报告继续做……”，Orchestrator可以搜索、读取并将选中版本交给新任务；普通独立操作不额外检索。Frontdesk可查询相关结果解释结论和限制。原任务详情及报告继续使用现有阅读/审核入口，没有新增记忆管理中心。

新报告按正常人类阅读顺序写结论、关键依据、实际验证、限制和产物；不要求填写数据库JSON。首版搜索这些可读内容及正文，不宣称程序已经可靠解析任意报告为通用知识。旧报告无需模型批量重写：有可读对象即可参与符合收尾条件的结果检索。

## 技术边界

`apps/desktop/src/agents/managed/result-memory.mjs`是可重建词法检索视图。采用中文双字、Unicode规范化、代码/路径词项，非向量语义理解；默认当前项目。根Plantree及主题Markdown原有读取入口保持独立，不以结果搜索替代全部项目资料。首版不新增树自动分类、完整版本化目录、语义合并、自动归档或GC政策。

搜索有界缓存是派生内存，重启可从规范报告重建；返回`coverage`、`corpusVersion`、`indexedThrough`和`verification:'verified-at-index-build'`。索引快照不代表CAS持续健康；确切读取和派发前resolve重新验证对象字节。缺失/损坏来源明确降低coverage，不能把不完整结果解释为没有历史。cursor绑定语料、query和history过滤，变化要求重新查询。

内存缓存预算不等于项目总内存预算；未缓存语料仍须扫描以维持完整覆盖，超过缓存时查询可能变慢。无新持久FTS表或后台模型队列；需生产规模证据后再决定是否增加持久派生索引。报告大对象遵循原有对象限额，单页整个JSON响应受字节预算控制；宿主上下文额度与续页元数据同计。

## 验证入口

开发者在`apps/desktop`运行，均只使用隔离合成项目：

```text
node --test tests/result-memory.test.mjs tests/managed-result-memory-integration.test.mjs tests/managed-result-memory-binding.test.mjs
node tests/result-memory-live.mjs
npm run build:renderer
```

Pi bridge源码变更后先在`integrations/pi`执行`npm run build`更新受校验runtime manifest，再运行：

```text
node tests/desktop-result-memory-live.mjs
```

桌面脚本需实际图形环境及已准备的私有Pi依赖；启动真实Electron、原生Pi owner及loopback确定性模型，不读取个人账号、不调用付费模型。其通过只证明工具/文件/报告/关闭/重启的工程链路，不是实际LLM召回与选择质量评测。

## 实测记录

### 定向回归与故障恢复

13个测试文件108/108通过，覆盖新检索、dispatch/continue原任务不变、Worker绑定访问、完整JSON预算、Unicode、分页/语料变化、缺损来源、已有角色/上下文/任务板/结果与发布回滚。完整TAP：本次工具原件`artifact://16423`。测试注册常规unit/integration，非全仓全部测试通过声明。

独立Reviewer发现并要求修正两处实际缺陷：未等待Workspace mutation提交就可能把暂态complete作为稳定结果；同正文多次发布具有不同objectId却被误判corrupt。已加入串行提交屏障与并发队列变更拒绝；新归档保存objectId/publicationRevision，旧归档按原archiveReport规则选择后再校验digest。对应回归通过。

实际子进程读完整语料后SIGKILL，再以原SQLite/对象与stale-owner恢复重开；报告确切来源仍可分页读取，无重派Worker。跨项目身份与已移除项目读取拒绝，managed state无修改。原件：`/tmp/nozeli-result-memory-live-CHRmid/report.json`（8MiB）与`/tmp/nozeli-result-memory-live-S7Rf7E/report.json`（生产默认2MiB），均ok=true。

### 性能与优化

Linux Node22.22.1共享工作站、真实SQLite及不可变对象；每份合成报告约二十段中英代码/Unicode文本，非百万级文档或8MiB大报告负载。30次交替查询取中位/P95，冷查询包含首次读盘和编目。完整报告全分页均可达，不以top-k成功冒充完整召回。

|缓存预算/阶段|报告数|冷查询ms|交替查询中位ms|P95 ms|
|---|---:|---:|---:|---:|
|优化前8MiB|1000|859.96|760.77|933.50|
|优化后8MiB|1000|836.61|27.05|36.58|
|优化后默认2MiB|100|124.97|4.96|6.70|
|优化后默认2MiB|1000|976.22|28.90|41.06|

初稿仅缓存单查询结果，不同query会重读全部报告；优化为共享预算的语义正文派生缓存与查询投影，不另建规范正文。默认2MiB千报告缓存计费1,634,490bytes、1000来源均缓存、无空间保留查询投影；仍无需每次重读CAS。该轮进程RSS约379MB（包含Node/SQLite/夹具/全部业务状态，不是记忆缓存占用），event-loop P99约51.9ms；不是无卡顿或固定响应时间承诺。超预算语料仍完整扫描未缓存项，冷查询约1秒，持久FTS和更大规模尚未验证。

优化前原件`/tmp/nozeli-result-memory-live-iAzkC1/report.json`；中间失败原件`/tmp/nozeli-result-memory-live-TG6ays/report.json`保留：其冷恢复错误是假设`code_identifier_42`只会匹配一项，实际词法前缀还匹配420等；验收修为完整分页查找，没有修改生产检索掩盖失败。

### 真实桌面与平台边界

真实Electron/Pi闭环最终记录在本节后续条目。初次验收遇到X11认证被环境清理误删、Pi桥修改后runtime manifest需重建、项目切换未等待scope及脚本对JSON转义层做正则的夹具问题，失败原件保留；不计为通过，也不修改产品准入绕过。

Windows/macOS、真实付费模型的自主选择与提炼质量、超缓存大型报告语料、永久清除/备份完整矩阵未在本轮新增验收。没有新持久索引/队列，当前只读派生缓存随原项目进程生命周期释放；不据此宣称全部记忆设计或跨平台完成。

最终真实桌面闭环通过：`/tmp/nozeli-memory-desktop-2LvBWt/report.json`，ok=true、errors=[]。任务A通过真实报告“采用并结束”控件完整收尾；关闭exit0并冷开，零旧模型请求重放；新任务B的原生Orchestrator实际调用memory_search→memory_read→dispatch(memorySources)，原生Worker从交接消息取得同一确切身份并调用memory_read→publish。验证了新任务持久来源及原始用户请求，最后正常exit0。确定性模型仅决定调用序列，文件/SQLite/报告/原生工具/生命周期不是浏览器模拟。

已检查该轮截图：新任务待审与原报告历史入口存在；shell截图未合成原生隔离报告guest，正文区域空白，因此**不作为报告正文视觉验收**，也不声称修复已有成果页视觉问题。本次新增功能是后端工具/来源交接，没有新增UI表面。

独立Reviewer最终复审确认上述P1/P2关闭，检查包括缓存返回串行屏障、mutation内同步assertSource不自等待、确切发布选择及legacy规则；本次复审范围内无剩余阻断项。仓库文档链接/元数据校验0失败，既有六项第三方再分发审计pending继续保留，不作公开发布资格。renderer与Pi runtime构建通过。

## 复杂多task交错与记忆深测（2026-11-07）

范围：隔离合成项目；既有多任务/输入/结局/任务板/记忆相关97项回归通过（本次工具原件`artifact://16435`）。新增六消费者task＋三份相互冲突/丢弃历史结果、额度2、忙时和排队补充、确切来源替换/清空、重复提交、原线程、冷恢复及最终资源释放。确定性Session驱动真实Controller/SQLite/报告/宿主收尾，不声称这些测试包含真实模型推理。

### 本轮发现并修复

- 四路相同来源冷查询重复安装语义缓存，投影并发替换又累加旧投影费用；实际保留78,838bytes却记账315,352bytes，超缓存场景实际540,133bytes却记账2,083,873bytes。修为await后再次检查语义key，投影安装先扣除正在替换的投影；新增确定性并发回归。
- 后一次queued补充覆盖当前memorySources，导致早期输入已绑定依据在激活后被MEMORY_SOURCE_FORBIDDEN拒绝。当前列表改为导航选择，Worker读取资格按同Work各次输入绑定保留；完整目录按需分页，其他Work未绑定来源仍拒绝。每次输入最多4项，不将累计全部来源塞入每轮投影。
- 独立Reviewer发现目录复用无版本稳定ref会将旧offset应用于新JSON；改为目录内容摘要身份。同回合已登记旧快照继续读原内容；新回合旧版本不再可用则明确READ_REF_EXPIRED，从新投影入口重读，不能静默跳过来源。

并发修前证据：`/tmp/nozeli-result-memory-concurrency-zndHAi/report.json`；修后完整通过：`/tmp/nozeli-result-memory-concurrency-DqgwK4/report.json`及`cold-report.json`。200份报告正文总计5,084,280bytes（接受180份、丢弃20份），超过默认2MiB缓存；15轮124项混合search/read/resolve/真实元数据提交，124项最终成功、0失败、229次尝试，其中105次快照冲突显式重试。缓存真实保留与计费一致，完整分页200身份无遗漏，精确分页digest/跨项目拒绝和独立冷进程状态及来源绑定核验通过。

|该轮混合操作指标|实测值|
|---|---:|
|中位耗时|107.33ms|
|P95耗时|518.18ms|
|事件循环P99|21.91ms|
|事件循环最大延迟|36.54ms|
|父进程峰值RSS|609,955,840bytes|

这些指标含SQLite夹具和同时运行的压力操作，不是单次查询SLA；超缓存需要扫描未缓存正文，内存预算仅限制派生缓存而非整个进程。快照拒绝不是结果丢失，但105次重试表明并发活跃时有明显读竞争；不能承诺每次首次请求即成功。只读或带持久幂等回执的选择可纠正重试，不据此重放文件/命令效果。

冷状态初期失败源于夹具用raw JSON比较，实际重建增加collectionOrder、空portableMessages与drafts默认值。逐字段诊断保留`/tmp/nozeli-cold-diagnostic-YPb6k9/{before,after}.json`；只规范化派生索引/键顺序并初始化空drafts，业务数组顺序、报告和来源绑定仍逐项核验，未修改生产存储来迎合夹具。

原生Electron/Pi四task场景已通过：`/tmp/nozeli-memory-multitask-aD2wKg/report.json`，两次正常冷重启、额度2，B/C各自Worker待审，D排队无线程，D补充去重且不启动模型；用户真实报告放弃B后原D激活并读取原绑定报告，C线程不变。使用loopback确定性模型，不加载账号、不验证真实LLM选择质量；最后均正常关闭。已查看工作面截图确认C/D待审与队列切换，shell不合成隔离guest正文，仍不作报告正文视觉验收。

版本化目录改动后真实Electron/Pi四task完整复测仍通过：`/tmp/nozeli-memory-multitask-hLvqB8/report.json`，ok=true、errors=[]，完整冷恢复和排队激活场景正常退出。独立Reviewer复审确认目录跨版偏移问题关闭，无新增可行动缺陷。最终8文件49/49联合回归通过（本次TAP原件`artifact://16463`），包含六消费者task真实Controller完整收尾，以及65+输入绑定清单、同回合旧快照续读、新回合旧目录/偏移拒绝、新目录发现旧证据、跨Work拒绝与并发缓存两项回归；不与前述97项重叠集简单相加。未安装、提交或推送；Windows/macOS、真实模型对多报告冲突的自主判断、长期无界任务量未验。

## 用户授权本机安装（2026-11-07）

- 使用真实用户HOME运行既有`tools/install-local.mjs`，从当前工作区构建renderer、复制源码/依赖并打包校验独立Pi与Git后激活`/home/bfly/.local/opt/nozeli/releases/2026-11-07T14-36-16-795Z`；不是将工作区描述为干净commit的公开发行包。426个源码文件与安装副本逐字节一致，记忆引擎及版本目录实际存在。
- current指向新版本，previous保留`retired-storage-isolation-20261107`。安装器按既有保留策略移除更早的`project-attention-badges-r2-20261107`，不删除当前/previous或用户资料；桌面入口和`~/.local/bin/nozeli`已更新。
- 实际安装ELF及安装内DesktopHost、私有Pi在隔离profile/项目运行四task冒烟：采用收尾→冷开→主控memory_search/read→绑定新任务→Worker确切读取；额度2、第四项排队、补充去重、第二次冷开无重放、放弃占位工作后原排队Worker激活，正常exit0。原件`/tmp/nozeli-memory-multitask-tGA6fQ/report.json`，ok=true、errors=[]；本地确定性模型，无账号/付费调用。
- 未强关/操作日常窗口或项目；旧进程不会热更新，用户正常退出全部旧窗口后从桌面入口重开才加载新版。未追加提交/推送/公开发布，不外推Windows/macOS或真实模型自主检索质量。一次性安装验证脚本已删除。

## 真实登记项目语料验收（2026-11-07）

用户要求基于真实打开项目系统测试。实际进程为已安装`2026-11-07T14-36-16-795Z`；X11原生窗口标题为“选择项目”，两个旧DevToolsActivePort端口均拒绝连接，实际Nozeli监听端口是受grant保护的document服务而非CDP。未提取grant/凭据、未注入调试器、未强制重启日常进程。因此下面区分真实项目只读测试与真实语料隔离原生回放，**不声称已操作日常前台会话或验证真实模型自主判断**。

1. 真实登记项目均以SQLite readOnly事务读取，未创建第二个Workspace owner或写入原库。三个有效项目中仅一个有3个完整结束Work和4次报告发布；两份网页结果accept、一份PPT结果discard，另外两个项目无任务结果。
2. 使用安装内ResultMemory与reportSemanticText处理实际冻结对象，store适配层为只读快照，online方法不代表实测live owner准入。默认稳定集合正确为2，显式历史为3，missing/corrupt均0；按closure定位最终publication，没有拿4次发布全部当稳定结果。
3. 三份最终报告以整个JSON每页1400bytes上限共8页读取，拼接语义正文与冻结原件逐字一致；精确digest及跨项目伪造引用拒绝。被观察项目SQLite/现存WAL读取前后SHA一致。证据仅本地保留`/tmp/nozeli-real-memory-audit-mu8ujn/report.json`，不将用户正文/账号写入仓库。
4. 实际小语料首次查询17.64ms；8类查询各10次，热查询中位约0.06—0.12ms，最慢样本约0.54ms。该数字不含live宿主online、IPC或模型延迟，不外推大规模。双星/混沌各命中对应网页与历史PPT；PPT只在历史命中丢弃结果，HTML命中3份，随机不存在词0。
5. 否定边界真实可见：查询“未验证”因中文双字中的“验证”命中3份，PPT仅含肯定校验措辞；搜索不能被解释为三个结果都未验证。两份网页原报告明确语法/数值检查与未做浏览器视觉核验的区别；回答仍须读上下文，不以词项分数推断否定语义。
6. 将原报告字节和原closure/receipt复制到新隔离测试项目（新项目身份，无账号、无用户文档复制），实际安装ELF＋私有Pi＋loopback确定性模型完成3个新消费者task。默认检索断言仅accept；主控读取实际双星最终报告并绑定来源，Worker读取同一来源；额度2下第三消费者排队、补充去重、两次冷开无回放，放弃隔离消费者后原排队task激活。原件`/tmp/nozeli-real-corpus-native-YEY7J1/report.json`，ok=true、errors=[]，正常exit0。仅是实际语料工程链路，不把模型脚本的后续结论当真实用户报告结论，不在原项目新增/采用/丢弃任何task。

待验：用户日常窗口实际打开项目后的端到端自主模型查询/选源、当前未保存材料与新task联动、真实多意图/否定的回答质量。当前缺少可连接的日常进程调试/受控自动化入口，不以另起一个独占原项目的宿主绕过owner保护。临时驱动已清理，证据留本机；未改产品代码、未安装、提交或推送。

## 安装版真实项目与真实模型端到端验收（2026-11-08）

**本轮不是语料复制/隔离模型回放。整体结果：部分通过，真实补充输入交付失败；不能签收为全部通过。** 用户要求安装后对真实项目直接测试。经窗口管理器正常关闭请求，原日常进程退出；以同一安装ELF、`HOME=/home/bfly`原用户配置及`nozeli_test2`重开临时本机CDP入口，真实shell scope确认项目`c37e7aa3-0bcd-42c9-ac08-268fecd5b995`。未绕过owner、未注入进程、未清锁或强制结束。测试后再次正常退出并恢复无调试端口普通启动，日常项目保持打开。

### 已通过：前台检索与新task来源交接

- 使用用户当前配置的真实模型，前台`bingxing/GLM-5.3-Flash`、主控`paratera/gpt-6.1-sol`、Worker`bingxing/GLM-5.3`；没有脚本模型、复制语料或更换账号/模型。测试请求带`REAL-MEMORY-QA-20261108`标识，正文/设置/草稿/任务决定均禁止改动。
- 前台实际调用4次memory_search：默认双星1、混沌1、PPT0，显式历史PPT1；实际读取三份报告，正确说明网页accepted/merged、PPTdiscard，区分原报告验证与未做浏览器视觉验收。不是只听模型说“已经查过”，原生toolResult逐项核实。
- 主控实际search/read两份网页、dispatch带两份确切`memorySources`，未绑定丢弃PPT。真实新Work`098db1b9-40e4-4794-9a6b-f6f7a204e383`，名称“记忆实测：网页验证边界”；Worker实际两次memory_read后publish HTML result、`files:[]`，报告同时引用objectId/digest，并明确本轮未重跑原测试。
- 首版报告`895c53e5-a76c-45ee-bf7a-a4e3e0738d54`保留。首次Worker根据投影直接读取来源，未额外读取manifest，不把这一步宣传为已验证目录发现。

### 未通过：真实主控空说明触发补充原文丢交付

- 第二请求明确续接原测试Work，要求`memorySources:[]`只清空导航，Worker经版本目录找回早期依据并发布新报告。主控实际manage参数为`{action:'continue',expectedRevision:1,memorySources:[],text:'',workId:<原Work>}`。
- 宿主持久保存了完整413字符用户原文到`work.inputs[].text`，绑定历史2条、原线程`01a1b88c-a767-759f-bde1-e22e10411f72`保持；但`manageIntake()`仅以`a.text`构造supplement job，`runJob()`对这种job沿job.text交付。实际native user正文只有“补充输入（保持原Work；原任务不逐轮复述，经宿主投影与nozeli_history_read读取）：\n”，没有当前用户补充。
- Worker实际history_read版本目录成功，得到current=[]及两份旧来源；又读取了原始任务。但当前投影只暴露原始任务/批准来源，不能据此定位本次补充原文。Worker判断没有新要求，结束而不发布新版结果；宿主生成缺少最终报告诊断`465952c4-5202-4858-8d57-4494aee8a64b`，原Work revision2进入paused，未伪装成功。
- 这不是记忆对象丢失或错误来源准入，而是任务输入交接合同缺陷：模型的可空路由说明不应成为用户原文的替代。建议后续修复从持久source job/当前输入绑定交付原文一次，路由说明仅补充；覆盖空/省略/非空text、忙/排队/冷恢复与预算/分页，不能只要求模型改填text或绕过最终发布门。本轮仅测试/诊断，没有改产品或静默补装。

### 文件、会话与测试现场

- 三个原有Work完整业务记录逐项不变，项目3个正文文件SHA逐项不变，用户草稿不变。仅新增上述1个测试Work、前台问答及其1次补充/报告/诊断；没有新增第二Work，没有接受或丢弃任何真实/测试结果。
- 测试完成后正常重启普通安装版，日志`debugPort=none`；readOnly持久核对测试Work仍paused/revision2，两条输入绑定及原Worker线程保留，没有自动重放、自动采用/恢复。
- 完整本机证据`/tmp/nozeli-installed-real-project-t_sq0vki/report.json`，overall=`PARTIAL_FAIL_REAL_CONTINUATION_INPUT_DELIVERY`；截图及正文文件基线同目录。原生会话工具回执留原项目原会话，不复制账号/思考过程到仓库。未新增付费模型性能基准、未验证所有自然语言问题、其他平台或未保存文档联动。用户可在真实项目看到该测试Work的首版报告及暂停诊断；应保留待修，不宣称新任务续接整体可用。

## 真实续接原文交付修复与同线程复测（2026-11-08）

- 修复`manageIntake`：从当前持久来源`intakeSource(job).request`交付完整用户补充，复用`workerInputText`将非空且不同的主控说明附后。`continue.text`可省略，归一为空说明；不改变其他动作的正文校验、任务CAS、范围、幂等或最终发布门，不重放历史输入。
- 新增`managed-supplement-source-delivery.test.mjs`并注册integration。空/空白/省略说明和不同说明均核对native prompt中当前原文逐字一次；排队初始交接、同线程、重复路由、冷开未准入回合interrupted保留且不自动重放通过。联合现有task-flow、context-cutover（含100轮原文）、多task记忆、来源交接最终43/43通过，TAP`artifact://16564`；早期测试期待冷开job仍queued失配，按既有不重放合同修正测试，不改生产恢复门。
- 既有安装器构建校验并激活`2026-11-08T00-46-26-197Z`，previous保留`2026-11-07T14-36-16-795Z`。controller/followup技能与安装副本逐字节一致；按当前工作区安装，非干净commit公开发行。本轮未提交/推送。
- 原`nozeli_test2`同Work`098db1b9-40e4-4794-9a6b-f6f7a204e383`、同Worker线程`01a1b88c-a767-759f-bde1-e22e10411f72`，真实主控仍提交`continue text:''、memorySources:[]、expectedRevision:2`。原生user输入包含完整当前用户原文和标记`ORIGINAL-SUPPLEMENT-DELIVERED-91827`，不是脚本模型、语料复制或改填说明绕过反例。
- Worker第3轮实际history_read目录/原始范围，memory_read两份旧网页报告，publish新版HTML结果`a0baa80c-55b0-4913-b26d-cec5edf9bee2`、files=[]；报告明确收到标记、当前导航空但早期依据可读、未重跑网页测试。任务回到review；旧第2轮失败诊断保留为历史，不篡改为通过。精确证据`/tmp/nozeli-real-supplement-fixed-99932F/report.json`，ok=true。
- 原有三个任务业务记录、3份项目正文文件SHA和用户草稿不变；只继续同一个测试Work，没有采用/丢弃任何结果。正常关闭验证进程exit0后，以无调试端口普通安装入口重开真实项目；第3轮review持久保留，用户可继续审阅。不强退/清锁、不切模型、不绕过未知效果屏障。
- 此次通过覆盖原始反例及既有回归，不等于全部自然语言/格式/平台通过；Windows/macOS、大输入补充分页、原任务其他独立故障仍按既有边界未验。

## 按当前项目状态调整的真实安装版深测（2026-11-08）

### 前提与实际操作

安装`2026-11-08T00-46-26-197Z`，原`nozeli_test2`及现有真实模型配置，非语料复制、脚本模型或第二Workspace owner。起始额度2，旧测试“记忆实测：网页验证边界”revision3待审占1名额、无busy/queued job、无非空草稿，三个原有已结束Work及3份正文文件记录基线。测试仅正常关闭/重开原用户配置以启用本机观察，未重置项目、改额度或作采用/丢弃决定。

- 新task A“安装深测A：采用版本与验证边界”（`ec30fcad-0b6b-47cd-a0f5-ab160e5ccbd6`）占余下名额。主控实际search/read及inspect原Work，绑定双星最终3D报告和混沌最终报告；Worker真实读取，输出`files:[]`报告`04cab149-077e-43c8-835f-a2c21a516640`。核验作者报告候选措辞与宿主后续accept/merged分层陈述，双星原先publication不冒充最终3D版本，语法/数值与未做视觉验证分开。
- 在旧测试第4轮supplement实际running后再提交第二条输入；主控仍continue原Work，第4轮`01:10:02.817Z—01:10:53.852Z`完成后，第5轮`01:10:54.109Z—01:11:34.763Z`才开始并完成。保持原线程`01a1b88c-a767-759f-bde1-e22e10411f72`；两轮报告分别包含`DEEP-SOURCE-ONE-631`及`DEEP-SOURCE-TWO-742`，files=[]，用户当前原文不丢或串轮。当前来源导航为空，旧输入两份依据仍可经目录读取。
- 新task B“安装深测B：丢弃成果历史”（`407e4237-8966-41ae-80d3-08a3d5e73578`）用显式历史查询绑定原discard PPT，不将之升为采用结果；额度2/2时保持queued/revision0、无thread。对B直接绑定补充`B-QUEUED-INPUT-853`，相同requestKey重复提交返回同一job，inputs仅1项，没有Worker执行。
- 第4/5轮结果对象分别`634178fd-2bde-4b6c-be6b-256ab2a2ae7b`、`69597401-d419-4c3c-a131-ab0e760edac5`；A待审、旧测试待审、B排队，未为了释放名额擅自结束任何成果。

### 冷恢复、可见性与保护

全部已准入模型回合完成后正常close exit0、重开同项目；逐项比较job IDs/status、report IDs、Work状态/revision/thread、inputs、memorySources/memorySourceBindings及drafts，全部一致，无新增job或报告，busy=[]、额度2/2、B无thread且仍queued。

冷开后前台真实调用memory_search空query核对全量：默认2份原已采用网页，history3份含原已丢弃PPT，coverage complete；A、旧测试及B均未进入默认或历史稳定结果集合，不因有待审报告就晋升。实际toolResult核对，不只信模型回答。模型有一处不当解释：称corpusVersion变化证明索引重建；此推断没有依据，版本指纹也受相关task事实变化影响。已记录为回答质量问题，不将该说明当实现证据；核心过滤结果正确。

原三个已结束Work业务记录逐项不变，原3份正文文件SHA和草稿不变；本轮只新增A/B两Work，续接旧测试2轮。正常关闭观察进程并恢复`debugPort=none`普通安装入口；最终A待审、旧测试revision5待审、B排队，供用户查看。未修改产品源码、未重新安装、提交或推送。

本机证据：`/tmp/nozeli-current-project-deep-58yie2xm/report.json`（ok=true，限已执行范围）、`execution-evidence.json`、`post-restart-visibility.json`及截图；28项阶段原生工具回执未见isError，后续2次可见性搜索另记，不当作性能压测或全量模型正确率。

**明确未验**：B仍排队，未执行/发布，不能宣称其Worker读取通过；未以结束待审项强行释放名额。起始无非空草稿，所以只核验现有草稿不变，未追加人为未保存编辑。未改正文、真实采用合入、强杀/异常断电、大报告超预算或触发Pi压缩；Pi原生能力不另建，不把正常重启当强故障恢复。其他平台及模型大样本自主判断仍未验。

## 版本指纹被误读为维护动作：分析与修复（2026-11-08，源码未安装）

反例来自上一节真实模型将corpusVersion变化解释成“索引已重建”。根因：返回字段提供一致性版本和coverage，却未明确这些标识不是动作回执；当前指纹还包括未进入稳定集合的task元数据，因此可见报告完全相同时版本也会变化。不是重建执行出错，不应伪造维护回执、隐藏版本变化或重写索引架构来修说明。

- search新增`versionSemantics`，所有响应（含resync）明确为opaque-read-consistency-token，变化不证明index rebuild/maintenance/adoption/report-content change；字段纳入原JSON字节预算。已有corpusVersion/indexedThrough、游标绑定、生命周期屏障和确切原文校验保持。
- 居民工具描述和前台/主控角色说明同步：coverage只描述该检索快照；宿主操作须有明确operation receipt，没有就说不能确定，不据此发起维修或声称已完成。
- 回归新增“排队task元数据变化→旧游标失效，但稳定结果/身份/采用事实完全一致”。含预算、中文/Unicode分页、并发缓存、来源准入、角色技能及目录版本共36/36通过；本次TAP`artifact://16610`。这不以源码文本/提示词匹配测试冒充模型行为保证。
- 真实项目SQLite只读快照，使用新源码ResultMemory处理原冻结报告；仅在内存中改一个queued任务名称，两次corpusVersion确实不同，但稳定matches逐项相同、总数仍2，原项目无写入。证据`/tmp/nozeli-memory-version-semantics-tCvbFD/source-replies.json`。
- 原真实前台模型对上述**显式新协议样本**做只读解释，未改账号/模型，也未调用工具/派Worker。回答明确否定“索引已重建／维修已执行／新成果已采用”的无据推断，区分同一报告身份/摘要与版本变化的原因未知。实际job`eeb72ae3-6663-4f4c-b53b-8ee942903a68` completed，原Work和用户草稿逐项不变，`model-interpretation.json`同证据目录。
- 该样本验证不是新协议安装后工具端到端验收，不宣称所有模型永远不误解；**本次源码修复未安装/提交/推送**，现有安装仍为`2026-11-08T00-46-26-197Z`。正常关闭临时观察进程exit0后恢复无调试端口真实项目；A/旧测试待审、B排队不变。B未运行不是故障，仍不擅自结束占位任务。

## 版本语义澄清安装及实际工具复测（2026-11-08）

- 用户明确授权安装复测。既有安装器按当前工作区构建校验并激活`2026-11-08T01-38-35-481Z`，previous保留`2026-11-08T00-46-26-197Z`；引擎、controller、frontdesk/orchestrator规则四文件与源码逐字节一致。未提交/推送或公开发行。
- 原日常安装进程正常关闭exit0，重开同用户配置/真实`nozeli_test2`及原前台模型。不是新协议显式样本回放：实际前台调用两次`nozeli_memory_search`，原生toolResult都包含新`versionSemantics`，默认2条、history3条、coverage complete；无其他工具或Worker/维修调用。实际job`26914b19-c397-4033-ab98-364f103c3d27` completed。
- 真实回答引用工具语义串，明确“版本不同不足以证明索引重建、维修或新成果采用”，区分最近一次token相同与更早历史token变化；不再将版本差异当动作回执。本轮两次实际token相同，更早变化反例及只读源码快照证据按前节保留，不伪造一次真实业务变更来制造差异。
- 全部Work业务状态、报告、用户草稿和项目正文文件SHA不变，A/原测试待审、B排队未动；不修改额度、采用/丢弃决定。测试进程正常关闭exit0后恢复普通安装启动，debugPort=none，真实项目保持打开。
- 证据`/tmp/nozeli-installed-version-semantics-tam51cbj/report.json`，ok=true，包含实际工具回复、模型回答和保护断言；安装引用见同目录`installation.json`。此轮只验证这次模型/项目的字段解读，不能保证全部模型/问题永不推断错误；未外推其他平台或B执行完成。旧“源码未安装”保留为前阶段状态。
