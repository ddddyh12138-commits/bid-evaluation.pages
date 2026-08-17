/* 评委外链打分端 · 手机优先
 * URL: judge.html#token=xxx
 * 看全部供应商，未讲标的锁定；对已讲标的逐维度打分，所有打分/评语/总评
 * 只保存在 localStorage，签名时一次性批量提交并锁定。
 */

const token = new URLSearchParams(location.hash.replace(/^#/, '')).get('token');
const signMode = new URLSearchParams(location.hash.replace(/^.*\?/, '')).get('sign') === '1';
const app = document.getElementById('app');
const savedEl = document.getElementById('saved');
const STORE_KEY = 'bid-eval-judge-' + (token || '');
const SIGNED_FLAG_KEY = 'bid-eval-judge-signed-' + (token || '');

let state = null;
let cloudScores = {}; // 云端已有分数（只用于展示他人是否完成；签名时用自己的本地数据覆盖）
let scores = {};      // {vendorId: {judgeId: {dimId: {value, comment}}}}  当前评委本地编辑
let myJudgeId = null;
let activeVendorId = null;
let isOnline = navigator.onLine;
let expandedEv = new Set(); // 记住已展开的 AI 证据维度，跨重渲染保留
let myMeta = { signature: null, signedAt: null, locked: false }; // 评委自己的签名/锁定状态（来自云端）
let vendorComments = {}; // {vendorId: comment} 评委对各家供应商的总评  本地编辑
let sigPad = null, sigCtx = null, sigInk = false, sigDrawing = false;
let autoSignShownFor = null; // 本轮已弹过一次完成弹窗的 token
let cloudWasLocked = false;  // 上次拉云端时的锁定状态，用于检测解锁

function loadLocal() {
  try {
    const r = localStorage.getItem(STORE_KEY);
    if (r) {
      const o = JSON.parse(r);
      scores = o.scores || {};
      activeVendorId = o.activeVendorId || null;
      myMeta = o.myMeta || myMeta;
      vendorComments = o.vendorComments || {};
      state = o.state || null;
      myJudgeId = o.myJudgeId || myJudgeId;
    }
  } catch {}
}
function saveLocal() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ scores, activeVendorId, myMeta, vendorComments, state, myJudgeId })); }
  catch (e) { console.warn('本地存盘失败', e); }
}

loadLocal();

async function load() {
  if (!token) { app.innerHTML = '<div class="empty">无效链接，请联系管理员获取正确的外链。</div>'; return; }
  // 优先用本地缓存立刻渲染首屏，避免白屏等网络
  if (state && !signMode) render();
  try {
    const r = await fetch('/api/state', { headers: { 'X-Judge-Token': token } });
    const data = await r.json();
    if (!data.ok) { app.innerHTML = `<div class="empty">${escapeHtml(data.error || '加载失败')}</div>`; return; }
    state = data.state;
    cloudScores = data.scores || {};
    myJudgeId = data.state.myJudgeId;
    if (data.judgeMeta) { myMeta = data.judgeMeta; }
    // 解锁后云端 scores/vendorComments 已被清空，本地也要清空，强制重新打分
    if (!myMeta.locked && cloudWasLocked) {
      scores = {};
      vendorComments = {};
    }
    cloudWasLocked = !!myMeta.locked;
    // 扫码纯签名模式：直接进签名页，不加载列表/分数
    if (signMode) { setTimeout(openMobileSignPage, 50); return; }
    // 总评：本地非空保留，云端补充
    vendorComments = mergeVendorComments(data.vendorComments);
    // 手机扫码场景：本地无分但云端有暂存 → 回填，签名提交时才带得上
    if (myJudgeId && cloudScores) {
      for (const vId of Object.keys(cloudScores)) {
        if (cloudScores[vId]?.[myJudgeId]) {
          scores[vId] = scores[vId] || {};
          if (!scores[vId][myJudgeId] || !Object.keys(scores[vId][myJudgeId]).length) {
            scores[vId][myJudgeId] = cloudScores[vId][myJudgeId];
          }
        }
      }
    }
  saveLocal();
  render();
  // 扫码场景（无 sign 参数但本地无分）：也进纯签名页
  if (!myMeta.locked && !hasLocalScores() && !signMode) {
    // 不自动进，让用户在列表用签名按钮
  }
  } catch (e) {
    app.innerHTML = '<div class="empty">网络错误，请刷新重试。</div>';
  }
}

