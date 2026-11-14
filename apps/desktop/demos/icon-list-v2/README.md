# 图标 Demo 02：少文字与清晰操作

打开：沿用桌面目录静态服务，访问 `http://127.0.0.1:8873/demos/icon-list-v2/`。页面左上可返回 Demo 01。普通用户产品不依赖此开发用静态服务。

本 demo 不再持有第二份清单或图形。生产单源已落地：

- `../../src/renderer/ui-actions.mjs`：生产双语动作清单（对象 `actionList`，按 key 索引；`actionGroups` 保留分组），含确认版 45 个动作与各分片新增的语义 key（jump-definition、diff-previous/diff-next、window-minimize/window-maximize、choose-comparison、focus-editor、show-conversation、browse-back/browse-forward、reload、stop-load、open-project、cancel-drawing、remove-tag、parent-directory）。`setActionButton(button,key,{label,text,locale})` 负责图形、展示策略、双语标签、aria 与悬停/键盘提示；`text:''` 强制纯图标，`label` 覆写 aria 与提示文案并保留具体对象。
- 当前62个动作；补充通用 `copy` 后，代码块复制不再手写“⧉/✓/!”字符。运行时连接／发送说明通过 `setUiHint/getUiHint` 更新，不使用title；统一图标按钮移除原生title，避免双重提示。
- `../../src/renderer/ui-icons.mjs`：唯一图形定义。确认版9个官方SVG已并入生产，另有 corner-up-right、folder-open、rotate-cw、copy。本demo的 `icons/` 与独立许可证副本已移除，许可统一保留在 `../../src/renderer/workspace-conversation-controls.LICENSE`。
- `../../src/renderer/ui-tooltip.mjs`：每 document 单例事件委派提示。demo 按钮与页面不再各自挂监听；Escape 关闭、不抢焦点、disabled/移除节点不留孤立提示。demo 仅保留一份 `.ui-tooltip` 主题样式以配合本页配色。

## 展示规则

保存/导出/视图重置、框选、返回主窗口、发送、请AI解释、完成涂鸦为纯图标；编译、停止本回合、交回人工稿并发送保留文字。备注与讨论仍保留短标签以区分本地记录与会话入口。按用户反馈，删除、重新连接、采纳并结束无常驻按钮文字或悬停/聚焦tooltip，仍保留准确中英aria-label和真实状态文字。其余需要提示的按钮支持悬停/焦点、aria-describedby及Escape关闭。清单卡片名称是用于审阅的元数据，不是按钮字幕。

成果审阅把意见/人工稿交回与应用决定分区，并就近显示“应用到项目并结束工作”。采纳用勾，保留确认；回嵌使用panel-top及“返回主窗口”提示；删除用垃圾桶而非X；告警是可见状态而不是按钮。“交回修改”采用message-square-reply并标注候选动作，不冒充生产独立入口，不与return-drafts复合发送合并。涂鸦完成在独立涂鸦工具组使用check，不与审阅采纳所在区域混排。

所有点击仅为演示：不写文件、不调用模型、不运行编译器或Shell。框选演示选中状态，编译演示忙碌到完成，重连演示连接状态。采纳、人工稿交回、停止展示带后果说明的确认窗；删除按本轮反馈不弹确认，单击只回显预览，生产删除保护不变。编辑只回显入口预览，不误跳到修改意见框。

## 已观察的验证

历史实屏验证（demo 自有实现时期）：45条目/40图形正常显示；删除/重连/采纳按钮无文字、无悬停/聚焦tooltip、有aria-label；窄窗无横向溢出。迁移生产单源后的回归由主流程统一检查（本 demo 未单独运行构建/测试）。此前结论中涉及 `icons/`、`extraGlyphs`、`#tooltip` 与每按钮监听的描述已随本页重构作废。

生产源码已完成逐页迁移；Linux实际Electron多格式、全部设置分类、窗口及涂鸦草稿、真实保存和冷恢复验收见 `docs/user-guide.md` 的统一图标章节。尚未安装／发布，非其他平台签收。
