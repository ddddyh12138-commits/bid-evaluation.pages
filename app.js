/* 智能评标室 V2 · 管理员端
 * 数据走 Cloudflare D1，跨设备同步。
 * 阶段/截止时间根据会议时间自动算。
 */

const STORAGE_KEY = 'bid-evaluation-state-v7';
const API_BASE = '/api';
const uid = () => Math.random().toString(36).slice(2, 9);

const DEFAULT_DIMENSIONS = [
  {
    id: 'd1', name: '方案整体适配性', max: 20,
    details: [
      '1.1 需求响应度：贴合手杀国庆节点活动，覆盖传播方向，遵循宣发要求及授权周期。',
      '1.2 预算配比合理性：贴合参考配比，拆分清晰，可保障 CPM 及 KPI 达标。',
      '1.3 达人类型适配性：覆盖全部必要达人，画像精准、数量达标，可提供达人资源及案例。',
    ],
    standard: '好（14-20分）；较好（8-14分）；一般（1-7分）',
  },
  {
    id: 'd2', name: '技术方案可行性', max: 35,
    details: [
      '2.1 内容技术落地性：内容可落地，明确技术路径，按要求执行口播、话题及游戏组件。',
      '2.2 投放技术策略：明确多平台投放策略，可控制 CPM 达标，有播放量保障措施。',
      '2.3 数据监测与优化：搭建监测体系，有异常预警及优化方案，提供数据复盘。',
      '2.4 版权与合规性技术：明确授权及版权，有合规检测，保障无侵权及违规风险。',
    ],
    standard: '好（21-35分）；较好（11-20分）；一般（1-10分）',
  },
  {
    id: 'd3', name: 'KPI 达成保障能力', max: 25,
    details: [
      '3.1 播放量保障：明确总播放及分项播放量达成路径，有落地保障措施及数据佐证。',
      '3.2 CPM 控制能力：有 CPM 控制及预算调整方案，提供过往同类项目数据佐证。',
      '3.3 声量堆积效果：有话题破圈策略，可实现短期声量峰值，提升内容转发互动，着重考虑前三天完成 KPI 占比。',
    ],
    standard: '好（18-25分）；较好（10-17分）；一般（1-9分）',
  },
  {
    id: 'd4', name: '资源与服务能力', max: 10,
    details: [
      '4.1 达人资源质量：达人贴合需求、有相关经验，可保障履约，有违约应急方案。',
      '4.2 服务与应急能力：有专业执行团队，有应急机制，提供全程对接及进度反馈。',
    ],
    standard: '好（8-10分）；较好（5-7分）；一般（1-4分）',
  },
  {
    id: 'd5', name: '创新与附加价值', max: 10,
    details: [
      '5.1 方案创新性：有新颖宣发角度及新技术应用，贴合手杀国庆节点活动。',
      '5.2 附加价值：提供增值服务，助力三国杀 IP 认知强化。',
    ],
    standard: '好（8-10分）；较好（5-7分）；一般（1-4分）',
  },
];

const GENERATE_AI_DEBOUNCE_MS = 900;
let aiGenTimers = {}; // { vid: timeoutId }
let aiGenRequests = {}; // { vid: { aborted: true, timer } } 旧请求作废标记 + 计时器
let aiGenStatus = {}; // { vid: { text: '生成中… 3s' } } 跨渲染保留的状态文案
let crossAnalysisGenerating = false;

function defaultState() {
  return {
    project: { name: '', budget: 0 },
    dimensions: structuredClone(DEFAULT_DIMENSIONS),
    vendors: [],
    judges: [],
    aiSuggestions: {},
    minutes: {},
    aiConfig: { baseUrl: '', model: '', key: '' },
    // 按天隔离的当前开放供应商：{ '2026-08-14': 'v123' }
    // 新一天的会议不会沿用旧推进进度，第一家按开始时间自动开放
    currentVendorId: null,
    currentVendorByDate: {},
    tenderReqs: '',
    qualInputs: {},
    qualResults: {},
    vendorMaterials: {},
    archives: [],
    supplierRegistry: {},
    crossVendorAnalysis: '',
  };
}

const DEFAULT_UI = { tab: 'dashboard', activeVendor: null, activeJudge: null };

let state = defaultState();
let ui = { ...DEFAULT_UI };
let scores = {};
let judgeMeta = {};  // {judgeId: {signature, signedAt, locked}}
let vendorComments = {}; // {vendorId: {judgeId: comment}}
// audit 已废弃：后端 /state 仍可能返回 audit 字段，前端不再读取或持久化，避免本地缓存膨胀

// ============ 后端 API ============
async function apiGet(path, headers = {}) {
  const r = await fetch(API_BASE + path, { headers });
  return r.json();
}
async function apiPost(path, body, headers = {}) {
  const r = await fetch(API_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function loadAll() {
  // 1. 先用本地缓存立即渲染（刷新不空白、不跳回第一家）
  const localRaw = localStorage.getItem(STORAGE_KEY);
  if (localRaw) {
    try {
      const local = JSON.parse(localRaw);
      // 一次性清理：旧版本本地缓存可能含已删除的 tab，检测到只重置 tab，保留 state 和 scores
      const VALID_TABS = ['dashboard', 'scoring', 'settings', 'history'];
      if (local.ui && !VALID_TABS.includes(local.ui.tab)) {
        local.ui.tab = 'dashboard';
      }
      state = mergeDefaults(local.state || defaultState());
      scores = local.scores || {};
      judgeMeta = local.judgeMeta || {};
      vendorComments = local.vendorComments || {};
      ui = local.ui || { ...DEFAULT_UI };
      migrateMaterials();
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
  }
  // 按当前归档全量重算供应商档案，清掉历史库为空时的残留数据
  rebuildSupplierRegistry();
  renderAll();
  // 2. 后台静默拉云端（评委打分）；不 await，不阻塞首屏
  pullCloud();
}

// 把缺失的默认字段补上（不覆盖已有值），用于合并本地/云端 state
// 注意：vendors/judges/project/dimensions 只在字段缺失时回退，空数组保留空数组
function mergeDefaults(s) {
  const d = defaultState();
  return {
    ...d, ...s,
    project: { ...d.project, ...(s.project || {}) },
    dimensions: Array.isArray(s.dimensions) ? s.dimensions : d.dimensions,
    vendors: Array.isArray(s.vendors) ? s.vendors : d.vendors,
    judges: Array.isArray(s.judges) ? s.judges : d.judges,
  };
}

// 旧版 minutes + qualInputs 迁移合并为 vendorMaterials（只迁移一次，已有 vendorMaterials 不动）
function migrateMaterials() {
  state.vendorMaterials = state.vendorMaterials || {};
  for (const v of (state.vendors || [])) {
    if (state.vendorMaterials[v.id]) continue;
    const m = state.minutes?.[v.id] || '';
    const q = state.qualInputs?.[v.id] || '';
    if (m || q) {
      state.vendorMaterials[v.id] = [m, q].filter(Boolean).join('\n\n——— 资质摘录 ———\n\n');
    }
  }
}

// 从云端拉最新；保留 ui；仅数据真变时渲染
async function pullCloud() {
  if (isInputFocused()) return;  // 正在输入，绝不打断
  try {
    const r = await apiGet('/state');
    if (!r.ok) return;
    if (!r.state || !Object.keys(r.state).length) return;
    const before = JSON.stringify({ s: state, sc: scores, vc: vendorComments });
    // scores 永远以云端为权威（评委打分实时进来）
    scores = r.scores || {};
    if (r.judgeMeta) judgeMeta = r.judgeMeta;
    if (r.vendorComments) vendorComments = r.vendorComments;
    // state 只在本地没有未推改动时才合并，避免覆盖管理员正在编辑的字段
    if (!dirty) {
      state = mergeDefaults(r.state);
      migrateMaterials();
    }
    const after = JSON.stringify({ s: state, sc: scores });
    persistLocal();
    if (before !== after) renderAll();
  } catch (e) {
    console.warn('云端拉取失败，用本地', e);
  }
}

let isSaving = false;
let lastSaveAt = 0;
let dirty = false;   // 本地有未推云的改动

// 只写 localStorage（零延迟，不打断输入）
function persistLocal() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ state, scores, judgeMeta, vendorComments, ui }));
  dirty = true;
}

// 兼容旧名
function saveLocal() { persistLocal(); }

async function syncToCloud() {
  if (isSaving) return;
  if (!dirty) return;
  isSaving = true;
  lastSaveAt = Date.now();
  // 快照本次要推的 state，await 期间用户若又编辑，dirty 会被重新置 true，
  // 此时不能清 dirty，否则那笔新编辑会丢失云端同步
  const snapshot = JSON.stringify(state);
  try {
    await apiPost('/admin', { patch: state });
    // 只有当 state 在 await 期间没被再次修改时，才清 dirty
    if (JSON.stringify(state) === snapshot) dirty = false;
  } catch (e) {
    console.warn('云端同步失败，下次重试', e);
  } finally {
    isSaving = false;
  }
}

// 关页面/隐藏时把本地改动推云，保证跨设备不丢
let exitFlushed = false;
function flushOnExit() {
  if (exitFlushed) return;  // pagehide + beforeunload 可能都触发，防重入
  if (!dirty) return;
  if (isSaving) return;  // syncToCloud 正在飞，相信它会带上最新 state，避免并发覆盖
  const payload = JSON.stringify({ patch: state });
  try {
    navigator.sendBeacon('/api/admin', new Blob([payload], { type: 'application/json' }));
    dirty = false;
    exitFlushed = true;
  } catch (e) {
    // sendBeacon 抛异常（如构造 Blob 失败）时 fall back，但页面可能已卸载，同步失败也不致命
    try { syncToCloud(); } catch (_) {}
  }
}
document.addEventListener('visibilitychange', () => { if (document.hidden) flushOnExit(); });
window.addEventListener('beforeunload', flushOnExit);
window.addEventListener('pagehide', flushOnExit);

// saveState：输入事件调用，只写本地，不渲染、不立即推云（关页面时再推）
let saveStateSyncTimer = null;
async function saveState() {
  persistLocal();
  // debounce 推云：输入停止 1.2s 后同步，避免刷新前云端拿不到
  clearTimeout(saveStateSyncTimer);
  saveStateSyncTimer = setTimeout(() => { try { syncToCloud(); } catch (_) {} }, 1200);
}

// 结构性改动（增删供应商/维度/评委、解析粘贴、推进讲标等按钮）：写本地 + 立即渲染
function saveStateAndRender() {
  persistLocal();
  renderAll();
}
// 推 state 到云（非结构改动用）
function saveStateCloud() {
  syncToCloud();
}

function debounceGenVendorAi(vid, delay = GENERATE_AI_DEBOUNCE_MS) {
  if (aiGenTimers[vid]) clearTimeout(aiGenTimers[vid]);
  // 作废掉正在跑的旧请求（粘贴新内容后旧请求结果不应再回写）
  if (aiGenRequests[vid]) aiGenRequests[vid].aborted = true;
  aiGenTimers[vid] = setTimeout(() => autoGenerateVendorAi(vid), delay);
}

async function autoGenerateVendorAi(vid) {
  delete aiGenTimers[vid];
  const text = (state.vendorMaterials?.[vid] || '').trim();
  if (!text) return;
  // 启动本轮请求，拿到自己的句柄
  const myReq = { aborted: false, timer: null };
  aiGenRequests[vid] = myReq;
  const t0 = Date.now();
  const tick = () => { if (!myReq.aborted) aiGenStatus[vid] = { text: `生成中… ${((Date.now()-t0)/1000).toFixed(0)}s` }; };
  tick(); myReq.timer = setInterval(tick, 1000);
  try {
    const res = await generateVendorAiLocal(vid);
    if (myReq.aborted) { if (myReq.timer) clearInterval(myReq.timer); return; }
    if (myReq.timer) clearInterval(myReq.timer);
    state.aiSuggestions = state.aiSuggestions || {};
    state.qualResults = state.qualResults || {};
    state.aiSuggestions[vid] = res.scores || {};
    state.qualResults[vid] = res.quals || [];
    persistLocal();
    saveStateCloud();
    aiGenStatus[vid] = { text: `已生成 · ${((Date.now()-t0)/1000).toFixed(1)}s` };
    safeRenderAll();
    setTimeout(() => { if (aiGenStatus[vid]?.text?.startsWith('已生成')) { delete aiGenStatus[vid]; const el = viewEl?.querySelector(`.ai-status[data-vid="${vid}"]`); if (el) el.textContent = ''; } }, 3000);
  } catch (e) {
    if (myReq.aborted) { if (myReq.timer) clearInterval(myReq.timer); return; }
    if (myReq.timer) clearInterval(myReq.timer);
    aiGenStatus[vid] = { text: '失败：' + e.message };
    safeRenderAll();
  } finally {
    aiGenRequests[vid] = null;
  }
}

// 结果回来时若用户正在输入则只落本地，不重渲染，避免打断输入
function safeRenderAll() {
  if (isInputFocused()) { persistLocal(); return; }
  renderAll();
}

// 后台补生成 watcher：无论在哪个 tab，只要有材料、没初评、当前没在跑，就自动补跑
// 解决"切走 tab 后自动生成被中断、不再继续"的问题
const pendingAiGen = {};      // vid -> true 本轮 watcher 已派发，防同家并发
const watcherFailCount = {};  // vid -> 连续失败次数，超过上限跳过避免烧 token
const WATCHER_FAIL_LIMIT = 3;
function startPendingAiWatcher() {
  setInterval(() => {
    if (document.hidden) return;       // 标签页隐藏时暂停
    if (isInputFocused()) return;      // 正在输入时不派发（不打断）
    if (!state.aiConfig?.key) return;  // 没配 AI key 不跑
    if (!state.vendors?.length) return;
    for (const v of state.vendors) {
      const hasMat = !!(state.vendorMaterials?.[v.id] || '').trim();
      const hasResult = !!(state.aiSuggestions?.[v.id] && Object.keys(state.aiSuggestions[v.id]).length);
      const inFlight = aiGenRequests[v.id] || aiGenTimers[v.id] || pendingAiGen[v.id];
      if (!hasMat || hasResult || inFlight) continue;
      if ((watcherFailCount[v.id] || 0) >= WATCHER_FAIL_LIMIT) continue;
      pendingAiGen[v.id] = true;
      autoGenerateVendorAi(v.id).then(() => {
        const ok = !!(state.aiSuggestions?.[v.id] && Object.keys(state.aiSuggestions[v.id]).length);
        watcherFailCount[v.id] = ok ? 0 : (watcherFailCount[v.id] || 0) + 1;
      }).finally(() => { pendingAiGen[v.id] = false; });
      break; // 一次只派发一家，避免并发烧 token
    }
  }, 5000);
}

// 渲染时把 aiGenStatus 写进 .ai-status
function applyAiGenStatus() {
  if (!viewEl) return;
  for (const vid of Object.keys(aiGenStatus)) {
    const el = viewEl.querySelector(`.ai-status[data-vid="${vid}"]`);
    if (el) el.textContent = aiGenStatus[vid].text || '';
  }
}

// 前端直调 AI（不经 Worker，避开 Cloudflare CPU/超时限制）
async function generateAiLocal(vendorId, minutesText) {
  const cfg = state.aiConfig || {};
  const apiKey = cfg.key;
  const baseUrl = (cfg.baseUrl || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/$/, '');
  const model = cfg.model || 'glm-4.5-air';
  if (!apiKey) throw new Error('未配置 AI API Key，请在「项目设置」填 Base URL / Model / API Key');

  const vendor = state.vendors.find(v => v.id === vendorId);
  const dimSpec = state.dimensions.map(d => {
    const det = (d.details || []).map(t => `  - ${t}`).join('\n');
    return `${d.id}｜${d.name}｜满分${d.max}\n${det}\n评分标准：${d.standard || '无'}`;
  }).join('\n\n');

  const prompt = `你是评标专家。下面是一家供应商的讲标会议纪要，请根据纪要为每个评分维度给出建议分（0 到该维度满分）和评分依据。

评分维度：
${dimSpec}

供应商名称：${vendor?.name || ''}

会议纪要：
${minutesText}

请严格返回 JSON，不要任何解释，格式：
{"dimId1":{"score":数字,"evidence":"评分依据：50-150字，说明为什么给这个分，纪要里哪些具体点支持这个分数"},"dimId2":{...}}
其中 dimId 替换为上面的实际维度 id。务必给出具体依据，不要泛泛而谈。`;

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.3 }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`大模型 ${resp.status}：${t.slice(0, 200)}`);
  }
  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content || '';
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('大模型未返回 JSON：' + content.slice(0, 200));
  const raw = JSON.parse(m[0]);
  const out = {};
  for (const d of state.dimensions) {
    const r = raw[d.id];
    if (r && typeof r.score === 'number') {
      out[d.id] = {
        score: Math.max(0, Math.min(d.max, r.score)),
        evidence: String(r.evidence || '').slice(0, 500),
      };
    }
  }
  return out;
}