// 增量刷新：只更新 state（商务分/CPM/会议时间等），不丢用户输入焦点、不覆盖本地未提交的总评
async function refreshState() {
  if (!token) return;
  try {
    const r = await fetch('/api/state', { headers: { 'X-Judge-Token': token } });
    const data = await r.json();
    if (!data.ok) return;
    const fresh = data.state;
    if (!state || !fresh) return;
    state.vendors = fresh.vendors;
    state.aiSuggestions = fresh.aiSuggestions;
    state.project = fresh.project;
    if (data.judgeMeta) myMeta = data.judgeMeta;
    // 检测解锁：上次锁定现在未锁 → 清空本地打分/总评，强制重新打分
    if (!myMeta.locked && cloudWasLocked) {
      scores = {};
      vendorComments = {};
    }
    cloudWasLocked = !!myMeta.locked;
    // 本地非空保留，云端补充
    vendorComments = mergeVendorComments(data.vendorComments);
    if (activeVendorId) {
      const ae = document.activeElement;
      if (ae && ae.tagName === 'INPUT' && ae.classList.contains('score-input')) {
        const v = fresh.vendors.find(x => x.id === activeVendorId);
        const judgeEl = app.querySelector('.head .judge');
        if (judgeEl && v) judgeEl.textContent = `商务分 ${v.businessScore?.toFixed(1) || 0} / 50 · CPM ¥${(v.cpm||0).toFixed(2)}`;
      } else {
        render();
        maybeShowAutoSignModal();
      }
    } else {
      render();
      maybeShowAutoSignModal();
    }
  } catch {}
}

function myScore(vId, dId) {
  const cell = scores[vId]?.[myJudgeId]?.[dId];
  return (cell && typeof cell === 'object') ? cell.value : cell;
}
function myComment(vId, dId) {
  const cell = scores[vId]?.[myJudgeId]?.[dId];
  return (cell && typeof cell === 'object') ? (cell.comment || '') : '';
}
function myVendorComment(vId) { return vendorComments[vId] || ''; }
// 合并云端与本地总评：本地非空覆盖云端，云端补充本地未填的
function mergeVendorComments(cloud) {
  const merged = { ...(cloud || {}) };
  for (const vId of Object.keys(vendorComments)) {
    if (vendorComments[vId] && vendorComments[vId].trim()) merged[vId] = vendorComments[vId];
  }
  return merged;
}
function hasLocalVendorComments() {
  return Object.values(vendorComments).some(c => c && c.trim());
}
function hasLocalScores() {
  if (!myJudgeId) return false;
  return Object.values(scores).some(v => v?.[myJudgeId] && Object.keys(v[myJudgeId]).length > 0);
}
function myTotal(vId) {
  if (!state) return 0;
  return state.dimensions.reduce((s, d) => s + (myScore(vId, d.id) || 0), 0);
}

function render() {
  if (myMeta.locked) {
    app.innerHTML = renderLockedPage();
  } else if (activeVendorId) {
    renderScoring();
  } else {
    renderList();
  }
  updateTopbar();
  maybeShowAutoSignModal();
}

function updateTopbar() {
  const topbar = document.getElementById('topbar');
  if ((activeVendorId || myMeta.locked) && state) {
    let title = '';
    if (activeVendorId) {
      const v = state.vendors.find(x => x.id === activeVendorId);
      title = v ? v.name : '';
    } else {
      title = '已签名确认';
    }
    document.getElementById('topbarTitle').textContent = title;
    topbar.classList.add('show');
  } else {
    topbar.classList.remove('show');
  }
}

function bindTopbar() {
  document.getElementById('topbarBack').addEventListener('click', () => {
    if (!checkVendorCommentBeforeLeave()) return;
    activeVendorId = null; saveLocal(); render();
  });
  document.getElementById('topbarHelp').addEventListener('click', () => { document.getElementById('helpModal').hidden = false; });
  const closeHelp = () => { document.getElementById('helpModal').hidden = true; };
  document.getElementById('helpClose').addEventListener('click', closeHelp);
  document.getElementById('helpModal').addEventListener('click', (e) => { if (e.target.id === 'helpModal') closeHelp(); });
}
bindTopbar();

function renderList() {
  const sorted = sortedVendorList();
  const complete = isAllScoringComplete();
  app.innerHTML = `
    <div class="help-bar"><button id="listHelp">说明</button></div>
    <div class="head">
      <div class="head-main">
        <div class="eyebrow">Bid Evaluation</div>
        <h1>${escapeHtml(state.project.name)}</h1>
        <div class="judge">评委：${escapeHtml(state.judges.find(j=>j.id===myJudgeId)?.name || '')}</div>
        <div class="meta">
          <div class="tag">${state.dimensions.length} 个维度</div>
          <div class="tag">${sorted.length} 家供应商</div>
        </div>
      </div>
      <button class="sign-submit-btn${complete ? '' : ' disabled'}" data-action="open-sign-modal" ${complete ? '' : 'disabled'}>
        签名并提交
      </button>
    </div>
    <div class="vendor-list">
      ${sorted.map(v => {
        const locked = isLocked(v);
        const effStatus = effectiveStatus(v);
        const vc = myVendorComment(v.id);
        const missingVendorComment = !locked && effStatus === 'done' && !vc.trim();
        const missingScores = !locked && effStatus === 'done' && state.dimensions.some(d => myScore(v.id, d.id) == null);
        return `
        <div class="vendor-item ${locked?'locked':''} ${!locked && effStatus==='done' ? (missingScores || missingVendorComment ? 'has-missing' : 'all-done') : ''}" data-vid="${v.id}" ${locked?'':'data-action="open"'}>
          <div class="vh">
            <div>
              <div class="name">${escapeHtml(v.name)}</div>
              <div class="slot">${escapeHtml(v.meetingDate||'')} ${escapeHtml(v.startTime||'')}-${escapeHtml(v.endTime||'')}</div>
            </div>
            <div class="status ${statusClass(effStatus)}">${statusLabel(effStatus)}${locked?' · '+lockReason(v):''}</div>
          </div>
          ${!locked ? `<div class="biz">商务分 ${v.businessScore?.toFixed(1) || 0} / 50 · CPM ¥${(v.cpm||0).toFixed(2)}</div>` : ''}
          ${!locked ? `<div class="mytotal">我的技术分：<strong>${myTotal(v.id).toFixed(1)}</strong></div>` : ''}
          ${!locked && effStatus==='done' ? `<div class="complete-badge ${missingScores || missingVendorComment ? 'incomplete' : 'done'}">${missingScores || missingVendorComment ? '未完成' : '已完成'}</div>` : ''}
        </div>`;
      }).join('')}
    </div>
  `;
  bindList();
}
function bindList() {
  app.querySelectorAll('[data-action="open"]').forEach(el => {
    el.addEventListener('click', () => {
      activeVendorId = el.dataset.vid;
      saveLocal();
      render();
    });
  });
  const lh = app.querySelector('#listHelp');
  if (lh) lh.addEventListener('click', () => { document.getElementById('helpModal').hidden = false; });
  const signHintBtn = app.querySelector('[data-action="open-sign-modal"]');
  if (signHintBtn) signHintBtn.addEventListener('click', showAutoSignModal);
}

