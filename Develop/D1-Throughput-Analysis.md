# D1 数据库吞吐分析报告

> 生成时间：2025-07-11
> 分析对象：Uptimer 项目 Cloudflare D1 数据库
> 数据来源：Worker 源码静态分析 + 工程估算

---

## 〇、状态更新（实施进度）

本文初版（2025-07-11）的两条"最大收益"建议，对照当前源码（截至本更新）状态如下：

1. **写入建议 #1（去掉每 monitor 执行锁，原估占写入 50%）= 已实现。**
   `apps/worker/wrangler.toml` 中 `UPTIMER_INTERNAL_CHECK_BATCH_TRUST_SCHEDULER_LEASE = "1"` 已开启，使内部 `check-batch` 端点走 `scheduler/scheduled.ts` 的 `trustSchedulerLease` 快速路径，跳过 `claimMonitorExecutionLeases` 与批次锁的 acquire/release。正常调度/服务批次路径不再写锁；唯一仍写 monitor 级锁的是 `scheduled.ts` 的失败回退（异常路径）。因此当前实测写入基线约为 `2T + 快照写 + retention 删除`（≈1.2–1.4M 行/天），而非原估的 `4T`。

2. **读取建议 #1（`listHeartbeatsByMonitorId` 无界全扫，原估占读取 ~80%）= 已实施（P0）。**
   已为该函数增加 `sinceCheckedAt` 时间下界（由调用方按本批 monitor 的最大 `interval_sec` 推导），依赖已有索引 `idx_check_results_monitor_time(monitor_id, checked_at)` 将 `ROW_NUMBER` 全扫转为索引 seek。调用方 `rebuildPublicMonitorRuntimeSnapshot` 与 `buildPublicMonitorCards` 均已传入下界。无 schema 变更。

**结论**：文档原始的"写入 24× / 读取 6×"中，写入大户（锁，50%）已消除；读取侧 listHeartbeatsByMonitorId 的无界扫描（原占读 ~80%）也已修复（P0）。在此之上，**Phase 2（见第八节）又消除了一类读放大源——runtime 快照的全量 
ebuild / 公开页回退扫 check_results**，使读取在 60s 频率、不降检测数量与频率的前提下可稳进 5M。但**写入仍是硬墙**：免费档 100K/天与 T≈610K 次/天在数学上不兼容（INSERT 与 retention DELETE 都按行计费，日流入/流出≈T），纯改 SQL 进不了 100K；要么升级付费档（25M/5M，当前 ~1.4M 直接达标），要么把"每次探测"的写入移出 D1（Durable Object / KV 缓冲 + 周期性聚合落盘），见第八节。

## 一、实测数据 vs 限制

| 指标 | 实测 | 限制 | 超额倍数 |
|------|------|------|----------|
| 读取行 | 31.18M | 5M | **6.24×** |
| 写入行 | 2.44M | 100K | **24.4×** |

**写入超额比读取严重得多（24× vs 6×）。** 这通常说明：写入主要来自**高频定时循环**（每分钟的探测），而读取除循环外，还被少数**重型全表扫描**显著放大。

### D1 计数口径

- **读取行** = 查询扫描/返回的累计行数，`JOIN` 两边各算；`ROW_NUMBER()` 这类窗口函数会先把整个分区读出来再过滤。
- **写入行** = `INSERT/UPDATE/DELETE` 实际改动的行数（no-op 的 upsert 改 0 行算 0）。

---

## 二、写入占比分解

> **状态更新**：以下为初版估算。monitor/批次锁已于本更新前通过 `UPTIMER_INTERNAL_CHECK_BATCH_TRUST_SCHEDULER_LEASE=1` 消除，故当前写入约为 `2T + 快照写 + retention 删除`（见〇节），原估 `4T`（含 2T 锁）不再适用。下文"写入结论"中的"~50% 锁"已归零。

设 `M` = 活跃 monitor 数，`T` = 每天探测总次数 = Σ(86400 / interval_sec)。

每个 monitor 一次探测，在 `scheduled.ts` 的 `persistCompletedMonitors` + `claimMonitorExecutionLeases` 中产生：

