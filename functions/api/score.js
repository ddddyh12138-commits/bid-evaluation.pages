import { json, err, readState, writeScore, pushAudit, findJudge, ensureSchema, readJudgeMeta, onRequestOptions } from './_lib.js';

// POST /api/score — 评委打分（含分项评语）
// body: { vendorId, dimId, value, comment }
// 鉴权：X-Judge-Token
export async function onRequestPost({ request, env }) {
  const token = request.headers.get('X-Judge-Token');
  if (!token) return err('缺少评委凭据', 401);
  const judge = await findJudge(env, token);
  if (!judge) return err('无效评委链接', 403);

  const body = await request.json().catch(() => ({}));
  const { vendorId, dimId, value, comment } = body;
  if (!vendorId || !dimId) return err('缺少 vendorId/dimId');

  // 锁定校验：已签名则拒绝改分
  await ensureSchema(env);
  const meta = await readJudgeMeta(env);
  if (meta[judge.id]?.locked) {
    return err('已签名锁定，如需修改请联系管理员解锁', 423);
  }

  const state = await readState(env);
  if (!state) return err('项目未初始化', 404);

  const vendor = (state.vendors || []).find(v => v.id === vendorId);
  if (!vendor) return err('供应商不存在');

  // 管理员手动推进：按 currentVendorId 判断哪些供应商开放
  // 第一家到 startTime 后自动激活（兼容 currentVendorId 为空的情况）
  function sortedVendors() {
    return [...(state.vendors || [])].sort((a, b) => {
      const sa = a.meetingDate && a.startTime ? new Date(`${a.meetingDate}T${a.startTime}:00+08:00`).getTime() : null;
      const sb = b.meetingDate && b.startTime ? new Date(`${b.meetingDate}T${b.startTime}:00+08:00`).getTime() : null;
      if (sa && sb) return sa - sb;
      if (sa && !sb) return -1;
      if (!sa && sb) return 1;
      return (a.order ?? 0) - (b.order ?? 0);
    });
  }
  const sorted = sortedVendors();
  let curIdx = sorted.findIndex(v => v.id === (state.currentVendorId || ''));
  if (curIdx === -1) {
    const first = sorted[0];
    if (first && first.meetingDate && first.startTime) {
      const start = new Date(`${first.meetingDate}T${first.startTime}:00+08:00`);
      if (!isNaN(start) && Date.now() >= start.getTime()) curIdx = 0;
    }
  }
  const vIdx = sorted.findIndex(v => v.id === vendorId);
  if (curIdx === -1 || vIdx === -1 || vIdx > curIdx) {
    return err('该供应商尚未开放评分', 403);
  }

  const dim = (state.dimensions || []).find(d => d.id === dimId);
  if (!dim) return err('维度不存在');

  let val = value === null || value === '' ? null : Number(value);
  if (val !== null) {
    if (isNaN(val) || val < 0) return err('分数无效');
    if (val > dim.max) val = dim.max;
  }

  await writeScore(env, vendorId, judge.id, dimId, val, comment);
  await pushAudit(env, `评委 ${judge.name} 评分 ${vendor.name} · ${dim.name}：${val ?? '--'}${comment ? `（${String(comment).slice(0,40)}）` : ''}`);
  return json({ ok: true });
}

export { onRequestOptions };