function renderScoring() {
  const v = state.vendors.find(x => x.id === activeVendorId);
  if (!v) { activeVendorId = null; renderList(); return; }
  app.innerHTML = `
    <div class="head">
      <div class="eyebrow">${escapeHtml(v.meetingDate||'')} ${escapeHtml(v.startTime||'')}-${escapeHtml(v.endTime||'')}</div>
      <h1>${escapeHtml(v.name)}</h1>
      <div class="judge">商务分 ${v.businessScore?.toFixed(1) || 0} / 50 · CPM ¥${(v.cpm||0).toFixed(2)}</div>
    </div>
    ${state.dimensions.map(d => {
      const val = myScore(v.id, d.id);
      const ai = state.aiSuggestions?.[v.id]?.[d.id];
      const pct = d.max > 0 ? ((val || 0) / d.max * 100) : 0;
      return `
        <div class="dim-card">
          <div class="top">
            <strong>${escapeHtml(d.name)}</strong>
            <span class="max">满分 ${d.max}</span>
          </div>
          ${ai ? renderAiBlock(v.id, d.id, ai) : ''}
          <p class="desc">${escapeHtml(d.desc || '')}</p>
          ${d.details?.length ? `<ul class="details">${d.details.map(t => `<li>${escapeHtml(t)}</li>`).join('')}</ul>` : ''}
          ${d.standard ? `<div class="standard">评分标准：${escapeHtml(d.standard)}</div>` : ''}
          <div class="score-row">
            <input class="score-input" type="number" min="0" max="${d.max}" step="0.1" data-did="${d.id}" value="${val ?? ''}" placeholder="0">
            <div class="quick">
              ${[0, 0.5, d.max/2, d.max].filter((x,i,a)=>a.indexOf(x)===i).map(q => `<button data-quick="${q}" data-did="${d.id}">${q}</button>`).join('')}
            </div>
          </div>
          <div class="bar"><i style="width:${pct}%"></i></div>
          <textarea class="dim-comment${isAnomaly(d, val) ? ' required' : ''}" data-did="${d.id}" placeholder="分项说明（选填，异常分需说明扣分依据）">${escapeHtml(myComment(v.id, d.id))}</textarea>
          ${isAnomaly(d, val) ? `<div class="dim-comment-hint">分数低于满分的 60%，请说明扣分依据（必填）</div>` : ''}
        </div>`;
    }).join('')}
    <div class="summary">
      <small>我的技术分</small>
      <strong>${myTotal(v.id).toFixed(1)}</strong>
    </div>
    <div class="vendor-comment" style="margin-top:14px;">
      <label style="display:block;font-size:13px;color:var(--gold);font-weight:700;margin-bottom:6px;">本供应商总评（必填）</label>
      <textarea class="overall" data-action="set-vendor-comment" placeholder="请填写对 ${escapeHtml(v.name)} 的整体评价（必填，≤800 字）" maxlength="800">${escapeHtml(myVendorComment(v.id))}</textarea>
    </div>
  `;
  bindScoring();
}