// 前端直调 AI 通用封装（用于生成分类标签）
async function aiChat(prompt, options = {}) {
  const cfg = state.aiConfig || {};
  const apiKey = cfg.key;
  const baseUrl = (cfg.baseUrl || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/$/, '');
  const model = cfg.model || 'glm-4.5-air';
  if (!apiKey) throw new Error('未配置 AI API Key');

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: options.temperature ?? 0.3 }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`大模型 ${resp.status}：${t.slice(0, 200)}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

// 从横评正文里抽取「综合结论·最推荐」整段，作为折叠区默认显示的摘要
function extractCrossRecommendation(text) {
  if (!text) return '';
  const t = String(text).trim();
  // 优先取「综合结论」段：从"综合结论"标记到下一个同级 #### 或 ## / ### 标题
  const m = t.match(/综合结论[\s\S]*/);
  let seg = m ? m[0] : '';
  if (seg) {
    // 截到下一个标题（## / ### / ####）
    const nextHead = seg.search(/\n#{2,4}\s/);
    if (nextHead > 0) seg = seg.slice(0, nextHead);
    return seg.trim();
  }
  // 兜底：匹配「最推荐 XXX」句式，取到第一个句号/换行
  const m2 = t.match(/(最推荐|综合推荐|推荐选择?|首选)[^。\n]{0,200}/);
  if (m2) return m2[0].trim();
  const firstLine = t.split(/\n/).find(l => l.trim()) || t;
  return firstLine.trim().slice(0, 120);
}

// 横评正文去掉「综合结论」段后的剩余内容，作为展开后才显示的部分
function extractCrossRest(text) {
  if (!text) return '';
  const t = String(text).trim();
  const idx = t.search(/综合结论/);
  if (idx === -1) return '';
  // 找综合结论段之后的第一个标题位置
  const after = t.slice(idx);
  const nextHead = after.search(/\n#{2,4}\s/);
  if (nextHead === -1) return ''; // 没有后续标题
  return t.slice(idx + nextHead).trim();
}

// 横评摘要格式化：保留 markdown 标题/加粗，转 HTML
function formatCrossSummary(md) {
  if (!md) return '';
  let html = escapeHtml(md);
  // markdown 加粗 **xxx**
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong style="color:var(--gold);">$1</strong>');
  // markdown 标题 ### / ## → 加粗行
  html = html.replace(/^#{2,3}\s+(.+)$/gm, '<strong style="color:var(--gold);font-size:13px;">$1</strong>');
  // 换行
  html = html.replace(/\n/g, '<br>');
  return html;
}

// 完整横评格式化：保留 markdown 结构，转 HTML
function formatCrossFull(md) {
  if (!md) return '';
  let html = escapeHtml(md);
  html = html.replace(/^####\s+(.+)$/gm, '<h5 style="color:var(--gold);margin:10px 0 4px;font-size:13px;">$1</h5>');
  html = html.replace(/^###\s+(.+)$/gm, '<h4 style="color:var(--gold);margin:10px 0 4px;font-size:13px;">$1</h4>');
  html = html.replace(/^##\s+(.+)$/gm, '<h3 style="color:var(--gold);margin:12px 0 6px;">$1</h3>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\n/g, '<br>');
  // 把标题前后的 <br> 去掉，避免空行过大
  html = html.replace(/<br>(<h[345])/g, '$1').replace(/(<\/h[345]>)<br>/g, '$1');
  return html;
}

// 供应商横评：一次性汇总所有已评供应商的横向对比
async function generateCrossVendorAnalysis() {
  const cfg = state.aiConfig || {};
  const apiKey = cfg.key;
  if (!apiKey) throw new Error('未配置 AI API Key');
  const baseUrl = (cfg.baseUrl || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, '');
  const model = cfg.model || 'glm-4.5-air';

  const ranked = [...state.vendors].sort((a, b) => vendorTotal(b.id) - vendorTotal(a.id));
  const anomalies = detectAnomalies();

  const vendorBlocks = ranked.map((v, i) => {
    const ai = state.aiSuggestions[v.id] || {};
    const aiLines = state.dimensions.map(d => {
      const s = ai[d.id];
      return s ? `  - ${d.name}：建议 ${s.score}/${d.max}，依据：${s.evidence || '无'}` : '';
    }).filter(Boolean).join('\n');
    const qual = (state.qualResults[v.id] || []).map(q => `  - [${q.result}] ${q.req}${q.evidence ? '：' + q.evidence : ''}`).join('\n');
    const anom = anomalies.filter(x => x.vid === v.id).map(x => `- ${x.label}：${x.desc}`).join('\n');
    return `### ${i + 1}. ${v.name}
- 总分：${vendorTotal(v.id).toFixed(1)}（技术权重 ${vendorTechWeighted(v.id).toFixed(1)} + 商务分 ${vendorBusinessScore(v.id).toFixed(1)}）
- CPM：¥${cpm(v.id).toFixed(2)}，播放量：${v.playCount || 0} 万
- 各评委技术分：${state.judges.map(j => `${j.name} ${judgeTotalForVendor(v.id, j.id).toFixed(1)}`).join('、') || '暂无'}
- AI 维度评价：
${aiLines || '  （未生成）'}
${qual ? `- 资质核验：\n${qual}` : ''}
${anom ? `- 风险提示：\n${anom}` : ''}`;
  }).join('\n\n');

  const prompt = `你是资深评标专家。请根据以下所有供应商的评标数据，生成一段供应商横评分析，用于帮助决策者快速理解各家的相对位置。要求：
1. 先给出综合结论：最推荐哪家、关键优势是什么。
2. 逐家或归类描述各供应商的定位（优势 / 劣势 / 适合场景）。
3. 提示主要风险（性价比、履约、资质合规等）。
4. 全文 400-800 字，用正式、客观的中文，引用具体数据。

项目：${state.project.name || '未命名'}
预算：¥${(state.project.budget || 0).toLocaleString()}

供应商横评数据：
${vendorBlocks}`;

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.4 }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`大模型 ${resp.status}：${t.slice(0, 200)}`);
  }
  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content?.trim() || '';
  if (!content) throw new Error('大模型返回空内容');
  return content;
}

// 技术冗余：横评备用生成（绕过主流程，直接走 aiChat 单条 prompt）
async function generateCrossVendorAnalysisFallback() {
  const cfg = state.aiConfig || {};
  if (!cfg.key) throw new Error('未配置 AI API Key');
  const summary = state.vendors.map(v => {
    const total = vendorTotal(v.id).toFixed(1);
    const ai = state.aiSuggestions[v.id] || {};
    const aiBrief = state.dimensions.map(d => ai[d.id] ? `${d.name}=${ai[d.id].score}` : '').filter(Boolean).join('，');
    return `- ${v.name}：总分 ${total}，CPM ¥${cpm(v.id).toFixed(2)}，${aiBrief || '无 AI 初评'}`;
  }).join('\n');
  const prompt = `你是评标专家，请基于以下供应商评分数据生成一段 400-800 字的中文横评分析，给出综合结论、各家优劣、风险提示：\n${summary}`;
  const text = await aiChat(prompt, { temperature: 0.4 });
  if (!text) throw new Error('备用生成返回空内容');
  return text;
}

// 从项目名自动生成分类标签
async function generateCategoryFromName(projectName) {
  if (!projectName) return '通用';
  const prompt = `请为下面的项目起一个 2-4 个字的品类标签（如"达人传播""IP 宣发""品牌广告"），只返回标签文字，不要解释：\n项目名：${projectName}`;
  const raw = await aiChat(prompt, { temperature: 0.2 });
  return raw.replace(/[\"“”]/g, '').slice(0, 8) || '通用';
}
async function generateReportLocal() {
  const cfg = state.aiConfig || {};
  const apiKey = cfg.key;
  const baseUrl = (cfg.baseUrl || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/$/, '');
  const model = cfg.model || 'glm-4.5-air';
  if (!apiKey) throw new Error('未配置 AI API Key，请在「项目设置」填 Base URL / Model / API Key');

  const ranked = [...state.vendors].sort((a, b) => vendorTotal(b.id) - vendorTotal(a.id));
  const anomalies = detectAnomalies();
  const dimSpec = state.dimensions.map(d => `- ${d.name}（满分 ${d.max}）：${d.standard || ''}`).join('\n');

  const vendorBlocks = ranked.map((v, i) => {
    const ai = state.aiSuggestions[v.id] || {};
    const aiLines = state.dimensions.map(d => ai[d.id] ? `  - ${d.name}：建议 ${ai[d.id].score}（${ai[d.id].evidence || ''}）` : '').filter(Boolean).join('\n');
    const anom = anomalies.filter(x => x.vid === v.id).map(x => `- ${x.label}：${x.desc}`).join('\n');
    const qual = (state.qualResults[v.id] || []).map(q => `  - [${q.result}] ${q.req}${q.evidence ? '（' + q.evidence + '）' : ''}`).join('\n');
    return `### ${i + 1}. ${v.name}
- 排名：第 ${i + 1} 名
- 技术平均分：${vendorTechAverage(v.id).toFixed(1)}
- 技术权重得分：${vendorTechWeighted(v.id).toFixed(1)}
- 商务分：${vendorBusinessScore(v.id).toFixed(1)}（承诺播放量 ${v.playCount || 0} 万，CPM ¥${cpm(v.id).toFixed(2)}）
- 总分：${vendorTotal(v.id).toFixed(1)}
- 各评委技术分：${state.judges.map(j => `${j.name} ${judgeTotalForVendor(v.id, j.id).toFixed(1)}`).join('、') || '暂无'}
${aiLines ? `- AI 初评：\n${aiLines}` : ''}
${qual ? `- 资质核验：\n${qual}` : ''}
${anom ? `- 风险提示：\n${anom}` : ''}`;
  }).join('\n\n');

  const prompt = `你是资深评标专家。根据以下评标数据，生成一份正式的评标报告（Markdown 格式）。

项目：${state.project.name || '未命名'}
预算：¥${(state.project.budget || 0).toLocaleString()}
评分维度：
${dimSpec}

供应商数据（按总分降序）：

${vendorBlocks}

报告结构（严格按此顺序，用 Markdown 二级标题）：
1. ## 评标概述（项目背景、评标过程简述）
2. ## 推荐中标候选人（明确给出第 1 名，说明理由）
3. ## 分供应商点评（每家：核心优势 / 主要风险 / 资质合规提示）
4. ## 评分汇总表（Markdown 表格：排名、供应商、技术平均、商务分、总分、CPM）
5. ## 风险提示与建议（异常报价、资质缺口、履约风险等，无则说明"未发现重大风险"）

用正式、客观的中文，不要泛泛而谈，要引用上面的具体数字和证据。`;

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.4 }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`大模型 ${resp.status}：${t.slice(0, 200)}`);
  }
  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content || '';
  if (!content.trim()) throw new Error('大模型返回空内容');
  // 追加评委签字段
  const signSection = buildSignSectionMd();
  const fullMd = signSection ? content + '\n\n' + signSection : content;
  const doc = await buildReportDocx(fullMd);
  return { md: fullMd, doc };
}

// 生成「评委评分」段 Markdown：每个评委签名图 + 每家供应商各一级维度评分表 + 总评
// 签名图通过占位符 [SIG:judgeId] 嵌入，buildReportDocx 再替换成 Word 图片
function buildSignSectionMd() {
  if (!state.judges || !state.judges.length) return '';
  const lines = ['## 评委评分'];
  for (const j of state.judges) {
    const m = judgeMeta[j.id] || {};
    if (m.locked) {
      const t = m.signedAt ? new Date(m.signedAt).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : '';
      lines.push(`### ${j.name}`);
      lines.push('');
      if (m.signature) lines.push(`[SIG:${j.id}]`);
      lines.push(`签名时间：${t}`);
      lines.push('');
      // 每家供应商各一级维度评分表（标准 markdown 表格，首尾带 |）
      if (state.vendors && state.vendors.length) {
        const header = ['供应商', ...state.dimensions.map(d => d.name), '技术合计'];
        lines.push('| ' + header.join(' | ') + ' |');
        lines.push('| ' + header.map(() => '---').join(' | ') + ' |');
        for (const v of state.vendors) {
          const vals = state.dimensions.map(d => {
            const s = getScore(v.id, j.id, d.id);
            return (s === undefined || s === null || s === '') ? '—' : Number(s).toFixed(1);
          });
          const techTotal = judgeTotalForVendor(v.id, j.id).toFixed(1);
          lines.push('| ' + [v.name, ...vals, techTotal].join(' | ') + ' |');
        }
        lines.push('');
      }
      // 各供应商总评
      if (state.vendors && state.vendors.length) {
        lines.push('**总评：**');
        for (const v of state.vendors) {
          const c = vendorComments[v.id]?.[j.id] || '';
          lines.push(`- ${v.name}：${c || '（未填写总评）'}`);
        }
      }
    } else {
      lines.push(`### ${j.name}（未签名）`);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

// 把 Markdown 报告转成 Word 文档对象（docx.js）
// 签名占位符 [SIG:judgeId] 会被替换成签名图片（dataURL → ImageRun）
async function buildReportDocx(md) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableCell, TableRow, WidthType, BorderStyle, ImageRun } = docx;
  const children = [];
  const lines = md.split('\n');
  let inTable = false;
  let tableRows = [];

  function flushTable() {
    if (!tableRows.length) return;
    const rows = tableRows.map((cells, ridx) => {
      const isHeader = ridx === 0;
      return new TableRow({
        children: cells.map(c => new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: c.trim(), bold: isHeader, size: 21, font: 'Microsoft YaHei' })] })],
          shading: isHeader ? { fill: 'F5E8D6' } : undefined,
        })),
      });
    });
    children.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
    tableRows = [];
    inTable = false;
  }

  for (let raw of lines) {
    raw = raw.trimEnd();
    // 签名图片占位符
    const sigMatch = raw.match(/^\[SIG:(.+?)\]$/);
    if (sigMatch) {
      const jid = sigMatch[1];
      const m = judgeMeta[jid] || {};
      if (m.signature) {
        try {
          const data = await dataUrlToU8(m.signature);
          const dims = pngOrJpegDims(m.signature, data);
          children.push(new Paragraph({
            children: [new ImageRun({ data, transformation: { width: dims.w, height: dims.h }, type: m.signature.includes('image/png') ? 'png' : 'jpg' })],
            spacing: { after: 80 },
          }));
        } catch (e) { /* 图片插入失败则跳过，保留签名时间文字 */ }
      }
      continue;
    }
    // 表格：行首须有 |，避免普通段落以 | 结尾被误判
    if (/^\|.+\|$/.test(raw)) {
      const cells = raw.split('|').slice(1, -1).map(s => s.trim()).filter((_, i, a) => !(i === 0 && a[0] === ''));
      if (cells.length && cells.every(c => /^[-: |]+$/.test(c))) { inTable = true; continue; }
      if (cells.length) { tableRows.push(cells); inTable = true; continue; }
    }
    if (inTable) flushTable();

    // 标题
    const hMatch = raw.match(/^(#{1,5})\s+(.*)$/);
    if (hMatch) {
      const level = Math.min(hMatch[1].length, 3);
      children.push(new Paragraph({
        heading: level === 1 ? HeadingLevel.HEADING_1 : level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3,
        children: [new TextRun({ text: hMatch[2], bold: true, size: level === 1 ? 32 : level === 2 ? 28 : 24, color: '6B3A0A', font: 'Microsoft YaHei' })],
        spacing: { before: 200, after: 120 },
      }));
      continue;
    }

    if (!raw) {
      children.push(new Paragraph({ children: [new TextRun({ text: '', size: 21 })] }));
      continue;
    }

    // 普通段落，做简单加粗
    const parts = raw.split(/\*\*(.+?)\*\*/g);
    children.push(new Paragraph({
      children: parts.map((p, i) => new TextRun({ text: p, bold: (i % 2 === 1), size: 21, font: 'Microsoft YaHei' })),
      spacing: { after: 80 },
    }));
  }
  if (inTable) flushTable();

  return new Document({
    sections: [{
      properties: { page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
      children,
    }],
  });
}

// dataURL → Uint8Array
async function dataUrlToU8(dataUrl) {
  const r = await fetch(dataUrl);
  const buf = await r.arrayBuffer();
  return new Uint8Array(buf);
}

// 从签名图片字节里读宽高（支持 PNG/JPEG），并按宽度上限 360px 等比缩放到 Word 像素
function pngOrJpegDims(dataUrl, data) {
  let w = 0, h = 0;
  if (dataUrl.includes('image/png')) {
    // PNG 宽高在偏移 16/20（big-endian）
    w = (data[16] << 24 | data[17] << 16 | data[18] << 8 | data[19]) >>> 0;
    h = (data[20] << 24 | data[21] << 16 | data[22] << 8 | data[23]) >>> 0;
  } else if (dataUrl.includes('image/jpeg') || dataUrl.includes('image/jpg')) {
    // JPEG：扫 SOF0/SOF2 标记读高宽
    let i = 2;
    while (i < data.length - 9) {
      if (data[i] !== 0xFF) { i++; continue; }
      const marker = data[i + 1];
      if (marker === 0xC0 || marker === 0xC2) {
        h = (data[i + 5] << 8) | data[i + 6];
        w = (data[i + 7] << 8) | data[i + 8];
        break;
      }
      const len = (data[i + 2] << 8) | data[i + 3];
      i += 2 + len;
    }
  }
  if (!w || !h) { w = 360; h = 150; }
  const maxW = 360;
  if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
  return { w, h };
}


// 用 pdf.js 从 PDF 文件提取文字；文字层为空（扫描件/图片型 PDF）时自动回退到 OCR
async function extractPdfText(file, onProgress) {
  if (typeof pdfjsLib === 'undefined') throw new Error('pdf.js 未加载');
  pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.min.js';
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const maxPages = Math.min(pdf.numPages, 30); // 最多 30 页，避免太大
  const textPerPage = [];
  let out = '';
  for (let i = 1; i <= maxPages; i++) {
    const page = await pdf.getPage(i);
    const c = await page.getTextContent();
    const text = c.items.map(it => it.str).join(' ').replace(/\s+/g, ' ').trim();
    textPerPage.push(text);
    if (text) out += text + '\n';
  }
  out = out.trim();
  if (out.length >= 20) return out; // 文字层够用，直接返回

  // 文字层过少 → 视为扫描件，逐页渲染成图片做 OCR
  if (typeof Tesseract === 'undefined') {
    throw new Error('PDF 文字层为空（疑似扫描件），且 OCR 库未加载；请直接粘贴文字或上传文字版 PDF');
  }
  onProgress && onProgress('疑似扫描件，正在启用 OCR 识别（较慢，请等待）…');
  let ocrOut = '';
  for (let i = 1; i <= maxPages; i++) {
    const prev = textPerPage[i - 1] || '';
    if (prev.length >= 20) { ocrOut += prev + '\n'; continue; } // 已有文字层的不重复 OCR
    onProgress && onProgress(`OCR 识别中：第 ${i}/${maxPages} 页…`);
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    try {
      const { data } = await Tesseract.recognize(canvas, 'chi_sim+eng');
      ocrOut += (data.text || '') + '\n';
    } catch (e) {
      ocrOut += prev + '\n'; // OCR 失败至少保留文字层
    }
  }
  return ocrOut.trim();
}

// 通用文件文字提取：PDF / Word / Excel 分流，其他按纯文本读
async function extractFileText(file, onProgress) {
  const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB，避免卡死标签页
  if (file.size && file.size > MAX_FILE_SIZE) {
    throw new Error(`文件过大（${(file.size/1024/1024).toFixed(1)}MB），请压缩到 20MB 以内再导入`);
  }
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.pdf') || file.type === 'application/pdf') return extractPdfText(file, onProgress);
  if (name.endsWith('.docx') || name.endsWith('.doc')) {
    if (typeof mammoth === 'undefined') throw new Error('mammoth 未加载');
    const ab = await file.arrayBuffer();
    const r = await mammoth.extractRawText({ arrayBuffer: ab });
    return r.value || '';
  }
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    if (typeof XLSX === 'undefined') throw new Error('XLSX 未加载');
    const ab = await file.arrayBuffer();
    const wb = XLSX.read(ab, { type: 'array' });
    return wb.SheetNames.map(n => XLSX.utils.sheet_to_csv(wb.Sheets[n])).join('\n\n');
  }
  return await file.text();
}

// 前端直调 AI 资质核验：把招标要求拆成逐条清单，比对投标响应
async function generateQualLocal(vendorId) {
  const cfg = state.aiConfig || {};
  const apiKey = cfg.key;
  const baseUrl = (cfg.baseUrl || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/$/, '');
  const model = cfg.model || 'glm-4.5-air';
  if (!apiKey) throw new Error('未配置 AI API Key，请在「项目设置」填 Base URL / Model / API Key');

  const reqs = (state.tenderReqs || '').split('\n').map(s => s.trim()).filter(Boolean);
  if (!reqs.length) throw new Error('请先在「项目设置」填招标要求');
  const input = (state.qualInputs || {})[vendorId] || '';
  if (!input.trim()) throw new Error('请先粘贴该供应商的投标响应摘录');

  const vendor = state.vendors.find(v => v.id === vendorId);
  const reqList = reqs.map((r, i) => `${i + 1}. ${r}`).join('\n');

  const prompt = `你是招投标合规审查专家。下面是招标要求和一家供应商的投标响应摘录，请逐条核验每一条招标要求在投标响应中是否被满足。

招标要求：
${reqList}

供应商：${vendor?.name || ''}
投标响应摘录：
${input}

对每一条招标要求，判定为「符合」「不符」或「部分符合」，并从投标响应中摘录一句话作为证据（若无证据则留空）。
严格返回 JSON 数组，不要任何解释，格式：
[{"req":"招标要求原文","result":"符合","evidence":"证据一句话"},...]`;

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.2 }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`大模型 ${resp.status}：${t.slice(0, 200)}`);
  }
  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content || '';
  const m = content.match(/\[[\s\S]*\]/);
  if (!m) throw new Error('大模型未返回 JSON：' + content.slice(0, 200));
  const raw = JSON.parse(m[0]);
  const out = [];
  for (const r of raw) {
    if (!r || typeof r.req !== 'string') continue;
    const result = ['符合', '不符', '部分符合'].includes(r.result) ? r.result : '部分符合';
    out.push({ req: r.req.slice(0, 500), result, evidence: String(r.evidence || '').slice(0, 500) });
  }
  return out;
}

