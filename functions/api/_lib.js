// 评标工作台后端共用库：CORS、JSON 响应、D1 状态读写

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS, HEAD',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Judge-Token',
  'Access-Control-Max-Age': '86400',
};

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export function err(msg, status = 400) {
  return json({ ok: false, error: msg }, status);
}

// 读全量 state（项目配置 + 维度 + 供应商 + 评委 + aiSuggestions + ui）
// 不含 scores 和 audit（那俩单独表）
export async function readState(env) {
  const row = await env.DB.prepare('SELECT v FROM kv WHERE k = ?').bind('state').first();
  if (!row) return null;
  try { return JSON.parse(row.v); } catch { return null; }
}

export async function writeState(env, state) {
  const now = Date.now();
  const s = JSON.stringify({ ...state, updatedAt: now });
  await env.DB.prepare('INSERT INTO kv(k,v,updated_at) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at').bind('state', s, now).run();
}

// 幂等 schema 迁移：建 judge_meta 表、给 scores 加 comment 列、建 vendor_comments 表
// 并行执行 + 失败（表/列已存在）静默忽略，避免每次冷启动串行 3 次 RTT
let schemaReady = false;
export async function ensureSchema(env) {
  if (schemaReady) return;
  await Promise.allSettled([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS judge_meta (judge_id TEXT PRIMARY KEY, signature TEXT, signed_at INTEGER, locked INTEGER DEFAULT 0, updated_at INTEGER NOT NULL)').run(),
    env.DB.prepare('ALTER TABLE scores ADD COLUMN comment TEXT').run(),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS vendor_comments (vendor_id TEXT NOT NULL, judge_id TEXT NOT NULL, comment TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (vendor_id, judge_id))').run(),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS pending_sig (judge_id TEXT PRIMARY KEY, signature TEXT, updated_at INTEGER NOT NULL)').run(),
  ]);
  schemaReady = true;
}

// 读所有打分 → {vendorId: {judgeId: {dimId: {value, comment}}}}
export async function readScores(env) {
  const rows = await env.DB.prepare('SELECT vendor_id, judge_id, dim_id, value, comment FROM scores').all();
  const out = {};
  for (const r of rows.results || []) {
    out[r.vendor_id] = out[r.vendor_id] || {};
    out[r.vendor_id][r.judge_id] = out[r.vendor_id][r.judge_id] || {};
    out[r.vendor_id][r.judge_id][r.dim_id] = { value: r.value, comment: r.comment || '' };
  }
  return out;
}

export async function writeScore(env, vendorId, judgeId, dimId, value, comment) {
  const now = Date.now();
  const c = comment == null ? null : String(comment).slice(0, 500);
  await env.DB.prepare(
    'INSERT INTO scores(vendor_id,judge_id,dim_id,value,comment,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(vendor_id,judge_id,dim_id) DO UPDATE SET value=excluded.value, comment=excluded.comment, updated_at=excluded.updated_at'
  ).bind(vendorId, judgeId, dimId, value, c, now).run();
}

export async function writeScoresBatch(env, judgeId, scoresMap) {
  const now = Date.now();
  for (const vId of Object.keys(scoresMap)) {
    const judgeScores = scoresMap[vId]?.[judgeId];
    if (!judgeScores) continue;
    for (const dId of Object.keys(judgeScores)) {
      const cell = judgeScores[dId] || {};
      const value = cell.value ?? null;
      const comment = cell.comment != null ? String(cell.comment).slice(0, 500) : null;
      await env.DB.prepare(
        'INSERT INTO scores(vendor_id,judge_id,dim_id,value,comment,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(vendor_id,judge_id,dim_id) DO UPDATE SET value=excluded.value, comment=excluded.comment, updated_at=excluded.updated_at'
      ).bind(vId, judgeId, dId, value, comment, now).run();
    }
  }
}

export async function writeVendorCommentsBatch(env, judgeId, commentsMap) {
  const now = Date.now();
  for (const vId of Object.keys(commentsMap)) {
    const comment = commentsMap[vId];
    if (comment == null) continue;
    const c = String(comment).slice(0, 800);
    await env.DB.prepare(
      'INSERT INTO vendor_comments(vendor_id,judge_id,comment,updated_at) VALUES(?,?,?,?) ON CONFLICT(vendor_id,judge_id) DO UPDATE SET comment=excluded.comment, updated_at=excluded.updated_at'
    ).bind(vId, judgeId, c, now).run();
  }
}