// 已锁定后展示页：签名 + 各供应商各维度打分（不含说明）供评委检查
function renderLockedPage() {
  const time = myMeta.signedAt ? new Date(myMeta.signedAt).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : '';
  const vendors = (state?.vendors || []).slice().sort((a,b)=>(a.order??0)-(b.order??0));
  const dims = state?.dimensions || [];
  let scoresHtml = '';
  for (const v of vendors) {
    scoresHtml += `
      <div class="lk-vendor">
        <div class="lk-vname">${escapeHtml(v.name)} <span class="lk-vtotal">技术分 ${myTotal(v.id).toFixed(1)}</span></div>
        <div class="lk-dims">
          ${dims.map(d => `<div class="lk-dim"><span>${escapeHtml(d.name)}</span><strong>${myScore(v.id, d.id) ?? '--'}</strong><small>/${d.max}</small></div>`).join('')}
        </div>
      </div>`;
  }
  return `
    <div class="locked-card" style="margin-top:40px;">
      <div style="color:var(--green);font-weight:700;font-size:18px;">✓ 已签名确认</div>
      <div class="lk-time">签名时间：${escapeHtml(time)}</div>
      ${myMeta.signature ? `<img src="${escapeAttr(myMeta.signature)}" alt="签名">` : ''}
      <div class="lk-time" style="margin-top:10px;">打分已锁定，如需修改请联系管理员解锁</div>
    </div>
    <div class="lk-scores">
      <h3>我的打分</h3>
      ${scoresHtml || '<div class="empty">无打分记录</div>'}
    </div>`;
}

function renderAiBlock(vid, did, ai) {
  const score = escapeHtml(String(ai.score));
  let html = `<div class="ai"><span class="ai-head">AI 建议 ${score} 分<span class="adopt" data-action="adopt" data-did="${did}" data-score="${score}">采纳</span></span>`;
  if (ai.evidence) {
    const long = ai.evidence.length > 50;
    html += `<span class="ai-ev${long ? ' collapsed' : ''}" data-did="${did}">${escapeHtml(ai.evidence)}</span>`;
    if (long) html += `<span class="ai-toggle" data-action="toggle-ev" data-did="${did}">展开</span>`;
  }
  html += '</div>';
  return html;
}

function allMeetingsEnded() {
  if (!state || !state.vendors || !state.vendors.length) return false;
  return state.vendors.every(v => effectiveStatus(v) === 'done');
}

function isAnomaly(dim, val) {
  if (val == null || val === '') return false;
  return Number(val) < dim.max * 0.6;
}

let saveTimer = null;
function flashSaved() {
  savedEl.classList.add('show');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => savedEl.classList.remove('show'), 1200);
}

function confirmIfLargeChange(vId, dId, newVal) {
  const old = myScore(vId, dId);
  const dim = state.dimensions.find(d => d.id === dId);
  if (old == null || newVal == null || !dim) return true;
  if (Math.abs(newVal - old) >= dim.max * 0.3) {
    return confirm(`分数从 ${old} 改为 ${newVal}，差值较大，确认？`);
  }
  return true;
}

function bindScoring() {
  app.querySelectorAll('.score-input').forEach(el => {
    el.addEventListener('input', () => {
      const did = el.dataset.did;
      const dim = state.dimensions.find(d => d.id === did);
      let val = el.value === '' ? null : parseFloat(el.value);
      if (val !== null) {
        if (isNaN(val) || val < 0) { el.value = (myScore(activeVendorId, did) ?? ''); return; }
        if (val > dim.max) { val = dim.max; el.value = val; }
      }
      scores[activeVendorId] = scores[activeVendorId] || {};
      scores[activeVendorId][myJudgeId] = scores[activeVendorId][myJudgeId] || {};
      const cur = scores[activeVendorId][myJudgeId][did] || {};
      scores[activeVendorId][myJudgeId][did] = { value: val, comment: cur.comment || '' };
      saveLocal();
      // 分数改了 → 允许下次完成时再次弹签名窗
      resetAutoSignShown();
      maybeShowAutoSignModal();
      // 更新进度条、总分、异常高亮
      const pct = dim.max > 0 ? ((val || 0) / dim.max * 100) : 0;
      const card = el.closest('.dim-card');
      if (card) {
        const bar = card.querySelector('.bar i');
        if (bar) bar.style.width = pct + '%';
        const ta = card.querySelector('.dim-comment');
        const hint = card.querySelector('.dim-comment-hint');
        if (ta) ta.classList.toggle('required', isAnomaly(dim, val));
        if (hint) hint.style.display = isAnomaly(dim, val) ? 'block' : 'none';
        if (!hint && isAnomaly(dim, val)) {
          const div = document.createElement('div');
          div.className = 'dim-comment-hint';
          div.textContent = '分数低于满分的 60%，请说明扣分依据（必填）';
          card.appendChild(div);
        }
      }
      const sumEl = app.querySelector('.summary strong');
      if (sumEl) sumEl.textContent = myTotal(activeVendorId).toFixed(1);
      flashSaved();
    });
  });

  app.querySelectorAll('[data-quick]').forEach(el => {
    el.addEventListener('click', () => {
      const did = el.dataset.did;
      const q = parseFloat(el.dataset.quick);
      if (!confirmIfLargeChange(activeVendorId, did, q)) return;
      const input = app.querySelector(`.score-input[data-did="${did}"]`);
      if (input) input.value = q;
      scores[activeVendorId] = scores[activeVendorId] || {};
      scores[activeVendorId][myJudgeId] = scores[activeVendorId][myJudgeId] || {};
      const cur = scores[activeVendorId][myJudgeId][did] || {};
      scores[activeVendorId][myJudgeId][did] = { value: q, comment: cur.comment || '' };
      saveLocal();
      input.dispatchEvent(new Event('input'));
      flashSaved();
    });
  });

  app.querySelectorAll('[data-action="adopt"]').forEach(el => {
    el.addEventListener('click', () => {
      const did = el.dataset.did;
      const score = parseFloat(el.dataset.score);
      if (isNaN(score)) { alert('AI 建议分数无效，无法采纳'); return; }
      if (!confirmIfLargeChange(activeVendorId, did, score)) return;
      const input = app.querySelector(`.score-input[data-did="${did}"]`);
      if (input) {
        input.value = score;
        input.dispatchEvent(new Event('input'));
      }
      flashSaved();
    });
  });

  app.querySelectorAll('.dim-comment').forEach(el => {
    el.addEventListener('input', () => {
      const did = el.dataset.did;
      scores[activeVendorId] = scores[activeVendorId] || {};
      scores[activeVendorId][myJudgeId] = scores[activeVendorId][myJudgeId] || {};
      const cur = scores[activeVendorId][myJudgeId][did] || {};
      scores[activeVendorId][myJudgeId][did] = { value: cur.value, comment: el.value };
      saveLocal();
      resetAutoSignShown();
      maybeShowAutoSignModal();
      flashSaved();
    });
  });

  const overallEl = app.querySelector('[data-action="set-vendor-comment"]');
  if (overallEl) {
    overallEl.addEventListener('input', () => {
      vendorComments[activeVendorId] = overallEl.value;
      saveLocal();
      flashSaved();
      // 总评改了 → 允许下次完成时再次弹签名窗
      resetAutoSignShown();
      maybeShowAutoSignModal();
    });
  }

  app.querySelectorAll('[data-action="toggle-ev"]').forEach(el => {
    const did = el.dataset.did;
    if (expandedEv.has(did)) {
      const ev = el.previousElementSibling;
      if (ev) { ev.classList.remove('collapsed'); el.textContent = '收起'; }
    }
    el.addEventListener('click', () => {
      const ev = el.previousElementSibling;
      if (!ev) return;
      const collapsed = ev.classList.toggle('collapsed');
      el.textContent = collapsed ? '展开' : '收起';
      if (collapsed) expandedEv.delete(did); else expandedEv.add(did);
    });
  });
}

