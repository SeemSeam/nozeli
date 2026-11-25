# Windows alpha.6 原始请求与 journal 冷核验

基线固定 merged PR27 `cb07c5180c85ca0e127ddc332089300498103cc5`，原生协议仍为 v8。本批沿用并逐摘要核对前次实际构建的原生组件；不宣称本批重新编译。

原检查器已有原始start／stop／输入输出和最终journal校验，但未逐项关联prompt返回与原输入，也依赖单一experimentalWindowsRoot。本批按ProjectStorage为每个文件选择登记原生根；home、agentDir和journal必须处于同一原生私有根，保留实际SDK目录编码和源登记约束，覆盖桌面profile与项目分离目录。

原始RPC、owner返回和反向host tool调用／回复身份必须唯一且匹配。普通无材料／图片／projection输入必须有字节数和SHA256一致的delivery、原native user entry、带相同requestId／jobId的原entry事件和返回nativeEntry。只有这些证据及provider-completed返回同时成立，才记录native-result-confirmed；仅原生输入已确认或执行未知单列。没有原始回复即execution-unknown，不能因journal出现用户消息就推断完成。材料／图片／projection暂不继承普通文本资格。所有结果持续businessSettlementQualified=false，不修改既有业务状态，不自动派工或重放。

原host tool调用与stdin中回复分别留摘要；未回复工具明确列入unresolvedToolIds。收到回复不等于宿主原生事务／业务账本已完成，仍需原业务回执协调。该解释器只消费已验证来源数据，其JSON输出不是接管凭证。

openWindowsManagedColdInspection显式inspectJournals:true会逐owner运行实际journal核验；默认仍可检查纯Job／stdio。journal与metadata完整身份／摘要及请求观察进入本机managed_cold_checkpoints的原CAS；提交前后重新核对原生宿主启动集合、来源、所有owner和journal观察。提交后发生实际journal并发修改保留STORAGE_RESULT_UNKNOWN，不重试，不覆盖外部赢家。

本批仍要求原Pi最终stop ack及原File ID／SHA256／同步证据；被杀且没有最终stop的owner仍未资格化。真实任务工具业务账本、pending／projection冷接管、既往退休代次、默认ManagedProjects和完整W0–W5资格仍待完成。原全量unit／safety／integration历史失败继续保留。

证据根 `D:\nozeli-test\20261110-alpha6-journal-reconciliation`。最终结果见下表。使用独立合成项目与本地HTTP Provider，无真实／付费模型或日常账号。

## 最终实际结果与验证包

总收据 `D:\nozeli-test\20261110-alpha6-journal-reconciliation\qualification.json`。下表均为本批实际完整定向套件，0 fail／0 skip／0 cancelled；不代表全量测试通过。

| 范围 | 结果 |
| --- | --- |
| journal-node-verified | 47/47 |
| journal-electron-verified | 47/47 |
| journal-extracted-node-verified | 47/47 |
| journal-extracted-electron-verified | 47/47 |
| cold-node | 15/15 |
| cold-electron | 15/15 |
| cold-extracted-node | 15/15 |
| cold-extracted-electron | 15/15 |
| worker-node-verified | 2/2 |
| worker-electron-verified | 2/2 |
| worker-extracted-node | 2/2 |
| worker-extracted-electron | 2/2 |
| gui-source-verified | 6/6 |
| gui-extracted | 6/6 |

JS语法 1243 文件通过。每套47项由35项真实Pi／Controller／原生监管用例和12项解析器用例组成，覆盖桌面分离目录、缺失prompt回复、输入摘要不符、真实反向host tool单次效果及journal提交后并发变化。journal外部赢家保留，检查点UNKNOWN后不重试。初次完整Pi套件的手工Workspace fixture因默认persistence不适用失败，改用实际native Workspace IO后完整复验；host tool fixture最初使用none而关闭了自定义工具，改为明确空内置工具列表后复验。原失败TAP／收据均保留，定向诊断不冒充完整套件。

renderer本批实际构建；原生组件、Pi及依赖输入／实际实编字节闭包逐摘要核对，本批没有重编native或干净npm ci。protocol仍为v8。

ZIP `D:\nozeli-test\20261110-alpha6-journal-reconciliation\desktop-package-final\Nozeli-windows-alpha6-journal-reconciliation-qualification.zip`；SHA256 `152f1cb4d9d5978c36498c2be7cc1e88c19ecd9c5f7e13a3eee571f3cd44b596`。43617文件、1412774675展开字节、1702当前src／dist／tests／tools冻结文件。CRC、中文空格目录独立解压、全部字节和原生／Pi闭包、仅System32 PATH的Node／Electron／Git／Pi运行时解析及运行后完整性均通过。前次因测试源码在打包期间改变而拒绝的desktop-package保留，不作为交付包。

解压journal首跑因外部测试运行器未设置已有NOZELI_TEST_PI_ROOT选项，按源码目录结构查找Pi而ENOENT；识别后停止仅匹配本批测试的进程，失败TAP和中断退出码保留。运行器明确绑定已校验的包内app/integrations/pi后完整复验；产品源码和ZIP未因此改变。修正收据为extracted-harness-correction.json。

Worker每宿主各2项使用实际Controller／Pi SDK／Git，本地HTTP Provider，覆盖单根与桌面分离根的修改、明确接受、归档和warm reopen。GUI各6项为实际可见shell与IPC登记／保存CAS／冲突草稿／重启恢复，未外推物理Explorer、IME、多屏或完整文档矩阵。本批无真实／付费模型和日常账号操作。

历史unit813通过／8失败／1跳过、safety12／25／16、integration766／1111／58仍保留，本批未重跑全量。未进行安装、签名、发布、commit或push；该包是带合成验证harness的本地开发ZIP。原生请求／journal观察取得限定证据，业务接管、默认派工及完整W0–W5仍未完成。
