# 稳定结果记忆：首版接入与验证

Date: 2026-11-07
Status: 源码已接入，验证记录逐项列在下文；未安装、提交、推送或迁移日常项目。完整系统设计见[Plantree结果记忆合同](plantree-result-memory-design.md)。

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
