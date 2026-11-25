# Windows alpha.6 / PR #27 最终合并版整合（2026-11-09）

后续原生项目host启动集合与当前包见[最新记录](windows-alpha6-launch-set.md)；下文保留原批次事实和当时限制。

2026-11-09 19:39（Asia/Shanghai）再次核对 GitHub API：最新发布仍为 `v0.1.0-alpha.6`，最新创建 PR 仍为已合并的 #27，main 与本地 HEAD 同为 `cb07c5180c85ca0e127ddc332089300498103cc5`。官方 tag 是本地 HEAD 的祖先，最终 PR HEAD 与 main 的 tree 均为 `d796c6776ec5b9b6878f572b312e4363c66b5a25`；没有新增上游代码需要迁入。开放依赖 PR 保持独立，Windows 未提交实现保留。本次 API 原始响应、Git 状态及核对收据在 `D:\nozeli-test\20261109-alpha6-merge-review-113949`；未执行远程 merge、commit 或 push。

当前最新完成的源码／验证包以[冷恢复前置记录](windows-alpha6-cold-checkpoint.md)为准：process 四宿主各109/109、冷检查点各11/11、Worker各2/2、源码／解压 GUI各6项，均为对应前批已完成结果，本次没有重跑或重建。包 SHA256 为 `3c36f842fff2bc0b3184ed85de6c15f7b3ebf8160a9db444de4d7ec03ffa4122`。本文下方较早 ZIP 和测试计数继续作为各自批次历史；完整宿主启动集合、默认托管入口、业务冷恢复及安装发行仍未完成。

后续 managed 分离目录验证与当前源码包见[最新记录](windows-alpha6-managed-roots.md)；下文保留对应批次的原始结果。

后续生产功能与当前包已更新，见[Windows 外部启动持久队列](windows-alpha6-external-routing.md)。下文保留本次上游整合批次的原结果。

2026-11-09 17:06（Asia/Shanghai）再次通过 GitHub API 核对：最新功能 PR 仍为已合并的 #27，main 仍为 `cb07c5180c85ca0e127ddc332089300498103cc5`，最终 PR HEAD 与 main 的 tree 均为 `d796c6776ec5b9b6878f572b312e4363c66b5a25`。最新发布标签仍为 `v0.1.0-alpha.6`，开放的依赖升级 PR 未纳入此基线；本次没有新增上游代码需要迁入。Git HTTPS 的两次 `ls-remote` 分别连接重置、连接超时，本次实时核对使用成功返回的 GitHub API，不宣称重新 fetch 成功。

本次独立复核证据为 `D:\nozeli-test\20261109-alpha6-upstream-recheck`：当前包 ZIP SHA256／CRC、43578 个解压文件、当前 src／dist／tests／tools 的 1692 个冻结文件、native 输入及二进制、Pi manifest 与旧 Windows 树 311 个文件摘要均一致；`git diff --check` 通过，无暂存内容。仅补上游与产物复核记录，本次未重建或重跑业务测试；前批测试结果及未完成范围继续有效，完整 Windows 产品仍未通过资格。

当前本地 Windows 工作树已从 PR27 初稿 `5fbc482` 进一步整理到 GitHub 已合并的 main **`cb07c5180c85ca0e127ddc332089300498103cc5`**，再保留 Windows 未提交实现。官方 alpha.6 标签仍为 `9a2466a`；最终 PR HEAD 为 `b72e744640e02a117ab2ef95211eebb3e363dce6`，其 tree 与 main 合并提交完全一致。

这是本地整合完成与限定验证结果；Windows 全功能／安装发行资格仍未完成。

## 上游与保留

