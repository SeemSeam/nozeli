# Plantree 生命周期独立 Demo

状态：2026-11-07，已运行的独立研究工作台，**尚未接入 Nozeli**。不调用模型、不加载用户账号、不迁移或清理任何日常项目。

## 运行

开发验证需 Node.js 22 且内置 `node:sqlite`/FTS5 可用。在 checkout 根执行：

```text
node evaluation/plantree-lifecycle-demo/server.mjs --root /absolute/new/demo-directory --fixture --port 0
```

服务只监听 `127.0.0.1`，stdout 打印实际 URL。root 必须是不存在的新绝对目录，或此前由本 Demo 创建、有所有权 marker 的目录；任意已有目录、`.nozeli` 路径和链接会被拒绝。不要指向用户项目。已有数据再次启动不要加新 fixture：fixture 仅在空库创建。

本轮展示服务：`http://127.0.0.1:40409/`，数据 `/tmp/nozeli-plantree-lifecycle-showcase-20261107`，仅本机可访问；端口及进程为本次运行状态，不是持久产品地址。停止后可用同一受管 root 重新启动，端口以当次输出为准。

## 可以实际体验

- 沿树建分支，在当前节点创建方案/决策/实施/测试/报告/知识提议；修改已有文档保留同 ID 并创建不可变版本，而不是新增同职责散落文档。
- 节点状态、节点/文档 pin、文档来源引用参与归档保护。一个节点人工保留保护整个分支；完成父节点下的活跃/冲突后代不会被一起藏掉。
- 预览显示可归档项和阻止原因；执行必须使用同一全局 revision，再次检查。pin/新增来源等使旧预览失效，不自动替换计划后继续执行。
- 归档不删除正文；默认树不再显示归档节点；明确打开“包含归档”、历史检索、恢复和逐版读取保留身份及证据。
- 本工作面已知 dirty 草稿阻止相关归档；干净缓冲刷新读取服务器最新版本。此保护不等于已接入跨浏览器/Agent 的全局打开租约。
- 缓存可重建。GC 仅工具受管、hash 匹配、普通单链接、无所有规范 head/历史版本引用且超过60秒宽限的孤儿对象；正常历史不是GC垃圾。重建/归档不会删除用户文件。

界面来源引用使用文档 ID 方便隔离实验核对；这不是未来 Nozeli 普通用户必须手填内部协议的产品设计。

## 复跑

```text
node --test evaluation/plantree-lifecycle-demo/tests.mjs
node evaluation/plantree-lifecycle-demo/bench.mjs
node evaluation/plantree-lifecycle-demo/ui-smoke.mjs
```

前两项仅 Node 核心模块，产生独立 `/tmp` 证据目录。真实浏览器 smoke 复用仓库现有 `apps/desktop` 的 `puppeteer-core` 开发依赖；默认 `/usr/bin/google-chrome`，其他开发环境用 `CHROME_BIN` 指向已安装浏览器。使用普通 sandbox，不传 `--no-sandbox`。这是开发验收工具依赖，不是 Nozeli 产品新增用户前提。

`browser-check.mjs` 导出 `exercise(page,{url,out})` 可在已有 Puppeteer/browser tab 中驱动真实控件；没有 mock server/state。`ui-smoke.mjs` 自动创建独立服务器/数据、运行场景并正常退出，不复用展示库。

## 已执行证据与优化

详见 `results.json` 及主报告 `docs/long-term-memory-evaluation.md` §16。本轮实测：

- 最终真实 SQLite/文件/HTTP 回归 13/13；正文发布、归档事务、GC物理删除前后共六个真实 child SIGKILL 点。
- 跨连接 publication/GC 缺对象竞态修前复现 ENOENT，修后锁内发布测试通过。
- 100/1000节点真实生成/修订/归档/恢复/分页检索/重建。1000节点中800归档、200保留活动，1000文档仍完整经历史分页查回；同职责文档20次更新不增加文档数量。
- 实际浏览器创建、修订、dirty保护、pin使预览失效、归档/历史/恢复、旧版本正文、另一客户端更新后clean刷新、添加来源引用、重建/GC预览、深浅主题及390px无横向溢出通过；另1000节点40次历史开关实际DOM渲染样本。
- 归档分析从每done节点重建全树/全扫docs，改为共享树索引、子树区间和保护汇总。相同合成场景下1000节点预览128.64→3.93ms，执行118.55→5.49ms。共享工作站单次曲线，不是容量SLA；真实改进对象是归档分析，不宣称所有操作同样提速。
- 修复归档后普通正文刷新自动开启历史视图，以及未修改缓存挡住另一客户端新正文的UI缺陷。历史版本列表改为metadata，正文按确切revision单独读取。

失败原件均保留，包括测试驱动漏传node ID、维护反馈文案断言错误等，不能把这些说成产品逻辑缺陷。

## 不能据此承诺

- 归档减少活动树噪声，不使必须保留的历史正文磁盘永久有界。当前所有不可变版本均保留；永久历史删除/压缩/配额政策没有实现，也没有隐形删除。
- 确定性结构保护已测；语义合并/重复主题识别、真实LLM提炼/冲突理解、知识批准/撤销的完整新模型未实现，不能把搜索行称为已批准知识。
- 当前词法检索搜索文档heads；历史revision通过ID+revision可读取，不承诺所有旧revision全文查询。直接API search分页是显式offset/返回revision，UI检测续页revision变化；生产必须用绑定corpus/query的游标。
- state元数据一次读取、同步Node SQLite与对象I/O是独立Demo实现；没有接现有Nozeli存储worker/Pi、全局编辑/发布租约、知识outbox/模型费用、对象引用GC、永久清除和三平台打包。
- SIGKILL证明实际进程中断边界，不是硬断电/磁盘满/坏WAL/非合作用户修改全部保证。Demo拒绝不明对象与链接，但不是防当前系统用户恶意改写整个受管目录的沙箱。

接入 Nozeli 前保留独立 reviewer 复审及产品合同门：生成入口与稳定ID/来源映射、用户未保存及owner生命周期、已批准且冲突同时可见、撤销与GC pin、导入/备份/永久清除、真实中文/多意图模型质量与三平台。不得直接把该TreeStore当第二产品主库挂到Pi。