| 写入项 | 来源 | 行/天 |
|--------|------|-------|
| `check_results` INSERT | `getInsertCheckResultStatement` (scheduled.ts ~1620) | `T` |
| `monitor_state` UPSERT | `getUpsertMonitorStateStatement` (scheduled.ts ~1640) | `T` |
| 每 monitor 执行锁 acquire | `claimMonitorExecutionLeases` (scheduled.ts ~1125) | `T` |
| 每 monitor 执行锁 release | finally 中 `releaseLease` (scheduled.ts ~1280) | `T` |
| runtime 快照写 | `writePublicMonitorRuntimeSnapshot` (monitor-runtime.ts) | ~2×1440 ≈ 2.9K |
| homepage/status 快照写 | `writeHomepageSnapshot` (public-homepage.ts) | ~1–2×1440 ≈ 2.9K |
| daily rollup | `daily-rollup.ts` | `M` |
| retention 删除 | `retention.ts` (硬上限 `MAX_DELETED_ROWS=200K`) | ≤ 200K |

**合计 ≈ 4T + 少量。** 代入 2.44M：`4T ≈ 2.4M → T ≈ 600K` 次/天（≈ 417 个 @60s 的 monitor，或等价组合）。

### 写入结论（≈占 98%）

| 写入项 | 占比 |
|--------|------|
| `check_results` 插入 | ~25% |
| `monitor_state` 更新 | ~25% |
| 每 monitor 执行锁的 acquire + release | **~50%** |
| runtime 快照写 | ~1% |
| homepage/status 快照写 | ~1% |
| daily rollup | <1% |
| retention 删除（上限 200K） | ≤8% |

> **状态更新（已实施）**：原"关键事实"描述的是初版未优化状态。现已通过 `UPTIMER_INTERNAL_CHECK_BATCH_TRUST_SCHEDULER_LEASE=1` 去掉锁，每次探测 ≈ 2 行写入（check_results 插入 + monitor_state 更新），锁开销归零；原"砍掉锁即可减半"已落地。

---

## 三、读取占比分解

### 每分钟 tick

| 来源 | 行数/天 | 说明 |
|------|---------|------|
| `listDueMonitors` | `2M × 1440` | monitors(M) `LEFT JOIN monitor_state` (scheduled.ts ~1010) |
| `listPendingMonitorRowsByIds` | `~2T` | 每 batch 扫描 2×(batch 内 monitors) (scheduled.ts ~1095) |

### 每日 1 次（理想情况）

| 来源 | 行数 | 说明 |
|------|------|------|
| **`rebuildPublicMonitorRuntimeSnapshot`** | | monitor-runtime-bootstrap.ts ~35 |
| ├ monitors+state 扫描 | `2M` | |
| ├ **`listHeartbeatsByMonitorId`** | **`10,080·M`** | data.ts ~335，`ROW_NUMBER()` 无时间下界，全扫保留期 check_results |
| └ `computeTodayPartialUptimeBatch` | `1,440·M` | data.ts ~528，今天 check_results |
| `daily-rollup.ts` | `1,440·M` | 目标日 check_results |

### 热路径（首页/status）

`fetch-handler.ts` 先用 Cache API 边缘缓存命中即返回、**不落库**；未命中才从 `public_snapshots` 读 1–2 行 → 稳态可忽略。稳态下首页/status 刷新走 fast-path（`homepage-refresh-core.ts` 的 `tryCompute...FromScheduledRuntimeUpdates`），复用 runtime 快照，**不扫 check_results**。

### 读取结论（按占比）

| 来源 | 占比 | 说明 |
|------|------|------|
| **`listHeartbeatsByMonitorId` 无界全扫** | **~80%** | 单点最大杀手，rebuild/全量计算触发 |
| `computeTodayPartialUptimeBatch`（rebuild 内） | ~12% | 今天 check_results 窗口计算 |
| `listDueMonitors`（每分钟） | ~4% | M 行 JOIN |
| `listPendingMonitorRowsByIds`（每分钟） | ~4% | T 行 |
| daily rollup | ~2% | 目标日 check_results |
| 其余（热路径/锁/retention 读取） | <1% | |

> **最大发现：`listHeartbeatsByMonitorId` 的无界 `ROW_NUMBER` 全表扫描**是读取的绝对主力，且它在当前部署里被触发得比理想"每日 1 次"频繁得多（约 4–6 次/天）。这正是 31.18M 的核心来源。