// 合并版：一次 AI 调用同时产出维度建议分 + 资质核验
async function generateVendorAiLocal(vendorId) {
  const cfg = state.aiConfig || {};
  const apiKey = cfg.key;
  const baseUrl = (cfg.baseUrl || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/$/, '');
  const model = cfg.model || 'glm-4.5-air';
  if (!apiKey) throw new Error('未配置 AI API Key，请在「项目设置」填 Base URL / Model / API Key');

  const text = (state.vendorMaterials?.[vendorId] || '').trim();
  if (!text) throw new Error('请先粘贴或导入该供应商的材料');

  const vendor = state.vendors.find(v => v.id === vendorId);
  const dimSpec = state.dimensions.map(d => {
    const det = (d.details || []).map(t => `  - ${t}`).join('\n');
    return `${d.id}｜${d.name}｜满分${d.max}\n${det}\n评分标准：${d.standard || '无'}`;
  }).join('\n\n');
  const reqs = (state.tenderReqs || '').split('\n').map(s => s.trim()).filter(Boolean);
  const hasReqs = reqs.length > 0;
  const reqList = reqs.map((r, i) => `${i + 1}. ${r}`).join('\n');

  const prompt = `你是评标专家。下面是一家供应商的投标材料（可能含讲标纪要、方案、资质响应等）。请完成：
1. 为每个评分维度给出建议分（0 到该维度满分）和评分依据
${hasReqs ? `2. 逐条核验招标要求，判定「符合」「不符」「部分符合」并给出依据` : '2. 本项目无招标要求，跳过资质核验，quals 返回空数组'}

评分维度：
${dimSpec}
${hasReqs ? `\n招标要求：\n${reqList}\n` : ''}
供应商名称：${vendor?.name || ''}

投标材料：
${text}

严格返回 JSON，不要任何解释，格式：
{"scores":{"dimId1":{"score":数字,"evidence":"评分依据：50-150字，说明为什么给这个分，材料中哪些具体点支持该分数"},"dimId2":{...}},"quals":${hasReqs ? `[{"req":"招标要求原文","result":"符合","evidence":"依据：50-150字，说明材料中哪些证据支持该判定"},...]` : `[]`}}
其中 dimId 替换为上面的实际维度 id。务必给出具体依据，不要泛泛而谈。没有对应证据的维度/招标条目也保留 key，evidence 留空。`;

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.3 }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`大模型 ${resp.status}：${t.slice(0, 200)}`);
  }
  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content || '';
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('大模型未返回 JSON：' + content.slice(0, 200));
  const raw = JSON.parse(m[0]);

  // 维度建议
  const scoresOut = {};
  for (const d of state.dimensions) {
    const r = raw.scores?.[d.id];
    if (r && typeof r.score === 'number') {
      scoresOut[d.id] = {
        score: Math.max(0, Math.min(d.max, r.score)),
        evidence: String(r.evidence || '').slice(0, 500),
      };
    }
  }
  // 资质核验
  const qualsOut = [];
  if (Array.isArray(raw.quals)) {
    for (const r of raw.quals) {
      if (!r || typeof r.req !== 'string') continue;
      const result = ['符合', '不符', '部分符合'].includes(r.result) ? r.result : '部分符合';
      qualsOut.push({ req: r.req.slice(0, 500), result, evidence: String(r.evidence || '').slice(0, 500) });
    }
  }
  return { scores: scoresOut, quals: qualsOut };
}

// 归档当前项目：生成快照并更新供应商档案
async function archiveCurrentProject() {
  // 先拉一次最新 scores，确保评委刚提交的分数已到管理端，winner 计算正确
  try { await pullScores(); } catch (e) {}
  const ranked = [...state.vendors].sort((a, b) => vendorTotal(b.id) - vendorTotal(a.id));
  const winner = ranked[0] || null;
  const anomalies = detectAnomalies();
  const archive = {
    id: 'a' + uid(),
    name: state.project.name || '未命名项目',
    category: await generateCategoryFromName(state.project.name),
    archivedAt: new Date().toISOString(),
    budget: state.project.budget || 0,
    winnerId: winner?.id || null,
    winnerName: winner?.name || '—',
    winnerTotal: winner ? vendorTotal(winner.id) : 0,
    vendorSnapshot: ranked.map((v, i) => ({
      id: v.id,
      name: v.name,
      playCount: v.playCount || 0,
      cpm: cpm(v.id),
      techAvg: vendorTechAverage(v.id),
      techWeighted: vendorTechWeighted(v.id),
      businessScore: vendorBusinessScore(v.id),
      total: vendorTotal(v.id),
      rank: i + 1,
      anomalies: anomalies.filter(a => a.vid === v.id),
    })),
    judgeSnapshot: state.judges.map(j => {
      const m = judgeMeta[j.id] || {};
      return {
        name: j.name,
        signature: m.signature || null,
        signedAt: m.signedAt || null,
        scores: state.vendors.map(v => ({
          vendorName: v.name,
          techTotal: judgeTotalForVendor(v.id, j.id),
          overallComment: vendorComments[v.id]?.[j.id] || '',
          dimScores: state.dimensions.map(d => ({
            dimName: d.name,
            value: getScore(v.id, j.id, d.id) ?? '',
          })),
        })),
      };
    }),
    reportMd: lastReportMd || '',
    crossVendorAnalysis: state.crossVendorAnalysis || '',
    dimensionsSnapshot: structuredClone(state.dimensions),
    tenderReqs: state.tenderReqs || '',
  };
  state.archives = state.archives || [];
  state.archives.unshift(archive);
  rebuildSupplierRegistry();
  persistLocal();
  saveStateCloud();
  return archive;
}

// 根据所有归档记录全量重算供应商全局档案（历史库删空则档案为空）
function rebuildSupplierRegistry() {
  const archives = state.archives || [];
  const reg = {};
  // 保留用户填的备注/黑名单（按供应商名小写 key 索引）
  const oldReg = state.supplierRegistry || {};
  for (const arc of archives) {
    for (const vs of (arc.vendorSnapshot || [])) {
      const key = String(vs.name).trim().toLowerCase();
      if (!key) continue;
      const wins = vs.rank === 1 ? 1 : 0;
      const old = reg[key];
      if (!old) {
        const prev = oldReg[key];
        reg[key] = {
          name: vs.name,
          totalBids: 1,
          totalWins: wins,
          avgTotal: vs.total,
          avgTechAvg: vs.techAvg,
          avgCpm: vs.cpm,
          lastProject: arc.name,
          notes: prev?.notes || '',
          blacklist: prev?.blacklist || false,
        };
      } else {
        old.totalBids += 1;
        old.totalWins += wins;
        old.avgTotal = (old.avgTotal * (old.totalBids - 1) + vs.total) / old.totalBids;
        old.avgTechAvg = (old.avgTechAvg * (old.totalBids - 1) + vs.techAvg) / old.totalBids;
        old.avgCpm = (old.avgCpm * (old.totalBids - 1) + vs.cpm) / old.totalBids;
        old.lastProject = arc.name;
      }
    }
  }
  state.supplierRegistry = reg;
}

// 同品类相似项目推荐（按归档时间倒序，最多 5 条）
function similarArchives(arc, limit = 5) {
  if (!arc || !arc.category) return [];
  return (state.archives || [])
    .filter(x => x.id !== arc.id && x.category === arc.category)
    .sort((a, b) => new Date(b.archivedAt) - new Date(a.archivedAt))
    .slice(0, limit);
}

async function saveScore(vId, jId, dId, val) {
  scores[vId] = scores[vId] || {};
  scores[vId][jId] = scores[vId][jId] || {};
  // 保留已有的 comment（如果有），避免管理端代写分时不小心清掉评委评语
  const oldCell = scores[vId][jId][dId];
  const oldComment = (oldCell && typeof oldCell === 'object') ? (oldCell.comment || '') : '';
  scores[vId][jId][dId] = { value: val, comment: oldComment };
  persistLocal();
  apiPost('/admin-score', { vendorId: vId, judgeId: jId, dimId: dId, value: val });
  updateScoreSummary(vId, jId);
}

// 定向更新评分工作台底部的汇总三栏，避免 renderAll 丢焦点
function updateScoreSummary(vId, jId) {
  const box = document.querySelector('.score-summary');
  if (!box) return;
  const cells = box.querySelectorAll('strong');
  if (cells.length < 3) return;
  cells[0].textContent = judgeTotalForVendor(vId, jId).toFixed(1);
  cells[1].textContent = vendorTechAverage(vId).toFixed(1);
  cells[2].textContent = vendorTotal(vId).toFixed(1);
}

// ============ 计算工具 ============
function getScore(vId, jId, dId) {
  const cell = scores[vId]?.[jId]?.[dId];
  return (cell && typeof cell === 'object') ? cell.value : cell;
}
function getComment(vId, jId, dId) {
  const cell = scores[vId]?.[jId]?.[dId];
  return (cell && typeof cell === 'object') ? (cell.comment || '') : '';
}
function judgeTotalForVendor(vId, jId) {
  return state.dimensions.reduce((s, d) => s + (getScore(vId, jId, d.id) || 0), 0);
}
function vendorTechAverage(vId) {
  if (!state.judges.length) return 0;
  let n = 0, sum = 0;
  for (const j of state.judges) {
    const t = judgeTotalForVendor(vId, j.id);
    if (t > 0) { sum += t; n++; }
  }
  return n > 0 ? sum / n : 0;
}
function maxPlayCount() { return Math.max(1, ...state.vendors.map(v => v.playCount || 0)); }
function vendorBusinessScore(vId) {
  const v = state.vendors.find(x => x.id === vId);
  if (!v || !v.playCount) return 0;
  return (v.playCount / maxPlayCount()) * 50;
}
// 技术权重得分 = 技术平均分 × 0.5（技术占 50%）
function vendorTechWeighted(vId) { return vendorTechAverage(vId) * 0.5; }
// CPM = 预算(元) / 播放量(个) × 1000；播放量单位是万，×10000 转个
function cpm(vId) {
  const v = state.vendors.find(x => x.id === vId);
  if (!v || !v.playCount) return 0;
  const budget = state.project?.budget || 0;
  if (!budget) return 0;
  return budget / (v.playCount * 10000) * 1000;
}
// 总分 = 商务分 + 技术权重得分（对齐 Excel K=J+H）
function vendorTotal(vId) { return vendorTechWeighted(vId) + vendorBusinessScore(vId); }
function judgeName(id) { return state.judges.find(j => j.id === id)?.name || id; }
function vendorName(id) { return state.vendors.find(v => v.id === id)?.name || id; }
function dimName(id) { return state.dimensions.find(d => d.id === id)?.name || id; }

// ============ 异常报价检测（纯前端统计，不调 AI） ============
function detectAnomalies() {
  const withPlay = state.vendors.filter(v => v.playCount > 0);
  if (withPlay.length < 2) return [];
  const avgPlay = withPlay.reduce((s, v) => s + v.playCount, 0) / withPlay.length;
  const cpms = withPlay.map(v => ({ v, c: cpm(v.id) })).filter(x => x.c > 0);
  const avgCpm = cpms.length ? cpms.reduce((s, x) => s + x.c, 0) / cpms.length : 0;
  const out = [];
  for (const v of withPlay) {
    const c = cpm(v.id);
    if (v.playCount > avgPlay * 1.5 && avgPlay > 0) out.push({ vid: v.id, type: 'play', label: '过度承诺', desc: `播放量 ${v.playCount} 万（均值的 ${(v.playCount/avgPlay).toFixed(1)} 倍），履约风险`, severity: 'high' });
    else if (v.playCount < avgPlay * 0.5 && avgPlay > 0) out.push({ vid: v.id, type: 'play', label: '竞争力不足', desc: `播放量 ${v.playCount} 万（均值的 ${(v.playCount/avgPlay).toFixed(1)} 倍）`, severity: 'medium' });
    if (avgCpm > 0 && c > 0) {
      if (c < avgCpm * 0.6) out.push({ vid: v.id, type: 'cpm', label: 'CPM 偏低', desc: `CPM ¥${c.toFixed(2)}（均值 ${(c/avgCpm).toFixed(1)} 倍），疑似低价难履约`, severity: 'high' });
      else if (c > avgCpm * 1.6) out.push({ vid: v.id, type: 'cpm', label: 'CPM 偏高', desc: `CPM ¥${c.toFixed(2)}（均值 ${(c/avgCpm).toFixed(1)} 倍），报价偏高`, severity: 'medium' });
    }
  }
  return out;
}

