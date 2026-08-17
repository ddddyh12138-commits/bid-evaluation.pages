import { json, err, readState, writeJudgeMeta, pushAudit, ensureSchema, isAdmin, onRequestOptions } from './_lib.js';

// POST /api/admin-unlock — 管理员解锁评委
// 清签名 + 解除锁定 + 清空该评委所有打分/总评（强制重新打分重新提交）
// body: { judgeId }
export async function onRequestPost({ request, env }) {
  if (!isAdmin(request, env)) return err('需要管理员凭据', 401);
  await ensureSchema(env);
  const body = await request.json().catch(() => ({}));
  const { judgeId } = body;
  if (!judgeId) return err('缺少 judgeId');

  const state = await readState(env);
  const jName = (state?.judges || []).find(j => j.id === judgeId)?.name || judgeId;

  // 清空该评委所有打分、总评、签名
  await env.DB.prepare('DELETE FROM scores WHERE judge_id = ?').bind(judgeId).run();
  await env.DB.prepare('DELETE FROM vendor_comments WHERE judge_id = ?').bind(judgeId).run();
  await writeJudgeMeta(env, judgeId, {
    signature: null,
    signedAt: null,
    locked: false,
  });
  await pushAudit(env, `管理员解锁评委 ${jName}，签名及所有打分已清空，需重新打分提交`);
  return json({ ok: true });
}

export { onRequestOptions };