function isAllScoringComplete() {
  if (!state || !state.vendors || !state.vendors.length || !state.dimensions.length) return false;
  // 必须全部供应商都已开放（currentVendorId 是最后一家）
  const sorted = sortedVendorList();
  const curIdx = getCurrentVendorIndex();
  if (curIdx !== sorted.length - 1) return false;
  // 所有供应商的所有维度都打了分 + 总评都填了
  for (const v of state.vendors) {
    for (const d of state.dimensions) {
      if (myScore(v.id, d.id) == null) return false;
      if (isAnomaly(d, myScore(v.id, d.id)) && !myComment(v.id, d.id).trim()) return false;
    }
    if (!myVendorComment(v.id).trim()) return false;
  }
  return true;
}

function isMobileLike() {
  return (navigator.maxTouchPoints || 0) > 0 && window.innerWidth <= 768;
}

function showAutoSignModal() {
  if (myMeta.locked) return;
  if (!isAllScoringComplete()) { alert('还有未完成的打分/总评，请先全部填写完成'); return; }
  const modal = document.getElementById('autoSignModal');
  if (!modal) return;
  // 手机端：隐藏二维码区，只留本机手写
  const qrCol = modal.querySelector('.sign-choice');
  if (isMobileLike() && qrCol) qrCol.style.display = 'none';
  modal.hidden = false;
  setTimeout(initModalSigPad, 0);
  // 桌面端才需要暂存分数 + 二维码 + 轮询拉签名
  if (!isMobileLike()) {
    stageScores();
    renderQrCode();
    startSignWait();
    startSigFetch();
  }
}

// 轮询拉取手机端已写的签名，回填到本机手写框
let sigFetchTimer = null;
function startSigFetch() {
  stopSigFetch();
  sigFetchTimer = setInterval(async () => {
    try {
      const r = await fetch('/api/judge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Judge-Token': token },
        body: JSON.stringify({ action: 'fetchSig' }),
      });
      const d = await r.json().catch(() => null);
      if (d?.ok && d.signature) {
        // 把手机签名画到本机 canvas 上
        drawSigToCanvas(d.signature);
        stopSigFetch();
      }
    } catch {}
  }, 2000);
}
function stopSigFetch() { if (sigFetchTimer) { clearInterval(sigFetchTimer); sigFetchTimer = null; } }
function drawSigToCanvas(dataUrl) {
  if (!modalSigCtx || !modalSigPad) return;
  const img = new Image();
  img.onload = () => {
    modalSigCtx.clearRect(0, 0, modalSigPad.width, modalSigPad.height);
    const ratio = window.devicePixelRatio || 1;
    modalSigCtx.drawImage(img, 0, 0, modalSigPad.width / ratio, modalSigPad.height / ratio);
    modalSigInk = true;
  };
  img.src = dataUrl;
}

// 暂存分数到云端，供手机端扫码后回填
async function stageScores() {
  try {
    await fetch('/api/judge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Judge-Token': token },
      body: JSON.stringify({ action: 'stage', scores, vendorComments }),
    });
  } catch {}
}