// ============ 阶段/截止自动算 ============
// 时区固定 +08:00（北京时间），与后端 score.js 保持一致，避免跨国评委前端解锁但后端拒绝
function meetingStart(v) {
  if (!v.meetingDate || !v.startTime) return null;
  return new Date(`${v.meetingDate}T${v.startTime}:00+08:00`);
}
function meetingEnd(v) {
  if (!v.meetingDate || !v.endTime) return null;
  return new Date(`${v.meetingDate}T${v.endTime}:00+08:00`);
}
// 按开始时间排序（早的在前），重复时段也按开始时间先后
function sortedVendors() {
  return [...state.vendors].sort((a, b) => {
    const sa = meetingStart(a), sb = meetingStart(b);
    if (sa && sb) return sa - sb;
    if (sa && !sb) return -1;
    if (!sa && sb) return 1;
    return (a.order ?? 0) - (b.order ?? 0);
  });
}
// 供应商状态纯按会议时间自动算，不手填
function vendorStatus(v) {
  if (!v.meetingDate || !v.startTime || !v.endTime) return 'todo';
  const now = new Date();
  const start = meetingStart(v), end = meetingEnd(v);
  if (isNaN(start) || isNaN(end)) return 'todo';
  if (now < start) return 'todo';
  if (now > end) return 'done';
  return 'doing';
}
// 所有评委是否都已签名锁定
function allJudgesSigned() {
  if (!state.judges || !state.judges.length) return false;
  return state.judges.every(j => judgeMeta[j.id]?.locked);
}
function isAllMeetingsEnded() {
  if (!state.vendors.length) return false;
  return state.vendors.every(v => vendorStatus(v) === 'done');
}

// 项目是否已过期锁定：今天已晚于所有会议日期（过了会议日期当天就不能再操作）
// 任意一个供应商的会议日期 >= 今天，就还没过期
function isProjectLocked() {
  const today = todayStr();
  const dates = state.vendors.map(v => v.meetingDate).filter(Boolean);
  if (!dates.length) return false;
  return dates.every(d => d < today);
}
// 当天日期字符串，本地时区 YYYY-MM-DD
function todayStr() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}
// 取当前开放供应商 id（按天隔离）：优先用当天的，回退到旧的 currentVendorId（兼容旧数据）
function getCurrentVendorId() {
  const byDate = state.currentVendorByDate || {};
  const today = todayStr();
  if (byDate[today]) return byDate[today];
  return state.currentVendorId || null;
}
// 设置当前开放供应商（按当天写入）
function setCurrentVendorId(vid) {
  const today = todayStr();
  state.currentVendorByDate = state.currentVendorByDate || {};
  state.currentVendorByDate[today] = vid;
  state.currentVendorId = vid; // 兼容旧逻辑/旧端读取
}

function computePhase() {
  const sorted = sortedVendors().filter(v => v.meetingDate && v.endTime);
  if (!sorted.length) return { phase: '准备中', deadline: '', explain: '请先在项目设置里填会议时间' };
  const lastEnd = meetingEnd(sorted[sorted.length - 1]);
  const firstStart = meetingStart(sorted[0]);
  const deadline = new Date(lastEnd.getTime() + 20 * 60000);
  const now = new Date();
  let phase;
  if (now < firstStart) phase = '准备中';
  else if (now >= firstStart && now <= lastEnd) phase = '讲标中';
  else {
    // 讲标结束后：看评委是否都打完分
    const allScored = state.vendors.length > 0 && state.judges.length > 0 &&
      state.vendors.every(v => state.judges.every(j => judgeTotalForVendor(v.id, j.id) > 0));
    phase = allScored ? '已完成' : '评分汇总中';
  }
  return { phase, deadline: fmtDateTime(deadline), explain: '' };
}
function fmtDateTime(d) {
  if (!d) return '';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ============ 渲染 ============
const viewTitleEl = document.getElementById('viewTitle');
const viewEl = document.getElementById('view');
const progressBar = document.getElementById('progressBar');
const TITLES = {
  scoring: '评分工作台',
  dashboard: '汇总看板', settings: '项目设置',
  history: '历史库',
};

function renderAll() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === ui.tab);
  });
  viewTitleEl.textContent = TITLES[ui.tab] || '汇总看板';
  const r = RENDERERS[ui.tab] || RENDERERS.dashboard;
  viewEl.innerHTML = r();
  bindViewEvents();
  applyAiGenStatus();
  renderStatusCard();
  renderProgressBar();
}

function renderProgressBar() {
  const sorted = sortedVendors();
  if (!sorted.length) { progressBar.classList.remove('show'); return; }
  // 找当前正在讲标的一家；没有正在进行的就找下一家未开始的；都讲完了显示最后一家
  const doing = sorted.find(v => vendorStatus(v) === 'doing');
  const nextTodo = sorted.find(v => vendorStatus(v) === 'todo');
  const cur = doing || nextTodo || sorted[sorted.length - 1];
  const idx = sorted.findIndex(v => v.id === cur.id);
  const curPhase = vendorStatus(cur);
  const label = curPhase === 'doing' ? '正在讲标' : curPhase === 'done' ? '已结束' : '即将讲标';
  progressBar.classList.add('show');
  const now = Date.now();
  // 当前会议链接行：开始前 15 分钟到开始后 10 分钟之间显示（已结束不显示）
  let curLinkLine = '';
  let curLinkLineRaw = '';
  if (curPhase !== 'done' && cur.meetingDate && cur.startTime) {
    const start = new Date(`${cur.meetingDate}T${cur.startTime}:00+08:00`).getTime();
    if (!isNaN(start)) {
      const diffMin = (start - now) / 60000;
      if (diffMin <= 15 && diffMin >= -10) {
        const parts = [];
        if (cur.meetingLink && isSafeUrl(cur.meetingLink)) parts.push(`<a href="${escapeAttr(cur.meetingLink)}" target="_blank" rel="noopener" style="color:var(--gold);text-decoration:underline;">进入会议</a>`);
        else if (cur.meetingLink) parts.push(`链接 ${escapeHtml(cur.meetingLink)}`);
        if (cur.meetingId) parts.push(`会议号 ${escapeHtml(cur.meetingId)}`);
        if (cur.meetingPwd) parts.push(`密码 ${escapeHtml(cur.meetingPwd)}`);
        if (parts.length) {
          curLinkLineRaw = parts.join(' · ');
          curLinkLine = ` · <span style="font-size:12px;color:var(--muted);">${curLinkLineRaw}</span>`;
        }
      }
    }
  }
  // 下一家预告：同一天紧接的下一场，开始前 5 分钟显示，下一场开始后 10 分钟隐藏
  let nextLine = '';
  {
    const next = sorted[idx + 1];
    if (next && next.meetingDate && next.startTime && next.meetingDate === cur.meetingDate) {
      const nStart = new Date(`${next.meetingDate}T${next.startTime}:00+08:00`).getTime();
      if (!isNaN(nStart)) {
        const diffMin = (nStart - now) / 60000;
        if (diffMin <= 5 && diffMin >= -10) {
          const parts = [];
          if (next.meetingLink && isSafeUrl(next.meetingLink)) parts.push(`<a href="${escapeAttr(next.meetingLink)}" target="_blank" rel="noopener" style="color:var(--gold);text-decoration:underline;">进入会议</a>`);
          else if (next.meetingLink) parts.push(`链接 ${escapeHtml(next.meetingLink)}`);
          if (next.meetingId) parts.push(`会议号 ${escapeHtml(next.meetingId)}`);
          if (next.meetingPwd) parts.push(`密码 ${escapeHtml(next.meetingPwd)}`);
          nextLine = `<div style="font-size:12px;color:var(--muted);margin-top:6px;">下一家预告：${escapeHtml(next.name)}${parts.length ? ` · ${parts.join(' · ')}` : ''}</div>`;
        }
      }
    }
  }
  progressBar.innerHTML = `
    <div class="now">${label}：<strong>${escapeHtml(cur.name)}</strong>（第 ${idx + 1} / ${sorted.length} 家）${curLinkLine}</div>
    ${nextLine}
  `;
}

function renderStatusCard() {
  const { phase, deadline } = computePhase();
  const submitted = state.judges.filter(j =>
    state.vendors.some(v => judgeTotalForVendor(v.id, j.id) > 0)
  ).length;
  const totalRank = state.vendors.length ? state.vendors.reduce((s, v) => s + vendorTotal(v.id), 0) : 0;
  document.getElementById('statusCard').innerHTML = `
    <div class="sidebar-card">
      <h4>项目状态</h4>
      <div class="stat-grid">
        <div class="stat-tile stat-wide">
          <span class="lbl">项目名称</span>
          <span class="val">${escapeHtml(state.project.name || '未命名')}</span>
        </div>
        <div class="stat-tile">
          <span class="lbl">供应商</span>
          <span class="val">${state.vendors.length}<span class="sub"> 家</span></span>
        </div>
        <div class="stat-tile">
          <span class="lbl">评委</span>
          <span class="val">${state.judges.length}<span class="sub"> 位</span></span>
        </div>
        <div class="stat-tile stat-wide">
          <span class="lbl">当前阶段</span>
          <span class="val">${escapeHtml(phase)}</span>
        </div>
        <div class="stat-tile stat-wide">
          <span class="lbl">截止时间</span>
          <span class="val">${escapeHtml(deadline || '未设置')}</span>
        </div>
      </div>
    </div>
    <div class="sidebar-card">
      <h4>今日关注</h4>
      <div class="stat-grid">
        <div class="stat-tile">
          <span class="lbl">已打分评委</span>
          <span class="val">${submitted}<span class="sub"> / ${state.judges.length}</span></span>
        </div>
        <div class="stat-tile">
          <span class="lbl">维度数</span>
          <span class="val">${state.dimensions.length}<span class="sub"> 项</span></span>
        </div>
        <div class="stat-tile stat-wide">
          <span class="lbl">累计总分</span>
          <span class="val">${totalRank.toFixed(1)}</span>
        </div>
      </div>
    </div>
  `;
}

// ---------- 评分工作台（技术打分 + 商务分 + AI 初评；会议信息走弹层） ----------
function viewScoring() {
  const v = state.vendors.find(x => x.id === ui.activeVendor) || state.vendors[0];
  if (!v) return '<div class="empty-state">先去「项目设置」添加供应商。</div>';
  const jId = ui.activeJudge;
  const judge = state.judges.find(x => x.id === jId) || state.judges[0];
  const ai = state.aiSuggestions[v.id] || {};
  const hasAi = Object.keys(ai).length > 0;
  const qual = state.qualResults?.[v.id] || [];
  const hasQual = qual.length > 0;
  const hasReqs = (state.tenderReqs || '').split('\n').map(s => s.trim()).filter(Boolean).length > 0;
  const hasResult = hasAi || hasQual;

  return `
    <section class="panel">
      <div class="panel-head"><div><h3>评分工作台</h3></div>
        <button class="btn btn-ghost" data-action="gen-cross-analysis" ${crossAnalysisGenerating ? 'disabled' : ''} title="基于所有供应商数据生成横向对比分析">${crossAnalysisGenerating ? '横评生成中…' : '生成供应商横评'}</button>
      </div>
      <div class="vendor-tabs">
        ${sortedVendors().map(vv => `
          <div class="vendor-tab ${vv.id===v.id?'active':''}" data-action="pick-vendor" data-vid="${vv.id}">
            ${escapeHtml(shortName(vv.name))}<span class="vtotal">${vendorTotal(vv.id).toFixed(1)}</span>
          </div>`).join('')}
      </div>
      <div class="judge-tabs">
        <span style="color:var(--muted);font-size:12px;align-self:center;">评委视角：</span>
        ${state.judges.map(jj => `
          <div class="judge-tab ${jj.id===judge?.id?'active':''}" data-action="pick-judge" data-jid="${jj.id}">
            ${escapeHtml(jj.name)}<span class="jtotal">${judgeTotalForVendor(v.id, jj.id).toFixed(0)}</span>
          </div>`).join('')}
      </div>
      <div class="vendor-card-head">
        <div class="play">
          <strong>${escapeHtml(v.name)}</strong>
          <div class="status-pill ${statusClass(vendorStatus(v))}" style="margin-left:8px;">${statusLabel(vendorStatus(v))}</div>
        </div>
      </div>
      ${judge ? `
      <div class="dimension-grid ${state.dimensions.length % 2 === 1 ? 'has-odd' : ''}">
        ${state.dimensions.map(d => {
          const val = getScore(v.id, judge.id, d.id);
          const a = ai[d.id];
          const pct = d.max > 0 ? ((val || 0) / d.max * 100) : 0;
          return `
            <div class="dimension">
              <div class="top">
                <div>
                  <strong>${escapeHtml(d.name)}</strong>
                  ${a ? `<div style="color:var(--cyan);font-size:11px;margin-top:4px;">AI 建议 ${a.score}${a.evidence ? ' · ' + escapeHtml(a.evidence.slice(0,30)) : ''}</div>` : ''}
                </div>
                <div style="display:flex;align-items:center;gap:8px;">
                  <strong style="font-size:22px;color:var(--gold);">${val ?? '--'}</strong>
                  <span class="max">/ ${d.max}</span>
                </div>
              </div>
              <div class="bar"><i style="width:${pct}%"></i></div>
              ${d.details?.length ? `<ul class="dim-details">${d.details.map(t => `<li>${escapeHtml(t)}</li>`).join('')}</ul>` : ''}
              ${d.standard ? `<div class="dim-standard">评分标准：${escapeHtml(d.standard)}</div>` : ''}
            </div>`;
        }).join('')}
        ${state.dimensions.length % 2 === 1 ? renderJudgeVendorCommentsInline(v.id, judge.id) : ''}
      </div>
      ` : '<div class="empty-state" style="margin-bottom:14px;">未添加评委 — 技术分由评委外链端打分，可先填下方商务分与 AI 初评。</div>'}

      <div style="margin-top:18px;padding:14px 16px;border-radius:14px;border:1px solid var(--line);background:rgba(192,131,40,.06);">
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
          <strong style="color:var(--gold);">商务分</strong>
          <span style="color:var(--muted);font-size:12px;">播放量（万）：</span>
          <input class="input" type="number" min="0" data-field="playCount" data-vid="${v.id}" value="${v.playCount || 0}" style="width:130px;" placeholder="如 5000">
          <span class="biz" style="color:var(--gold);font-weight:700;">${vendorBusinessScore(v.id).toFixed(1)} / 50</span>
          <span style="color:var(--muted);font-size:12px;">CPM <strong style="color:var(--text);">${cpm(v.id).toFixed(2)}</strong></span>
        </div>
      </div>

      <details style="margin-top:14px;border:1px solid var(--line);border-radius:12px;padding:10px 12px;background:rgba(255,251,244,.4);" class="ai-block">
        <summary style="cursor:pointer;font-size:13px;color:var(--gold);font-weight:600;display:flex;align-items:center;justify-content:space-between;list-style:none;">
          <span>供应商 AI 初评（仅供参考） ${hasResult ? '（已生成）' : ''}</span>
          <span style="display:flex;gap:8px;align-items:center;">
            <span class="toggle-icon" style="font-size:11px;color:var(--muted);">展开 ▾</span>
            ${hasResult ? `<button class="btn btn-danger" data-action="clear-vendor-ai" data-vid="${v.id}" style="font-size:11px;padding:4px 10px;">删除初评</button>` : ''}
          </span>
        </summary>
        <div style="margin-top:10px;display:grid;gap:8px;">
          <textarea class="input" data-action="set-vendor-materials" data-vid="${v.id}" placeholder="粘贴或导入该供应商的投标材料（讲标纪要、方案、资质响应等）..." style="min-height:120px;">${escapeAttr(state.vendorMaterials?.[v.id] || '')}</textarea>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
            <label class="btn" style="cursor:pointer;margin:0;">
              导入文件
              <input type="file" accept="application/pdf,.docx,.doc,.xlsx,.xls" data-action="import-vendor-file" data-vid="${v.id}" style="display:none;">
            </label>
            <button class="btn btn-primary" data-action="gen-vendor-ai" data-vid="${v.id}">生成初评</button>
            <span class="ai-status" data-vid="${v.id}" style="color:var(--muted);font-size:12px;">${(aiGenStatus[v.id]?.text) ? '' : (hasResult ? '' : '粘贴/导入材料后自动生成，也可手动点此')}</span>
          </div>
          ${hasAi ? `<div class="dimension-grid" style="margin-top:6px;">
            ${state.dimensions.map(d => {
              const a = ai[d.id];
              return `
                <div class="dimension" style="padding:10px;">
                  <div class="top"><strong>${escapeHtml(d.name)}</strong><span class="max">${a ? `建议 ${a.score}/${d.max}` : `--/${d.max}`}</span></div>
                  ${a?.evidence ? `<p style="margin:6px 0 0;color:var(--muted);font-size:12px;">${escapeHtml(a.evidence)}</p>` : ''}
                </div>`;
            }).join('')}
          </div>` : ''}
          ${(hasReqs && hasQual) ? `<div class="qual-list" style="margin-top:6px;">
            ${qual.map(q => {
              const cls = q.result === '符合' ? 'qual-pass' : q.result === '不符' ? 'qual-fail' : 'qual-partial';
              return `
                <div class="qual-row">
                  <div class="qtop">
                    <span class="qreq">${escapeHtml(q.req)}</span>
                    <span class="qual-badge ${cls}">${escapeHtml(q.result)}</span>
                  </div>
                  ${q.evidence ? `<div class="qual-evidence">${escapeHtml(q.evidence)}</div>` : ''}
                </div>`;
            }).join('')}
          </div>` : ''}
        </div>
      </details>

      ${judge ? `
      <div class="score-summary">
        <div><small>该评委技术分</small><strong>${judgeTotalForVendor(v.id, judge.id).toFixed(1)}</strong></div>
        <div><small>评委技术均分</small><strong>${vendorTechAverage(v.id).toFixed(1)}</strong></div>
        <div><small>总分（含商务）</small><strong>${vendorTotal(v.id).toFixed(1)}</strong></div>
      </div>` : ''}

      ${judge ? (state.dimensions.length % 2 === 1 ? '' : renderJudgeVendorComments(v.id, judge.id)) : ''}
    </section>
  `;
}