// 评委级元数据：签名 + 锁定
export async function readJudgeMeta(env) {
  const rows = await env.DB.prepare('SELECT judge_id, signature, signed_at, locked FROM judge_meta').all();
  const out = {};
  for (const r of rows.results || []) {
    out[r.judge_id] = {
      signature: r.signature || null,
      signedAt: r.signed_at || null,
      locked: r.locked === 1,
    };
  }
  return out;
}

export async function writeJudgeMeta(env, judgeId, patch) {
  const now = Date.now();
  const cur = await env.DB.prepare('SELECT signature, signed_at, locked FROM judge_meta WHERE judge_id = ?').bind(judgeId).first();
  const signature = patch.signature !== undefined ? patch.signature : (cur?.signature ?? null);
  const signedAt = patch.signedAt !== undefined ? patch.signedAt : (cur?.signed_at ?? null);
  const locked = patch.locked !== undefined ? (patch.locked ? 1 : 0) : (cur?.locked ?? 0);
  await env.DB.prepare(
    'INSERT INTO judge_meta(judge_id, signature, signed_at, locked, updated_at) VALUES(?,?,?,?,?) ON CONFLICT(judge_id) DO UPDATE SET signature=excluded.signature, signed_at=excluded.signed_at, locked=excluded.locked, updated_at=excluded.updated_at'
  ).bind(judgeId, signature, signedAt, locked, now).run();
}

// 评委对各家供应商的总评 → {vendorId: {judgeId: comment}}
export async function readVendorComments(env) {
  const rows = await env.DB.prepare('SELECT vendor_id, judge_id, comment FROM vendor_comments').all();
  const out = {};
  for (const r of rows.results || []) {
    out[r.vendor_id] = out[r.vendor_id] || {};
    out[r.vendor_id][r.judge_id] = r.comment || '';
  }
  return out;
}

export async function writeVendorComment(env, vendorId, judgeId, comment) {
  const now = Date.now();
  const c = comment == null ? null : String(comment).slice(0, 800);
  await env.DB.prepare(
    'INSERT INTO vendor_comments(vendor_id,judge_id,comment,updated_at) VALUES(?,?,?,?) ON CONFLICT(vendor_id,judge_id) DO UPDATE SET comment=excluded.comment, updated_at=excluded.updated_at'
  ).bind(vendorId, judgeId, c, now).run();
}

export async function pushAudit(env, text) {
  const time = new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
  await env.DB.prepare('INSERT INTO audit(time,text) VALUES(?,?)').bind(time, text).run();
}

export async function readAudit(env, limit = 200) {
  const rows = await env.DB.prepare('SELECT time,text FROM audit ORDER BY id DESC LIMIT ?').bind(limit).all();
  return (rows.results || []).map(r => ({ time: r.time, text: r.text }));
}

// 管理员鉴权：首页无密码，任何能访问 URL 的人都是管理员（内部工具，URL 不公开即可）。
// 评委走 judge.html#token=xxx 单独鉴权。
export async function isAdmin(request, env) {
  return true;
}

// 评委鉴权：state.judges[].token === token
export async function findJudge(env, token) {
  const state = await readState(env);
  if (!state || !state.judges) return null;
  return state.judges.find(j => j.token === token) || null;
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

// 计算工具（后端也用，避免往返）
export function vendorTotal(state, scores, vendorId) {
  const v = state.vendors.find(x => x.id === vendorId);
  if (!v) return 0;
  // 技术均分
  let techSum = 0, techCount = 0;
  for (const j of state.judges || []) {
    let s = 0;
    for (const d of state.dimensions || []) {
      const val = scores[vendorId]?.[j.id]?.[d.id];
      if (val !== undefined && val !== null) s += val;
    }
    if (s > 0 || (scores[vendorId]?.[j.id] && Object.keys(scores[vendorId][j.id]).length)) {
      techSum += s; techCount++;
    }
  }
  const techAvg = techCount > 0 ? techSum / techCount : 0;
  // 商务分
  const maxPlay = Math.max(1, ...state.vendors.map(x => x.playCount || 0));
  const biz = v.playCount ? (v.playCount / maxPlay) * 50 : 0;
  return { techAvg, biz, total: techAvg + biz };
}