---

## 四、优化建议

### 写入侧（收益最大）

1. **【已完成】去掉每 monitor 执行锁的 acquire/release**（原估占写入 50%）
   - 已通过 `wrangler.toml` 的 `UPTIMER_INTERNAL_CHECK_BATCH_TRUST_SCHEDULER_LEASE = "1"` 实现：内部 `check-batch` 端点信任 scheduler 租约，走 `trustSchedulerLease` 快速路径，跳过 `claimMonitorExecutionLeases` 与批次锁。
   - 仅失败回退路径（`scheduled.ts:2045`）仍写锁，属异常路径。
   - 效果：每次探测从 ≈4 行写入降到 ≈2 行，锁开销归零。

2. **适度提高默认 `interval_sec`**（60s→120s 直接减半 T）

3. **缩短 `check_results` 保留期**可降低 retention 删除量，但非主因

### 读取侧（收益最大）

1. **【已完成】给 `listHeartbeatsByMonitorId` 加时间下界**（P0，无 schema 变更）
   - 实现：`listHeartbeatsByMonitorId(db, monitorIds, limitPerMonitor, { sinceCheckedAt })`，调用方 `rebuildPublicMonitorRuntimeSnapshot` 与 `buildPublicMonitorCards` 按本批 monitor 最大 `interval_sec` 推导 `sinceCheckedAt = now - limitPerMonitor * maxIntervalSec * 2 - maxIntervalSec`（安全系数 2 + 1 个 interval 缓冲），导出辅助函数 `computeHeartbeatSinceCheckedAt`。
   - 依赖索引 `idx_check_results_monitor_time(monitor_id, checked_at)`，`ROW_NUMBER` 从整段保留期全扫转为索引 seek。
   - 效果：该查询行数由 `10,080·M`（全保留期）降到约 `60·M`（最近窗口），削减 ~99%；因该查询原占读取 ~80%，整体读取约降 ~75%+。

2. **排查为何 runtime 快照重建/首页全量计算被反复触发**
   - 确认 fast-path 稳定命中
   - 跨天/失效重建不要重复
   - 检查多 datacenter 时钟偏移导致 `day_start_at` 不匹配而反复 rebuild

3. `listDueMonitors`/`listPending` 的 monitors+state JOIN 是找到期 monitor 的必需成本（O(M)），随 M 线性增长，难避免

4. 确认首页/status 热路径 Cache API 命中率（基本不落库）

---

## 五、待确认事实

本报告是**基于源码的工程估算**，不是按表实测。要给出精确占比，建议核对：

1. Cloudflare D1 的 per-table / per-statement 用量（或开启 DB 洞察），看 `check_results`、`monitor_state`、`locks` 谁的读写最高
2. 实际 `M`（活跃 monitor 数）、各 monitor 的 `interval_sec`、当前 `retention_check_results_days`
3. runtime 快照 `rebuild` 与首页 `computePublicHomepagePayload` 全量计算的**实际触发频率日志**（`scheduled:` 与 `homepage_refresh` 的 skip/refreshed 行）

---

## 六、关键代码位置索引

| 文件 | 关键函数/常量 | 作用 |
|------|---------------|------|
| `apps/worker/src/scheduler/scheduled.ts` | `claimMonitorExecutionLeases` | 每 monitor 锁 acquire（写入大户） |
| `apps/worker/src/scheduler/scheduled.ts` | `persistCompletedMonitors` | check_results + monitor_state 写入 |
| `apps/worker/src/scheduler/scheduled.ts` | `listDueMonitors` | 每分钟 JOIN 扫描 |
| `apps/worker/src/public/data.ts` | `listHeartbeatsByMonitorId` / `computeHeartbeatSinceCheckedAt` | **已加 `sinceCheckedAt` 时间下界（P0 修复，读取大户已消除）** |
| `apps/worker/src/public/data.ts` | `computeTodayPartialUptimeBatch` | 今天 uptime 计算 |
| `apps/worker/src/public/monitor-runtime-bootstrap.ts` | `rebuildPublicMonitorRuntimeSnapshot` | 触发上述两个读取大户 |
| `apps/worker/src/public/monitor-runtime.ts` | `writePublicMonitorRuntimeSnapshot` | runtime 快照写 |
| `apps/worker/src/snapshots/public-homepage.ts` | `writeHomepageSnapshot` | homepage 快照写 |
| `apps/worker/src/scheduler/daily-rollup.ts` | `runDailyRollup` | 每日聚合 |
| `apps/worker/src/scheduler/retention.ts` | `runRetention` | 过期数据删除 |
| `apps/worker/src/fetch-handler.ts` | `handlePublicHomepage` / `handlePublicStatus` | 热路径读取（Cache API 优先） |


