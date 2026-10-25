# OMP 私有运行时

本目录维护固定上游源码、三个产品补丁与有效回归夹具，不依赖旧仓库、预编译 OMP、用户配置或认证文件。产品启动的只能是 `apps/desktop/runtime/omp/` 中由本配方生成并带 manifest 的私有运行时；不会回退到系统 OMP。历史 P1 网关不是产品构建输入。

## 从干净输入构建

开发构建环境要求 Linux x64、Node.js 22+、Git、GNU tar，以及 **Bun 1.3.14**。需要能访问 GitHub、npm registry 和 Bun 锁文件中的依赖源；不需要 npm 登录或模型凭据。入口先校验 Bun 版本，不自动更换工具链。

在仓库根目录执行：

```bash
node integrations/omp/prepare-private-runtime.mjs
# 或：npm --prefix apps/desktop run build:omp
```

可指定独立工作目录：

```bash
node integrations/omp/prepare-private-runtime.mjs /absolute/disposable-build-directory
```

每次调用会在默认 `.build/omp/` 或指定目录中创建新的 `build-*` 子目录，克隆 `https://github.com/can1357/oh-my-pi`，detached checkout 到 `c2cb79e4c227aa4b22c4ccb933ff72fd88bceba4`（v18.11.0），不复用已打补丁的 checkout，也不覆盖已有工作目录。

随后直接下载官方 npm 包 `@oh-my-pi/pi-natives-linux-x64@18.11.0`，只读取两个指定 `.node` 成员，逐一校验 SHA-256 后写入 checkout 的 `packages/natives/native/`；不会执行该 npm 包的安装脚本。准备完成后调用 `build-private-runtime.mjs`，依次检查 commit、源码清洁性、Bun、pristine 源码和三个补丁的哈希，运行 `bun install --frozen-lockfile`，再次检查 native addons，按顺序应用补丁并运行上游 binary 构建脚本。

输出：

- `apps/desktop/runtime/omp/omp`
- 同目录的 `LICENSE`、`THIRD-PARTY-NOTICES.txt`、`BUN-LICENSE.txt`
- 同目录的 `runtime.json`，记录本次实际输出 SHA-256、平台、能力、输入锁和实际构建配方 SHA-256；不记录用户绝对路径。

这是固定输入的配方式重建，**不承诺字节完全一致**。锁文件不保存历史产物 hash。构建工作目录和已打补丁源码保留供排错与回归，入口末尾打印实际源码路径；失败时同样不会自动删除现场。需要重新构建时再次运行准备入口，切勿把已打补丁源码交给要求 pristine 输入的底层构建器。

## 文件权威与产品边界

- `private-runtime.lock.json`：上游 URL、commit/tag、Bun 版本、三个补丁及 native addons 的精确哈希与目的地。
- `upstream.lock.json`：pristine 上游源码哈希，以及保留的零模型协议探针输入哈希。
- `patches/0001-*`：managed CollabHost 入站准入门，epoch/attempt 水位、实算摘要、重放判定与受管提交链。
- `patches/0002-*`：私有目录、认证 broker 和仅产品管理的更新行为。
- `patches/0003-*`：真实 managed CollabHost 启动、relay capability、无损分块 journal entries、原生消息身份与有界流式快照合并。只合并同身份的相邻累计 text/thinking 快照；工具参数保留全部 delta，并在 SDK 事件入队时捕获不可变 append 证明，防止共享 live block 终结后证明丢失。控制/生命周期/原始日志/批次/sync/flush 均是屏障；普通 Collab、256 项/16 MiB 上限及 unknown 防重投不放宽。
- `src/nozeli-admission.ts`：独立准入逻辑回归测试与协议探针使用的源码。

产品 relay、guest、grant/adjudicator 和传输实现归 `apps/desktop/src/agents/managed/collab/` 所有，未从本目录运行历史 P1 gateway。原生 custom entries 与消息祖先 ID 决定 request/job 归属，不以输出时序推断。保留的准入门补丁不等同于引入旧业务网关。

## 回归命令（不访问真实模型）

先构建，然后把入口打印的 patched source 绝对路径设置为 `UPSTREAM_CLONE`：

```bash
export UPSTREAM_CLONE=/absolute/path/printed/by/prepare/source
bun test integrations/omp/tests/
bun --no-env-file integrations/omp/tests/accepted-replay-fixture.ts
npm --prefix apps/desktop run test:collab
# 实际 SDK 缓冲事件→AES 队列及编译后 CLI 大工具参数流（localhost 脚本响应，不调用付费模型）：
(cd "$UPSTREAM_CLONE" && bun test packages/coding-agent/test/collab/relay-client-backpressure.test.ts)
node --test apps/desktop/tests/omp-collab-native-tools-live.mjs
node integrations/omp/probes/native-managed-smoke.mjs "$PWD/apps/desktop/runtime/omp/omp"
# 环境具备 bubblewrap Worker 前提时：
node integrations/omp/probes/native-managed-smoke.mjs "$PWD/apps/desktop/runtime/omp/omp" --worker
```

`tests/` 包含确定性准入/重放测试、真实 AgentSession busy-race 和真实 CollabHost + relay + mock Session 集成夹具；后两类明确要求 `UPSTREAM_CLONE`，没有旧机器路径默认值。mock fixture 的模型与认证均为临时内存对象，不读取实际凭据。

额外的底层协议探针接受本次构建的 `runtime.json` 和源码 checkout，不再接受历史二进制 hash 白名单：

```bash
bun integrations/omp/probes/run-smoke.mjs "$PWD/apps/desktop/runtime/omp/omp" "$UPSTREAM_CLONE" "$PWD/.build/omp/protocol-smoke"
```

该探针校验当前 manifest 的二进制 hash、输入锁与构建配方 hash，并验证 guest/adjudicator/relay 输入；不发起模型请求。`native-managed-smoke.mjs` 只证明原生身份、draft/idle 与进程退出，不代表完整模型旅程验收。
