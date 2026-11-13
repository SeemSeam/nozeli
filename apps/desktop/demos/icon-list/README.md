# 图标与文字清单 Demo

本轮为候选设计展示，不迁移生产页面，不改变窗口、文件、草稿或后台任务行为。

## 打开

从 `apps/desktop` 提供本地静态 HTTP 服务，访问 `/demos/icon-list/`。例如开发环境运行 `python3 -m http.server 8873 --bind 127.0.0.1` 后打开 `http://127.0.0.1:8873/demos/icon-list/`。该服务只是开发预览方式，不是普通用户产品依赖。不要仅用 file:// 打开，浏览器可能阻止 ES module 导入。

## 单源清单

- `catalog.mjs` 仅再导出生产 `ui-actions.mjs`，不维护第二份动作定义；当前62个动作，默认中文、英文对照预留。保留本页第一版布局用于比较，不保留过期语义清单。
- 图形只来自 `../../src/renderer/ui-icons.mjs`，本 demo 不复制 SVG 路径，也不引入额外图标包。
- 同一动作只定义一个 key。不同语境可以引用同一图形，例如关闭内容、隐藏对话和移除引用都引用 `close`，但保留各自准确的中英名称。
- `icon`：纯图标并保留必要 tooltip / ARIA；`label`：图标和文字；`text`：保留文字；`status`：状态，不作为默认按钮。具体策略及新增图形以生产清单为准。
- `return-work` 仅表示要求继续修改；`return-drafts` 是“交回人工稿并发送 / Return edited drafts and send”，单独保留发送语义，不与保存或普通交回合并。
- 新动作先检查已有 key；只有图形确实不能表达时才增加共享图形，不在页面内定义私有路径或字符替代品。
- 披露详情用箭头；隐藏整个内容面用 X。关闭不冒充删除或停止；对话收起保留消息/草稿；终端关闭的实际进程副作用仍须单独说明。
- 品牌分区展示现有图形＋Nozeli名称、纯文字名称、紧凑搭配。名称使用系统字体示例，不是新绘制或已定稿的专属字标。品牌资产与操作图标分开管理。
- 文件类型图标、第三方编辑器内部图标不纳入本轮动作去重。

## 风格及来源

沿用现有24×24视口、2线宽、圆端点、currentColor；按钮内图形18px、标题操作28px点击区，清单卡片放大到22px便于比较。支持亮/暗主题及窄窗。

复用图形源自 [Lucide](https://github.com/lucide-icons/lucide)，部分继承 Feather；官方 [LICENSE](https://github.com/lucide-icons/lucide/blob/main/LICENSE) 为 ISC，所列 Feather 派生图标同时保留 MIT 声明。仓库原有完整声明位于 `../../src/renderer/workspace-conversation-controls.LICENSE`。本轮核对官方许可证，未新增第三方路径、依赖或品牌资产。

## 已验证范围

历史 Chromium 页面验证（原44条目时期）：中英切换、搜索、按钮反馈、品牌加载与窄窗通过。当前本页和第二版Demo都复用生产单源，并使用生产动作渲染器；生产实屏验收范围见 `docs/user-guide.md` 的统一图标章节。示例点击不执行真实产品命令。
