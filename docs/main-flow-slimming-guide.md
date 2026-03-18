# 主流程瘦身建议（Bot）

更新时间：2026-03-05  
适用仓库：`Bot`

## 目标

- 减少机器人在高并发下的卡顿和超时。
- 保证资金与订单状态优先正确落库。
- 将非关键 Discord API 调用改为异步，降低主流程等待时间。

## 核心原则

1. 事务内只做数据库读写，不做 Discord `send/edit/reply`。
2. 主流程只返回“关键反馈”。
3. 非关键反馈走异步队列（Outbox/Job Queue），失败重试，不影响主交易。

## 关键反馈（同步保留）

- 按钮点击是否成功（ack）。
- 扣款/入账成功与否。
- 余额不足、权限不足、参数错误。
- 订单关键状态变更结果（如接单/结单成功）。

## 非关键反馈（异步处理）

- 私信（DM）通知。
- 管理频道播报。
- 图片消息发送。
- 次要或高频 embed 更新。
- “已成功但不影响资金”的补充文案。

## 按模块拆分建议

### 1) `src/commands/gifting.ts`

- 同步：扣款、返利、流水、余额变更。
- 异步：频道播报、图片消息、高额礼物提醒、DM。

### 2) `src/services/orderService.ts` + `src/interactions/buttons/endOrder.ts`

- 同步：计费、订单状态、老板扣款、陪玩入账、抽成落库。
- 异步：结单 DM、频道结单公告、榜单刷新触发。

### 3) `src/interactions/buttons/blockStack.ts` + `src/services/redEnvelopeService.ts`

- 同步：抽取结果、资金变更、红包记录创建。
- 异步：高频 embed 更新、补充文本、次级状态广播。

### 4) `src/services/chatVoucherDropService.ts`

- 同步：命中判定、发券/积分写库。
- 异步：reply embed、管理频道 @ 提醒。

### 5) `src/services/voicePointService.ts`

- 同步：积分结算写库。
- 异步：带图的 DM embed 通知。

## 建议实现方式：Outbox 模式

1. 主流程事务成功后，写一条 outbox 任务（包含事件类型、payload、重试次数）。
2. Worker 定时拉取 pending 任务并调用 Discord API。
3. 成功标记 done；失败指数退避重试；超过阈值标记 dead 并告警。

## 时效目标（建议）

- 主流程响应：`< 300ms`（不含网络抖动）。
- 异步消息到达：`0.3s ~ 3s`。
- 异步失败重试：3~5 次（指数退避）。

## 幂等与防重复

- 每类业务事件都带 `idempotencyKey`（如 `orderId:eventType:version`）。
- Worker 发送前先查重，避免重复发消息。
- 数据库层加唯一键，防止重复写资金流水。

## 落地优先级

1. **P0**：`gifting` 主流程与通知拆分。
2. **P0**：`endOrder` 主流程与通知拆分。
3. **P1**：`blockStack/redEnvelope` 高频更新节流与合并 edit。
4. **P1**：`chatVoucherDrop` reply/播报改异步。
5. **P2**：统一 Outbox 监控面板（失败率、重试次数、堆积量）。

## 验收标准

- 高峰时段主命令“先回执、后通知”明显稳定。
- 无资金错账、无重复扣款。
- 失败消息可重试，且可追踪失败原因。
- 用户关键反馈不受影响（成功/失败结果即时可见）。