- [PR #27](https://github.com/SeemSeam/nozeli/pull/27) 已由上游于 2026-11-09T07:44:55Z 合并；本任务未执行远程 merge。GitHub API 的最终 HEAD 检查显示 CI gate、Linux unit、Linux integration、Linux clean build/smoke、macOS native safety 均 success。这些属于上游 CI，不代替 Windows 验证。
- 最新创建 PR 仍为 #27；其余开放依赖升级 PR 未混入该固定基线。远端无 `release/alpha.6` 分支，本次使用真实 alpha.6 tag 与 merged main，不猜测不存在的 ref。
- 当前工作区 `D:\nozeli_windows\nozeli-alpha6`，分支 `platform/windows-alpha6-pr27`。15 文件最终差异已迁入，公共 filesystem 注释与测试记录两处追加冲突已人工保留双方内容。Windows 额外修改和未跟踪源码保留；未新建开发提交或 push。
- 迁移前 321 条本地修改／新增路径已备份；15 个上游受影响文件之外，316 条原本地路径逐摘要一致。随后仅本轮说明的测试／Windows 长路径修正及文档发生有意修改。旧 `D:\nozeli_windows\nozeli` 的 311 条原 Windows 文件仍逐摘要一致。

## 最终 PR 的变更与 Windows 补修

保留受 pin 保护、同一 JS 同步窗口内的初始化比较／发布，明确这不是跨进程原子 CAS；Linux／Darwin 最终读取使用 nonblocking 打开以拒绝 FIFO；检查点暂存名独立于请求 ID；Darwin 进程事实错误向上传播，不能冒充进程已消失或空表；新增真实 macOS 原生安全 CI 与原回归。

Windows 初次新增原生存储／Git 暂存回归 **4 通过 / 2 失败 / 0 跳过（6 项）**：正常默认临时 profile 下，即使 UUID 暂存文件名也会形成超 MAX_PATH 完整路径，Git `hash-object` 返回 Filename too long。`ShadowVersions` 现在仅在 Windows 的隔离 Git 环境中设置 `core.longpaths=true`，同时保留 hooks 禁用和全局／系统配置隔离，不写用户全局或项目 Git 配置。

新增 3 项永久回归：unsupported 的同步 chain 操作必须在继续发布前同步抛错；200 字符请求 ID 与含冒号 ID 的冻结对象实际暂存／Git tree／元数据／残留清理。后两项使用真实 Windows 私有项目存储、材料对象与随包 Git，逐字节核对冻结内容和元数据，并保留不相关暂存文件与项目源文本。它们验证暂存边界，不冒充完整检查点来源证明、首次冻结或恢复业务验收。

Windows 项目语义初始化与永久重置的早期 unsupported 门保留，没有因迁入 Linux／Mac 实现而启用 Windows 执行或删除。ExternalOpenQueue 本轮未接入 main 的 externalFiles/takeOpen。

## 当前验证

证据根 `D:\nozeli-test\20261109-alpha6-pr27-merged`；命令、原始 TAP、失败名、源码输入、GitHub 元数据与总收据均保留。

| 项目 | 当前结果与范围 |
| --- | --- |
| renderer | 当前源码实际重建退出 0。Windows native 输入／4 个二进制与前批实际构建逐摘要一致，本批未重编；Pi/PPTist/依赖闭包未变并核对，不宣称干净 npm ci。 |
| JS 语法 | 1230 文件通过，无冲突标记。 |
| 单元 | 813 通过 / 8 失败 / 1 跳过（822 项）；8 项均 PERSISTENCE_UNSUPPORTED，原断言保留。 |
| 上游安全六文件批次 | 12 通过 / 25 失败 / 16 跳过（53 项）；Windows chain／safe-file／初始化门未支持、POSIX FIFO／符号链接 fixture 等失败保留。Darwin 专用跳过不算 Windows 通过。 |
| focused-node | 166 通过 / 0 失败 / 1 跳过（167 项） |
| focused-electron | 166 通过 / 0 失败 / 1 跳过（167 项） |
| focused-extracted-node | 166 通过 / 0 失败 / 1 跳过（167 项） |
| focused-extracted-electron | 166 通过 / 0 失败 / 1 跳过（167 项） |
| 源码与解压 GUI | 各 6 项通过；真实可见 Electron＋CDP/IPC 项目登记、文本 CAS、外部赢家／草稿保留与正常退出后冷恢复，renderer errors=0。无物理 IME／Explorer／多屏或所有文档面资格。 |

四组 focused 的唯一 skip 是 Linux 专用 non-dumpable 进程归属场景。本批没有重跑耗时的全 integration 或广泛 Windows 批次；前批 1935 项的 766 pass /1111 fail /58 skip 和其运行中清单边界继续保留为历史，不冒称对最终 merged head 全套通过。

## 新验证包

- `D:\nozeli-test\20261109-alpha6-pr27-merged\desktop-package\Nozeli-windows-alpha6-pr27-merged-qualification.zip`
- SHA-256：`76cab383ca5a758fabfc83d96699e7479eb920054fccefd36b4769b2522e4ffe`。
- 43545 文件，1412098731 展开字节；新 ZIP、独立中文／空格路径解压、CRC 与全部文件 SHA-256 复核通过。当前源码／dist／tests 共 1659 文件逐项一致；Windows native 与 Pi manifest 一致。
- 解压 `D:\nozeli-test\20261109-alpha6-pr27-merged\desktop-package\解压 空格\Nozeli-windows-x64\Nozeli.exe` 为本次验证入口。只保留 System32 PATH 时包内 Node／Git／Pi 解析通过；源码与解压包分别在 Node 和 Electron Node 模式执行同组回归。
- 新包采用已验证未变的独立依赖／运行时字节，加当前源码和本次成功构建的 renderer；没有旧源码或失败构建回退。旧首批 ZIP／收据保持原样。此 ZIP 含合成资格 harness，不是安装器；未替换日常安装、未签名或发布。

## 仍未完成

W0 保留本机原生构建证据但缺干净普通账号可重现资格；W1/W2 仍缺完整生产安全文件／持久化／进程归属选择及冷恢复；W3 unsupported；W4 缺新的初始化／永久重置、外部启动队列主入口、回收站／终端／TeX等消费者和物理桌面；W5 缺安装／升级／回滚／签名／干净机发行资格。

下一批先收敛生产文件／持久化与进程归属入口，再打通外部打开请求的持久接收、原窗口代次与实际显示确认；随后推进 alpha.6 未支持功能与安装资格。不能用局部暂存或 GUI IPC 通过替代这些产品门。
