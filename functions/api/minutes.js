import { json, err, readState, writeState, pushAudit, isAdmin, onRequestOptions } from './_lib.js';

// POST /api/minutes — 管理员粘贴纪要，调大模型生成初评
// body: { vendorId, minutesText }
export async function onRequestPost({ request, env }) {
  if (!isAdmin(request, env)) return err('需要管理员凭据', 401);
  const body = await request.json().catch(() => ({}));
  const { vendorId, minutesText } = body;
  if (!vendorId || !minutesText) return err('缺少 vendorId/minutesText');

  const state = await readState(env);
  if (!state) return err('项目未初始化', 404);
  const vendor = (state.vendors || []).find(v => v.id === vendorId);
  if (!vendor) return err('供应商不存在');

  // AI 配置：环境变量优先，否则读 state.aiConfig
  const aiConfig = state.aiConfig || {};
  const apiKey = env.AI_API_KEY || aiConfig.key;
  const baseUrl = env.AI_BASE_URL || aiConfig.baseUrl || 'https://open.bigmodel.cn/api/paas/v4';
  const model = env.AI_MODEL || aiConfig.model || 'glm-4-plus';

  if (!apiKey) {
    return err('未配置 AI API Key，请在环境变量或项目设置中配置');
  }

  const dimensions = state.dimensions || [];
  const dimSpec = dimensions.map(d => {
    const det = (d.details || []).map(t => `  - ${t}`).join('\n');
    return `${d.id}｜${d.name}｜满分${d.max}\n${det}\n评分标准：${d.standard || '无'}`;
  }).join('\n\n');

  const prompt = `你是评标专家。下面是一家供应商的讲标会议纪要，请根据纪要为每个评分维度给出建议分（0 到该维度满分）和评分依据。

评分维度：
${dimSpec}

供应商名称：${vendor.name}

会议纪要：
${minutesText}

请严格返回 JSON，不要任何解释，格式：
{"dimId1":{"score":数字,"evidence":"评分依据：50-150字，说明为什么给这个分，纪要里哪些具体点支持这个分数"},"dimId2":{...}}
其中 dimId 替换为上面的实际维度 id。务必给出具体依据，不要泛泛而谈。`;

  let aiResult;
  try {
    const resp = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
      }),
    });
    if (!resp.ok) {
      const t = await resp.text();
      return err(`大模型调用失败 (${resp.status})：${t.slice(0, 300)}`, 502);
    }
    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content || '';
    // 提取 JSON
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) return err('大模型未返回有效 JSON：' + content.slice(0, 200), 502);
    aiResult = JSON.parse(m[0]);
  } catch (e) {
    return err('大模型调用异常：' + e.message, 502);
  }

  // 校验并写入
  state.aiSuggestions = state.aiSuggestions || {};
  state.aiSuggestions[vendorId] = {};
  for (const d of dimensions) {
    const r = aiResult[d.id];
    if (r && typeof r.score === 'number') {
      state.aiSuggestions[vendorId][d.id] = {
        score: Math.max(0, Math.min(d.max, r.score)),
        evidence: String(r.evidence || '').slice(0, 500),
      };
    }
  }
  // 顺便存一下原始纪要，便于回看
  state.minutes = state.minutes || {};
  state.minutes[vendorId] = minutesText;

  await writeState(env, state);
  await pushAudit(env, `AI 初评生成：${vendor.name}`);
  return json({ ok: true, aiSuggestions: state.aiSuggestions[vendorId] });
}

export { onRequestOptions };
