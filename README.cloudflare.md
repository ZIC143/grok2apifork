# Grok2API（Cloudflare Workers / Pages：D1 + R2）

这个仓库已经新增 **Cloudflare Workers / Pages** 可部署版本（TypeScript）。

## 功能概览

- **D1（SQLite）**：持久化 Tokens / API Keys / 管理员会话 / 配置 / 日志
- **R2**：缓存 `/images/*` 的图片/视频资源（从 `assets.grok.com` 代理抓取）
- **自动清理**：
  - **TTL 清理**：按最后访问时间淘汰（默认 7 天）
  - **容量清理**：按后台配置的 `image_cache_max_size_mb` / `video_cache_max_size_mb` 限制总占用，删除最旧访问的对象
  - **触发方式**：Workers **Cron Trigger** 定时执行（`wrangler.toml` 已配置）

> 原 Python/FastAPI 版本仍保留用于本地/Docker；Cloudflare 部署请按本文件走 Worker 版本。

---

## 0) 前置条件

- Node.js 18+（你本机已满足即可）
- 已安装/可运行 `wrangler`（本仓库使用 `npx wrangler`）
- Cloudflare 账号（已托管域名更好，便于绑定自定义域名）

---

## 1) 初始化（本地）

```bash
npm install
```

登录 Cloudflare：

```bash
npx wrangler login
```

---

## 2) 创建并绑定 D1

创建 D1：

```bash
npx wrangler d1 create grok2api
```

把输出里的 `database_id` 填进 `wrangler.toml`：

- `wrangler.toml` 的 `database_id = "REPLACE_WITH_YOUR_D1_DATABASE_ID"`

应用迁移（会创建所有表）：

```bash
npx wrangler d1 migrations apply grok2api --remote
```

迁移文件在：
- `migrations/0001_init.sql`
- `migrations/0002_r2_cache.sql`

---

## 3) 创建并绑定 R2（用于图片/视频缓存）

创建 R2 bucket（名字需与 `wrangler.toml` 一致，默认 `grok2api-cache`）：

```bash
npx wrangler r2 bucket create grok2api-cache
```

如需改名，同时修改 `wrangler.toml` 的：

- `[[r2_buckets]]`
  - `binding = "R2_CACHE"`
  - `bucket_name = "<你的bucket名>"`

---

## 4) 配置自动清理（Cron + 参数）

`wrangler.toml` 已默认配置：

- `R2_CACHE_TTL_DAYS = "7"`：对象超过 N 天未访问会被清理
- `R2_CLEANUP_BATCH = "200"`：每轮清理批量大小（避免超时）
- `crons = ["0 */6 * * *"]`：每 6 小时运行一次清理

你也可以改成更频繁（例如每小时一次）：

```toml
[triggers]
crons = ["0 * * * *"]
```

容量限制来自后台设置：
- `image_cache_max_size_mb`
- `video_cache_max_size_mb`

登录后台后在「设置」里调整即可（无需重新部署）。

---

## 5) 部署到 Workers（推荐，功能最完整）

部署：

```bash
npx wrangler deploy
```

部署后检查：
- `GET https://<你的域名或workers.dev>/health`
- 打开 `https://<你的域名或workers.dev>/login`

默认管理员账号密码：
- `admin / admin`

强烈建议登录后立刻修改（在「设置」里改 `admin_password` / `admin_username`）。

---

## 5.1) GitHub Actions 一键部署（推荐）

仓库已包含工作流：`.github/workflows/cloudflare-workers.yml`，在 `main` 分支 push 时会自动：

1. `npm ci` + `npm run typecheck`
2. `wrangler d1 migrations apply grok2api --remote`
3. `wrangler deploy`

你需要在 GitHub 仓库里配置 Secrets（Settings → Secrets and variables → Actions）：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`（建议填写；如果你的 Token 只对应单一账号，有时也可不填）

然后直接 push 到 `main`（或在 Actions 页面手动 Run workflow）即可一键部署。

> 注意：R2 bucket（默认 `grok2api-cache`）需要提前在 Cloudflare 创建；D1 的 `database_id` 已写在 `wrangler.toml`。
>
> 另外：`app/template/_worker.js` 是 Pages Advanced Mode 的入口文件。Workers 部署时会被 `app/template/.assetsignore` 排除，避免被当成静态资源上传导致部署失败。

---

## 6) 绑定自定义域名（你有 CF 托管域名）

在 Cloudflare Dashboard：

1. Workers & Pages → 选择 `grok2api` 这个 Worker
2. Settings / Triggers（不同 UI 可能略有差异）
3. 找到 **Custom Domains** → Add
4. 选择你的域名并创建

绑定完成后，直接用你的域名访问 `/login` 与 `/v1/*` 即可。

---

## 7) 后台初始化配置（必须）

登录 `/manage` 后至少配置：

1. **Tokens**：添加 `sso` 或 `ssoSuper`
2. **设置**：
   - `dynamic_statsig`（建议开启）
   - 或者关闭动态并填写 `x_statsig_id`
   - （可选）填写 `cf_clearance`（只填值，不要 `cf_clearance=` 前缀）
3. **Keys**：创建 API Key，用于调用 `/v1/*`

---

## 8) 接口

- `POST /v1/chat/completions`（支持 `stream: true`）
- `GET /v1/models`
- `GET /images/<img_path>`：从 R2 读缓存，未命中则抓取 `assets.grok.com` 并写入 R2
- 管理后台 API：`/api/*`（用于管理页）

---

## 9) 部署到 Pages（可选，但不推荐用于“定时清理”）

仓库已提供 Pages Advanced Mode 入口：
- `app/template/_worker.js`

部署静态目录：

```bash
npx wrangler pages deploy app/template --project-name <你的Pages项目名> --commit-dirty
```

然后在 Pages 项目设置里添加绑定（名称必须匹配代码）：
- D1：绑定名 `DB`
- R2：绑定名 `R2_CACHE`

注意：
- **自动清理依赖 Cron Trigger**，目前更推荐用 Workers 部署该项目以保证定时清理稳定运行。