// 生成二维码：内容是当前外链 URL + sign=1，手机扫码直接进纯签名页
function buildSignUrl() {
  const base = location.origin + location.pathname;
  return `${base}#token=${encodeURIComponent(token)}&sign=1`;
}
function renderQrCode() {
  const box = document.getElementById('qrBox');
  if (!box) return;
  box.innerHTML = '';
  try {
    new QRCode(box, { text: buildSignUrl(), width: 150, height: 150 });
  } catch (e) {
    box.textContent = '二维码生成失败，可复制下方链接到手机';
  }
}

// 轮询检测手机端是否已完成签名提交
let signWaitTimer = null;
function startSignWait() {
  stopSignWait();
  signWaitTimer = setInterval(async () => {
    try {
      const r = await fetch('/api/state', { headers: { 'X-Judge-Token': token } });
      const d = await r.json().catch(() => null);
      if (d?.judgeMeta?.locked) {
        stopSignWait();
        myMeta = d.judgeMeta;
        saveLocal();
        const m = document.getElementById('autoSignModal');
        if (m) m.hidden = true;
        render();
      }
    } catch {}
  }, 2000);
}
function stopSignWait() { if (signWaitTimer) { clearInterval(signWaitTimer); signWaitTimer = null; } }

// 手机扫码纯签名页：全屏签名框，自适应横竖屏，类似银行签名
function openMobileSignPage() {
  document.getElementById('topbar')?.classList.remove('show');
  const landscape = window.innerWidth > window.innerHeight;
  document.body.style.padding = '0';
  app.innerHTML = `
    <div class="msign-page ${landscape ? 'msign-land' : 'msign-port'}">
      <div class="msign-head">
        <div class="msign-eyebrow">手写签名</div>
        <div class="msign-title">${escapeHtml(state?.project?.name || '签名确认')}</div>
        <div class="msign-judge">评委：${escapeHtml(state?.judges?.find(j=>j.id===myJudgeId)?.name || '')}</div>
      </div>
      <div class="msign-pad-wrap">
        <canvas class="msign-pad" id="mobileSigPad"></canvas>
        <div class="msign-baseline"></div>
        <div class="msign-clear" id="mobileSigClear">清除</div>
      </div>
      <button class="msign-go" id="mobileSignGo">发送签名到电脑</button>
    </div>
  `;
  initMobileSigPad();
  document.getElementById('mobileSigClear').addEventListener('click', clearMobileSig);
  document.getElementById('mobileSignGo').addEventListener('click', doMobileSign);
  // 屏幕旋转时重布局
  window.addEventListener('resize', onMobileResize);
}
let msignResizeTimer = null;
function onMobileResize() {
  if (!document.getElementById('mobileSigPad')) return;
  clearTimeout(msignResizeTimer);
  msignResizeTimer = setTimeout(() => {
    const landscape = window.innerWidth > window.innerHeight;
    const page = document.querySelector('.msign-page');
    if (page) page.className = `msign-page ${landscape ? 'msign-land' : 'msign-port'}`;
    // canvas 尺寸重置（清空签名，因为像素尺寸变了无法保留）
    if (mobileSigInk && !confirm('屏幕方向变化会清空签名，继续？')) return;
    const saved = mobileSigInk ? mobileSigPad.toDataURL() : null;
    initMobileSigPad();
    if (saved) {
      const img = new Image();
      img.onload = () => {
        const ratio = window.devicePixelRatio || 1;
        mobileSigCtx.drawImage(img, 0, 0, mobileSigPad.width / ratio, mobileSigPad.height / ratio);
      };
      img.src = saved;
    }
  }, 200);
}

