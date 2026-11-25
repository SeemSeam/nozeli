# Windows 配置读取记录的冷校验

2026-11-12，v56 定向验证完成，固定 alpha.6＋已合并 PR27。正式基线仍为 v50。证据目录：`D:\nozeli-test\20261112-alpha6-settings-cold`。测试结果以该目录 `development-status.json` 和各原始 TAP/JSON 为准；未结束的进程不计通过。

## 实现

v55 的配置读取证据绑定字节摘要，但没有绑定证据文件自身的原生身份。同字节替换证据文件会保留内容摘要，因此不能单独证明仍是原输出确认的实体。新记录采用 schema 2：每条记录包含字节文件 FileID、前一条记录 FileID 和摘要；同进程 stdout 快照包含 head FileID、head 摘要和读取数。旧 schema 1 保留为未验证材料，不升级历史资格。

共享只读读取器 `cold-settings-reads.mjs` 接收已经认证的原 launch、stdin/stdout 和 retained tree。它逐一检查实际匹配的 start/prompt/flush/stop 回复、同一 stream 和单调读取数，按最后确认 head 反向验证整个记录链，再检查每个较早 head。记录字段、序号、路径、项目/父目录/原配置身份、字节文件身份、摘要和长度均有界核对。当前项目配置可以已经改变或删除；冷校验读取保留字节，不访问或改写现在的项目设置，不调用 SDK 或模型。

所有 settings-reads 成员进入完整集合观察。未确认尾部、孤立 bytes、pending 发布、缺少本轮原 stdout 的历史流及 legacy 记录均显式列为 unknown/unverified，不静默忽略或据此重放。确认链缺段、记录或 blob 同字节替换、错误摘要/身份/head/请求/launch 则拒绝。`completeObservedSet` 只说明这次观察集合全部被原输出确认，不能授予完整恢复或释放资格。

原 helper 的 journal 检查新增 settings 观察；归档前以完整 home 源清单复核该子树全部成员、身份和摘要。独立归档读取器先核对原 intent/ready SQLite 精确提交收据和整个归档，再从归档 stdin/stdout 重建同样的配置观察。副本字节与源完整内容集合比较，证据链的原 FileID 则与源清单比较；副本的新 FileID 不冒充原实体。

## 验证范围与限制

永久测试包含真实 Windows HANDLE 配置读取与复制、项目配置删除后读取旧证据、同字节记录/blob替换、内容篡改、缺段、重复序号、错误/倒退 head、请求/launch/目录/stream 错配、未确认尾部、孤立字节文件、pending 和同 home 的另一代流。真实 Pi 原 host 退出场景检查同字节 receipt 替换拒绝及额外未知文件保留。真实三 owner 业务归档检查正常复制，以及 ready 提交成功但回复丢失后的独立进程只读核对，原候选、草稿、外部赢家和零重放保持。

本批 Pi 重建；原生实现沿用 v55，输入/输出摘要另核对；renderer 未改。新包从保留 v55 payload 组合当前源码，不恢复刚清理的 v54 解压目录。独立包使用显式 runtime root 的配置、资源、真实 owner、Worker 和归档测试，不以通用 Provider 测试中的旧仓库相对导入授予当前包 bridge 资格。

没有证明从首次读取到原输出确认之间不可替换的完整生命周期 custody。models/auth、动态 import/node_modules、角色文件、metadata/journal 交接和完整恢复闭包仍需补齐。原 helper/home 继续保留。祖代释放后二次冷恢复、pending/default ManagedProjects、终端/TeX/force quit、物理 IME/多屏、普通账户复现、安装升级回滚、签名发行及其余 W0–W5 条目仍未完成。macOS/Linux 未执行本批共享改动。


<!-- final-validation -->
最终结果详见本批 development-status.json。独立v2包全量核对 43641 文件、1795 冻结输入和 36 项v55原生输入输出。ZIP SHA256 `d0c7e682cbef5fa1c71bfaf8dbe3cd1bdbcf51467181f0fc6cc69771f28580b3`。首包在归档测试补强后冻结输入校验报告测试源码差异，该包及原始日志保留为历史，不计最终v2资格。
<!-- /final-validation -->
