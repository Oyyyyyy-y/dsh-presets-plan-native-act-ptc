# dsh-presets-plan-native-act-ptc

DeepSeek Harness 的 `ptc-hybrid` 预设：**一个预设、两个阶段**。

- **计划（plan mode）**：顶层可调用全部原生工具，与内置 **standard** 预设一致；`run_code` 被拒绝。
- **执行（计划批准之后）**：顶层只能用 `run_code`，与内置 **PTC** 预设一致；程序内可调用全部原生工具，`workflow` / `plugin_manager` 除外。
- 两个阶段声明的工具表与系统提示相同，`/plan` 开关不重建请求前缀缓存（实测进 plan 命中 98%、出 plan 99%）。

## 两个阶段

| 阶段 | 顶层可直接调用 | 程序内（`run_code`） |
|---|---|---|
| 计划（plan mode） | 全部原生工具（`read` / `grep` / `glob` / `pwsh` / `edit` / `exit_plan_mode` / `workflow` / `plugin_manager` …） | —（计划阶段没有程序） |
| 执行（批准之后） | 只有 `run_code` | 全部原生工具，但 `workflow` / `plugin_manager` 被拒 |

需要向用户提问或等待审批时，给 `run_code` 传 `timeoutMs`（默认 120 000 ms，上限由部署配置决定，默认 600 000 ms）。

## 安装

组合包声明了 `dsh.bundle.patch`，安装后由 profile 启动时合并，不需要手工改 profile 文件。

```bash
# 从 GitHub
dsh plugin --profile <profile> add github:Oyyyyyy-y/dsh-presets-plan-native-act-ptc

# 本地 checkout
dsh plugin --profile demo add ./dsh-presets-plan-native-act-ptc
dsh --profile demo --dump-config        # 应看到 "# == dsh-presets-plan-native-act-ptc" 层
```

桌面端安装后重启 DSH，在会话的预设选择里选 **PTC 混合（计划=标准，执行=PTC）**。

## 预设范围

本包只提供一个预设 `ptc-hybrid`：standard 树 + `tool-executor-ptc` + 路由器，不带 agent 层插件行。

## 故障与降级

- 执行器模块加载失败：不安装路由器，会话退回预设自带的 PTC 执行器（只有 `run_code`），日志里有一条 `superset-router: ...` warn。
- `run_code` 传输不可用：目录只声明原生工具，act 阶段放行原生工具，日志里有一条 `superset-router DEGRADED ...` error，阶段提醒会改写；不会出现没有任何工具可用的情况。
- 想确认是否装上：看日志里的 `superset-router: installed for <session>`。

## 已知限制

- **`plan-mode` 的 `section` 配置不生效**：plan 指引在 `plugins/superset-router.mjs` 的 `planReminder`，改提示词请改那里。
- **act 阶段没有 PTC 的 tools SDK 类型声明**：程序参数靠本请求里的工具 JSON Schema；程序的 TypeScript 规则已并入阶段提醒（runtime-context，不改系统提示）。
- **plan 阶段仍列着 `write` / `edit`**：DSH 的 plan mode 是提示词约束而非权限门，与内置 standard 一致。
- **`exit_plan_mode` 在 act 阶段仍被声明但不可用**：调用会被拒绝并说明原因。
- **`plugin_manager` 可能缺席**：内置 standard 按 `profileContext` 是否可用决定是否挂载它。
- **`run_code` 预算**：审批等待计入程序预算，需要长时间等待时显式传 `timeoutMs`。

## 兼容性

- 在 **DSH 0.2.2-rc.3** 上开发；`engines.dsh` 声明为 `>=0.2.2-rc.1 <0.3.0-0`。
- 升级 DSH 后可用 `scripts/gen-cordis-patch.mjs` 重新生成 `cordis.patch.yml`（开发用，不随包发布）。

## 卸载

```bash
dsh plugin --profile <profile> remove dsh-presets-plan-native-act-ptc
```

## 目录结构

```text
index.mjs                    # 包入口
plugins/superset-router.mjs  # 路由插件：阶段策略
cordis.patch.yml             # dsh.bundle.patch：注册 ptc-hybrid 预设
package.json                 # dsh.bundle manifest
locale/                      # 预设名称与描述
docs/awesome-entry.yml       # awesome-dsh-plugin 提交用的条目
```

开发文件（`scripts/`）不随 npm 包发布，只在仓库里保留。

## English

A DeepSeek Harness agent preset with one tool catalog and two phases. While plan mode is active every native tool is directly callable (the standard preset's set) and `run_code` is refused. After approval only `run_code` is directly callable (the PTC preset's set); inside a program every native tool is available except `workflow` / `plugin_manager`. Both phases declare the same catalog and system prompt, so toggling plan mode does not rebuild the provider prefix cache (measured: 98% on entering plan, 99% on leaving).

```bash
dsh plugin --profile <profile> add github:Oyyyyyy-y/dsh-presets-plan-native-act-ptc
```

## License

MIT
