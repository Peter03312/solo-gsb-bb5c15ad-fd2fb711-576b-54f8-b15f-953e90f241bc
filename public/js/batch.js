// 批量试拼弹窗：用户按顺序填写一批候选接缝（两端陶片、旋转角、毫米平移、说明），
// 先做整批“只读试算”——既有接缝优先、候选按填写顺序参与布局，画布预览整批加入后的
// 连通组/陶片位姿，下方列出每个闭合环残差并逐条标出超差候选序号、偏差与冲突链；
// 试算不改动方案。确认时必须用“同一批内容”（batch_token）与当前方案版本
// （Base-Version）在服务端单事务内重新校验全部闭合环，通过才依序采纳、版本只 +1，
// 否则整批不生效；版本已变化或内容被改动时要求重新试算。
import { api } from './api.js';
import { esc, openModal, toast } from './ui.js';
import {
  DEG, sherdMm, computeCards, sherdWorldPose, applyPose,
} from './geo-client.js';

const RANGES = { theta_deg: [-360, 360], tx: [-100000, 100000], ty: [-100000, 100000] };
const BLUE = '#2b6cb0';

export async function openBatchModal(state, opts) {
  const { getVersion, onApplied, onError } = opts;
  const scaled = state.sherds.filter((s) => s.scale_px && s.scale_mm);
  const { body, close } = openModal({ wide: true, title: '批量试拼候选接缝' });

  if (scaled.length < 2) {
    body.innerHTML = `<div class="conflict-box">至少要有两片已标记毫米比例尺的陶片，才能批量试拼接缝。</div>
      <div class="actions"><button id="bt-close">知道了</button></div>`;
    body.querySelector('#bt-close').onclick = close;
    return;
  }

  body.innerHTML = `
    <p class="align-hint">
      按顺序填写每条候选接缝（<b>A → B</b>：把 A 局部毫米坐标映射到 B 的旋转角/平移与说明）。
      点“试算整批”做只读推演：<b>既有接缝优先，候选严格按填写顺序参与布局</b>；试算不改动接缝与版本。
      确认时服务器会用同一批内容在<b>单事务</b>内重新校验全部闭合环：全部在容差内才依序采纳、
      版本只增加一次；任一超差则整批不生效。
    </p>
    <div id="bt-rows"></div>
    <div class="actions" style="justify-content:flex-start">
      <button class="secondary" id="bt-add">＋ 添加一条候选</button>
    </div>
    <div id="bt-status" class="kv" style="margin:6px 0"></div>
    <canvas class="align-canvas" id="bt-cv" width="840" height="380"></canvas>
    <div class="legend">
      <span><i style="border-color:#8a5a2b"></i>既有生成树</span>
      <span><i style="border-color:#b0551f"></i>既有成环</span>
      <span><i style="border-color:${BLUE}"></i>本批候选</span>
      <span><i style="border-color:#b3392f"></i>超差/冲突链</span>
    </div>
    <div id="bt-residuals" style="margin-top:8px"></div>
    <details style="margin-top:8px">
      <summary class="kv" style="cursor:pointer">试算：各连通组陶片世界位姿</summary>
      <div id="bt-poses" class="kv" style="margin-top:6px;max-height:180px;overflow:auto"></div>
    </details>
    <div class="actions">
      <button class="secondary" id="bt-cancel">取消</button>
      <button class="secondary" id="bt-trial">试算整批</button>
      <button id="bt-submit" disabled>确认采纳整批</button>
    </div>`;

  const cv = body.querySelector('#bt-cv');
  const ctx = cv.getContext('2d');
  const rowsHost = body.querySelector('#bt-rows');
  const statusEl = body.querySelector('#bt-status');
  const residualsEl = body.querySelector('#bt-residuals');
  const posesEl = body.querySelector('#bt-poses');
  const submitBtn = body.querySelector('#bt-submit');
  const trialBtn = body.querySelector('#bt-trial');

  let rows = [];
  let lastPreview = null;
  let trialSig = null;
  let disposed = false;

  const imageCache = new Map();
  function getImage(url) {
    if (imageCache.has(url)) return imageCache.get(url);
    const img = new Image();
    const entry = { img, loaded: false };
    img.onload = () => { entry.loaded = true; if (lastPreview) drawPreview(lastPreview); };
    img.src = url;
    imageCache.set(url, entry);
    return entry;
  }

  function sherdOptions(sel) {
    return scaled.map((s) =>
      `<option value="${s.id}"${String(s.id) === String(sel)} selected>#${s.id} ${esc(s.label)}</option>`).join('');
  }

  function addRow(prefill) {
    rows.push(prefill || {
      from_id: scaled[0].id,
      to_id: scaled[1] ? scaled[1].id : scaled[0].id,
      theta_deg: 0, tx: 0, ty: 0, join_note: '',
    });
    renderRows();
    invalidate();
  }

  function renderRows() {
    rowsHost.innerHTML = rows.map((r, i) => `
      <div class="bt-row" data-idx="${i}">
        <span class="bt-idx">候选 ${i + 1}</span>
        <select data-f="from_id">${sherdOptions(r.from_id)}</select>
        <span class="kv">→</span>
        <select data-f="to_id">${sherdOptions(r.to_id)}</select>
        <input type="number" data-f="theta_deg" step="0.1" title="旋转角 θ (°)" placeholder="θ°" value="${r.theta_deg}" />
        <input type="number" data-f="tx" step="0.1" title="平移 tx (mm)" placeholder="tx mm" value="${r.tx}" />
        <input type="number" data-f="ty" step="0.1" title="平移 ty (mm)" placeholder="ty mm" value="${r.ty}" />
        <input type="text" data-f="join_note" maxlength="2000" title="接缝说明" placeholder="说明（断口/吻合特征）" value="${esc(r.join_note)}" />
        <span class="bt-row-ops">
          <button type="button" class="secondary" data-op="up" title="上移">↑</button>
          <button type="button" class="secondary" data-op="down" title="下移">↓</button>
          <button type="button" class="danger" data-op="del" title="删除">✕</button>
        </span>
      </div>`).join('');

    rowsHost.querySelectorAll('.bt-row').forEach((el) => {
      const i = parseInt(el.dataset.idx, 10);
      el.querySelectorAll('[data-f]').forEach((input) => {
        input.addEventListener('input', () => {
          const f = input.dataset.f;
          rows[i][f] = f === 'join_note' ? input.value : parseFloat(input.value);
          invalidate();
        });
        if (input.tagName === 'SELECT') {
          input.addEventListener('change', () => {
            rows[i][input.dataset.f] = parseInt(input.value, 10);
            invalidate();
          });
        }
      });
      el.querySelector('[data-op="up"]').onclick = () => {
        if (i > 0) { const t = rows[i - 1]; rows[i - 1] = rows[i]; rows[i] = t; renderRows(); invalidate(); }
      };
      el.querySelector('[data-op="down"]').onclick = () => {
        if (i < rows.length - 1) { const t = rows[i + 1]; rows[i + 1] = rows[i]; rows[i] = t; renderRows(); invalidate(); }
      };
      el.querySelector('[data-op="del"]').onclick = () => { rows.splice(i, 1); renderRows(); invalidate(); };
    });
  }

  // 任何编辑都使上次试算失效：必须重新试算才能确认。
  function invalidate() {
    lastPreview = null;
    trialSig = null;
    submitBtn.disabled = true;
    statusEl.innerHTML = '<span class="kv">内容已改动，请重新“试算整批”。</span>';
  }

  function readCandidates() {
    const candidates = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const at = `候选 ${i + 1}`;
      if (!Number.isInteger(r.from_id) || !Number.isInteger(r.to_id)) return { error: `${at}：请选择两端陶片` };
      if (r.from_id === r.to_id) return { error: `${at}：两端不能是同一片陶片` };
      for (const f of ['theta_deg', 'tx', 'ty']) {
        if (!Number.isFinite(r[f])) return { error: `${at}：${f} 必须是数字` };
        const [lo, hi] = RANGES[f];
        if (r[f] < lo || r[f] > hi) return { error: `${at}：${f} 超出范围（${lo} ~ ${hi}）` };
      }
      candidates.push({
        from_id: r.from_id, to_id: r.to_id,
        theta_deg: r.theta_deg, tx: r.tx, ty: r.ty,
        join_note: (r.join_note || '').toString(),
      });
    }
    if (!candidates.length) return { error: '请至少填写一条候选接缝' };
    return { candidates };
  }

  const sigOf = (cs) => JSON.stringify(cs);

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  // 预览画布：卡片底板 + 接缝（候选蓝，超差/冲突链红）+ 陶片（候选端点蓝框）。
  function drawPreview(preview) {
    if (disposed) return;
    const { layout, sherds } = preview;
    const cards = computeCards(layout, sherds);
    const byId = new Map(sherds.map((s) => [s.id, s]));
    const candidateIds = new Set((preview.seams || []).filter((s) => s.candidate_index).map((s) => s.id));
    const candidateEnds = new Set();
    preview.seams.forEach((s) => { if (s.candidate_index) { candidateEnds.add(s.from_id); candidateEnds.add(s.to_id); } });
    const violationIds = new Set((preview.violations || []).map((v) => v.seam_id));
    const chainIds = new Set();
    for (const v of preview.violations || []) v.conflict_chain.seams.forEach((s) => chainIds.add(s.id));

    ctx.setTransform(1, 0, 0, 1, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    const W = cards.contentW || 400, H = cards.contentH || 300;
    const zoom = Math.min(cv.width / W, cv.height / H) * 0.95;
    const ox = (cv.width - W * zoom) / 2;
    const oy = (cv.height - H * zoom) / 2;
    const w2s = (x, y) => ({ x: x * zoom + ox, y: y * zoom + oy });

    for (const c of cards.cards) {
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

    for (const c of cards.cards) {
      if (c.kind !== 'group') continue;
      const g = c.group;
      const treeSet = new Set(g.tree_seam_ids);
      for (const sm of preview.seams) {
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
        const isCandidate = candidateIds.has(sm.id);
        const bad = violationIds.has(sm.id) || chainIds.has(sm.id);
        let color;
        if (bad) color = '#b3392f';
        else if (isCandidate) color = BLUE;
        else color = treeSet.has(sm.id) ? '#8a5a2b' : '#b0551f';
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = bad || isCandidate ? 3 : 2;
        // 候选的成环边用虚线；既有成环边沿用虚线；树边实线。
        if (!treeSet.has(sm.id)) ctx.setLineDash([7, 5]);
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

    for (const c of cards.cards) {
      const ids = c.kind === 'group' ? c.group.member_ids : [c.sherdId];
      for (const id of ids) {
        const sh = byId.get(id);
        const pose = sherdWorldPose(layout, c, id);
        if (!pose) continue;
        const m = sherdMm(sh);
        const entry = getImage(sh.image_url);
        const p = w2s(pose.x, pose.y);
        const scale = zoom / m.ppm;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(pose.theta * DEG);
        ctx.scale(scale, scale);
        if (entry.loaded) ctx.drawImage(entry.img, 0, 0);
        else { ctx.fillStyle = '#ddd4c0'; ctx.fillRect(0, 0, sh.img_w, sh.img_h); }
        ctx.lineWidth = (candidateEnds.has(id) ? 3 : 1.5) / scale;
        ctx.strokeStyle = candidateEnds.has(id) ? BLUE : 'rgba(60,50,35,.55)';
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
          const sh = preview.sherds.find((s) => s.id === id);
          return `<div class="kv">#${id} ${esc(sh ? sh.label : '')}：x=${p.x} mm, y=${p.y} mm, θ=${p.theta}°</div>`;
        }).join('')}
      </div>`).join('') || '<div class="kv">当前候选不构成连通组。</div>';
  }

  function seamTag(s, candidateIndex) {
    if (candidateIndex) return `候${candidateIndex}`;
    return `#${s.id}`;
  }

  function renderResiduals(preview) {
    const residuals = preview.layout.residuals || [];
    const violations = preview.violations || [];
    if (!residuals.length) {
      residualsEl.innerHTML = '<div class="kv">整批加入后没有闭合环（无闭合残差）。</div>';
      return;
    }
    const seamById = new Map(preview.seams.map((s) => [s.id, s]));
    const rowsHtml = residuals.map((r) => {
      const s = seamById.get(r.seam_id);
      return `<div class="seam-row" style="border-color:${r.within_tolerance ? 'var(--line)' : 'var(--danger)'}">
        <div>闭合接缝 <b>${seamTag(s, r.candidate_index)}</b>（#${r.from_id} → #${r.to_id}）
          ${r.candidate_index ? ' <span class="tag-cycle">本批候选</span>' : ''}</div>
        <div class="residual ${r.within_tolerance ? 'ok' : 'bad'}">
          闭合残差：${r.distance_mm} mm / ${r.rotation_deg}°
          ${r.within_tolerance ? '✔ 容差内' : `✘ 超容差 ${preview.project.tolerance_mm} mm`}
        </div>
      </div>`;
    }).join('');
    const chains = violations.map((v) => `
      <div class="conflict-box" style="margin-top:8px">
        <div><b>超差闭合接缝 ${v.candidate_index ? `候选 ${v.candidate_index}` : `#${v.seam_id}`}</b>
          （#${v.from_id} → #${v.to_id}）偏差 ${v.deviation_mm} mm / ${v.rotation_deg}°，
          超容差 ${v.tolerance_mm} mm。</div>
        <div style="margin-top:6px">
          <b>冲突链：</b>
          <div class="chain-seams" style="font-family:ui-monospace,Menlo,monospace;margin:4px 0">
            ${v.conflict_chain.sherds.map((s) => `#${s.id}`).join(' → ')}
            ，沿接缝 ${v.conflict_chain.seams.map((s) => seamTag(s, s.candidate_index)).join(' → ') || '（无）'}
            ，由闭合接缝 ${v.candidate_index ? `候选 ${v.candidate_index}` : `#${v.seam_id}`} 成环
          </div>
          <pre>${v.conflict_chain.seams.map((s) =>
            `${s.candidate_index ? `候选 ${s.candidate_index}` : `接缝 #${s.id}`}  (#${s.from_id}→#${s.to_id})${s.join_note ? `  ${esc(s.join_note)}` : ''}`).join('\n') || '（链上无接缝）'}</pre>
        </div>
      </div>`).join('');
    residualsEl.innerHTML =
      `<div class="legend" style="padding:0 0 4px">共 ${residuals.length} 个闭合环，超差 ${violations.length} 条</div>${rowsHtml}${chains}`;
  }

  function refreshSubmitState() {
    const parsed = readCandidates();
    const ok = !!lastPreview
      && !parsed.error
      && trialSig === sigOf(parsed.candidates || [])
      && lastPreview.violations.length === 0
      && lastPreview.base_version === getVersion();
    submitBtn.disabled = !ok;
    if (lastPreview && lastPreview.base_version !== getVersion()) {
      statusEl.innerHTML = '<span style="color:var(--danger);font-weight:600">⚠ 试算后方案版本已变化，请重新试算整批。</span>';
    }
  }

  async function runTrial() {
    const parsed = readCandidates();
    if (parsed.error) {
      statusEl.innerHTML = `<span style="color:var(--danger)">⚠ ${esc(parsed.error)}</span>`;
      return;
    }
    statusEl.innerHTML = '<span class="kv">正在试算整批…</span>';
    trialBtn.disabled = true;
    try {
      const data = await api.batchPreviewSeams(state.project.id, parsed.candidates);
      if (disposed) return;
      lastPreview = data;
      trialSig = sigOf(parsed.candidates);
      drawPreview(data);
      renderResiduals(data);
      renderPoses(data);
      if (data.violations.length) {
        const byCandidate = new Map();
        data.violations.forEach((v) => {
          if (v.candidate_index) byCandidate.set(v.candidate_index, v);
        });
        const who = [...byCandidate.keys()].sort((a, b) => a - b).map((n) => `候选 ${n}`).join('、');
        statusEl.innerHTML = `<span style="color:var(--danger);font-weight:600">
          ✘ 试算：${data.violations.length} 条闭合接缝超容差${who ? `（${who}）` : ''}，整批不可采纳（方案不会被改动）。</span>`;
      } else {
        statusEl.innerHTML = '<span style="color:var(--ok);font-weight:600">✔ 试算：所有闭合环残差在容差内，可确认采纳整批。</span>';
      }
      refreshSubmitState();
    } catch (e) {
      statusEl.innerHTML = `<span style="color:var(--danger)">试算被拒绝：${esc(e.message)}</span>`;
      submitBtn.disabled = true;
    } finally {
      if (!disposed) trialBtn.disabled = false;
    }
  }

  // 确认被 422 拒绝（重算超差 / 内容不一致）：展示服务端返回的超差链，
  // 旧试算已作废，须重新试算后才能再次确认。
  function renderConfirmReject(info) {
    let html = `<div class="conflict-box"><div>${esc(info.message || '整批未生效，请重新试算。')}</div></div>`;
    if (Array.isArray(info.violations) && info.violations.length) {
      html += info.violations.map((v) => `
        <div class="conflict-box" style="margin-top:8px">
          <div><b>超差闭合接缝 ${v.candidate_index ? `候选 ${v.candidate_index}` : `#${v.seam_id}`}</b>
            （#${v.from_id} → #${v.to_id}）偏差 ${v.deviation_mm} mm / ${v.rotation_deg}°，
            超容差 ${v.tolerance_mm} mm。</div>
          <div style="margin-top:6px">
            <b>冲突链：</b>
            <div class="chain-seams" style="font-family:ui-monospace,Menlo,monospace;margin:4px 0">
              ${v.conflict_chain.sherds.map((s) => `#${s.id}`).join(' → ')}
              ，沿接缝 ${v.conflict_chain.seams.map((s) => seamTag(s, s.candidate_index)).join(' → ') || '（无）'}
              ，由闭合接缝 ${v.candidate_index ? `候选 ${v.candidate_index}` : `#${v.seam_id}`} 成环
            </div>
            <pre>${v.conflict_chain.seams.map((s) =>
              `${s.candidate_index ? `候选 ${s.candidate_index}` : `接缝 #${s.id}`}  (#${s.from_id}→#${s.to_id})${s.join_note ? `  ${esc(s.join_note)}` : ''}`).join('\n') || '（链上无接缝）'}</pre>
          </div>
        </div>`).join('');
    }
    residualsEl.innerHTML = html;
  }

  submitBtn.onclick = async () => {
    const parsed = readCandidates();
    if (parsed.error) return toast(parsed.error, 'error');
    if (!lastPreview || trialSig !== sigOf(parsed.candidates) || lastPreview.violations.length) {
      return toast('请先完成无超差的整批试算', 'warn');
    }
    if (lastPreview.base_version !== getVersion()) {
      return toast('试算后方案版本已变化，请重新试算', 'warn');
    }
    submitBtn.disabled = true;
    try {
      const next = await api.commitBatchSeams(
        state.project.id, getVersion(), parsed.candidates, lastPreview.batch_token);
      close();
      onApplied(next);
    } catch (e) {
      // 版本冲突 / 内容不一致 / 确认时重算超差：旧试算一律作废，必须重新试算。
      lastPreview = null;
      trialSig = null;
      submitBtn.disabled = true;
      const info = e.data && e.data.error;
      if (info && (info.reason === 'batch_content_mismatch' || info.reason === 'batch_cycle_tolerance_exceeded')) {
        statusEl.innerHTML = `<span style="color:var(--danger);font-weight:600">✘ ${esc(e.message)} 请重新试算。</span>`;
        renderConfirmReject(info);
      } else {
        onError(e);
      }
    }
  };

  body.querySelector('#bt-add').onclick = () => addRow();
  body.querySelector('#bt-trial').onclick = runTrial;
  body.querySelector('#bt-cancel').onclick = close;

  const mask = body.closest('.modal-mask');
  const observer = new MutationObserver(() => {
    if (!document.body.contains(mask)) { disposed = true; observer.disconnect(); }
  });
  observer.observe(document.getElementById('modal-host'), { childList: true, subtree: true });

  // 初始两行候选，等待用户填写并手动试算（不自动请求）。
  addRow();
  addRow();
}
