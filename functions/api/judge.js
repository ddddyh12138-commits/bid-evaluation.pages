import { json, err, findJudge, writeJudgeMeta, readJudgeMeta, writeScoresBatch, writeVendorCommentsBatch, pushAudit, ensureSchema, onRequestOptions } from './_lib.js';

// POST /api/judge — 评委批量提交打分 + 评语 + 签名
// body: { action: 'submit', signature, scores, vendorComments }
// scores: {vendorId: {judgeId: {dimId: {value, comment}}}}
// vendorComments: {vendorId: comment}
// 鉴权：X-Judge-Token
export async function onRequestPost({ request, env }) {
  const token = request.headers.get('X-Judge-Token');
  if (!token) return err('缺少评委凭据', 401);
  const judge = await findJudge(env, token);
  if (!judge) return err('无效评委链接', 403);

  await ensureSchema(env);

  // 已签名锁定则拒绝重签
  const meta = await readJudgeMeta(env);
  if (meta[judge.id]?.locked) return err('已签名，如需修改请联系管理员解锁', 423);

  const body = await request.json().catch(() => ({}));

  // 暂存：把桌面端本地分数/总评写到 D1，供手机扫码签名时拉回
  if (body.action === 'stage') {
    await writeScoresBatch(env, judge.id, body.scores || {});
    await writeVendorCommentsBatch(env, judge.id, body.vendorComments || {});
    return json({ ok: true });
  }

  // 手机扫码纯签名：把签名图存到 pending_sig，不锁定、不写分。网页版稍后来取
  if (body.action === 'signOnly') {
    const sig = String(body.signature || '');
    if (!sig) return err('请手写签名');
    if (sig.length > 200000) return err('签名数据过大');
    const now = Date.now();
    await env.DB.prepare('INSERT INTO pending_sig(judge_id, signature, updated_at) VALUES(?,?,?) ON CONFLICT(judge_id) DO UPDATE SET signature=excluded.signature, updated_at=excluded.updated_at').bind(judge.id, sig, now).run();
    return json({ ok: true });
  }

  // 网页版取手机已写的签名：取走后删除，避免重复
  if (body.action === 'fetchSig') {
    const row = await env.DB.prepare('SELECT signature FROM pending_sig WHERE judge_id = ?').bind(judge.id).first();
    if (!row || !row.signature) return json({ ok: true, signature: null });
    await env.DB.prepare('DELETE FROM pending_sig WHERE judge_id = ?').bind(judge.id).run();
    return json({ ok: true, signature: row.signature });
  }

  if (body.action !== 'submit') return err('未知操作');

  const signature = String(body.signature || '');
  if (!signature) return err('请手写签名');
  if (signature.length > 200000) return err('签名数据过大');

  const scoresMap = body.scores || {};
  const vendorComments = body.vendorComments || {};

  // 只在有数据时写入；手机扫码纯签名场景 body 无 scores，保留之前 stage 的分数
  if (Object.keys(scoresMap).length) await writeScoresBatch(env, judge.id, scoresMap);
  if (Object.keys(vendorComments).length) await writeVendorCommentsBatch(env, judge.id, vendorComments);

  await writeJudgeMeta(env, judge.id, {
    signature,
    signedAt: Date.now(),
    locked: true,
  });
  await pushAudit(env, `评委 ${judge.name} 签名确认并一次性提交打分，已锁定`);
  return json({ ok: true });
}

export { onRequestOptions };
