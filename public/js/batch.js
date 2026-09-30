// 批量试拼弹窗：按顺序填写一批候选接缝（两端陶片、旋转角、毫米平移、说明），
// 先做只读“试算”（整批加入后的连通组、陶片位姿、每个闭合环残差），
// 再用“试算所基于的方案版本 + 同一批内容指纹”在单事务内确认采纳。
//
// 布局规则与后端一致：既有接缝优先，候选按填写顺序参与布局；
// 超差时逐条指出候选序号、偏差与冲突链。试算不改接缝与版本。
import { api } from './api.js';
import { esc, openModal, toast } from './ui.js';
import {
  DEG, sherdMm, computeCards, sherdWorldPose, applyPose,
} from './geo-client.js';

const RANGES = { theta_deg: [-360, 360], tx: [-100000, 100000], ty: [-100000, 100000] };

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

export async function openBatchModal(state, { onApplied, onError }) {
  const { body, close } = openModal({
    wide: true,
    title: '批量试拼候选接缝',
  });
  body.innerHTML = `
    <p class="align-hint">
      按顺序逐条填写候选接缝（A → B 的旋转角 θ、毫米平移 tx/ty、说明）。
      点“试算整批”做<b>只读推演</b>：<b>既有接缝优先</b>，候选按填写顺序参与布局；
      给出整批加入后的连通组、陶片位姿与每个闭合环残差，超差时指出<b>候选序号、偏差与冲突链</b>。
      试算不改动方案；确认时服务器在<b>单事务</b>内基于试算版本重新校验全部闭合环，
      通过才依序采纳且版本只增加一次，否则整批不生效。
    </p>
    <div id="bt-rows"></div>
    <div class="actions" style="justify-content:space-between">
      <button class="secondary" id="bt-add">＋ 添加一条候选</button>
      <span>
        <button class="secondary" id="bt-cancel">取消</button>
        <button class="secondary" id="bt-preview">试算整批</button>
        <button id="bt-submit" disabled>确认采纳整批</button>
      </span>
    </div>
    <div id="bt-status" class="kv" style="margin:6px 0"></div>
    <canvas class="align-canvas" id="bt-cv" width="840" height="420"></canvas>
    <div id="bt-residuals" style="margin-top:8px"></div>
    <details style="margin-top:8px">
      <summary class="kv" style="cursor:pointer">试算：各连通组陶片世界位姿</summary>
      <div id="bt-poses" class="kv" style="margin-top:6px;max-height:180px;overflow:auto"></div>
    </details>`;

  const scaled = state.sherds.filter((s) => s.scale_px);
  const rowsHost = body.querySelector('#bt-rows');
  const statusEl = body.querySelector('#bt-status');
  const residualsEl = body.querySelector('#bt-residuals');
  const posesEl = body.querySelector('#bt-poses');
  const submitBtn = body.querySelector('#bt-submit');
  const cv = body.querySelector('#bt-cv');
  const ctx = cv.getContext('2d');

  if (scaled.length < 2) {
    statusEl.innerHTML = '<span style="color:var(--danger)">至少要有两片已标记比例尺的陶片才能填写候选接缝。</span>';
  }

  let rowSeq = 0;
  let lastPreview = null;  // 最近一次成功试算的返回体
  let lastCandidates = null;
  let previewSeq = 0;
  let debounceTimer = null;
  let disposed = false;

  function sherdOptions(selectedId) {
    return scaled.map((s) =>
      `<option value="${s.id}"${s.id === selectedId ? ' selected' : ''}>#${s.id} ${esc(s.label)}</option>`).join('');
  }

  function addRow(prefill) {
    const seq = ++rowSeq;
    const wrapEl = document.createElement('div');
    wrapEl.className = 'bt-row';
    wrapEl.dataset.seq = seq;
    const fromId = prefill && prefill.from_id ? prefill.from_id : (scaled[0] && scaled[0].id);
    const toId = prefill && prefill.to_id
      ? prefill.to_id
      : (scaled[1] && scaled[1].id ? scaled[1].id : (scaled[0] && scaled[0].id));
    wrapEl.innerHTML = `
      <span class="bt-idx"></span>
      <label class="field">A
        <select data-f="from_id">${sherdOptions(fromId)}</select>
      </label>
      <label class="field">B
        <select data-f="to_id">${sherdOptions(toId)}</select>
      </label>
      <label class="field">θ°
        <input type="number" step="0.1" data-f="theta_deg" value="${prefill ? prefill.theta_deg : 0}" />
      </label>
      <label class="field">tx
        <input type="number" step="0.1" data-f="tx" value="${prefill ? prefill.tx : 0}" />
      </label>
      <label class="field">ty
        <input type="number" step="0.1" data-f="ty" value="${prefill ? prefill.ty : 0}" />
      </label>
      <label class="field bt-note">说明
        <input type="text" maxlength="2000" data-f="join_note" placeholder="断口说明（可选）" value="${esc(prefill ? prefill.join_note || '' : '')}" />
      </label>
      <button class="secondary bt-del" title="删除该候选">✕</button>`;
    wrapEl.querySelector('.bt-del').onclick = () => {
      wrapEl.remove();
      renumber();
      invalidate('已删除候选，请重新试算');
      schedulePreview();
    };
    wrapEl.querySelectorAll('[data-f]').forEach((el) => {
      el.addEventListener('input', onRowChange);
      el.addEventListener('change', onRowChange);
    });
    rowsHost.appendChild(wrapEl);
    renumber();
    return wrapEl;
  }

  function renumber() {
    [...rowsHost.children].forEach((el, i) => {
      el.querySelector('.bt-idx').textContent = `#${i + 1}`;
    });
  }

  function invalidate(msg) {
    submitBtn.disabled = true;
    lastPreview = null;
    lastCandidates = null;
    if (msg && !disposed) statusEl.innerHTML = `<span class="kv">${esc(msg)}…</span>`;
  }

  // 行内编辑：标记旧试算失效，并防抖自动重新试算（与修订弹窗一致）。
  function onRowChange() {
    invalidate('候选有改动，正在重新试算');
    schedulePreview();
  }

  // 读取并本地校验全部候选行；错误按行（候选序号）收集。
  function readCandidates() {
    const rowEls = [...rowsHost.children];
    if (!rowEls.length) return { error: '请至少添加一条候选接缝' };
    const errors = [];
    const candidates = rowEls.map((rowEl, i) => {
      const get = (f) => rowEl.querySelector(`[data-f="${f}"]`);
      const itemErrors = [];
      const fromId = parseInt(get('from_id').value, 10);
      const toId = parseInt(get('to_id').value, 10);
      if (fromId === toId) itemErrors.push('接缝连接了同一片陶片');
      const numField = (f) => {
        const n = parseFloat(get(f).value);
        if (!Number.isFinite(n)) return { error: `${f} 必须是数字` };
        const [lo, hi] = RANGES[f];
        if (n < lo || n > hi) return { error: `${f} 超出范围（${lo}~${hi}）` };
        return { value: n };
      };
      const th = numField('theta_deg');
      const tx = numField('tx');
      const ty = numField('ty');
      if (th.error) itemErrors.push(th.error);
      if (tx.error) itemErrors.push(tx.error);
      if (ty.error) itemErrors.push(ty.error);
      if (itemErrors.length) {
        errors.push({ index: i + 1, messages: itemErrors });
        rowEl.classList.add('bt-row-bad');
        return null;
      }
      rowEl.classList.remove('bt-row-bad');
      return {
        from_id: fromId, to_id: toId,
        theta_deg: th.value, tx: tx.value, ty: ty.value,
        join_note: get('join_note').value,
      };
    });
    if (errors.length) {
      return { error: `候选 ${errors.map((e) => `#${e.index}（${e.messages.join('；')}）`).join('、')} 不合法` };
    }
    return { candidates };
  }

  const imageCache = new Map();
  function getImage(sh) {
    if (imageCache.has(sh.id)) return imageCache.get(sh.id);
    const img = new Image();
    const entry = { img, loaded: false };
    img.onload = () => { entry.loaded = true; if (lastPreview) drawPreview(lastPreview); };
    img.src = sh.image_url;
    imageCache.set(sh.id, entry);
    return entry;
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  // 试算画布：卡片底板 + 接缝（既有生成树棕 / 既有成环橙虚 /
  // 候选生成树蓝 / 候选成环绿虚；超差相关一律红虚）+ 陶片（候选端点蓝框）。
  function drawPreview(preview) {
    if (disposed) return;
    const { layout, sherds, seams } = preview;
    const cardsInfo = computeCards(layout, sherds);
    const cards = cardsInfo.cards;
    const byId = new Map(sherds.map((s) => [s.id, s]));
    const violationIds = new Set((preview.violations || []).map((v) => v.virtual_seam_id));
    const chainIds = new Set();
    const candidateEndpoints = new Set();
    for (const v of preview.violations || []) {
      v.conflict_chain.seams.forEach((s) => chainIds.add(s.virtual_seam_id));
    }
    for (const sm of seams) {
      if (sm.candidate_index !== null) {
        candidateEndpoints.add(sm.from_id);
        candidateEndpoints.add(sm.to_id);
      }
    }

    ctx.setTransform(1, 0, 0, 1, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    const W = cardsInfo.contentW || 400, H = cardsInfo.contentH || 300;
    const zoom = Math.min(cv.width / W, cv.height / H) * 0.95;
    const ox = (cv.width - W * zoom) / 2;
    const oy = (cv.height - H * zoom) / 2;
    const w2s = (x, y) => ({ x: x * zoom + ox, y: y * zoom + oy });

    for (const c of cards) {
      const p = w2s(c.x, c.y);
      ctx.fillStyle = '#fffdf8';
      ctx.strokeStyle = '#cfc5b0';
      ctx.lineWidth = 1;
      roundRect(ctx, p.x, p.y, c.w * zoom, c.h * zoom, 10);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = c.kind === 'group' ? '#8a5a2b' : '#7a7264';
      ctx.font = '600 12px sans-serif';
      ctx.fillText(c.kind === 'group' ? `▣ ${c.title}` : `◇ ${c.title}`, p.x + 10, p.y + 18);
    }

    for (const c of cards) {
      if (c.kind !== 'group') continue;
      const g = c.group;
      const treeSet = new Set(g.tree_seam_ids);
      for (const sm of seams) {
        if (!g.member_ids.includes(sm.from_id)) continue;
        const pFrom = sherdWorldPose(layout, c, sm.from_id);
        const pTo = sherdWorldPose(layout, c, sm.to_id);
        if (!pFrom || !pTo) continue;
        const mA = sherdMm(byId.get(sm.from_id));
        const mB = sherdMm(byId.get(sm.to_id));
        const aW = applyPose(pFrom, mA.wMm / 2, mA.hMm / 2);
        const bW = applyPose(pTo, mB.wMm / 2, mB.hMm / 2);
        const cA = w2s(aW.x, aW.y);
        const cB = w2s(bW.x, bW.y);
        const isCandidate = sm.candidate_index !== null;
        const isTree = treeSet.has(sm.virtual_seam_id);
        const bad = violationIds.has(sm.virtual_seam_id);
        const inChain = chainIds.has(sm.virtual_seam_id);
        let color;
        if (bad || inChain) color = '#b3392f';
        else if (isCandidate) color = isTree ? '#2b6cb0' : '#2f8f4e';
        else color = isTree ? '#8a5a2b' : '#b0551f';
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = bad ? 3 : isCandidate ? 2.6 : 2;
        if (!isTree) ctx.setLineDash([7, 5]);
        ctx.beginPath();
        ctx.moveTo(cA.x, cA.y);
        ctx.lineTo(cB.x, cB.y);
        ctx.stroke();
        ctx.restore();

        const midX = (cA.x + cB.x) / 2, midY = (cA.y + cB.y) / 2;
        const label = isCandidate ? `候${sm.candidate_index}` : `#${sm.id}`;
        ctx.font = '600 11px ui-monospace, Menlo, monospace';
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = color;
        roundRect(ctx, midX - tw / 2 - 5, midY - 9, tw + 10, 17, 4);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.fillText(label, midX - tw / 2, midY + 3);
      }
    }

    for (const c of cards) {
      const ids = c.kind === 'group' ? c.group.member_ids : [c.sherdId];
      for (const id of ids) {
        const sh = byId.get(id);
        const pose = sherdWorldPose(layout, c, id);
        if (!pose) continue;
        const m = sherdMm(sh);
        const entry = getImage(sh);
        const p = w2s(pose.x, pose.y);
        const scale = zoom / m.ppm;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(pose.theta * DEG);
        ctx.scale(scale, scale);
        if (entry.loaded) ctx.drawImage(entry.img, 0, 0);
        else { ctx.fillStyle = '#ddd4c0'; ctx.fillRect(0, 0, sh.img_w, sh.img_h); }
        ctx.lineWidth = (candidateEndpoints.has(id) ? 3 : 1.5) / scale;
        ctx.strokeStyle = candidateEndpoints.has(id) ? '#2b6cb0' : 'rgba(60,50,35,.55)';
        ctx.strokeRect(0, 0, sh.img_w, sh.img_h);
        ctx.restore();
        ctx.save();
        ctx.fillStyle = '#3a2f22';
        ctx.font = '600 12px sans-serif';
        ctx.fillText(`#${sh.id} ${sh.label}`, p.x + 3, p.y - 4);
        ctx.restore();
      }
    }
  }

  function renderPoses(preview) {
    posesEl.innerHTML = preview.layout.groups.map((g) => `
      <div style="margin-bottom:8px">
        <b>连通组 · 根 #${g.root_sherd_id}（${g.member_ids.length} 片）</b>
        ${g.member_ids.map((id) => {
          const p = g.poses[id];
          const sh = preview.sherds.find((x) => x.id === id);
          return `<div class="kv">#${id} ${esc(sh ? sh.label : '')}：x=${p.x} mm, y=${p.y} mm, θ=${p.theta}°</div>`;
        }).join('')}
      </div>`).join('') || '<div class="kv">当前候选不构成连通组。</div>';
  }

  function seamLabel(sm) {
    return sm.candidate_index !== null ? `候选 #${sm.candidate_index}` : `接缝 #${sm.id}`;
  }

  function renderResiduals(preview) {
    const residuals = preview.layout.residuals || [];
    const violations = preview.violations || [];
    const roleRows = (preview.candidate_results || []).map((r) => `
      <span class="badge ${r.role === 'tree' ? 'ok' : 'warn'}">
        候选 #${r.index}：#${r.from_id}→#${r.to_id} ${r.role === 'tree' ? '生成树接缝（决定布局）' : '成环接缝（仅闭合校验）'}
      </span>`).join(' ');

    if (!residuals.length) {
      residualsEl.innerHTML = `
        <div class="legend" style="padding:0 0 4px">
          <span><i style="border-color:#2b6cb0"></i>候选生成树</span>
          <span><i style="border-color:#2f8f4e"></i>候选成环</span>
          <span><i style="border-color:#8a5a2b"></i>既有生成树</span>
          <span><i style="border-color:#b0551f"></i>既有成环</span>
        </div>
        <div style="margin:4px 0">${roleRows || '<span class="kv">无候选。</span>'}</div>
        <div class="kv">整批加入后没有闭合环（无闭合残差）。</div>`;
      return;
    }
    const seamByVId = new Map(preview.seams.map((s) => [s.virtual_seam_id, s]));
    const rows = residuals.map((r) => {
      const s = seamByVId.get(r.seam_id);
      const vId = r.seam_id;
      return `<div class="seam-row" style="border-color:${r.within_tolerance ? 'var(--line)' : 'var(--danger)'}">
        <div>${seamLabel(s)}（#${r.from_id} → #${r.to_id}）</div>
        <div class="residual ${r.within_tolerance ? 'ok' : 'bad'}">
          闭合残差：${r.distance_mm} mm / ${r.rotation_deg}°
          ${r.within_tolerance ? '✔ 容差内' : `✘ 超容差 ${preview.project.tolerance_mm} mm`}
        </div>
      </div>`;
    }).join('');
    const chains = violations.map((v) => `
      <div class="conflict-box" style="margin-top:8px">
        <div><b>候选 #${v.candidate_index}</b>（#${v.from_id} → #${v.to_id}）形成的闭合环偏差
          ${v.deviation_mm} mm / ${v.rotation_deg}°，超容差 ${v.tolerance_mm} mm。</div>
        <div style="margin-top:6px">
          <b>冲突链：</b>
          <div class="chain-seams" style="font-family:ui-monospace,Menlo,monospace;margin:4px 0">
            ${v.conflict_chain.sherds.map((s) => `#${s.id}`).join(' → ')}
            ，沿 ${v.conflict_chain.seams.map((s) => s.candidate_index ? `候选#${s.candidate_index}` : `接缝#${s.id}`).join(' → ') || '（无）'}
            ，由候选 #${v.candidate_index} 成环
          </div>
          <pre>${v.conflict_chain.seams.map((s) =>
            `${s.candidate_index ? `候选 #${s.candidate_index}` : `接缝 #${s.id}`}  (#${s.from_id}→#${s.to_id})${s.join_note ? `  ${esc(s.join_note)}` : ''}`).join('\n') || '（链上无接缝）'}</pre>
        </div>
      </div>`).join('');
    residualsEl.innerHTML = `
      <div class="legend" style="padding:0 0 4px">
        <span><i style="border-color:#2b6cb0"></i>候选生成树</span>
        <span><i style="border-color:#2f8f4e"></i>候选成环</span>
        <span><i style="border-color:#b3392f"></i>超差/冲突链</span>
      </div>
      <div style="margin:4px 0">${roleRows}</div>
      <div class="legend" style="padding:4px 0">共 ${residuals.length} 个闭合环，超差 ${violations.length} 条</div>
      ${rows}${chains}`;
  }

  async function runPreview() {
    const parsed = readCandidates();
    if (parsed.error) {
      statusEl.innerHTML = `<span style="color:var(--danger)">⚠ ${esc(parsed.error)}</span>`;
      submitBtn.disabled = true;
      return;
    }
    const seq = ++previewSeq;
    statusEl.innerHTML = '<span class="kv">正在试算整批…</span>';
    try {
      const data = await api.batchPreview(state.project.id, parsed.candidates);
      if (disposed || seq !== previewSeq) return;
      lastPreview = data;
      lastCandidates = parsed.candidates;
      drawPreview(data);
      renderResiduals(data);
      renderPoses(data);
      if (data.violations.length) {
        statusEl.innerHTML = `<span style="color:var(--danger);font-weight:600">✘ 试算：候选 #${data.violations.map((v) => v.candidate_index).join('、#')} 的闭合环超容差，整批不可确认（试算未改动方案）。</span>`;
        submitBtn.disabled = true;
      } else {
        statusEl.innerHTML = `<span style="color:var(--ok);font-weight:600">✔ 试算完成（基于方案 v${data.base_version}）：所有闭合环残差在容差内，可确认采纳整批。</span>`;
        submitBtn.disabled = false;
      }
    } catch (e) {
      if (disposed || seq !== previewSeq) return;
      if (e.status === 400 && e.data && e.data.error && e.data.error.errors) {
        // 服务器前置校验：逐候选序号指出问题（陶片不属于方案/未标比例尺/同片/参数非法）。
        const errs = e.data.error.errors.map((x) => `#${x.index} ${esc(x.message)}`).join('；');
        statusEl.innerHTML = `<span style="color:var(--danger);font-weight:600">✘ ${esc(e.data.error.message)}：${errs}</span>`;
      } else {
        statusEl.innerHTML = `<span style="color:var(--danger)">试算失败：${esc(e.message)}</span>`;
      }
      submitBtn.disabled = true;
    }
  }

  function schedulePreview() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runPreview, 250);
  }

  body.querySelector('#bt-add').onclick = () => addRow();
  body.querySelector('#bt-cancel').onclick = close;
  body.querySelector('#bt-preview').onclick = () => { clearTimeout(debounceTimer); runPreview(); };

  submitBtn.onclick = async () => {
    if (!lastPreview || !lastCandidates) return toast('请先试算整批', 'warn');
    submitBtn.disabled = true;
    try {
      const next = await api.batchCommit(
        state.project.id,
        lastPreview.base_version,
        lastCandidates,
        lastPreview.base_version,
        lastPreview.batch_fingerprint
      );
      close();
      onApplied(next);
    } catch (e) {
      submitBtn.disabled = false;
      if (e.status === 422 && e.data && e.data.error) {
        // 单事务内重新校验仍超差：整批不生效；基于服务器当前状态重新试算同一批。
        statusEl.innerHTML = `<span style="color:var(--danger);font-weight:600">✘ ${esc(e.data.error.message)}</span>`;
        try {
          const fresh = await api.batchPreview(state.project.id, lastCandidates);
          if (!disposed) {
            lastPreview = fresh;
            drawPreview(fresh);
            renderResiduals(fresh);
            renderPoses(fresh);
            submitBtn.disabled = true;
          }
        } catch { /* 保留错误状态 */ }
      } else if (e.status === 409) {
        // 方案版本已变化：必须重新试算。关闭弹窗交由上层版本冲突流程处理。
        close();
        onError(e);
      } else {
        onError(e);
      }
    }
  };

  const mask = body.closest('.modal-mask');
  const observer = new MutationObserver(() => {
    if (!document.body.contains(mask)) { disposed = true; clearTimeout(debounceTimer); observer.disconnect(); }
  });
  observer.observe(document.getElementById('modal-host'), { childList: true, subtree: true });

  // 初始两条空候选，便于直接填写。
  addRow();
  addRow();
}
