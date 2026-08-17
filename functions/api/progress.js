import { json, err, readState, writeState, pushAudit, isAdmin, onRequestOptions } from './_lib.js';

// POST /api/progress — 管理员推进"当前讲到哪家"指针
// 状态(status)纯按会议时间自动算，这里只更新 currentVendorId
export async function onRequestPost({ request, env }) {
  if (!isAdmin(request, env)) return err('需要管理员凭据', 401);
  const body = await request.json().catch(() => ({}));
  const { currentVendorId } = body;
  const state = await readState(env);
  if (!state) return err('项目未初始化', 404);

  state.currentVendorId = currentVendorId || null;
  const cur = (state.vendors || []).find(v => v.id === currentVendorId);
  await writeState(env, state);
  if (cur) await pushAudit(env, `管理员推进讲标：当前 → ${cur.name}`);
  return json({ ok: true });
}

export { onRequestOptions };
