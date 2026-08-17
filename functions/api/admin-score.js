import { json, err, readState, isAdmin, pushAudit, onRequestOptions } from './_lib.js';

// POST /api/admin-score — 管理员代评委写分
// body: { vendorId, judgeId, dimId, value }
export async function onRequestPost({ request, env }) {
  if (!isAdmin(request, env)) return err('需要管理员凭据', 401);
  const body = await request.json().catch(() => ({}));
  const { vendorId, judgeId, dimId, value } = body;
  if (!vendorId || !judgeId || !dimId) return err('缺少参数');

  const state = await readState(env);
  if (!state) return err('项目未初始化', 404);
  const dim = (state.dimensions || []).find(d => d.id === dimId);
  if (!dim) return err('维度不存在');

  let val = value === null || value === undefined || value === '' ? null : Number(value);
  if (val !== null) {
    if (isNaN(val) || val < 0) return err('分数无效');
    if (val > dim.max) val = dim.max;
  }

  const now = Date.now();
  // 取旧值
  const oldRow = await env.DB.prepare('SELECT value FROM scores WHERE vendor_id=? AND judge_id=? AND dim_id=?').bind(vendorId, judgeId, dimId).first();
  await env.DB.prepare(
    'INSERT INTO scores(vendor_id,judge_id,dim_id,value,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(vendor_id,judge_id,dim_id) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at'
  ).bind(vendorId, judgeId, dimId, val, now).run();

  const vName = (state.vendors || []).find(v => v.id === vendorId)?.name || vendorId;
  const jName = (state.judges || []).find(j => j.id === judgeId)?.name || judgeId;
  const dName = dim.name;
  await pushAudit(env, `管理员修改 ${vName} · ${dName}（评委 ${jName}）：${oldRow?.value ?? '--'} → ${val ?? '--'}`);
  return json({ ok: true });
}

export { onRequestOptions };
