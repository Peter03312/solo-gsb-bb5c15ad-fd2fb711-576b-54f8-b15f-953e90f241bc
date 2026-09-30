// 接缝修订弹窗：修改一条“已采纳接缝”的旋转角 / 毫米平移 / 说明。
// 身份（接缝 #id、两端陶片）与采纳排序不可改。
//
// 交互：
//   改参后防抖自动调用“只读预览”（不带 Base-Version，绝不改方案）；
//   预览按原接缝身份与排序重算全部陶片位姿与各闭合环残差，画布随预览重绘，
//   超差接缝逐条列出冲突链；确认必须基于当前版本重新原子校验（PATCH）。
import { api } from './api.js';
import { esc, openModal, toast } from './ui.js';
import {
  DEG, sherdMm, computeCards, sherdWorldPose, applyPose,
} from './geo-client.js';

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

const RANGES = { theta_deg: [-360, 360], tx: [-100000, 100000], ty: [-100000, 100000] };

export async function openReviseSeamModal(seam, opts) {
  const { getVersion, onApplied, onError } = opts;
  const { body, close } = openModal({
    wide: true,
    title: `修订接缝 #${seam.id}（#${seam.from_id} → #${seam.to_id}）`,
  });
  body.innerHTML = `
    <p class="align-hint">
      仅修改旋转角与毫米平移、接缝说明；接缝 <b>#${seam.id}</b> 的身份与采纳排序保持不变。
      改动后下方会<b>自动预览</b>：按原身份/排序重算的陶片位姿与各闭合环残差；
      预览不改动方案，确认时服务器还会基于当前版本重新做一次原子校验。
    </p>
    <div class="row">
      <label class="field">旋转角 θ (°)
        <input type="number" id="rv-theta" step="0.1" value="${seam.theta_deg}" />
      </label>
      <label class="field">平移 tx (mm)
        <input type="number" id="rv-tx" step="0.1" value="${seam.tx}" />
      </label>
      <label class="field">平移 ty (mm)
        <input type="number" id="rv-ty" step="0.1" value="${seam.ty}" />
      </label>
    </div>
    <div class="row">
      <label class="field" style="flex:1">接缝说明
        <input type="text" id="rv-note" maxlength="2000" value="${esc(seam.join_note || '')}" placeholder="断口位置、走向、吻合特征……" />
      </label>
    </div>
    <div id="rv-status" class="kv" style="margin:4px 0"></div>
    <canvas class="align-canvas" id="rv-cv" width="840" height="420"></canvas>
    <div id="rv-residuals" style="margin-top:8px"></div>
    <details style="margin-top:8px">
      <summary class="kv" style="cursor:pointer">预览：各连通组陶片世界位姿</summary>
      <div id="rv-poses" class="kv" style="margin-top:6px;max-height:180px;overflow:auto"></div>
    </details>
    <div class="actions">
      <button class="secondary" id="rv-cancel">取消</button>
      <button class="secondary" id="rv-preview-now">立即预览</button>
      <button id="rv-submit" disabled>确认修订</button>
    </div>`;

  const cv = body.querySelector('#rv-cv');
  const ctx = cv.getContext('2d');
  const thetaInput = body.querySelector('#rv-theta');
  const txInput = body.querySelector('#rv-tx');
  const tyInput = body.querySelector('#rv-ty');
  const noteInput = body.querySelector('#rv-note');
  const statusEl = body.querySelector('#rv-status');
  const residualsEl = body.querySelector('#rv-residuals');
  const posesEl = body.querySelector('#rv-poses');
  const submitBtn = body.querySelector('#rv-submit');

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

  let lastPreview = null; // 最近一次预览返回体
  let lastSig = null;     // 与 lastPreview 对应的入参指纹
  let previewSeq = 0;
  let debounceTimer = null;
  let disposed = false;

  function readParams() {
    const num = (el, field) => {
      const n = parseFloat(el.value);
      if (!Number.isFinite(n)) return { error: `${field} 必须是数字` };
      const [lo, hi] = RANGES[field];
      if (n < lo || n > hi) return { error: `${field} 超出允许范围（${lo} ~ ${hi}）` };
      return n;
    };
    const theta = num(thetaInput, 'theta_deg');
    const tx = num(txInput, 'tx');
    const ty = num(tyInput, 'ty');
    if (theta && theta.error) return { error: theta.error };
    if (tx && tx.error) return { error: tx.error };
    if (ty && ty.error) return { error: ty.error };
    return { params: { theta_deg: theta, tx, ty, join_note: noteInput.value } };
  }

  const sigOf = (p) => JSON.stringify([p.theta_deg, p.tx, p.ty, p.join_note]);

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  // 预览画布：卡片底板 + 接缝（生成树棕 / 正常成环橙虚 / 超差红虚）+ 陶片。
  function drawPreview(preview) {
    if (disposed) return;
    const { layout, sherds } = preview;
    const cards = computeCards(layout, sherds);
    const byId = new Map(sherds.map((s) => [s.id, s]));
    const violationIds = new Set((preview.violations || []).map((v) => v.seam_id));
    const chainIds = new Set();
    for (const v of preview.violations || []) {
      v.conflict_chain.seams.forEach((s) => chainIds.add(s.id));
    }

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
        const isTree = treeSet.has(sm.id);
        const bad = violationIds.has(sm.id);
        const inChain = chainIds.has(sm.id);
        const pFrom = sherdWorldPose(layout, c, sm.from_id);
        const pTo = sherdWorldPose(layout, c, sm.to_id);
        if (!pFrom || !pTo) continue;
        const mA = sherdMm(byId.get(sm.from_id));
        const mB = sherdMm(byId.get(sm.to_id));
        const aW = applyPose(pFrom, mA.wMm / 2, mA.hMm / 2);
        const bW = applyPose(pTo, mB.wMm / 2, mB.hMm / 2);
        const cA = w2s(aW.x, aW.y);
        const cB = w2s(bW.x, bW.y);
        ctx.save();
        ctx.strokeStyle = bad || inChain ? '#b3392f' : isTree ? '#8a5a2b' : '#b0551f';
        ctx.lineWidth = bad ? 3 : 2;
        if (!isTree) ctx.setLineDash([7, 5]);
        ctx.beginPath();
        ctx.moveTo(cA.x, cA.y);
        ctx.lineTo(cB.x, cB.y);
        ctx.stroke();
        ctx.restore();
        const midX = (cA.x + cB.x) / 2, midY = (cA.y + cB.y) / 2;
        const label = `#${sm.id}${sm.id === seam.id ? ' ✎' : ''}`;
        ctx.font = '600 11px ui-monospace, Menlo, monospace';
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = bad || inChain ? '#b3392f' : (isTree ? '#8a5a2b' : '#b0551f');
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
        const entry = getImage(sh);
        const p = w2s(pose.x, pose.y);
        const scale = zoom / m.ppm;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(pose.theta * DEG);
        ctx.scale(scale, scale);
        if (entry.loaded) ctx.drawImage(entry.img, 0, 0);
        else { ctx.fillStyle = '#ddd4c0'; ctx.fillRect(0, 0, sh.img_w, sh.img_h); }
        ctx.lineWidth = (id === seam.from_id || id === seam.to_id ? 3 : 1.5) / scale;
        ctx.strokeStyle = (id === seam.from_id || id === seam.to_id) ? '#2b6cb0' : 'rgba(60,50,35,.55)';
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
    const tol = preview.project.tolerance_mm;
    posesEl.innerHTML = preview.layout.groups.map((g) => `
      <div style="margin-bottom:8px">
        <b>连通组 · 根 #${g.root_sherd_id}（${g.member_ids.length} 片）</b>
        ${g.member_ids.map((id) => {
          const p = g.poses[id];
          const sh = preview.sherds.find((s) => s.id === id);
          return `<div class="kv">#${id} ${esc(sh ? sh.label : '')}：x=${p.x} mm, y=${p.y} mm, θ=${p.theta}°</div>`;
        }).join('')}
      </div>`).join('') ||
      `<div class="kv">当前接缝不构成连通组（容差 ${tol} mm）。</div>`;
  }

  function renderResiduals(preview) {
    const residuals = preview.layout.residuals || [];
    const violations = preview.violations || [];
    if (!residuals.length) {
      residualsEl.innerHTML = '<div class="kv">本方案当前没有闭合环（接缝不构成环，无闭合残差）。</div>';
      return;
    }
    const seamById = new Map(preview.seams.map((s) => [s.id, s]));
    const rows = residuals.map((r) => {
      const s = seamById.get(r.seam_id);
      return `<div class="seam-row ${r.within_tolerance ? '' : 'active'}" style="border-color:${r.within_tolerance ? 'var(--line)' : 'var(--danger)'}">
        <div>闭合接缝 <b>#${r.seam_id}</b>（#${r.from_id} → #${r.to_id}）${r.seam_id === seam.id ? ' <span class="tag-cycle">本次修订</span>' : ''}</div>
        <div class="residual ${r.within_tolerance ? 'ok' : 'bad'}">
          闭合残差：${r.distance_mm} mm / ${r.rotation_deg}°
          ${r.within_tolerance ? '✔ 容差内' : `✘ 超容差 ${preview.project.tolerance_mm} mm`}
        </div>
      </div>`;
    }).join('');
    const chains = violations.map((v) => `
      <div class="conflict-box" style="margin-top:8px">
        <div><b>超差接缝 #${v.seam_id}</b>（#${v.from_id} → #${v.to_id}）偏差 ${v.deviation_mm} mm / ${v.rotation_deg}°，超容差 ${v.tolerance_mm} mm。</div>
        <div style="margin-top:6px">
          <b>冲突链：</b>
          <div class="chain-seams" style="font-family:ui-monospace,Menlo,monospace;margin:4px 0">
            ${v.conflict_chain.sherds.map((s) => `#${s.id}`).join(' → ')}
            ，沿接缝 ${v.conflict_chain.seams.map((s) => `#${s.id}`).join(' → ') || '（无）'}
            ，由闭合接缝 #${v.seam_id} 成环
          </div>
          <pre>${v.conflict_chain.seams.map((s) => `接缝 #${s.id}  (#${s.from_id}→#${s.to_id})${s.join_note ? `  ${esc(s.join_note)}` : ''}`).join('\n') || '（链上无接缝）'}</pre>
        </div>
      </div>`).join('');
    residualsEl.innerHTML = `<div class="legend" style="padding:0 0 4px">共 ${residuals.length} 个闭合环，超差 ${violations.length} 条</div>${rows}${chains}`;
  }

  async function runPreview() {
    const parsed = readParams();
    if (parsed.error) {
      statusEl.innerHTML = `<span style="color:var(--danger)">⚠ ${esc(parsed.error)}</span>`;
      submitBtn.disabled = true;
      return;
    }
    const seq = ++previewSeq;
    statusEl.innerHTML = '<span class="kv">正在重算预览…</span>';
    try {
      const data = await api.reviseSeamPreview(seam.id, parsed.params);
      if (disposed || seq !== previewSeq) return;
      lastPreview = data;
      lastSig = sigOf(parsed.params);
      drawPreview(data);
      renderResiduals(data);
      renderPoses(data);
      if (data.violations.length) {
        statusEl.innerHTML = `<span style="color:var(--danger);font-weight:600">✘ 预览：${data.violations.length} 条闭合接缝超容差，不能确认修订（方案不会被改动）。</span>`;
        submitBtn.disabled = true;
      } else {
        statusEl.innerHTML = '<span style="color:var(--ok);font-weight:600">✔ 预览：所有闭合环残差在容差内，可确认修订。</span>';
        submitBtn.disabled = false;
      }
    } catch (e) {
      if (disposed || seq !== previewSeq) return;
      statusEl.innerHTML = `<span style="color:var(--danger)">预览失败：${esc(e.message)}</span>`;
      submitBtn.disabled = true;
    }
  }

  function schedulePreview() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runPreview, 250);
  }

  [thetaInput, txInput, tyInput, noteInput].forEach((el) => {
    el.addEventListener('input', () => { submitBtn.disabled = true; schedulePreview(); });
  });
  body.querySelector('#rv-preview-now').onclick = () => { clearTimeout(debounceTimer); runPreview(); };
  body.querySelector('#rv-cancel').onclick = close;

  submitBtn.onclick = async () => {
    const parsed = readParams();
    if (parsed.error) return toast(parsed.error, 'error');
    if (!lastPreview || lastSig !== sigOf(parsed.params)) {
      return toast('参数有改动，请等待最新预览完成后再确认', 'warn');
    }
    if (lastPreview.violations.length) return;
    submitBtn.disabled = true;
    try {
      const next = await api.reviseSeam(seam.id, getVersion(), parsed.params);
      close();
      onApplied(next);
    } catch (e) {
      submitBtn.disabled = false;
      if (e.status === 422 && e.data && e.data.error) {
        // 确认时基于当前版本重算发现超差（多为期间他人已改方案）：不得套用旧预览。
        // 重新拉取基于服务器当前状态的预览，再展示服务器给出的冲突链。
        statusEl.innerHTML = `<span style="color:var(--danger);font-weight:600">✘ ${esc(e.data.error.message)}</span>`;
        const fresh = await api.reviseSeamPreview(seam.id, parsed.params).catch(() => null);
        if (fresh && !disposed) {
          lastPreview = fresh;
          lastSig = sigOf(parsed.params);
          drawPreview(fresh);
          renderResiduals(fresh);
          renderPoses(fresh);
          submitBtn.disabled = true;
        }
      } else {
        onError(e);
      }
    }
  };

  // 关闭时停止防抖，避免向已移除的 DOM 写入。
  const mask = body.closest('.modal-mask');
  const observer = new MutationObserver(() => {
    if (!document.body.contains(mask)) { disposed = true; clearTimeout(debounceTimer); observer.disconnect(); }
  });
  observer.observe(document.getElementById('modal-host'), { childList: true, subtree: true });

  // 初始即按原参数预览一次（布局应与当前读取一致，残差为既有状态）。
  runPreview();
}
