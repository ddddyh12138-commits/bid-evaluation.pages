import { json, err, readState, writeState, pushAudit, isAdmin, onRequestOptions } from './_lib.js';

// POST /api/admin — 管理员写项目配置
// body: { patch }  patch 会浅合并进 state（除 scores/audit 外）
// 特殊操作：{ action: 'reset', state } 整体覆盖
export async function onRequestPost({ request, env }) {
  if (!isAdmin(request, env)) return err('需要管理员凭据', 401);
  const body = await request.json().catch(() => ({}));

  if (body.action === 'reset' && body.state) {
    await writeState(env, body.state);
    await env.DB.prepare('DELETE FROM scores').run();
    return json({ ok: true });
  }

  // 清空审计日志
  if (body.action === 'clearAudit') {
    await env.DB.prepare('DELETE FROM audit').run();
    return json({ ok: true });
  }

  // 清空 scores 表（归档/复用/删除供应商/评委/维度时调用，防止旧分数残留污染新项目）
  if (body.action === 'clearScores') {
    await env.DB.prepare('DELETE FROM scores').run();
    return json({ ok: true });
  }

  // 按 vendorId / judgeId / dimId 精准清理 scores 表
  if (body.action === 'clearScoresBy') {
    const { vendorId, judgeId, dimId } = body;
    if (vendorId) await env.DB.prepare('DELETE FROM scores WHERE vendor_id = ?').bind(vendorId).run();
    if (judgeId) await env.DB.prepare('DELETE FROM scores WHERE judge_id = ?').bind(judgeId).run();
    if (dimId) await env.DB.prepare('DELETE FROM scores WHERE dim_id = ?').bind(dimId).run();
    return json({ ok: true });
  }

  const state = await readState(env) || {};
  const patch = body.patch || {};
  // 浅合并顶层，project 单独浅合并；ui 不存云端（设备本地状态，避免跨设备覆盖）
  // scores/audit 由各自端点管理，不走 state blob
  for (const k of Object.keys(patch)) {
    if (k === 'project') {
      state.project = { ...(state.project || {}), ...patch.project };
    } else if (k === 'scores' || k === 'audit' || k === 'ui' || k === 'updatedAt' || k === '_clearAudit') {
      continue;
    } else {
      state[k] = patch[k];
    }
  }
  await writeState(env, state);
  return json({ ok: true });
}

export { onRequestOptions };
