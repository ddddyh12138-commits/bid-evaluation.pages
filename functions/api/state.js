import { json, err, readState, readScores, readJudgeMeta, readVendorComments, ensureSchema, isAdmin, onRequestOptions } from './_lib.js';

// GET /api/state — 管理员取全量（含 scores + judgeMeta + vendorComments）
// 评委通过 X-Judge-Token 取脱敏（无其他评委分数、无播放量细节，但有商务分结果 + 自己的 judgeMeta + 自己的 vendorComments）
export async function onRequestGet({ request, env }) {
  const judgeToken = request.headers.get('X-Judge-Token');
  await ensureSchema(env);

  // 管理员：首页无密码，直接返回全量（但 ui 是设备本地状态，不返回）
  if (!judgeToken) {
    const [state, scores, judgeMeta, vendorComments] = await Promise.all([
      readState(env),
      readScores(env),
      readJudgeMeta(env),
      readVendorComments(env),
    ]);
    if (state) delete state.ui;
    return json({ ok: true, state: state || {}, scores, judgeMeta, vendorComments, role: 'admin' });
  }

  // 评委
  if (judgeToken) {
    const state = await readState(env);
    if (!state) return err('项目未初始化', 404);
    const judge = (state.judges || []).find(j => j.token === judgeToken);
    if (!judge) return err('无效的评委链接', 403);
    const [scores, allMeta, allComments] = await Promise.all([
      readScores(env),
      readJudgeMeta(env),
      readVendorComments(env),
    ]);
    const myScores = {};
    for (const vId of Object.keys(scores)) {
      if (scores[vId][judge.id]) myScores[vId] = { [judge.id]: scores[vId][judge.id] };
    }
    const myComments = {};
    for (const vId of Object.keys(allComments)) {
      if (allComments[vId][judge.id] != null) myComments[vId] = allComments[vId][judge.id];
    }
    const safeState = {
      project: state.project,
      dimensions: state.dimensions,
      vendors: (state.vendors || []).map(v => ({
        id: v.id, name: v.name, slot: v.slot, status: v.status, order: v.order,
        meetingDate: v.meetingDate, startTime: v.startTime, endTime: v.endTime,
      })),
      judges: (state.judges || []).map(j => ({ id: j.id, name: j.name })),
      aiSuggestions: state.aiSuggestions || {},
      currentVendorId: state.currentVendorId || null,
      myJudgeId: judge.id,
    };
    const maxPlay = Math.max(1, ...(state.vendors || []).map(x => x.playCount || 0));
    const budget = state.project?.budget || 0;
    safeState.vendors = safeState.vendors.map(v => {
      const orig = state.vendors.find(x => x.id === v.id);
      const play = orig?.playCount || 0;
      const biz = play ? (play / maxPlay) * 50 : 0;
      const cpm = (play && budget) ? budget / (play * 10000) * 1000 : 0;
      return { ...v, businessScore: biz, cpm };
    });
    const myMeta = allMeta[judge.id] || { signature: null, signedAt: null, locked: false };
    return json({ ok: true, state: safeState, scores: myScores, role: 'judge', judge, judgeMeta: myMeta, vendorComments: myComments });
  }

  return err('需要管理员或评委凭据', 401);
}

export { onRequestOptions };