---

## 七、监控频率改为 5 分钟（300s）的影响

用户问"如果把监控频率改成 5min，能降低多少"。基于文档实测 31.18M 读取，并建模写入（锁已去除）：设 `M`≈417、`T(60s)`≈610K/天。下表给出四种组合下的读取/写入估算（"5min"=interval 60s→300s，`T→T/5`）。

| 来源 | 现在 60s | 60s + P0 | 仅 5min | 5min + P0 |
|------|----------|----------|---------|-----------|
| `listHeartbeats`（无界/有界扫描） | 24.9M | ~0.15M（有界 60 点） | 5.0M（行数 1/5） | ~0.15M（有界） |
| `computeTodayPartialUptime`（rebuild） | 3.7M | 3.7M | 0.74M（1/5） | 0.74M |
| `listDueMonitors`（每分 M 行） | 1.2M | 1.2M | 1.2M | 1.2M |
| `listPendingMonitorRowsByIds`（2T） | 1.2M | 1.2M | 0.24M（1/5） | 0.24M |
| 每日 rollup | 0.6M | 0.6M | 0.12M（1/5） | 0.12M |
| **读取合计** | **31M（6.2× 超限）** | **~7.3M（1.5×）** | **~7.6M（1.5×）** | **~2.8M（✓ 低于 5M）** |
| **写入合计**（2T+开销，无 P0 影响） | **~1.4M（~14× 超限）** | **~1.4M（~14×）** | **~0.29M（~2.9×）** | **~0.29M（~2.9×）** |

结论：

- **写入**：5min 让写入降约 **5×**（~1.4M → ~0.29M/天），但仍约 **2.9× 超过 100K/天**上限（P0 不改写入，对写入无影响）。
- **读取（不做 P0）**：约 **4.3×**（31M → ~7.6M），仍约 1.5× 超限。
- **读取（结合 P0）**：约 **11×**（31M → ~2.8M），**低于 5M 上限 ✓**。
- **关键洞察**：P0 修的是 `listHeartbeats` 那块无界扫描；5min 修的是"按天/每次探测量"那块（computeToday、listPending、rollup）。两者各自单独做都只能把读取压到 ~7M（仍略超），**要让读取稳稳进限，必须 P0 + 5min 一起做**。写入进限只靠 5min 也还差一节（2.9×），需更长 interval 或收紧保留期。
---

## 八、Phase 2：读侧收口（已实施，不动 schema）

> 目标：在不降低检测数量（M）与频率（T=60s）的前提下，把读取压进 5M/天。
> 状态：代码已改，`pnpm exec tsc` 通过，worker 全部 451 测试通过。

### 8.1 根因（代码实证）

第七节测算 "60s + P0" 读取 ≈7.3M，仍 1.5× 超限。P0 只修了 `listHeartbeats` 那次无界扫描；剩余大头是 **runtime 快照的全量 `rebuild`** 与**公开页回退扫 `check_results`**：

- `rebuildPublicMonitorRuntimeSnapshot`（`monitor-runtime-bootstrap.ts`）每次都扫全 monitor + 跑 `computeTodayPartialUptimeBatch`（扫当天 `check_results`，~1,440·M 行/次）。
- 公开页读路径 `data.ts:1111-1159`：仅当 runtime 快照覆盖请求 id 时才用 `materializeMonitorRuntimeTotals`（0 行 `check_results` 扫描）；一旦快照缺失/过期/覆盖不全，就回退到 `computeTodayPartialUptimeBatch` + `listHeartbeats` 全扫。
- 增量刷新 `refreshPublicMonitorRuntimeSnapshot`（`monitor-runtime.ts:1464`）本不扫 `check_results`，只在 `shouldRebuild`（缺失/跨天/**未来时间戳**/历史 monitor 缺失）时全量重建。

