# bid-evaluation

评标（招标）管理 Web 应用，部署在 Cloudflare Pages + D1。

> **给 agent：接手前请先读 [AGENTS.md](./AGENTS.md)，里面有反复踩过的坑和正确做法，避免重复犯错。**

## 功能

- 多供应商 / 多评委 / 多评分维度的评标流程
- 管理员配置项目、维度、评委、供应商，外链发给评委打分
- 评委手机 / 电脑打开外链即可打分，全部打完手写签名并提交（锁定）
- 支持管理员手动推进讲标进度（第一家到开始时间自动开放，之后手动「结束当前，开始下一家」）
- AI 初评：粘贴投标材料（PDF / Word / Excel），AI 给出各维度建议分及评分依据（50-150 字）
- 资质核验：填招标要求后逐条核验供应商资质
- 供应商横评：一键生成所有供应商横向对比分析，归档到历史库
- 自动生成 Word 评标报告（含评委签字、签名时间、各供应商总评）
- 历史库 / 复用为新项目

## 架构

- 前端：纯静态 `index.html` + `app.js`（管理端），`judge.html` + `judge.js`（评委端）
- 后端：Cloudflare Pages Functions，位于 `functions/api/`
- 存储：Cloudflare D1（`wrangler.toml` 中配置），`schema.sql` 为建表脚本
- 状态：通过 `state`（D1 中的 JSON blob）集中管理

## 部署

```bash
export CLOUDFLARE_API_TOKEN="<token>"
export CLOUDFLARE_ACCOUNT_ID="<account-id>"
npx wrangler pages deploy . --project-name bid-evaluation --branch main
```

D1 数据库需先创建并执行 `schema.sql`。

## 目录结构

```
.
├── index.html / app.js        # 管理端
├── judge.html / judge.js      # 评委端
├── functions/api/             # Pages Functions（_lib.js 共享工具，其余为各 API）
├── schema.sql                 # D1 建表
├── wrangler.toml              # Cloudflare 配置
└── *.min.js                   # 第三方库（docx / mammoth / pdf.js / xlsx / qrcode）
```
