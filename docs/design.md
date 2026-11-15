# 设计说明

## 1. 起点：两套预设，一个会话一套

DSH 内置 standard 与 PTC 两套预设。它们不是“新旧”关系，而是两种调用形态：

| | standard | PTC |
|---|---|---|
| 调用 | 一次一个工具调用 | 写一段程序交给 `run_code` |
| 中间结果 | 全部进上下文 | 留在沙箱，只有打印的内容回来 |
| 轮次成本 | 一个任务几十轮 | 一个任务 1–3 轮 |
| 适合 | 探索、逐步确认 | 批处理、流程确定 |

计划阶段天然是“边看边问、要人确认”的探索过程，执行阶段才适合批处理。把两者塞进同一套工具形态，就会在最需要等人的地方撞上预算。

## 2. 根因：审批被塞进了有预算的进程

standard 的审批发生在工具进程启动之前，宿主 `await` 时没有任何 deadline 在走；PTC 的程序预算从 worker 启动就开始计时，程序内部的审批等待也被算进去：

```text
standard:  model -> host --(等待审批，无 deadline)--> spawn tool --(tool timeout)--> result
PTC:       model -> run_code [===== program budget 从 spawn 开始 =====]
                        +-- nested tool approval -> 等人（计入预算）
```

这不是“预算太小”，调大只是抬高水位。更严重的是超时可能落在“已批准、正在执行”之间，留下半执行的副作用——这是正确性问题，不是体验问题。

结论：**把无界的等待移出有界的作用域**，而不是让有界的域去容纳无界的等待。

## 3. 为什么只改插件层

改 `app.asar` 里的核心能实现同样的效果，但每次升级都要重新打补丁、重新验证，维护成本与风险都高。DSH 已经提供了足够的扩展点：

- `ToolsService.setExecutor(executor)` 把执行器登记在**调用方的 scope** 上；
- `ToolsService.selectExecutor(scope)` 沿 `scopeChainOf(scope)` 找最近的登记；
- 宿主本来就为每个 agent 建了 scope（`createScope(loopCtx, this)`），agent 对象本身就是 scope key。

于是在 agent scope 上装一个路由器，就能只影响这一个会话，而且不改任何全局配置。

一个必须遵守的细节：上游实现里执行器登记被释放后，`selectExecutor` 会保持“已选中但不可用”，**不会回退**到预设执行器（`packages/core/tools/src/index.ts` 中 `setExecutor` 的 disposer 注释）。所以路由器常驻、只切换内部 phase，绝不 dispose。

## 4. 阶段状态从哪里读

第一版直接读 `ctx.planMode.get(agent).active`，结果**完全没生效**：`plan-mode` 插件在预设的 `planning` 组里，该组声明了 `isolate: { planMode: true }`；路由器在组外，按默认符号解析服务，拿到的是 `undefined`（宿主层同名插件是 `disabled` 的）。cordis 的 isolate 是 realm 级的符号隔离，域外看不见域内服务。

第二版退回去扫事件日志（`session.eventAt`），能跑，但踩了上游的硬约束：

> `Session.eventAt()` / `snapshotEvents()` / `ownEvents()` 已 `@deprecated`，**new calls are prohibited**。历史状态应由投影提供，恢复后增量维护。
> —— `.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md`

现在的读法：

1. 触发事件本身就是 `plan/mode` 时，直接用 `event.data.active`（零延迟、不依赖读取顺序）；
2. 其余情况读 `sessionProjections.snapshot(session, ['plan'])` —— 未弃用的同步投影快照，只计算指定的 key，返回客户端的 wire 视图 `{ active, pending }`。

这也是上游自己在用的读法：`dsh-api-session-controller` 用 `snapshot(session, ['subagent'])` 读子代理身份做行为判断。

投影不可用（未注册、会话未附着）时返回 `undefined`，路由器保持不介入——失败方向是“退回原始 PTC”，不是“装一个半成品”。

## 5. 阶段提醒与缓存