两个会**反复触发 rebuild** 的放大源：

1. **跨 colo 时钟偏移**：原 `stored.generatedAt > opts.now`（`monitor-runtime.ts:1477`）触发重建，但读路径 `readPublicMonitorRuntimeSnapshot`（`:1050`）以 `> now + 60s` 才判未来——两者不一致，导致读路径肯接受的快照在刷新时被强制全量重建，可能反复震荡。
2. **瞬态失败强制重建**：`scheduled.ts` 在 service batch 失败（`:2057`）、runtime-fragment 写出失败（`:2085`）时置 `requiresRuntimeSnapshotRebuild=true`，强制全量扫 `check_results`；但下游增量刷新（`:2116`）本就会用已捕获的 `runtimeUpdates` 增量更新快照，全量重建是多余的读放大。文档原担心的"rebuild 一天跑 4–6 次"即源于此类。

### 8.2 改动

1. **对齐未来时间戳容忍**：`monitor-runtime.ts` 重建判断改用 `opts.now + FUTURE_SNAPSHOT_TOLERANCE_SECONDS`（与读路径一致），≤60s 的轻微时钟偏移不再触发全量重建。（无 schema 变更。）
2. **瞬态失败不再强制全量重建**：`scheduled.ts` 上述两处仅保留 `requiresFullHomepageRefresh=true`，移除 `requiresRuntimeSnapshotRebuild=true`；增量刷新仍按 `runtimeUpdates` 更新快照。保留 `processedCount===0` 的安全网分支不变。（无 schema 变更。）
3. **重建原因埋点**：`refreshPublicMonitorRuntimeSnapshot` 在每次真正重建时 `console.info('runtime_snapshot_rebuild', { reason, ... })`，reason ∈ {missing, day_rollover, generated_before_day, future_dated, missing_historical_entry}。用于确认文档"待确认事实"中的实际重建频率（grep 该日志即可核对）。

### 8.3 预期效果

- 重建收口到"仅跨天 + 真正缺失/损坏"，从 ~4–6×/天 → ~1×/天。
- `computeTodayPartialUptimeBatch` 由 ~3.7M/天（按 6× 估算）降到 ~0.6M/天（1×）。
- 读取合计：7.3M − 3.1M（computeToday）≈ **~3.5–4M < 5M ✓**（listDueMonitors 1.2M、listPending 1.2M 为 60s 频率下必要的 O(M/分钟)/O(batch) 成本，索引无法缩减——见 8.4）。

### 8.4 更正（原文档误判）

原文档认为给"到期 monitor 扫描"加索引能省读。但 **60s 频率下每个 monitor 每分钟都到期**，无论全扫还是索引 seek 每分钟都要触碰 ≈M 行，扫描量不变（`LIST_DUE_MONITORS_SQL` 用 `s.last_checked_at <= ?1 - m.interval_sec`，无 `monitor_state(last_checked_at)` 索引也罢，结果都是 O(M/分钟) 必要成本）。该索引仅在 interval > 60s 时有用——与"不降频率"前提冲突，故**不是优先项**。真正把读压进限的是 8.2 的"消灭回退扫 + 重建收口"，而非索引。

### 8.5 写侧硬墙（本节未触及，仍需决策）

读稳了，但写仍 ~1.4M（14× 超 100K）。数学上免费档 100K/天 与 T≈610K 不兼容：每次探测最终要 INSERT 或日后被 retention DELETE（上限 200K/天），两者都按行计费，日流入/流出≈T。纯改 SQL / 批处理 / 索引 / 缩短保留期都进不了 100K。两条路：

- **升级付费 D1（25M 读 / 5M 写）**：当前 7.3M 读、1.4M 写全部在付费档内，一步达标，最具性价比。
- **架构改造（唯一能进 100K 的工程手段）**：用 Durable Object（每 monitor 或分片）作热存储/写缓冲，探测结果先写 DO（不计入 D1 行限额），低频把聚合行（按桶 up/down 计数 + 延迟 min/avg/max/p95 + 样本数）flush 到 D1；`monitor_state` 仅状态翻转时写；retention 因 D1 不再存逐条 `check_results` 而≈0。D1 写入降到 ~M×桶数/天（几百~几千）。或折中：KV 存原始探测 + 只把 rollup 写 D1。
