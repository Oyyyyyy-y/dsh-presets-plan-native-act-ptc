# 实测记录

环境：DSH 0.2.2-rc.3 桌面端，Windows。记录来自一次本地实测会话（创建时预设 `ptc`，投影切到 `ptc-hybrid`）；表中的序号可在该会话日志里复核。

## 怎么读

会话日志是 zstd 多帧压缩的 JSONL（`session.v4.jsonl.zstd`），按 `28 B5 2F FD` 魔数切帧逐帧解压。用到的观测点：

| 观测点 | 位置 | 判据 |
|---|---|---|
| 工具表 | `request/header` 的 `data.header.tools` | 1 个（PTC）↔ 89 个（原生） |
| 系统提示 | `system/message` 的文本长度 | PTC ≈ 104 749 字符；plan ≈ 9 662 字符 |
| 阶段切换 | `plan/mode` 事件 | `{active: true/false}`，整值替换 |
| 阶段提醒 | `user/message`（`source.kind=runtime-context`）的 `phase:mode` 段 | 出现/切换文本 |
| 程序执行 | `tool/ptc-dispatch` | 只应出现在非 plan 窗口 |
| 缓存 | `assistant/message` 的 `usage` | `inputTokens`（未命中）/ `cacheReadTokens`（命中） |

## 实测时间线

| 时间/序号 | 事件 | 结果 |
|---|---|---|
| seq 6 | 进入 plan（旧版插件） | `plan/mode active=true` |
| seq 17 | 旧版请求 | `tools=[run_code]`，未切换（当时的 `planMode` 服务读不到） |
| seq 305 | 修复后重新进入 plan | `plan/mode active=true` |
| seq 312 | 系统提示 | 9 662 字符，含 `plan:policy`，无 PTC-only 段 |
| seq 315 | runtime-context | 出现 `phase:mode`：“计划阶段：用标准工具……” |
| seq 316 | 请求头 | `reason=change`、`startsSeries=true`、89 个工具（含 `exit_plan_mode`），无 `run_code` |
| seq 318 | 边界请求的缓存 | `inputTokens=129 546`、`cacheReadTokens=512`（整段前缀重算） |
| seq 323/330 | 后续步骤 | 新增约 2k、命中 130k（前缀稳定） |
| seq 366/367 | 计划卡 | 停留约 10 分钟后批准，无 `TOOL_TIMEOUT` |
| seq 369 | 退出 plan | `plan/mode active=false` |
| seq 381 | 批准后的请求 | `tools=[run_code]`；当时隔离 runtime 的描述为 `Default 7200000` |
| seq 603 | 最终版重启后 | `Default 120000; capped at 600000`（act = 原始 PTC） |

## 每个 plan 窗口的 `ptc-dispatch`

```text
window active=true   ptc-dispatch=2      # 旧版 plan（修复前，仍在跑 PTC）
window active=false  ptc-dispatch=24
window active=true   ptc-dispatch=0      # 修复后的 plan：一次程序都没跑
window active=false  ptc-dispatch=22
```

## 复核

```bash
node scripts/check-context-integrity.mjs --preset ptc-hybrid
node scripts/check-context-integrity.mjs --session <id>
```

期望：

- `system/message` 只有 `replace`，没有异常新增；
- plan 窗口 `ptc-dispatch=0`，act 窗口 > 0；
- 每次 `plan/mode` 切换后的下一个请求是缓存边界（命中率低），之后恢复。