let mobileSigPad = null, mobileSigCtx = null, mobileSigInk = false;
function initMobileSigPad() {
  const canvas = document.getElementById('mobileSigPad');
  if (!canvas) return;
  mobileSigPad = canvas;
  const ratio = window.devicePixelRatio || 1;
  // 签名框尽量撑满：宽度取 canvas 实际宽，高度横屏取屏幕高-头部按钮、竖屏取屏幕高一半
  const w = canvas.offsetWidth || window.innerWidth - 40;
  const landscape = window.innerWidth > window.innerHeight;
  const h = canvas.offsetHeight || (landscape ? window.innerHeight - 100 : Math.round(window.innerHeight * 0.55));
  canvas.width = w * ratio;
  canvas.height = h * ratio;
  canvas.style.height = h + 'px';
  mobileSigCtx = canvas.getContext('2d');
  mobileSigCtx.scale(ratio, ratio);
  mobileSigCtx.lineWidth = 2;
  mobileSigCtx.lineCap = 'round';
  mobileSigCtx.lineJoin = 'round';
  mobileSigCtx.strokeStyle = '#3d2a1c';
  mobileSigInk = false;
  let last = null;
  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX ?? e.touches?.[0]?.clientX) - r.left, y: (e.clientY ?? e.touches?.[0]?.clientY) - r.top };
  };
  canvas.addEventListener('pointerdown', (e) => { e.preventDefault(); mobileSigInk = true; last = pos(e); });
  canvas.addEventListener('pointermove', (e) => {
    if (!last) return;
    e.preventDefault();
    const p = pos(e);
    mobileSigCtx.beginPath();
    mobileSigCtx.moveTo(last.x, last.y);
    mobileSigCtx.lineTo(p.x, p.y);
    mobileSigCtx.stroke();
    last = p;
  });
  canvas.addEventListener('pointerup', () => { last = null; });
  canvas.addEventListener('pointerleave', () => { last = null; });
}
function clearMobileSig() {
  if (!mobileSigCtx || !mobileSigPad) return;
  mobileSigCtx.clearRect(0, 0, mobileSigPad.width, mobileSigPad.height);
  mobileSigInk = false;
}
// 把签名 canvas 压成白底 JPEG，避免 PNG 透明像素导致体积过大
function exportSig(canvas) {
  const tmp = document.createElement('canvas');
  tmp.width = canvas.width; tmp.height = canvas.height;
  const ctx = tmp.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, tmp.width, tmp.height);
  ctx.drawImage(canvas, 0, 0);
  return tmp.toDataURL('image/jpeg', 0.6);
}
function doMobileSign() {
  if (myMeta.locked) { alert('已签名锁定'); return; }
  if (!mobileSigInk) { alert('请手写签名'); return; }
  const signature = exportSig(mobileSigPad);
  if (signature.length > 200000) { alert('签名数据过大，请简化签名'); return; }
  const btn = document.getElementById('mobileSignGo');
  if (btn) { btn.disabled = true; btn.textContent = '发送中…'; }
  try {
    const r = fetch('/api/judge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Judge-Token': token },
      body: JSON.stringify({ action: 'signOnly', signature }),
    }).then(r => r.json()).then(d => {
      if (!d.ok) { alert(d.error || '提交失败'); if (btn) { btn.disabled = false; btn.textContent = '发送签名到电脑'; } return; }
      app.innerHTML = `<div style="padding:60px 20px;text-align:center;color:var(--green);font-size:15px;line-height:1.8;">✓ 签名已发送<br><span style="color:var(--muted);font-size:13px;">请回到电脑端点「本机签名并提交」完成最终提交</span></div>`;
    }).catch(() => { alert('网络错误，提交未成功'); if (btn) { btn.disabled = false; btn.textContent = '发送签名到电脑'; } });
  } catch { if (btn) { btn.disabled = false; btn.textContent = '发送签名到电脑'; } }
}

function maybeShowAutoSignModal() {
  // 不自动弹窗，只在用户点「签名并提交打分」按钮时弹
}
// 允许重新弹出：用户返回修改后，下次完成时应再弹
function resetAutoSignShown() { autoSignShownFor = null; }

function bindAutoSignModal() {
  const modal = document.getElementById('autoSignModal');
  const go = document.getElementById('autoSignGo');
  const back = document.getElementById('autoSignBack');
  const clear = document.getElementById('modalSigClear');
  const copyLink = document.getElementById('copyMobileLink');
  if (!modal || !go || !back) return;
  go.addEventListener('click', doModalSign);
  back.addEventListener('click', () => { stopSignWait(); stopSigFetch(); modal.hidden = true; resetAutoSignShown(); });
  if (clear) clear.addEventListener('click', clearModalSig);
  if (copyLink) copyLink.addEventListener('click', () => {
    try { navigator.clipboard.writeText(buildSignUrl()); copyLink.textContent = '已复制'; setTimeout(() => copyLink.textContent = '复制手机签名链接', 1500); } catch {}
  });
  modal.addEventListener('click', (e) => { if (e.target === modal) { stopSignWait(); stopSigFetch(); modal.hidden = true; resetAutoSignShown(); } });
}
bindAutoSignModal();

function statusClass(s) { return { done: 'st-done', doing: 'st-doing', todo: 'st-todo' }[s] || 'st-todo'; }
function statusLabel(s) { return { done: '已讲完', doing: '讲标中', todo: '未开始' }[s] || '未开始'; }

function checkVendorCommentBeforeLeave() {
  if (!activeVendorId || myMeta.locked) return true;
  const v = state.vendors.find(x => x.id === activeVendorId);
  if (!v || !state.dimensions.length) return true;
  if (effectiveStatus(v) !== 'done') return true;
  // 异常分（低于满分 60%）未填扣分依据 → 拦返回
  for (const d of state.dimensions) {
    const val = myScore(v.id, d.id);
    if (val != null && isAnomaly(d, val) && !myComment(v.id, d.id).trim()) {
      alert(`「${v.name} · ${d.name}」分数低于满分的 60%，请填写分项说明（扣分依据）后再返回`);
      const ta = app.querySelector(`.dim-comment[data-did="${d.id}"]`);
      if (ta) ta.focus();
      return false;
    }
  }
  const allScored = state.dimensions.every(d => myScore(v.id, d.id) != null);
  if (!allScored) return true;
  if (!myVendorComment(v.id).trim()) {
    alert(`「${v.name}」的供应商总评未填写，请填写后再返回`);
    const overallEl = app.querySelector('[data-action="set-vendor-comment"]');
    if (overallEl) overallEl.focus();
    return false;
  }
  return true;
}