// 渲染某供应商各评委的总评（嵌入维度网格空位）
function renderJudgeVendorCommentsInline(vid, activeJudgeId) {
  const comments = state.judges.map(j => {
    const text = (vendorComments[vid]?.[j.id] || '').trim();
    return { j, text };
  });
  const any = comments.some(c => c.text);
  if (!any) return `<div class="dimension dim-comments-slot" style="display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:12px;border-style:dashed;">评委总评（暂无）</div>`;
  return `
    <div class="dimension dim-comments-slot judge-comments-card" style="margin:0;">
      <div class="jc-head"><strong>评委总评</strong></div>
      <div class="jc-list">
        ${comments.map(c => `
          <div class="jc-row ${c.j.id===activeJudgeId?'active':''}">
            <div class="jc-judge">${escapeHtml(c.j.name)}</div>
            <div class="jc-text">${c.text ? escapeHtml(c.text) : '<span class="jc-empty">未填写</span>'}</div>
          </div>`).join('')}
      </div>
    </div>`;
}

// 渲染某供应商各评委的总评卡片
function renderJudgeVendorComments(vid, activeJudgeId) {
  const comments = state.judges.map(j => {
    const text = (vendorComments[vid]?.[j.id] || '').trim();
    return { j, text };
  });
  const any = comments.some(c => c.text);
  if (!any) return '';
  return `
    <div class="judge-comments-card">
      <div class="jc-head"><strong>评委总评</strong></div>
      <div class="jc-list">
        ${comments.map(c => `
          <div class="jc-row ${c.j.id===activeJudgeId?'active':''}">
            <div class="jc-judge">${escapeHtml(c.j.name)}</div>
            <div class="jc-text">${c.text ? escapeHtml(c.text) : '<span class="jc-empty">未填写</span>'}</div>
          </div>`).join('')}
      </div>
    </div>`;
}

// ---------- 汇总看板（对齐 Excel 评分汇总表） ----------
function viewDashboard() {
  const { phase, deadline } = computePhase();
  const ranked = [...state.vendors].sort((a, b) => vendorTotal(b.id) - vendorTotal(a.id));
  const anyScored = state.vendors.some(v => vendorTotal(v.id) > 0);
  const leader = ranked[0];
  const leaderTech = anyScored && leader ? vendorTechAverage(leader.id) : 0;
  const leaderCpm = anyScored && leader ? cpm(leader.id) : 0;
  const doneCount = state.vendors.filter(v => vendorStatus(v) === 'done').length;
  const judges = state.judges;

  const rankHead = `<tr>
    <th>供应商</th>
    ${judges.map(j => `<th>${escapeHtml(j.name)}</th>`).join('')}
    <th>技术平均</th><th>技术权重</th><th>商务分</th><th>总分</th><th>CPM</th>
  </tr>`;
  const rankRows = ranked.map((v, i) => `
    <tr>
      <td><strong>${i === 0 && anyScored ? '🏆 ' : ''}${escapeHtml(shortName(v.name))}</strong></td>
      ${judges.map(j => `<td>${judgeTotalForVendor(v.id, j.id).toFixed(1)}</td>`).join('')}
      <td>${vendorTechAverage(v.id).toFixed(1)}</td>
      <td>${vendorTechWeighted(v.id).toFixed(1)}</td>
      <td>${vendorBusinessScore(v.id).toFixed(1)}</td>
      <td class="${i === 0 && anyScored ? 'rank-1' : ''}">${vendorTotal(v.id).toFixed(1)}</td>
      <td>${cpm(v.id).toFixed(2)}</td>
    </tr>`).join('');

  // 手机端排名卡片
  const rankCards = ranked.map((v, i) => `
    <div class="rank-card ${i === 0 && anyScored ? 'lead' : ''}">
      <div class="rc-head">
        <span class="rc-no">${i + 1}</span>
        <strong class="rc-name">${escapeHtml(v.name)}</strong>
        <span class="rc-total ${i === 0 && anyScored ? 'rank-1' : ''}">${vendorTotal(v.id).toFixed(1)}</span>
      </div>
      <div class="rc-rows">
        ${judges.map(j => `<div class="rc-row"><span>${escapeHtml(j.name)}</span><strong>${judgeTotalForVendor(v.id, j.id).toFixed(1)}</strong></div>`).join('')}
        <div class="rc-row"><span>技术平均</span><strong>${vendorTechAverage(v.id).toFixed(1)}</strong></div>
        <div class="rc-row"><span>技术权重</span><strong>${vendorTechWeighted(v.id).toFixed(1)}</strong></div>
        <div class="rc-row"><span>商务分</span><strong>${vendorBusinessScore(v.id).toFixed(1)}</strong></div>
        <div class="rc-row"><span>CPM</span><strong>${cpm(v.id).toFixed(2)}</strong></div>
      </div>
    </div>
  `).join('') || '<div class="empty-state">还没有供应商。</div>';

  const crossAnalysis = state.crossVendorAnalysis || '';
  const hasAiEnough = state.vendors.length > 0 && state.vendors.every(v => state.vendorMaterials?.[v.id]?.trim());

  return `
    <section class="hero">
      <div>
        <div class="eyebrow">Bid Evaluation Command Room</div>
        <h2>${escapeHtml(state.project.name)}</h2>
        <p>当前阶段：${escapeHtml(phase)}。</p>
        <div class="hero-meta">
          <div class="tag">${state.dimensions.length} 个评分维度</div>
          <div class="tag">${state.judges.length} 位评委</div>
          <div class="tag">${state.vendors.length} 家供应商</div>
          <div class="tag">预算 ¥${(state.project.budget || 0).toLocaleString()}</div>
        </div>
      </div>
      <div class="countdown">
        <div>
          <div class="eyebrow">评分截止</div>
          <div class="time">${escapeHtml(deadline || '未设置')}</div>
        </div>
        <div class="sub"></div>
      </div>
    </section>

    <section class="grid-4">
      <div class="metric"><small>总分最高</small><strong>${anyScored && leader ? escapeHtml(shortName(leader.name)) : '--'}</strong><span>${anyScored && leader ? vendorTotal(leader.id).toFixed(1) + ' 分' : '尚未评分'}</span></div>
      <div class="metric"><small>其技术平均分</small><strong>${anyScored ? leaderTech.toFixed(1) : '--'}</strong><span></span></div>
      <div class="metric"><small>其 CPM</small><strong>${anyScored && leaderCpm > 0 ? leaderCpm.toFixed(2) : '--'}</strong><span></span></div>
      <div class="metric"><small>讲标进度</small><strong>${doneCount} / ${state.vendors.length}</strong><span></span></div>
    </section>

    <section class="panel">
      <div class="panel-head"><div><h3>智能分析</h3><p>异常报价自动检测 + 评标报告自动生成 Word + 供应商横评</p></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn btn-primary" data-action="gen-report" ${(reportGenerating || !allJudgesSigned()) ? 'disabled' : ''}>${reportGenerating ? '报告生成中…' : (allJudgesSigned() ? '生成评标报告' : '评分未收集完')}</button>
          <button class="btn" data-action="download-report" data-report-dl ${(lastReportDoc && !reportGenerating) ? '' : 'hidden'}>下载 Word</button>
        </div>
      </div>
      <div>
        <strong style="font-size:13px;color:var(--gold);">异常报价检测</strong>
        ${(() => {
          const an = detectAnomalies();
          if (!an.length) return '<div class="anomaly-ok">所有报价在正常区间内（样本不足 2 家或无偏离）。</div>';
          return `<div class="anomaly-list">${an.map(x => `
            <div class="anomaly-item anomaly-${x.severity}">
              <span class="aname">${escapeHtml(shortName(vendorName(x.vid)))}</span>
              <span class="atag">${escapeHtml(x.label)}</span>
              <span style="flex:1;">${escapeHtml(x.desc)}</span>
            </div>`).join('')}</div>`;
        })()}
      </div>
      <div class="cross-vendor-box" style="margin-top:14px;">
        ${crossAnalysis
          ? `<div data-action="toggle-cross-detail" style="cursor:pointer;">
              <div style="display:flex;align-items:center;justify-content:space-between;font-size:13px;color:var(--gold);font-weight:600;">
                <span>供应商横评 · 已生成</span>
                <span class="toggle-icon" style="font-size:11px;color:var(--muted);">展开 ▾</span>
              </div>
              <div class="cross-vendor-summary" style="color:var(--text);font-size:13px;margin-top:8px;line-height:1.7;">${formatCrossSummary(extractCrossRecommendation(crossAnalysis))}</div>
            </div>
            <div class="cross-vendor-content" style="display:none;margin-top:10px;padding-top:10px;border-top:1px dashed var(--border);">${formatCrossFull(extractCrossRest(crossAnalysis))}</div>`
          : `<div style="font-size:13px;color:var(--gold);font-weight:600;margin-bottom:6px;">供应商横评</div>
             <div class="anomaly-ok">${hasAiEnough ? '点击右上角「生成供应商横评」按钮生成横向对比分析。' : '所有供应商都上传材料后，可一键生成横评（评分工作台右上角按钮）。'}</div>`}
      </div>
    </section>

    <section class="stack">
      <div class="panel">
        <div class="panel-head">
          <div>
            <h3>讲标时间线</h3>
            <p>每家到开始时间自动开放；同一天内可手动推进下一家，新一天按开始时间自动开放第一家</p>
          </div>
          ${(() => {
            const sorted = sortedVendors();
            if (!sorted.length) return '';
            const locked = isProjectLocked();
            if (locked) {
              return `<div class="progress-actions" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                <span class="status-pill status-done">会议已结束，项目已锁定（只读）</span>
              </div>`;
            }
            const first = sorted[0];
            const firstStarted = first && first.meetingDate && first.startTime && new Date() >= new Date(`${first.meetingDate}T${first.startTime}:00+08:00`);
            const curId = getCurrentVendorId();
            const curIdx = sorted.findIndex(v => v.id === curId);
            const idx = curId ? curIdx : (firstStarted ? 0 : -1);
            const current = idx >= 0 ? sorted[idx] : null;
            const next = idx >= 0 && idx < sorted.length - 1 ? sorted[idx + 1] : null;
            return `
            <div class="progress-actions" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
              ${!firstStarted ? `<span class="status-pill status-todo">第一家将于 ${escapeHtml(first.startTime || '--')} 自动开放</span>` : ''}
              ${current ? `<span class="status-pill status-doing">当前开放：${escapeHtml(current.name)}</span>` : ''}
              ${next ? `<button class="btn btn-primary" data-action="advance-vendor">结束当前，开始下一家：${escapeHtml(next.name)}</button>` : (firstStarted ? '<span class="status-pill status-done">已全部开放</span>' : '')}
            </div>`;
          })()}
        </div>
        <div class="timeline">
          ${sortedVendors().map(v => {
            const st = vendorStatus(v);
            return `
            <div class="timeline-item">
              <div class="slot">${escapeHtml(v.meetingDate || '--')}<br>${escapeHtml(v.startTime || '')}-${escapeHtml(v.endTime || '')}</div>
              <div>
                <div class="name">${escapeHtml(v.name)}</div>
                ${v.meetingLink ? (isSafeUrl(v.meetingLink) ? `<a class="link" href="${escapeAttr(v.meetingLink)}" target="_blank" rel="noopener">${escapeHtml(v.meetingLink)}</a>` : `<span class="link">${escapeHtml(v.meetingLink)}</span>`) : ''}
              </div>
              <div class="status-pill ${statusClass(st)}">${statusLabel(st)}</div>
            </div>`;
          }).join('') || '<div class="empty-state">还没有供应商。</div>'}
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><div><h3>实时排名</h3></div></div>
        <table class="table desktop-table">
          <thead>${rankHead}</thead>
          <tbody>${rankRows || `<tr><td colspan="${7 + judges.length}" class="empty-state">没有供应商</td></tr>`}</tbody>
        </table>
        <div class="rank-cards-mobile">${rankCards}</div>
      </div>
    </section>
  `;
}

// ---------- 历史库 ----------
function viewHistory() {
  const archives = state.archives || [];
  const registry = state.supplierRegistry || {};
  const historyJudgeProjects = archives.reduce((sum, a) => sum + ((a.judgeSnapshot || []).length ? 1 : 0), 0);
  const categories = [...new Set(archives.map(a => a.category).filter(Boolean))];
  const filterCat = ui.historyFilter || '';
  const filtered = filterCat ? archives.filter(a => a.category === filterCat) : archives;

  const registryRows = Object.values(registry).sort((a, b) => b.totalBids - a.totalBids).map(s => `
    <div class="supplier-row" data-key="${escapeAttr(s.name.toLowerCase())}">
      <span class="sname">${escapeHtml(s.name)}</span>
      <span class="smeta">投标 <span class="snum">${s.totalBids}</span> 次</span>
      <span class="smeta">中标 <span class="snum">${s.totalWins}</span> 次</span>
      <span class="smeta">均分 ${s.avgTotal.toFixed(1)}</span>
      <input class="input" data-action="set-supplier-note" data-key="${escapeAttr(s.name.toLowerCase())}" value="${escapeAttr(s.notes || '')}" placeholder="备注">
      <button class="btn ${s.blacklist ? 'btn-primary' : 'btn-danger'}" data-action="toggle-blacklist" data-key="${escapeAttr(s.name.toLowerCase())}" style="font-size:12px;padding:6px 10px;">${s.blacklist ? '取消黑名单' : '黑名单'}</button>
    </div>
  `).join('') || '<div class="empty-state">暂无供应商档案。</div>';

  return `
    <section class="hero">
      <div>
        <div class="eyebrow">Project Archive</div>
        <h2>历史库</h2>
        <p>归档的评标项目，可查看历史记录、供应商档案，或复用为新项目。</p>
      </div>
    </section>

    <section class="grid-4">
      <div class="metric"><small>已归档项目</small><strong>${archives.length}</strong><span></span></div>
      <div class="metric"><small>历史供应商</small><strong>${Object.keys(registry).length}</strong><span></span></div>
      <div class="metric"><small>评委参与项目</small><strong>${historyJudgeProjects}</strong><span></span></div>
      <div class="metric"><small>可复用模板</small><strong>${archives.length}</strong><span></span></div>
    </section>

    <section class="panel">
      <div class="panel-head"><div><h3>供应商档案</h3><p>按归档自动聚合的中标率、平均分、CPM</p></div></div>
      <div class="supplier-registry">${registryRows}</div>
    </section>

    <section class="panel">
      <div class="panel-head"><div><h3>归档项目</h3><p>按时间倒序，点击卡片查看详情</p></div>
        ${categories.length ? `<div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn ${!filterCat?'btn-primary':''}" data-action="filter-history" data-cat="">全部</button>
          ${categories.map(c => `<button class="btn ${filterCat===c?'btn-primary':''}" data-action="filter-history" data-cat="${escapeAttr(c)}">${escapeHtml(c)}</button>`).join('')}
        </div>` : ''}
      </div>
      <div class="archive-list">
        ${filtered.length ? filtered.map(a => `
          <div class="archive-card">
            <div class="ac-head">
              <div>
                <div class="ac-name">${escapeHtml(a.name)}</div>
                <div class="ac-meta">
                  <span class="ac-tag">${escapeHtml(a.category || '通用')}</span>
                  <span>${new Date(a.archivedAt).toLocaleString('zh-CN')}</span>
                </div>
              </div>
              <div style="text-align:right;">
                <div style="font-size:20px;font-weight:700;color:var(--gold);">${a.winnerTotal.toFixed(1)}</div>
                <div style="font-size:11px;color:var(--muted);">中标总分</div>
              </div>
            </div>
            <div class="ac-winner">中标：${escapeHtml(a.winnerName || '—')}</div>
            <div class="ac-actions">
              <button class="btn btn-primary" data-action="open-archive" data-aid="${a.id}">查看详情</button>
              <button class="btn" data-action="clone-from-archive" data-aid="${a.id}">复用为新项目</button>
              <button class="btn btn-danger" data-action="del-archive" data-aid="${a.id}">删除归档</button>
            </div>
          </div>
        `).join('') : '<div class="empty-state">还没有归档项目。去「汇总看板」点「归档本项目」。</div>'}
      </div>
    </section>
  `;
}

