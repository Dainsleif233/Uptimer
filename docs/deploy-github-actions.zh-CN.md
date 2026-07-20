# 部署指南（GitHub Actions）

[English](deploy-github-actions.md) | 中文

通过仓库内置的 GitHub Actions 工作流将 Uptimer 部署到 Cloudflare。

## 前置要求

- GitHub 仓库（默认分支为 `master` 或 `main`）
- Cloudflare 账号
- 具有部署权限的 Cloudflare API Token
- 仓库 Settings > Secrets and Variables 的配置权限

## 工作流概览

**触发方式**：推送到 `main`/`master`，或手动触发 `workflow_dispatch`

**配置文件**：`.github/workflows/deploy.yml`

**执行步骤（按顺序）**：

1. 安装 Node + pnpm + 依赖
2. 解析 Cloudflare Account ID（优先读配置，回退到 API 查询）
3. 计算资源命名（Worker / D1）
4. 检查或创建 D1 数据库，注入真实 `database_id` 到临时 `wrangler.ci.toml`
5. 远程执行 D1 迁移
6. 构建前端（Vite）到 `apps/web/dist`
7. 部署 Worker —— 将构建好的 SPA 作为静态资源与 API 一起上传
8. （可选）写入 Worker Secret：`ADMIN_TOKEN`

前端与 API 部署为同一个 Worker，因此没有独立的 Pages 项目，也无需配置跨域 API 地址。

## 配置说明

### 必需密钥

| 名称                   | 必需 | 说明                                                    |
| ---------------------- | ---- | ------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN` | 是   | Cloudflare API 认证                                     |
| `UPTIMER_ADMIN_TOKEN`  | 是   | 管理面板访问密钥；自动写入 Worker 的 `ADMIN_TOKEN` 密钥 |

### 推荐密钥

| 名称                    | 说明             |
| ----------------------- | ---------------- |
| `CLOUDFLARE_ACCOUNT_ID` | 避免自动解析失败 |

### 可选变量

覆盖默认命名：

| 名称                                     | 默认值               | 说明                      |
| ---------------------------------------- | -------------------- | ------------------------- |
| `UPTIMER_PREFIX`                         | 仓库名 slug          | 统一资源名前缀            |
| `UPTIMER_WORKER_NAME`                    | `${UPTIMER_PREFIX}`  | Worker 名称               |
| `UPTIMER_D1_NAME`                        | `${UPTIMER_PREFIX}`  | D1 数据库名               |
| `UPTIMER_D1_BINDING`                     | `DB`                 | Worker 中 D1 binding 名称 |
| `VITE_ADMIN_PATH` / `UPTIMER_ADMIN_PATH` | —                    | 自定义管理后台路径        |

> 若不配置命名变量，工作流会使用仓库名 slug 作为默认前缀。这在 fork 场景下能保持命名稳定。
>
> **API 地址**：无需配置——前端与 API 共用同一个来源（Worker URL），SPA 以相对路径调用 `/api/v1`。

## Cloudflare Token 权限

工作流会创建和更新多个资源，你的 Token 需要以下权限：

- Workers 脚本：部署与管理密钥
- D1：查询、创建与迁移数据库
- 账号：读取账号信息（用于 Account ID 解析）

## 首次部署

1. 在仓库 Secrets 中添加 `CLOUDFLARE_API_TOKEN`
2. 添加 `UPTIMER_ADMIN_TOKEN`（管理面板访问密钥）
3. 添加 `CLOUDFLARE_ACCOUNT_ID`（推荐）
4. （可选）设置 `UPTIMER_PREFIX`，避免与其他实例重名
5. 推送到 `master`/`main`，或手动触发 "Deploy to Cloudflare"
6. 工作流成功后，从日志中记录 Worker URL —— 状态页、管理后台与 API 都在该域名下

## 部署后验证

### 检查状态页

- 访问 Worker URL（公共状态页）
- 导航到 `/admin`（或你自定义的 `VITE_ADMIN_PATH`）

### 测试 API

```bash
# 公开 API
curl https://<worker-url>/api/v1/public/status

# 管理 API
curl https://<worker-url>/api/v1/admin/monitors \
  -H "Authorization: Bearer <YOUR_ADMIN_TOKEN>"
```

### 验证数据库（可选）

使用 Wrangler 检查 D1 中关键表是否存在：

```
monitors, monitor_state, check_results, outages, settings
```

## 故障排除

### "Resolve Cloudflare Account ID" 失败

- 确认 `CLOUDFLARE_API_TOKEN` 已设置且有效
- 确认 Token 具有账号读取权限
- 直接设置 `CLOUDFLARE_ACCOUNT_ID` 跳过自动解析

### D1 迁移失败

- 检查 `UPTIMER_D1_BINDING` 是否与 `apps/worker/wrangler.toml` 中的 binding 一致
- 确认迁移 SQL 是幂等的且语法正确

### 静态资源或 SPA 路由返回 404

- 确认 `Build Web (Vite)` 步骤在 `Deploy Worker` 之前已生成 `apps/web/dist`
- 确认 `apps/worker/wrangler.toml` 中 `[assets]` 指向 `../web/dist`，且 `not_found_handling = "single-page-application"`
- `/admin` 等深链接依赖 SPA fallback，仅在部署后的 Worker 上生效（本地开发请使用 `:5173` 的 Vite 服务器）

### 管理端返回 401

- 确认 `UPTIMER_ADMIN_TOKEN` 已写入 Worker Secret
- 检查浏览器 localStorage 中的 token 是否与 Secret 一致

## 回滚

优先重新部署上一个已知可用的 commit：

1. 找到上一个绿色部署 commit
2. 基于该 commit 重新触发 "Deploy to Cloudflare"
3. 若涉及 Schema 变更，通过新增前向兼容 migration 修复，而非回滚

> D1 迁移不应做破坏性回滚。若远程迁移已执行，请通过新增 migration 向前修复。

## 与 CI 的关系

| 工作流       | 用途                            |
| ------------ | ------------------------------- |
| `ci.yml`     | 质量门禁：lint、typecheck、test |
| `deploy.yml` | 生产发布                        |

推荐的分支策略：

- PR 合并前必须通过 CI
- `master`/`main` 仅接收经过 Review 的变更
- 发布由 push 自动触发，避免手工漂移
