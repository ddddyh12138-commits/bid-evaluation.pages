# bid-evaluation — Agent 移交说明

> 本文件记录本项目开发中反复踩过的坑和正确做法，供下一位 agent 接手时参考。
> **改用户可见交互前务必先读 [踩坑记录](#踩坑记录)，避免重复犯错。**

## 项目概览

评标（招标）管理 Web 应用，Cloudflare Pages + D1 部署。

- 管理端：`index.html` + `app.js`
- 评委端：`judge.html` + `judge.js`
- 后端：`functions/api/`（Pages Functions）
- 存储：Cloudflare D1，`schema.sql` 建表
- 第三方库（本地 `*.min.js`）：docx / mammoth / pdf.js / xlsx / qrcode / tesseract

## 部署

```bash
export CLOUDFLARE_API_TOKEN="<token>"
export CLOUDFLARE_ACCOUNT_ID="<account-id>"
unset all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY   # 代理会挡 wrangler
npx wrangler pages deploy . --project-name bid-evaluation --branch main --commit-dirty=true
```

⚠️ `cfut_` token 作用域受限，必须显式传 `CLOUDFLARE_ACCOUNT_ID`，否则鉴权失败。

## 踩坑记录（必读）

### 1. `defaultState()` 绝不能写死业务数据

`defaultState()` 只能放结构骨架（空 vendors/judges/dimensions/project）。**不能写死供应商名、评委名、项目名**。刷新时本地 defaultState 会覆盖云端 D1，已犯两次。

### 2. 改用户可见交互必须同步更新说明文案

改了评委端/管理端交互，**主动**同步 `judge.html` 的 helpModal 和管理端帮助文案，别等用户提醒。

### 3. 弹层只留右上角 ✕

弹层关闭按钮只保留 sticky 常驻的右上角 ✕，**底部不要放重复的关闭/知道了按钮**。

### 4. 横评折叠显示（重点，反复踩过）

`state.crossVendorAnalysis` 是 AI 生成的 markdown 横评正文，结构通常是：
```
## 综合结论
最推荐XXX。关键优势：...
#### 各供应商定位
1. ...
#### 主要风险
...
```

**正确做法**（`app.js` `viewDashboard` 的 `.cross-vendor-box`）：
- **收起状态（默认）**：只显示「综合结论·最推荐…」摘要，用 `extractCrossRecommendation(text)` 抽取「综合结论」段（到下一个 `##/###/####` 标题为止），`formatCrossSummary` 转格式化 HTML。
- **展开状态**：显示综合结论**之后**的剩余内容（各供应商定位、主要风险等），用 `extractCrossRest(text)` 抽取（综合结论段之后的部分），`formatCrossFull` 转格式化 HTML。**不要**在展开区重复显示综合结论。
- 整块标题+摘要区可点击切换，用 `data-action="toggle-cross-detail"`。

**踩过的坑（别再犯）**：
- ❌ 不要用 `<details>`/`<summary>` 包住全部内容再让 summary 显示摘要——原生 details 的展开会显示 summary 外的内容，无法实现「收起只看摘要、展开看剩余」。
- ❌ 不要在折叠区底部加「展开查看完整横评」按钮——冗余，用户嫌多余。点击整块标题/摘要区切换即可，右上角用「展开 ▾ / 收起 ▴」小标识提示。
- ❌ 新增 `data-action` 时**必须**把它加进 `bindViewEvents`（约 app.js:2035）的 action 白名单数组，否则 `handleAction` 收不到点击事件，按钮失效（`toggle-cross-detail` 就因此失效过一次）。
- ❌ `extractCrossRecommendation` 截取下一段标题时正则要覆盖 `#{2,4}`（##/###/####），不能只写 `#{2,3}`，否则遇到 `#### 各供应商定位` 会切不干净。

### 5. 签名校验与报告生成时机

- 评委端 `isAllScoringComplete()`（judge.js）**只校验所有供应商所有维度都打了分 + 总评填完**，**不要**强制要求 `currentVendorId` 推进到最后一家——管理员可能没推进到底或会议日期已过，强行卡住会导致评委填完也签不了名。
- 签名按钮（`renderList` 的 `sign-submit-btn`）**不要加 `disabled` 属性**，只用 `.disabled` class 做灰色视觉提示。始终可点击打开签名弹窗，最终校验放在 `doModalSign` 提交时做。
- 管理端报告生成（`gen-report` + `startSilentReportWatcher`）必须等**所有评委都签名锁定**（`allJudgesSigned()`）才生成，否则评分没收集完就出报告。

### 6. 返回前校验留在当前页

评委端 `checkVendorCommentBeforeLeave()`（judge.js）：对已讲完（`effectiveStatus === 'done'`）的供应商，点返回时必须校验「所有维度已打分 + 异常分已填扣分依据 + 总评已填」，未完成则 `alert` 提示并聚焦对应输入框、`return false` 阻止返回。**不要**把校验推迟到签名时才提示——用户希望在打分页当场知道哪里没填、被留在该页。讲标中/未开始的供应商允许自由进出。

### 7. AI 初评 / OCR 跨 tab 静默工作

- OCR（tesseract.js）和 AI 初评的进度提示要写进全局 `aiGenStatus`，`renderAll` 时用 `applyAiGenStatus` 恢复，否则切 tab 回来提示消失。
- `startPendingAiWatcher`（5s 轮询）补生成漏掉的 AI 初评；进行中的 async 流程切 tab 不中断，只有刷新/关闭页面才断。完成后 `aiGenRequests[vid] = null`，否则遗留句柄会误判「在跑」导致不再补生成。

### 8. 提交按钮即时反馈

`doModalSign` 等异步提交：点击**立即**禁用按钮 + 改文案「提交中…」+ 防重复点击（已禁用则 return），成功后保持禁用（避免误点二次提交），失败/超大数据才恢复。不要串行 await 几秒却无任何视觉反馈。

### 9. `currentVendorByDate` 必须下发评委端

`functions/api/state.js` 的 `safeState` 必须包含 `currentVendorByDate`，否则评委端 `getCurrentVendorIndex` 找不到推进状态，签名按钮/开放判断全失效。

### 10. 改完别留死代码，别留旧文案

本项目经历过多次来回改动（五维度总分列加了又删、上传报告按钮加了又删、横评折叠从 details 改成 extract 函数、UI 从奶油金改白底蓝），每次都容易留下没人调用的函数 / 不再渲染的 CSS 类 / 写在说明里但功能已删的文案。**改完务必 grep 一遍**：
- 删了某 `data-action` 的 DOM，就同时删 `bindViewEvents` 白名单数组里对应项和 `handleAction` 里的 case。
- 删了某功能，就 grep 函数名/CSS 类名是否还有定义但无引用；有就一起删，别留"以后可能用得上"。
- 改了报告/表格结构，记得同步 `index.html` helpModal 里的说明文字（"含技术合计、五维度总分"这种过时描述就是漏改的）。
- 改了主色（CSS 变量），grep 旧色值硬编码（如 `#c08328` / `rgba(192,131,40,…)` / Word 里的 `F5E8D6` `6B3A0A`），它们不走 CSS 变量不会自动跟变。

### 11. 事件委托调用要补 `currentTarget`

`archiveModal` 等动态弹层里用 `handleAction({ currentTarget: btn, target: e.target })` 手动转发点击事件。直接传 DOM 元素 `handleAction(btn)` 会导致 `e.currentTarget` 为 undefined，`toggle-archive-cross` 这类依赖 `el = e.currentTarget` 的 action 拿不到 dataset，按钮点了没反应。

### 12. UI 主题只改 CSS 变量，别动逻辑

UI 重设计（白底蓝主色）只改 `index.html` / `judge.html` 的 `:root` 变量与样式段，`app.js` / `judge.js` 一行不碰。颜色全部走 `var(--gold)` 等变量，改一处全站生效。注意签名 canvas 的 `strokeStyle` 和 Word 报告里的 `shading.fill` / `color` 是硬编码十六进制色，不读 CSS 变量，需单独替换。

## 提交流程

改完代码：
1. `node -c app.js judge.js functions/api/*.js` 语法检查
2. `wrangler pages deploy` 部署
3. `git add -A && git commit && git push`（GitHub: ddddyh12138-commits/bid-evaluation.pages.git）

## 已知外部依赖

- AI 用 GLM（open.bigmodel.cn），需在管理端「项目设置」配 Base URL / Model / API Key
- 评委端 10s 轮询 `/api/state` 同步；输入时不重渲染只落本地（`safeRenderAll`）
- 时区按 +08:00（Asia/Shanghai）