// ---------- 项目设置 ----------
function viewSettings() {
  const { phase, deadline } = computePhase();
  const judgeLink = (j) => `${location.origin}${location.pathname.replace(/index\.html$/,'')}judge.html#token=${j.token}`;
  return `
    <section class="panel">
      <div class="panel-head"><div><h3>项目基本信息</h3></div></div>
      <div class="form-section">
        <div class="form-row"><label>项目名称</label></div>
        <input class="input" data-action="set-project" data-field="name" value="${escapeAttr(state.project.name)}">
        <div class="form-row" style="margin-top:14px;grid-template-columns:120px 1fr;"><label>项目预算（元）</label><input class="input" data-action="set-project" data-field="budget" type="number" min="0" value="${state.project.budget || 0}" placeholder="如 1400000"></div>
        <div style="margin-top:14px;">
          <div class="readonly-row"><span>当前阶段</span><strong>${escapeHtml(phase)}</strong></div>
          <div class="readonly-row"><span>评分截止</span><strong>${escapeHtml(deadline || '未设置')}</strong></div>
        </div>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head"><div><h3>评分维度</h3></div>
        <button class="btn btn-primary" data-action="add-dim">+ 添加维度</button>
      </div>
      ${state.dimensions.map(d => `
        <div class="form-row" data-did="${d.id}">
          <input class="input" data-action="set-dim" data-did="${d.id}" data-field="name" value="${escapeAttr(d.name)}" placeholder="维度名">
          <input class="input small" data-action="set-dim" data-did="${d.id}" data-field="max" type="number" min="0" value="${d.max}" placeholder="满分">
          <button class="btn btn-danger" data-action="del-dim" data-did="${d.id}">删除</button>
        </div>
        <textarea class="input" data-action="set-dim-details" data-did="${d.id}" placeholder="二级维度评分细则，每行一条" style="margin-bottom:8px;min-height:90px;">${escapeAttr((d.details || []).join('\n'))}</textarea>
        <input class="input" data-action="set-dim" data-did="${d.id}" data-field="standard" value="${escapeAttr(d.standard || '')}" placeholder="评分标准（如：好14-20；较好8-14；一般1-7）" style="margin-bottom:14px;">
      `).join('')}
    </section>

    <section class="panel">
      <div class="panel-head"><div><h3>评委</h3></div>
        <button class="btn btn-primary" data-action="add-judge">+ 添加评委</button>
      </div>
      ${state.judges.map(j => {
        const m = judgeMeta[j.id] || {};
        const signed = m.locked;
        const sigTime = m.signedAt ? new Date(m.signedAt).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : '';
        return `
        <div class="form-row" data-jid="${j.id}" style="grid-template-columns:1fr auto auto;">
          <input class="input" data-action="set-judge" data-jid="${j.id}" data-field="name" value="${escapeAttr(j.name)}" placeholder="评委名">
          <button class="btn ${signed?'':'btn-danger'}" data-action="del-judge" data-jid="${j.id}">删除</button>
          ${signed ? `<button class="btn" data-action="unlock-judge" data-jid="${j.id}">解锁</button>` : `<button class="btn" disabled>未签名</button>`}
        </div>
        <div class="link-row">
          <span class="lname">外链：</span>
          <span class="lurl">${escapeHtml(judgeLink(j))}</span>
          <button class="btn copy" data-action="copy-link" data-link="${escapeAttr(judgeLink(j))}">复制</button>
          ${signed ? `<span style="color:var(--green);font-size:12px;margin-left:8px;">✓ 已签名 ${escapeHtml(sigTime)}</span>` : ''}
        </div>`;
      }).join('') || '<div class="empty-state">还没有评委。</div>'}
    </section>

    <section class="panel">
      <div class="panel-head"><div><h3>供应商</h3></div>
        <button class="btn btn-primary" data-action="add-vendor">+ 添加供应商</button>
      </div>
      ${state.vendors.map(v => {
        const isCurrent = v.id === getCurrentVendorId();
        return `
        <div class="form-row" data-vid="${v.id}" style="grid-template-columns:1fr auto auto auto;">
          <input class="input" data-action="set-vendor-name" data-vid="${v.id}" value="${escapeAttr(v.name)}" placeholder="供应商名称">
          <button class="btn ${isCurrent ? 'btn-primary' : ''}" data-action="set-current-vendor" data-vid="${v.id}" ${isCurrent ? 'disabled' : ''}>${isCurrent ? '当前开放' : '设为当前'}</button>
          <button class="btn" data-action="open-meeting" data-vid="${v.id}">会议信息</button>
          <button class="btn btn-danger" data-action="del-vendor" data-vid="${v.id}">删除</button>
        </div>`;
      }).join('') || '<div class="empty-state">还没有供应商。</div>'}
    </section>

    <section class="panel">
      <div class="panel-head"><div><h3>招标要求</h3></div></div>
      <div class="form-section">
        <p style="color:var(--muted);font-size:12px;margin:0 0 8px;">粘贴招标文件中的资格/资质/合规要求，每行一条。用于评分工作台逐家资质核验。</p>
        <textarea class="input" data-action="set-tender-reqs" placeholder="例如：&#10;具备有效的广告经营许可证&#10;近三年同类项目案例不少于 3 个&#10;注册资本不低于 500 万元" style="min-height:120px;">${escapeAttr(state.tenderReqs || '')}</textarea>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head"><div><h3>AI 配置</h3></div></div>
      <div class="form-section">
        <div class="form-row" style="grid-template-columns:120px 1fr;"><label>Base URL</label><input class="input" data-action="set-ai" data-field="baseUrl" value="${escapeAttr(state.aiConfig?.baseUrl || '')}" placeholder="https://open.bigmodel.cn/api/paas/v4"></div>
        <div class="form-row" style="grid-template-columns:120px 1fr;"><label>Model</label><input class="input" data-action="set-ai" data-field="model" value="${escapeAttr(state.aiConfig?.model || '')}" placeholder="glm-4-plus"></div>
        <div class="form-row" style="grid-template-columns:120px 1fr;"><label>API Key</label><input class="input" data-action="set-ai" data-field="key" type="password" value="${escapeAttr(state.aiConfig?.key || '')}" placeholder="留空则用后端环境变量"></div>
      </div>
    </section>
  `;
}

const RENDERERS = {
  scoring: viewScoring,
  dashboard: viewDashboard, settings: viewSettings,
  history: viewHistory,
};

// ============ 事件绑定 ============
function bindViewEvents() {
  // 评委打分由评委外链端写入，管理端只读展示，无输入绑定

  // 供应商字段（讲标安排 + 评分工作台的播放量）
  viewEl.querySelectorAll('[data-field][data-vid]').forEach(el => {
    el.addEventListener('input', () => {
      const { vid, field } = el.dataset;
      const v = state.vendors.find(x => x.id === vid);
      if (!v) return;
      if (field === 'playCount') v.playCount = parseFloat(el.value) || 0;
      else v[field] = el.value;
      saveState();
    });
  });

  // 设置：项目字段
  viewEl.querySelectorAll('[data-action="set-project"]').forEach(el => {
    el.addEventListener('input', () => {
      const f = el.dataset.field;
      state.project[f] = f === 'budget' ? (parseFloat(el.value) || 0) : el.value;
      saveState();
    });
  });
  // 维度
  viewEl.querySelectorAll('[data-action="set-dim"]').forEach(el => {
    el.addEventListener('input', () => {
      const d = state.dimensions.find(x => x.id === el.dataset.did);
      if (!d) return;
      const f = el.dataset.field;
      d[f] = f === 'max' ? (parseFloat(el.value) || 0) : el.value;
      saveState();
    });
  });
  // 维度细则（textarea，每行一条）
  viewEl.querySelectorAll('[data-action="set-dim-details"]').forEach(el => {
    el.addEventListener('input', () => {
      const d = state.dimensions.find(x => x.id === el.dataset.did);
      if (!d) return;
      d.details = el.value.split('\n').map(s => s.trim()).filter(Boolean);
      saveState();
    });
  });
  // 评委
  viewEl.querySelectorAll('[data-action="set-judge"]').forEach(el => {
    el.addEventListener('input', () => {
      const j = state.judges.find(x => x.id === el.dataset.jid);
      if (j) { j[el.dataset.field] = el.value; saveState(); }
    });
  });
  // 供应商名
  viewEl.querySelectorAll('[data-action="set-vendor-name"]').forEach(el => {
    el.addEventListener('input', () => {
      const v = state.vendors.find(x => x.id === el.dataset.vid);
      if (v) { v.name = el.value; saveState(); }
    });
  });

  // 供应商档案备注
  viewEl.querySelectorAll('[data-action="set-supplier-note"]').forEach(el => {
    el.addEventListener('input', () => {
      state.supplierRegistry = state.supplierRegistry || {};
      const s = state.supplierRegistry[el.dataset.key];
      if (s) { s.notes = el.value; saveState(); }
    });
  });

  // AI 配置
  viewEl.querySelectorAll('[data-action="set-ai"]').forEach(el => {
    el.addEventListener('input', () => {
      state.aiConfig = state.aiConfig || {};
      state.aiConfig[el.dataset.field] = el.value;
      saveState();
    });
  });

  // 供应商材料：粘贴/输入立即保存，并自动静默生成 AI 初评（不打断，保留生成按钮冗余）
  viewEl.querySelectorAll('[data-action="set-vendor-materials"]').forEach(el => {
    el.addEventListener('input', () => {
      const vid = el.dataset.vid;
      state.vendorMaterials = state.vendorMaterials || {};
      state.vendorMaterials[vid] = el.value;
      saveState();
      debounceGenVendorAi(vid);
    });
    el.addEventListener('paste', () => {
      const vid = el.dataset.vid;
      state.vendorMaterials = state.vendorMaterials || {};
      state.vendorMaterials[vid] = el.value;
      saveState();
      debounceGenVendorAi(vid, 600);
    });
  });

  // 招标要求
  viewEl.querySelectorAll('[data-action="set-tender-reqs"]').forEach(el => {
    el.addEventListener('input', () => {
      state.tenderReqs = el.value;
      saveState();
    });
  });

  // 文件导入：change 事件单独绑（不是 click）
  viewEl.querySelectorAll('[data-action="import-vendor-file"]').forEach(el => {
    el.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const vid = el.dataset.vid;
      const setGenStatus = (text) => {
        if (text === null) delete aiGenStatus[vid];
        else aiGenStatus[vid] = { text };
        safeRenderAll();
      };
      setGenStatus('正在读取文件…');
      try {
        const text = await extractFileText(file, msg => setGenStatus(msg));
        if (!text.trim()) {
          setGenStatus('抽不到文字（OCR 也无结果），请直接粘贴文字或换文字版文件');
          setTimeout(() => setGenStatus(null), 6000);
          return;
        }
        state.vendorMaterials = state.vendorMaterials || {};
        state.vendorMaterials[vid] = text;
        saveState();
        const ta = viewEl.querySelector(`textarea[data-action="set-vendor-materials"][data-vid="${vid}"]`);
        if (ta) ta.value = text;
        setGenStatus(`已从文件提取 ${text.length} 字，自动生成中…`);
        debounceGenVendorAi(vid, 400);
      } catch (err) {
        setGenStatus('文件读取失败：' + err.message);
        setTimeout(() => setGenStatus(null), 8000);
      } finally {
        e.target.value = ''; // 允许重复选同一文件
      }
    });
  });

  // 通用 action（view 内）
  viewEl.querySelectorAll('[data-action]').forEach(el => {
    const a = el.dataset.action;
    if (['add-vendor','del-vendor','add-dim','del-dim','add-judge','del-judge','pick-vendor','pick-judge','parse-paste-modal','auto-end-modal','open-meeting','close-meeting','save-meeting','gen-vendor-ai','clear-vendor-ai','gen-report','gen-cross-analysis','download-report','archive-project','open-archive','del-archive','clone-from-archive','adopt-from-similar','filter-history','set-supplier-note','toggle-blacklist','copy-link','unlock-judge','advance-vendor','set-current-vendor','view-archive-cross','toggle-cross-detail','toggle-archive-cross'].includes(a)) {
      el.addEventListener('click', handleAction);
    }
  });

  // 推进下拉已移除（按时间自动推进）
}