function sortedVendorList() {
  return [...state.vendors].sort((a, b) => {
    const sa = a.meetingDate && a.startTime ? new Date(`${a.meetingDate}T${a.startTime}:00`).getTime() : null;
    const sb = b.meetingDate && b.startTime ? new Date(`${b.meetingDate}T${b.startTime}:00`).getTime() : null;
    if (sa && sb) return sa - sb;
    if (sa && !sb) return -1;
    if (!sa && sb) return 1;
    return (a.order ?? 0) - (b.order ?? 0);
  });
}
function getCurrentVendorIndex() {
  const sorted = sortedVendorList();
  // currentVendorId 已设置则用它；否则若第一家已开始，自动视为已激活
  if (state.currentVendorId) {
    return sorted.findIndex(v => v.id === state.currentVendorId);
  }
  if (!sorted.length) return -1;
  const first = sorted[0];
  if (!first.meetingDate || !first.startTime) return -1;
  const start = new Date(`${first.meetingDate}T${first.startTime}:00+08:00`);
  if (isNaN(start) || new Date() < start) return -1;
  return 0;
}
function isLocked(v) {
  const idx = getCurrentVendorIndex();
  if (idx === -1) return true;
  const vIdx = sortedVendorList().findIndex(x => x.id === v.id);
  return vIdx === -1 || vIdx > idx;
}
function effectiveStatus(v) {
  const idx = getCurrentVendorIndex();
  const vIdx = sortedVendorList().findIndex(x => x.id === v.id);
  if (vIdx === -1) return 'todo';
  if (vIdx < idx) return 'done';
  if (vIdx === idx) return 'doing';
  return 'todo';
}
function lockReason(v) {
  if (getCurrentVendorIndex() === -1) return '管理员未开始讲标';
  return '尚未开放评分';
}

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escapeAttr(s) { return escapeHtml(s); }

let modalSigPad = null, modalSigCtx = null, modalSigInk = false;
function initModalSigPad() {
  const canvas = document.getElementById('modalSigPad');
  if (!canvas) return;
  modalSigPad = canvas;
  const ratio = window.devicePixelRatio || 1;
  const w = canvas.offsetWidth || 600, h = canvas.offsetHeight || 320;
  canvas.width = w * ratio;
  canvas.height = h * ratio;
  canvas.style.height = h + 'px';
  modalSigCtx = canvas.getContext('2d');
  modalSigCtx.scale(ratio, ratio);
  modalSigCtx.lineWidth = 2;
  modalSigCtx.lineCap = 'round';
  modalSigCtx.lineJoin = 'round';
  modalSigCtx.strokeStyle = '#3d2a1c';
  modalSigInk = false;
  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    const x = (e.clientX ?? e.touches?.[0]?.clientX) - r.left;
    const y = (e.clientY ?? e.touches?.[0]?.clientY) - r.top;
    return { x, y };
  };
  const start = (e) => { e.preventDefault(); modalSigInk = true; sigPad = { last: pos(e) }; };
  const move = (e) => {
    if (!sigPad) return;
    e.preventDefault();
    const p = pos(e);
    modalSigCtx.beginPath();
    modalSigCtx.moveTo(sigPad.last.x, sigPad.last.y);
    modalSigCtx.lineTo(p.x, p.y);
    modalSigCtx.stroke();
    sigPad.last = p;
  };
  const end = () => { sigPad = null; };
  canvas.addEventListener('pointerdown', start);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointerleave', end);
}

function clearModalSig() {
  if (!modalSigCtx || !modalSigPad) return;
  modalSigCtx.clearRect(0, 0, modalSigPad.width, modalSigPad.height);
  modalSigInk = false;
}

async function doModalSign() {
  if (myMeta.locked) { alert('已签名锁定'); return; }
  if (!modalSigInk) { alert('请手写签名'); return; }
  // 本机手写路径：提交前确保最新分数已暂存到云端（防本地丢失）
  try {
    await fetch('/api/judge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Judge-Token': token },
      body: JSON.stringify({ action: 'stage', scores, vendorComments }),
    });
  } catch {}
  const signature = exportSig(modalSigPad);
  if (signature.length > 200000) { alert('签名数据过大，请简化签名'); return; }

  const btn = document.getElementById('autoSignGo');
  if (btn) { btn.disabled = true; btn.textContent = '提交中…'; }
  try {
    const r = await fetch('/api/judge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Judge-Token': token },
      body: JSON.stringify({ action: 'submit', signature, scores, vendorComments }),
    });
    const d = await r.json();
    if (!d.ok) { alert(d.error || '提交失败'); return; }
    stopSignWait();
    myMeta = { signature, signedAt: Date.now(), locked: true };
    saveLocal();
    sessionStorage.setItem(SIGNED_FLAG_KEY, '1');
    document.getElementById('autoSignModal').hidden = true;
    render();
  } catch (e) {
    alert('网络错误，提交未成功');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '本机签名并提交'; }
  }
}

setInterval(() => {
  if (!activeVendorId) load();
  else refreshState();
}, 10000);

load();