提醒通过 `systemPrompt.context({ name: 'phase:mode', text })` 注册。DSH 的 runtime-context 投影**只在文本变化时**追加一条 `<system-reminder>` 用户消息，所以阶段不变时请求前缀逐字节稳定；相位切换时只在对话尾部追加，不动前缀。

工具表则无法避免变化：请求前缀的顺序是 `tools → system → messages`，执行器一换，工具数组和系统提示同时变，整段前缀失效。实测：

- 进入 plan：一次请求重算约 129 546 tokens（其余步骤恢复为约 2k 新增 / 130k 命中）；
- 退出 plan：前缀形态回到进入 plan 之前，通常能命中旧前缀（实测 135 424 tokens 命中）。

这是有意的取舍：用一次缓存 miss 换“计划阶段完全不受程序预算约束”。ZCode 的做法是保持工具表不变、只用权限与尾部提醒表达阶段，因此没有这次 miss；DSH 的工具表由执行器决定，二者无法同时满足。

## 6. 与 ZCode 的对照

ZCode 把“审批”和“超时”分在两个阶段：`resolveToolPermission`（含人工审批）完成后才创建 `ToolDeadline`，随后才进入 `executeWithTimeout`。也就是说，它的工具 deadline 从结构上就不覆盖审批等待。本预设的 plan 阶段达到同样效果——审批是一个普通工具调用，外面没有程序预算。

阶段提醒也同构：ZCode 用 `PLAN_MODE_FULL_REMINDER` / `SPARSE` / `EXIT` 追加在对话尾部；本预设用 `phase:mode` 段落，靠 runtime-context 的“变化才追加”实现相同效果。

差别在于强制力：ZCode 的 plan mode 是权限门，写操作会被拒绝；DSH 的 plan mode 是提示词约束，`write`/`edit` 仍然在工具表里，只是规则要求不要用。本预设不改变这一点。

## 7. 被否定的方案

| 方案 | 否定原因 |
|---|---|
| 改核心 / 打 asar | 每次升级重做，风险与维护成本高 |
| 把预算从 120s 调到 600s | 只抬高水位；等人的时间没有上界 |
| 独立 2h runtime + 遇审批暂停的看门狗 | 可行且验证过，但把 act 的预算语义改成了两套；计划审批移出程序后不再需要 |
| 超集预设（同时给 standard 与 run_code） | 把“什么时候用哪个”交给模型，确定性问题变成概率问题 |
| 批量预授权（程序内一次审批、批量执行） | 审批粒度由沙箱里的脚本决定，等于把安全边界交给不可信代码 |

## 8. 限制

- **版本耦合**：依赖 `setExecutor`/`selectExecutor` 的 scope 语义、`dsh-scope`、`plan` 投影与 `plan/mode` 事件。升级 DSH 后必须重新验证（`scripts/check-context-integrity.mjs` 可复核）。
- **粒度是会话**：路由器装在 agent scope，同一预设的其他会话互不影响；未进入过 plan 的会话不装路由器。
- **不改变审批策略**：只改变等待发生在哪个执行上下文，沙箱与审批规则一个字不动。
- **子代理未单独验证**：子代理若也使用该预设，会各自走同样的 install 路径，但未做端到端验证。

## 9. 上游引用

- `packages/core/tools/src/index.ts`：`setExecutor` / `selectExecutor` / 释放语义；
- `packages/core/session/src/index.ts`：`eventAt` 的 `@deprecated`；
- `packages/session/session-projection/src/index.ts`：`snapshot` / `stateOf` 的弃用关系；
- `packages/bundle/web-app/presets/ptc.patch.yml`：`planning` 组的 `isolate: { planMode: true }`；
- `.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md`；
- ZCode `apps/zcode-cli/packages/core/src/tool/executor/call-runner.ts`：审批 → deadline → 执行的顺序；
- ZCode `apps/zcode-cli/packages/core/src/runtime/helpers/runtime-reminders.ts`：计划提醒。