async function handleAction(e) {
  const el = e.currentTarget || (e.target && e.target.closest ? e.target.closest('[data-action]') : null);
  if (!el) return;
  const a = el.dataset.action;
  switch (a) {
    case 'add-vendor':
      state.vendors.push({ id: 'v'+uid(), name: '', order: state.vendors.length, meetingDate: '', startTime: '', endTime: '', meetingLink: '', meetingId: '', meetingPwd: '', playCount: 0, status: 'todo' });
      saveStateAndRender(); break;
    case 'del-vendor': {
      const id = el.dataset.vid;
      state.vendors = state.vendors.filter(v => v.id !== id);
      // 先清云端 scores 再推 state，避免 state 先到后短暂残留孤儿 scores
      await apiPost('/admin', { action: 'clearScoresBy', vendorId: id });
      saveStateAndRender(); break;
    }
    case 'add-dim':
      state.dimensions.push({ id: 'd'+uid(), name: '', max: 10, desc: '' });
      saveStateAndRender(); break;
    case 'del-dim':
      state.dimensions = state.dimensions.filter(d => d.id !== el.dataset.did);
      await apiPost('/admin', { action: 'clearScoresBy', dimId: el.dataset.did });
      saveStateAndRender(); break;
    case 'add-judge':
      state.judges.push({ id: 'j'+uid(), name: '', token: uid() });
      saveStateAndRender(); break;
    case 'del-judge':
      state.judges = state.judges.filter(j => j.id !== el.dataset.jid);
      await apiPost('/admin', { action: 'clearScoresBy', judgeId: el.dataset.jid });
      saveStateAndRender(); break;
    case 'unlock-judge': {
      const jid = el.dataset.jid;
      const j = state.judges.find(x => x.id === jid);
      if (!confirm(`解锁评委 ${j?.name || ''}？将清空其签名，打分可再修改。`)) break;
      await apiPost('/admin-unlock', { judgeId: jid });
      if (judgeMeta[jid]) { judgeMeta[jid].locked = false; judgeMeta[jid].signature = null; judgeMeta[jid].signedAt = null; }
      saveStateAndRender();
      break;
    }
    case 'pick-vendor':
      ui.activeVendor = el.dataset.vid;
      persistLocal();
      renderAll(); break;
    case 'pick-judge':
      ui.activeJudge = el.dataset.jid;
      persistLocal();
      renderAll(); break;
    case 'advance-vendor': {
      if (isProjectLocked()) { alert('会议已结束，项目已锁定，无法推进'); break; }
      const sorted = sortedVendors();
      const curId = getCurrentVendorId();
      const curIdx = sorted.findIndex(v => v.id === curId);
      const next = sorted[curIdx + 1];
      if (next) {
        setCurrentVendorId(next.id);
        persistLocal();
        saveStateCloud();
        // 即时反馈：按钮已点击立即改文案，避免等待推云回写
        el.disabled = true; el.textContent = '已推进，同步中…';
        setTimeout(saveStateAndRender, 200);
      }
      break;
    }
    case 'set-current-vendor': {
      if (isProjectLocked()) { alert('会议已结束，项目已锁定，无法更改开放供应商'); break; }
      setCurrentVendorId(el.dataset.vid);
      persistLocal();
      saveStateCloud();
      saveStateAndRender();
      break;
    }
    case 'parse-paste-modal': {
      const text = document.getElementById('modalPaste').value;
      const cnt = applyParsedMeeting(text);
      const hint = document.getElementById('pasteHint');
      if (hint) hint.textContent = cnt > 0 ? `已识别 ${cnt} 项` : '未识别到内容，请手动填写';
      break;
    }
    case 'auto-end-modal': {
      const s = document.getElementById('mStart').value;
      if (s) {
        const [h, m] = s.split(':').map(Number);
        const end = new Date(); end.setHours(h, m + 30, 0, 0);
        document.getElementById('mEnd').value = `${String(end.getHours()).padStart(2,'0')}:${String(end.getMinutes()).padStart(2,'0')}`;
      }
      break;
    }
    case 'open-meeting': {
      openMeetingModal(el.dataset.vid);
      break;
    }
    case 'close-meeting':
      closeMeetingModal();
      break;
    case 'save-meeting': {
      const vid = meetingModal.dataset.vid;
      const v = state.vendors.find(x => x.id === vid);
      if (v) {
        const startVal = document.getElementById('mStart').value;
        const endVal = document.getElementById('mEnd').value;
        const dateVal = document.getElementById('mDate').value;
        // 校验 1：结束晚于开始
        if (startVal && endVal) {
          const [sh, sm] = startVal.split(':').map(Number);
          const [eh, em] = endVal.split(':').map(Number);
          if (eh * 60 + em <= sh * 60 + sm) {
            alert('结束时间必须晚于开始时间，请检查');
            break;
          }
        }
        // 校验 2：会议不能整场设到过去（以结束时间判断，进行中的会议仍可编辑补会议号等）
        if (dateVal && endVal) {
          const endMs = new Date(`${dateVal}T${endVal}:00+08:00`).getTime();
          if (!isNaN(endMs) && endMs < Date.now()) {
            alert('会议结束时间已过，不能订到过去，请检查日期和时间');
            break;
          }
        }
        v.meetingDate = document.getElementById('mDate').value;
        v.startTime = startVal;
        v.endTime = endVal;
        v.meetingLink = document.getElementById('mLink').value;
        v.meetingId = document.getElementById('mId').value;
        v.meetingPwd = document.getElementById('mPwd').value;
        saveStateAndRender();
        saveStateCloud();
      }
      closeMeetingModal();
      break;
    }
    case 'auto-end': {
      const v = state.vendors.find(x => x.id === el.dataset.vid);
      if (v && v.startTime) {
        const [h, m] = v.startTime.split(':').map(Number);
        const end = new Date(); end.setHours(h, m + 30, 0, 0);
        v.endTime = `${String(end.getHours()).padStart(2,'0')}:${String(end.getMinutes()).padStart(2,'0')}`;
        saveStateAndRender();
      }
      break;
    }
    case 'gen-vendor-ai': {
      const vid = el.dataset.vid;
      const text = (state.vendorMaterials?.[vid] || '').trim();
      if (!text) { alert('请先粘贴或导入该供应商的材料'); return; }
      // 作废旧请求（auto 或手动），注册本轮句柄，防止并发回写覆盖
      if (aiGenRequests[vid]) aiGenRequests[vid].aborted = true;
      delete aiGenStatus[vid];
      const myReq = { aborted: false, timer: null };
      aiGenRequests[vid] = myReq;
      const statusEl = viewEl.querySelector(`.ai-status[data-vid="${vid}"]`);
      const t0 = Date.now();
      if (statusEl) {
        const tick = () => { if (!myReq.aborted) statusEl.textContent = `生成中… ${((Date.now()-t0)/1000).toFixed(0)}s`; };
        tick(); myReq.timer = setInterval(tick, 1000);
      }
      try {
        const res = await generateVendorAiLocal(vid);
        if (myReq.aborted) { if (myReq.timer) clearInterval(myReq.timer); break; }
        if (myReq.timer) clearInterval(myReq.timer);
        state.aiSuggestions = state.aiSuggestions || {};
        state.qualResults = state.qualResults || {};
        state.aiSuggestions[vid] = res.scores || {};
        state.qualResults[vid] = res.quals || [];
        persistLocal();
        saveStateCloud();
        delete aiGenStatus[vid];
        if (statusEl) statusEl.textContent = `已生成 · ${((Date.now()-t0)/1000).toFixed(1)}s`;
        safeRenderAll();
      } catch (e) {
        if (myReq.aborted) { if (myReq.timer) clearInterval(myReq.timer); break; }
        if (myReq.timer) clearInterval(myReq.timer);
        if (statusEl) statusEl.textContent = '失败：' + e.message;
      } finally {
        aiGenRequests[vid] = null;
      }
      break;
    }
    case 'clear-vendor-ai': {
      const vid = el.dataset.vid;
      if (!confirm('删除该供应商的 AI 初评及材料？')) break;
      delete state.aiSuggestions?.[vid];
      delete state.qualResults?.[vid];
      delete state.minutes?.[vid];
      delete state.qualInputs?.[vid];
      delete state.vendorMaterials?.[vid];
      saveStateAndRender();
      saveStateCloud();
      break;
    }
    case 'gen-report': {
      if (reportGenerating) break;
      if (!allJudgesSigned()) { alert('还有评委未签名确认，评分尚未收集完成，暂不能生成报告'); break; }
      reportGenerating = true;
      setReportButtonLoading();
      try {
        const { md, doc } = await generateReportLocal();
        lastReportMd = md;
        lastReportDoc = doc;
        setReportButtonOriginal();
        showReportDlButton();
      } catch (e) {
        console.warn('生成报告失败', e);
        setReportButtonOriginal();
      }
      reportGenerating = false;
      break;
    }
    case 'gen-cross-analysis': {
      if (crossAnalysisGenerating) break;
      if (!state.vendors.length) { alert('请先添加供应商'); break; }
      const missing = state.vendors.filter(v => !state.vendorMaterials?.[v.id]?.trim());
      if (missing.length) { alert(`${missing.map(v => v.name).join('、')} 还没有投标材料，无法生成横向对比`); break; }
      crossAnalysisGenerating = true;
      renderAll();
      try {
        const text = await generateCrossVendorAnalysis();
        state.crossVendorAnalysis = text;
        persistLocal();
        saveStateCloud();
      } catch (e) {
        console.warn('生成供应商横评失败，尝试备用生成', e);
        try {
          const text = await generateCrossVendorAnalysisFallback();
          state.crossVendorAnalysis = text;
          persistLocal();
          saveStateCloud();
        } catch (e2) {
          alert('生成失败：' + e2.message);
        }
      }
      crossAnalysisGenerating = false;
      renderAll();
      break;
    }
    case 'toggle-cross-detail': {
      const box = e.target.closest('.cross-vendor-box');
      if (!box) break;
      const detail = box.querySelector('.cross-vendor-content');
      const icon = box.querySelector('.toggle-icon');
      if (!detail) break;
      const shown = detail.style.display !== 'none';
      detail.style.display = shown ? 'none' : 'block';
      if (icon) icon.textContent = shown ? '展开 ▾' : '收起 ▴';
      break;
    }
    case 'download-report':
      downloadReportDocx();
      break;
    case 'archive-project': {
      if (!confirm('归档当前项目？归档后会将当前项目及其结果存入历史库，并清空当前项目数据以开始新项目。')) break;
      const statusEl = document.getElementById('reportStatus');
      if (statusEl) statusEl.textContent = '归档中…';
      archiveCurrentProject().then(() => {
        // 归档后重置当前项目（维度/招标要求模板保留）
        state.project = { name: '', budget: 0 };
        state.vendors = [];
        state.judges = [];
        state.aiSuggestions = {};
        state.minutes = {};
        state.qualInputs = {};
        state.qualResults = {};
        state.vendorMaterials = {};
        state.crossVendorAnalysis = '';
        state.currentVendorId = null;
        state.currentVendorByDate = {};
        scores = {};
        lastReportDoc = null;
        lastReportMd = '';
        ui.tab = 'history';
        persistLocal();
        // 先清云端 scores 表（旧 vendor id 的分数不能残留到新项目），再推新 state
        apiPost('/admin', { action: 'clearScores' }).then(() => saveStateCloud());
        renderAll();
      }).catch(e => {
        alert('归档失败：' + e.message);
        if (statusEl) statusEl.textContent = '';
      });
      break;
    }
    case 'view-archive-cross': {
      openArchiveCrossModal(el.dataset.aid);
      break;
    }
    case 'toggle-archive-cross': {
      const box = e.target.closest('.archive-cross-box');
      if (!box) break;
      const detail = box.querySelector('.archive-cross-content');
      const icon = box.querySelector('.toggle-icon');
      if (!detail) break;
      const shown = detail.style.display !== 'none';
      detail.style.display = shown ? 'none' : 'block';
      if (icon) icon.textContent = shown ? '展开 ▾' : '收起 ▴';
      break;
    }
    case 'open-archive': {
      openArchiveDetail(el.dataset.aid);
      break;
    }
    case 'close-archive':
      closeArchiveModal();
      break;
    case 'filter-history': {
      ui.historyFilter = el.dataset.cat || '';
      persistLocal();
      renderAll();
      break;
    }
    case 'del-archive': {
      const aid = el.dataset.aid;
      if (!confirm('删除该历史归档？供应商档案会按剩余归档重新统计。')) break;
      state.archives = (state.archives || []).filter(a => a.id !== aid);
      rebuildSupplierRegistry();
      saveStateAndRender();
      saveStateCloud();
      break;
    }
    case 'clone-from-archive': {
      const aid = el.dataset.aid || currentArchiveId;
      const arc = (state.archives || []).find(a => a.id === aid);
      if (!arc) break;
      if (!confirm(`复用项目「${arc.name}」的维度模板、招标要求、供应商名单和评委作为新项目？（不带会议链接和分数）`)) break;
      state.project = { name: arc.name + '（复用）', budget: 0 };
      state.dimensions = structuredClone(arc.dimensionsSnapshot || DEFAULT_DIMENSIONS);
      state.tenderReqs = arc.tenderReqs || '';
      // 复用供应商名单和评委，但清掉会议信息和分数
      state.vendors = (arc.vendorSnapshot || []).map((vs, i) => ({
        id: 'v' + uid(), name: vs.name, order: i,
        meetingDate: '', startTime: '', endTime: '',
        meetingLink: '', meetingId: '', meetingPwd: '',
        playCount: 0, status: 'todo',
      }));
      state.judges = (arc.judgeSnapshot || []).map(js => ({
        id: 'j' + uid(), name: js.name, token: uid(),
      }));
      scores = {};
      state.aiSuggestions = {};
      state.minutes = {};
      state.qualInputs = {};
      state.qualResults = {};
      state.vendorMaterials = {};
      lastReportDoc = null;
      lastReportMd = '';
      ui.tab = 'dashboard';
      persistLocal();
      apiPost('/admin', { action: 'clearScores' }).then(() => saveStateCloud());
      renderAll();
      break;
    }
    case 'adopt-from-similar': {
      const srcId = el.dataset.aid;
      const src = (state.archives || []).find(a => a.id === srcId);
      if (!src) break;
      if (!confirm(`采用「${src.name}」的维度模板和招标要求替换当前归档的模板？`)) break;
      const cur = (state.archives || []).find(a => a.id === currentArchiveId);
      if (cur) {
        cur.dimensionsSnapshot = structuredClone(src.dimensionsSnapshot || DEFAULT_DIMENSIONS);
        cur.tenderReqs = src.tenderReqs || '';
        persistLocal();
        saveStateCloud();
        openArchiveDetail(currentArchiveId);
      }
      break;
    }
    case 'toggle-blacklist': {
      const key = el.dataset.key;
      const s = state.supplierRegistry?.[key];
      if (s) { s.blacklist = !s.blacklist; saveStateAndRender(); saveStateCloud(); }
      break;
    }
    case 'dl-archive-report': {
      const arc = (state.archives || []).find(a => a.id === el.dataset.aid);
      if (!arc || !arc.reportMd) break;
      try {
        const doc = await buildReportDocx(arc.reportMd);
        const { Packer } = docx;
        Packer.toBlob(doc).then(blob => {
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${arc.name || '评标报告'}-${new Date(arc.archivedAt || Date.now()).toISOString().slice(0,10)}.docx`;
          a.click();
          URL.revokeObjectURL(url);
        }).catch(e => alert('下载失败：' + e.message));
      } catch (e) {
        alert('下载失败：' + e.message);
      }
      break;
    }
    case 'copy-link':
      navigator.clipboard.writeText(el.dataset.link).then(() => { el.textContent = '已复制'; setTimeout(()=>el.textContent='复制',1500); });
      break;
  }
}

// 解析腾讯会议文字
function parseMeetingText(text) {
  if (!text) return null;
  const r = {};
  // 日期 2026-08-15 或 2026/8/15 或 8月15日
  let m = text.match(/(20\d{2})[-\/年](\d{1,2})[-\/月](\d{1,2})/);
  if (m) r.date = `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
  // 时间 14:00-14:30 或 14:00~14:30
  m = text.match(/(\d{1,2}):(\d{2})\s*[-~至]\s*(\d{1,2}):(\d{2})/);
  if (m) {
    const sh = +m[1], sm = +m[2], eh = +m[3], em = +m[4];
    if (sh < 24 && eh < 24 && sm < 60 && em < 60 && (eh * 60 + em) >= (sh * 60 + sm)) {
      r.start = `${m[1].padStart(2,'0')}:${m[2]}`;
      r.end = `${m[3].padStart(2,'0')}:${m[4]}`;
    }
  }
  if (!r.start) {
    m = text.match(/(\d{1,2}):(\d{2})/);
    if (m && +m[1] < 24 && +m[2] < 60) r.start = `${m[1].padStart(2,'0')}:${m[2]}`;
  }
  // 链接
  m = text.match(/(https?:\/\/[^\s，。]+)/);
  if (m) r.link = m[1];
  // 会议号：支持 "#腾讯会议：706-143-865" / "腾讯会议：706-143-865" / "会议号：706-143-865"
  m = text.match(/#?腾讯会议[：:\s]*([0-9-]{6,})/) || text.match(/会议号[：:\s]*([0-9-]{6,})/);
  if (m) r.id = m[1];
  // 密码
  m = text.match(/密码[：:\s]*([0-9A-Za-z]{4,})/);
  if (m) r.pwd = m[1];
  return r;
}

// 把 parseMeetingText 结果填进弹层表单，返回识别到的字段数
function applyParsedMeeting(text) {
  const parsed = parseMeetingText(text);
  if (!parsed) return 0;
  let cnt = 0;
  if (parsed.date) { document.getElementById('mDate').value = parsed.date; cnt++; }
  if (parsed.start) { document.getElementById('mStart').value = parsed.start; cnt++; }
  if (parsed.end) { document.getElementById('mEnd').value = parsed.end; cnt++; }
  if (parsed.link) { document.getElementById('mLink').value = parsed.link; cnt++; }
  if (parsed.id) { document.getElementById('mId').value = parsed.id; cnt++; }
  if (parsed.pwd) { document.getElementById('mPwd').value = parsed.pwd; cnt++; }
  return cnt;
}

// ============ 说明弹层 ============
const helpModal = document.getElementById('helpModal');
const helpBtn = document.getElementById('helpBtn');
if (helpBtn && helpModal) {
  helpBtn.addEventListener('click', (e) => { e.stopPropagation(); helpModal.hidden = false; });
  helpModal.addEventListener('click', (e) => {
    if (e.target === helpModal || e.target.dataset.action === 'close-help') helpModal.hidden = true;
  });
  helpModal.querySelectorAll('[data-action="close-help"]').forEach(el => el.addEventListener('click', () => { helpModal.hidden = true; }));
}

// ============ 导出 xlsx ============
document.getElementById('exportBtn').addEventListener('click', () => {
  if (typeof XLSX === 'undefined') { alert('xlsx 库未加载'); return; }
  const ranked = [...state.vendors].sort((a, b) => vendorTotal(b.id) - vendorTotal(a.id));
  // Sheet1 汇总排名（对齐 Excel 评分汇总表）
  const s1 = [['排名','供应商','讲标安排', ...state.judges.map(j=>j.name), '技术平均分','技术权重得分','商务报价(万)','商务分','总分','CPM']];
  ranked.forEach((v, i) => s1.push([
    i+1, v.name, `${v.meetingDate||''} ${v.startTime||''}-${v.endTime||''}`,
    ...state.judges.map(j => +judgeTotalForVendor(v.id, j.id).toFixed(1)),
    +vendorTechAverage(v.id).toFixed(2),
    +vendorTechWeighted(v.id).toFixed(2),
    v.playCount || 0,
    +vendorBusinessScore(v.id).toFixed(2),
    +vendorTotal(v.id).toFixed(2),
    +cpm(v.id).toFixed(2),
  ]));
  // Sheet2 维度明细
  const s2 = [['供应商','评委', ...state.dimensions.map(d=>d.name), '技术总分']];
  state.vendors.forEach(v => state.judges.forEach(j => {
    s2.push([v.name, j.name, ...state.dimensions.map(d => getScore(v.id, j.id, d.id) ?? ''), +judgeTotalForVendor(v.id, j.id).toFixed(1)]);
  }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s1), '汇总排名');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s2), '维度明细');
  XLSX.writeFile(wb, `${state.project.name || 'bid-evaluation'}-${new Date().toISOString().slice(0,10)}.xlsx`);
});
// 导航
document.getElementById('navGroup').addEventListener('click', (e) => {
  const btn = e.target.closest('.nav-item');
  if (!btn) return;
  ui.tab = btn.dataset.tab;
  persistLocal();
  renderAll();
  closeSidebar();
});

// 汉堡菜单
const sidebar = document.getElementById('sidebar');
const overlay = document.getElementById('overlay');
function openSidebar() { sidebar.classList.add('open'); overlay.classList.add('show'); }
function closeSidebar() { sidebar.classList.remove('open'); overlay.classList.remove('show'); }
document.getElementById('menuBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
});
overlay.addEventListener('click', closeSidebar);

// 会议信息弹层
const meetingModal = document.getElementById('meetingModal');
function openMeetingModal(vid) {
  const v = state.vendors.find(x => x.id === vid);
  if (!v) return;
  meetingModal.dataset.vid = vid;
  document.getElementById('meetingVendorName').textContent = v.name;
  document.getElementById('mDate').value = v.meetingDate || '';
  document.getElementById('mStart').value = v.startTime || '';
  document.getElementById('mEnd').value = v.endTime || '';
  document.getElementById('mLink').value = v.meetingLink || '';
  document.getElementById('mId').value = v.meetingId || '';
  document.getElementById('mPwd').value = v.meetingPwd || '';
  document.getElementById('modalPaste').value = '';
  const hint = document.getElementById('pasteHint');
  if (hint) hint.textContent = '';
  meetingModal.hidden = false;
}
function closeMeetingModal() { meetingModal.hidden = true; }
meetingModal.addEventListener('click', (e) => { if (e.target === meetingModal) closeMeetingModal(); });
// 弹层内的按钮（不在 viewEl 里，单独绑）
meetingModal.querySelectorAll('[data-action]').forEach(el => {
  el.addEventListener('click', handleAction);
});
// 粘贴即自动识别（input 事件覆盖键盘粘贴和输入法上屏），按钮保留作冗余
const modalPasteEl = document.getElementById('modalPaste');
if (modalPasteEl) {
  modalPasteEl.addEventListener('input', () => {
    const cnt = applyParsedMeeting(modalPasteEl.value);
    const hint = document.getElementById('pasteHint');
    if (hint) {
      if (modalPasteEl.value.trim() === '') hint.textContent = '';
      else hint.textContent = cnt > 0 ? `已自动识别 ${cnt} 项` : '未识别到，可点「解析填入」或手动填写';
    }
  });
}

// 顶部归档按钮（不在 viewEl 里，单独绑）
const archiveActionBtn = document.getElementById('archiveActionBtn');
if (archiveActionBtn) archiveActionBtn.addEventListener('click', handleAction);

// 取报告按钮 DOM（在 viewDashboard 模板内，每次渲染后重新查询）
const reportDl = document.getElementById('reportDl');
function getReportActionBtn() { return viewEl.querySelector('[data-action="gen-report"]'); }
function getReportDlButton() { return viewEl.querySelector('[data-report-dl]'); }
function showReportDlButton() { const b = getReportDlButton(); if (b) b.hidden = false; }
function hideReportDlButton() { const b = getReportDlButton(); if (b) b.hidden = true; }
function setReportButtonLoading() {
  const btn = getReportActionBtn();
  if (!btn) return;
  btn.textContent = '报告生成中…';
  btn.disabled = true;
}
function setReportButtonOriginal() {
  const btn = getReportActionBtn();
  if (!btn) return;
  btn.textContent = '生成评标报告';
  btn.disabled = false;
  btn.classList.add('btn-primary');
  btn.dataset.action = 'gen-report';
}
function resetReportButton() {
  lastReportDoc = null;
  lastReportMd = '';
  hideReportDlButton();
  setReportButtonOriginal();
}
reportDl.addEventListener('click', () => downloadReportDocx());
const reportModal = document.getElementById('reportModal');
const reportBody = document.getElementById('reportBody');
const reportStatus = document.getElementById('reportStatus');
const reportCopy = document.getElementById('reportCopy');
let lastReportMd = '';
let lastReportDoc = null;
let reportGenerating = false;
function openReportModal() {
  reportStatus.textContent = '准备中…';
  reportBody.style.display = 'none';
  reportBody.textContent = '';
  reportCopy.style.display = 'none';
  reportModal.hidden = false;
}
function showReport(md, doc) {
  lastReportMd = md;
  lastReportDoc = doc || null;
  reportBody.textContent = md;
  reportBody.style.display = 'block';
  reportStatus.textContent = '已生成 · 点击下方下载 Word';
  reportCopy.style.display = 'inline-flex';
  reportDl.style.display = 'inline-flex';
  showReportDlButton();
  setReportButtonOriginal();
}
function closeReportModal() { reportModal.hidden = true; }
reportModal.addEventListener('click', (e) => { if (e.target === reportModal) closeReportModal(); });
document.getElementById('reportClose').addEventListener('click', closeReportModal);
reportCopy.addEventListener('click', () => {
  navigator.clipboard.writeText(lastReportMd).then(() => { reportCopy.textContent = '已复制'; setTimeout(()=>reportCopy.textContent='复制',1500); });
});
function downloadReportDocx() {
  if (!lastReportDoc) return;
  const { Packer } = docx;
  Packer.toBlob(lastReportDoc).then(blob => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${state.project.name || '评标报告'}-${new Date().toISOString().slice(0,10)}.docx`;
    a.click();
    URL.revokeObjectURL(url);
    // 下载后保留 lastReportDoc 和下载按钮，允许再次下载；生成按钮也始终是"生成评标报告"
  }).catch(e => alert('下载失败：' + e.message));
}

// 历史详情弹层底部按钮：复用为新项目即开始新项目
const archiveModal = document.getElementById('archiveModal');
const archiveBody = document.getElementById('archiveBody');
let currentArchiveId = null;
function openArchiveDetail(aid) {
  const arc = (state.archives || []).find(a => a.id === aid);
  if (!arc) return;
  currentArchiveId = aid;
  archiveModal.hidden = false;
  const judgeHeads = arc.judgeSnapshot.map(j => `<th>${escapeHtml(j.name)}</th>`).join('');
  const judgeBody = arc.vendorSnapshot.map(vs => arc.judgeSnapshot.map(j => {
    const s = j.scores.find(ss => ss.vendorName === vs.name);
    return `<td>${(s?.techTotal || 0).toFixed(1)}</td>`;
  }).join('')).join('');
  const anomTags = (anoms) => anoms?.length ? anoms.map(a => `<span class="atag" style="margin-right:4px;">${escapeHtml(a.label)}</span>`).join('') : '—';

  archiveBody.innerHTML = `
    <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:10px;">
      <div>
        <h4 style="margin-top:0;">${escapeHtml(arc.name)}</h4>
        <div style="color:var(--muted);font-size:12px;">品类：${escapeHtml(arc.category || '通用')} · 预算 ¥${(arc.budget || 0).toLocaleString()} · ${new Date(arc.archivedAt).toLocaleString('zh-CN')}</div>
      </div>
      <div style="text-align:right;">
        <div style="font-size:24px;font-weight:700;color:var(--gold);">${arc.winnerTotal.toFixed(1)}</div>
        <div style="font-size:12px;color:var(--muted);">中标：${escapeHtml(arc.winnerName)}</div>
      </div>
    </div>

    <h4>供应商表现</h4>
    <table class="mini-table">
      <thead><tr><th>排名</th><th>供应商</th>${judgeHeads}<th>技术均分</th><th>商务分</th><th>总分</th><th>CPM</th><th>异常</th></tr></thead>
      <tbody>
        ${arc.vendorSnapshot.map(vs => `
          <tr>
            <td>${vs.rank}</td>
            <td>${escapeHtml(vs.name)}</td>
            ${arc.judgeSnapshot.map(j => {
              const s = j.scores.find(ss => ss.vendorName === vs.name);
              return `<td>${(s?.techTotal || 0).toFixed(1)}</td>`;
            }).join('')}
            <td>${vs.techAvg.toFixed(1)}</td>
            <td>${vs.businessScore.toFixed(1)}</td>
            <td>${vs.total.toFixed(1)}</td>
            <td>${vs.cpm.toFixed(2)}</td>
            <td>${anomTags(vs.anomalies)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>

    ${(() => {
      const rows = (arc.judgeSnapshot || []).map(j => {
        const sig = j.signature || null;
        const time = j.signedAt ? new Date(j.signedAt).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : '未签名';
        const overalls = (j.scores || []).filter(s => s.overallComment)
          .map(s => `<div style="margin-top:6px;"><strong>${escapeHtml(s.vendorName)}：</strong>${escapeHtml(s.overallComment)}</div>`).join('');
        // 每家供应商各一级维度评分表
        const dimHeads = (arc.dimensionsSnapshot || []).map(d => `<th>${escapeHtml(d.name)}</th>`).join('');
        const dimBody = (arc.vendorSnapshot || []).map(vs => {
          const s = (j.scores || []).find(ss => ss.vendorName === vs.name);
          const cells = (arc.dimensionsSnapshot || []).map(d => {
            const ds = (s?.dimScores || []).find(x => x.dimName === d.name);
            const val = ds?.value;
            return `<td>${(val === undefined || val === null || val === '') ? '—' : Number(val).toFixed(1)}</td>`;
          }).join('');
          return `<tr><td>${escapeHtml(vs.name)}</td>${cells}<td>${(s?.techTotal || 0).toFixed(1)}</td></tr>`;
        }).join('');
        const dimTable = (dimHeads && (arc.vendorSnapshot || []).length) ? `
          <table class="mini-table" style="margin-top:8px;">
            <thead><tr><th>供应商</th>${dimHeads}<th>技术合计</th></tr></thead>
            <tbody>${dimBody}</tbody>
          </table>` : '';
        return `
          <div class="judge-sig-card">
            <div class="js-head"><strong>${escapeHtml(j.name)}</strong><span class="js-time">${escapeHtml(time)}</span></div>
            ${sig ? `<img src="${sig}" class="js-img" alt="签名">` : '<div class="js-empty">未签名</div>'}
            ${dimTable}
            ${overalls ? `<div class="js-overalls"><strong>总评：</strong>${overalls}</div>` : ''}
          </div>`;
      }).join('');
      if (!rows) return '';
      return `<h4>评委评分</h4><div class="judge-sig-list">${rows}</div>`;
    })()}

    ${arc.crossVendorAnalysis ? `<h4>供应商横评</h4><div class="archive-cross-box" data-aid="${arc.id}" style="margin-top:4px;">
      <div data-action="toggle-archive-cross" style="cursor:pointer;display:flex;align-items:center;justify-content:space-between;font-size:13px;color:var(--gold);font-weight:600;">
        <span>综合结论·最推荐（点击展开完整横评）</span>
        <span class="toggle-icon" style="font-size:11px;color:var(--muted);">展开 ▾</span>
      </div>
      <div class="archive-cross-summary" style="color:var(--text);font-size:13px;margin-top:8px;line-height:1.7;">${formatCrossSummary(extractCrossRecommendation(arc.crossVendorAnalysis))}</div>
      <div class="archive-cross-content" style="display:none;margin-top:10px;padding-top:10px;border-top:1px dashed var(--border);">${formatCrossFull(extractCrossRest(arc.crossVendorAnalysis))}</div>
    </div>` : ''}

    ${arc.reportMd ? `<h4>评标报告</h4><div style="margin-top:4px;">
      <details><summary>查看报告正文</summary><pre class="report-pre" style="max-height:40vh;margin-top:8px;">${escapeHtml(arc.reportMd)}</pre></details>
      <button class="btn btn-primary" data-action="dl-archive-report" data-aid="${arc.id}" style="margin-top:8px;">下载 Word 报告</button>
    </div>` : ''}
    ${arc.tenderReqs ? `<details><summary>招标要求</summary><pre class="report-pre" style="max-height:30vh;margin-top:8px;">${escapeHtml(arc.tenderReqs)}</pre></details>` : ''}
    ${(() => {
      const sims = similarArchives(arc);
      if (!sims.length) return '';
      return `
        <div class="similar-section" style="margin-top:14px;">
          <h4 style="margin:0 0 10px;color:var(--gold);">相似项目推荐（同品类「${escapeHtml(arc.category)}」）</h4>
          <div class="similar-list">
            ${sims.map(s => `
              <div class="similar-item">
                <div class="sinfo">
                  <strong>${escapeHtml(s.name)}</strong>
                  <span class="smeta">${escapeHtml((s.archivedAt||'').slice(0,10))} · 中标 ${escapeHtml(s.winnerName)} · 总分 ${(s.winnerTotal||0).toFixed(1)}</span>
                </div>
                <button class="btn btn-ghost" data-action="adopt-from-similar" data-aid="${s.id}">采用其维度模板</button>
              </div>
            `).join('')}
          </div>
        </div>`;
    })()}
  `;
}
function closeArchiveModal() { archiveModal.hidden = true; currentArchiveId = null; }
archiveModal.addEventListener('click', (e) => {
  if (e.target === archiveModal) { closeArchiveModal(); return; }
  // 事件委托：archiveBody 内动态注入的按钮也走 handleAction
  const btn = e.target.closest('[data-action]');
  if (btn && archiveBody.contains(btn)) handleAction(btn);
});
archiveModal.querySelectorAll('[data-action]').forEach(el => {
  el.addEventListener('click', handleAction);
});

// 历史横评二级弹层
const archiveCrossModal = document.getElementById('archiveCrossModal');
const archiveCrossBody = document.getElementById('archiveCrossBody');
const archiveCrossClose = document.getElementById('archiveCrossClose');
if (archiveCrossClose) archiveCrossClose.addEventListener('click', () => { archiveCrossModal.hidden = true; });
if (archiveCrossModal) archiveCrossModal.addEventListener('click', (e) => { if (e.target === archiveCrossModal) archiveCrossModal.hidden = true; });
function openArchiveCrossModal(aid) {
  const arc = (state.archives || []).find(a => a.id === aid);
  if (!arc || !arc.crossVendorAnalysis) return;
  archiveCrossBody.textContent = arc.crossVendorAnalysis;
  archiveCrossModal.hidden = false;
}

// 评标报告静默生成：所有会议结束后且未生成过时，后台生成一次
let silentReportTimer = null;
let silentFailCount = 0;
const SILENT_FAIL_LIMIT = 3;
function startSilentReportWatcher() {
  if (silentReportTimer) clearInterval(silentReportTimer);
  silentReportTimer = setInterval(() => {
    if (!state.aiConfig?.key) return;
    if (!isAllMeetingsEnded()) return;
    if (!allJudgesSigned()) return; // 评分未收集完（还有评委没签名）不自动生成
    if (lastReportDoc) { // 已有报告：停止 watcher，避免空跑
      if (silentReportTimer) { clearInterval(silentReportTimer); silentReportTimer = null; }
      return;
    }
    if (reportGenerating) return;
    if (silentFailCount >= SILENT_FAIL_LIMIT) { // 失败上限：停止 watcher，避免烧 token
      if (silentReportTimer) { clearInterval(silentReportTimer); silentReportTimer = null; }
      return;
    }
    reportGenerating = true;
    setReportButtonLoading();
    generateReportLocal().then(({ md, doc }) => {
      lastReportMd = md;
      lastReportDoc = doc;
      silentFailCount = 0;
      setReportButtonOriginal();
      showReportDlButton();
    }).catch(e => {
      silentFailCount++;
      console.warn('静默生成报告失败', silentFailCount, e);
      setReportButtonOriginal();
    }).finally(() => {
      reportGenerating = false;
    });
  }, 30000);
}
startSilentReportWatcher();
startPendingAiWatcher();

setInterval(async () => {
  if (document.hidden) return; // 标签页隐藏时暂停，避免重写 innerHTML 打断点击
  if (isInputFocused()) return;
  await pullScores();
  renderProgressBar();  // 让"即将讲标→正在讲标"等阶段切换自动刷新，不用手动刷新
}, 3000);

// 轻量拉取：只拉 scores + judgeMeta，不动 state，永远不挡输入、不丢管理员编辑
async function pullScores() {
  try {
    const r = await apiGet('/state');
    if (!r.ok) return;
    const before = JSON.stringify({ s: scores, m: judgeMeta, vc: vendorComments });
    scores = r.scores || scores;
    if (r.judgeMeta) judgeMeta = r.judgeMeta;
    if (r.vendorComments) vendorComments = r.vendorComments;
    const after = JSON.stringify({ s: scores, m: judgeMeta, vc: vendorComments });
    // 仅变化时写 localStorage，且不置 dirty（scores/judgeMeta/vendorComments 不在 syncToCloud 载荷里，
    // 置 dirty 会让下次 syncToCloud 把本地 state 推到云端覆盖其他设备）
    if (before !== after) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ state, scores, judgeMeta, vendorComments, ui }));
      renderAll();
    }
  } catch (e) {}
}

function isInputFocused() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}



// 工具
function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escapeAttr(s) { return escapeHtml(s); }
function isSafeUrl(u) { return /^https?:\/\//i.test(String(u || '')); }
function shortName(n) { n = String(n ?? ''); return n.length > 14 ? n.slice(0, 13) + '…' : n; }
function statusClass(s) { return { done: 'status-done', doing: 'status-doing', todo: 'status-todo' }[s] || 'status-todo'; }
function statusLabel(s) { return { done: '已完成', doing: '进行中', todo: '待开始' }[s] || '待开始'; }

// 启动
loadAll();
