// 比例尺标定弹窗 + 接缝对齐弹窗
import { esc, openModal, toast } from './ui.js';
import { api } from './api.js';
import { DEG, sherdMm } from './geo-client.js';

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

// ---------- 比例尺 ----------
export async function openScaleModal(sherd, version, onSaved) {
  const { body, close } = openModal({ title: `标记毫米比例尺 — ${sherd.label} #${sherd.id}` });
  body.innerHTML = `
    <p class="align-hint">在图上拖出一段对应已知长度的线段（例如比例尺上 10 mm），然后填入实际毫米数。</p>
    <canvas class="scale-canvas" id="scale-cv"></canvas>
    <div class="row" style="margin-top:12px">
      <label class="field">线段像素长度
        <input type="number" id="scale-px" min="1" step="0.1" value="${sherd.scale_px ?? ''}" />
      </label>
      <label class="field">对应毫米长度
        <input type="number" id="scale-mm" min="0.1" step="0.1" value="${sherd.scale_mm ?? '10'}" />
      </label>
    </div>
    <div class="actions">
      <button class="secondary" id="scale-cancel">取消</button>
      <button id="scale-save">保存比例尺</button>
    </div>`;

  const cv = body.querySelector('#scale-cv');
  const ctx = cv.getContext('2d');
  const img = await loadImage(sherd.image_url);

  // 显示缩放：图过大时等比缩小显示，但保存的是原始像素距离
  const maxW = Math.min(820, window.innerWidth - 120);
  const dispScale = img.width > maxW ? maxW / img.width : 1;
  cv.width = Math.round(img.width * dispScale);
  cv.height = Math.round(img.height * dispScale);

  let p1 = null, p2 = null, dragging = false;
  const pxInput = body.querySelector('#scale-px');

  function draw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    if (sherd.scale_px && !p1 && !p2) {
      // 回显已有比例尺：画一条示意横线
      ctx.strokeStyle = '#3f7d4e';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(20, 30);
      ctx.lineTo(20 + sherd.scale_px * dispScale, 30);
      ctx.stroke();
      ctx.fillStyle = '#3f7d4e';
      ctx.font = '13px sans-serif';
      ctx.fillText(`已有：${sherd.scale_px}px = ${sherd.scale_mm}mm`, 20, 22);
    }
    if (p1 && p2) {
      ctx.strokeStyle = '#b3392f';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
      for (const p of [p1, p2]) {
        ctx.fillStyle = '#b3392f';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  draw();

  const pos = (e) => {
    const r = cv.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  cv.addEventListener('mousedown', (e) => { p1 = pos(e); p2 = { ...p1 }; dragging = true; draw(); });
  cv.addEventListener('mousemove', (e) => { if (dragging) { p2 = pos(e); const d = Math.hypot(p2.x - p1.x, p2.y - p1.y) / dispScale; pxInput.value = d.toFixed(2); draw(); } });
  window.addEventListener('mouseup', function up() {
    if (dragging) { dragging = false; }
    window.removeEventListener('mouseup', up);
  });
  pxInput.addEventListener('input', () => { if (!dragging) { p1 = null; p2 = null; draw(); } });

  body.querySelector('#scale-cancel').onclick = close;
  body.querySelector('#scale-save').onclick = async () => {
    const px = parseFloat(pxInput.value);
    const mm = parseFloat(body.querySelector('#scale-mm').value);
    if (!(px > 0) || !(mm > 0)) return toast('请先在图上拖出线段并填写毫米长度', 'error');
    try {
      const state = await api.setScale(sherd.id, version, px, mm);
      toast('比例尺已保存', 'success');
      close();
      onSaved(state);
    } catch (e) {
      toast(e.message, 'error');
    }
  };
}

// ---------- 接缝对齐 ----------
// A=from 固定（淡显），B=to 可移动/旋转（不透明）。
// 输出接缝 T: pB(局部mm) = R(theta)*pA(局部mm) + (tx,ty)
export async function openAlignModal(sherdA, sherdB, version, onSubmit) {
  if (!sherdA.scale_px || !sherdB.scale_px) {
    return toast('两片陶片都必须先设定毫米比例尺', 'error');
  }
  const { body, close } = openModal({ wide: true, title: `新建接缝：${sherdA.label} #${sherdA.id} → ${sherdB.label} #${sherdB.id}` });
  body.innerHTML = `
    <p class="align-hint">A 片（参考，淡色）固定；拖动 B 片、旋转 B 片使断口吻合。所有位置以<b>毫米</b>计。</p>
    <canvas class="align-canvas" id="align-cv" width="840" height="520"></canvas>
    <div class="row" style="margin-top:10px">
      <label class="field">B 旋转角 (°)
        <input type="number" id="al-theta" step="0.1" value="0" />
      </label>
      <label class="field">平移 tx (mm)
        <input type="number" id="al-tx" step="0.1" value="0" disabled />
      </label>
      <label class="field">平移 ty (mm)
        <input type="number" id="al-ty" step="0.1" value="0" disabled />
      </label>
      <button class="secondary" id="al-reset">复位</button>
    </div>
    <div class="row">
      <label class="field" style="flex:1">接缝说明（断口位置、走向、吻合特征……）
        <input type="text" id="al-note" maxlength="2000" placeholder="例如：A 右侧口沿与 B 左侧口沿绳纹连续" />
      </label>
    </div>
    <div class="actions">
      <button class="secondary" id="al-cancel">取消</button>
      <button id="al-submit">采纳接缝</button>
    </div>`;

  const cv = body.querySelector('#align-cv');
  const ctx = cv.getContext('2d');
  const [imgA, imgB] = await Promise.all([loadImage(sherdA.image_url), loadImage(sherdB.image_url)]);

  const mA = sherdMm(sherdA);
  const mB = sherdMm(sherdB);

  // 显示缩放：让两片+位移空间放入画布
  const s = Math.min((cv.width * 0.8) / (mA.wMm + mB.wMm), (cv.height * 0.8) / Math.max(mA.hMm, mB.hMm));
  const pxPerMm = s;

  // 对齐画布中 A、B 共享一个“对齐坐标(mm)”：A 固定不动
  const A = { x: cv.width / pxPerMm / 2 - mA.wMm - 5, y: cv.height / pxPerMm / 2 - mA.hMm / 2, theta: 0 };
  const B = { x: A.x + mA.wMm + 10, y: A.y, theta: 0 };

  const thetaInput = body.querySelector('#al-theta');
  const txInput = body.querySelector('#al-tx');
  const tyInput = body.querySelector('#al-ty');

  // T: pB = R(theta) pA_local + t。
  // 同一点在对齐坐标中：A(pA)=B(pB) => pB = B^-1 A pA，
  // 因而 theta = thetaA - thetaB = -B.theta，t = R(-B.theta)*(A.pos - B.pos)
  function seamParams() {
    const theta = -B.theta;
    const th = theta * DEG;
    const dx = A.x - B.x, dy = A.y - B.y;
    const c = Math.cos(th), si = Math.sin(th);
    return { theta_deg: Math.round(((theta % 360) + 360) % 360 * 1000) / 1000,
      tx: Math.round((c * dx - si * dy) * 1000) / 1000,
      ty: Math.round((si * dx + c * dy) * 1000) / 1000 };
  }

  function drawSherd(img, m, pose, alpha, label) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(pose.x * pxPerMm, pose.y * pxPerMm);
    ctx.rotate(pose.theta * DEG);
    ctx.scale(pxPerMm / m.ppm, pxPerMm / m.ppm);
    ctx.drawImage(img, 0, 0);
    // 局部原点标记
    ctx.scale(m.ppm / pxPerMm, m.ppm / pxPerMm);
    ctx.strokeStyle = 'rgba(43,108,176,.9)';
    ctx.lineWidth = 1.5 / pxPerMm;
    ctx.strokeRect(0, 0, m.wMm, m.hMm);
    ctx.fillStyle = 'rgba(43,108,176,.9)';
    ctx.beginPath();
    ctx.arc(0, 0, 2 / pxPerMm, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = Math.min(1, alpha + 0.25);
    ctx.fillStyle = '#2e2a24';
    ctx.font = '13px sans-serif';
    ctx.fillText(label, pose.x * pxPerMm + 4, pose.y * pxPerMm - 6);
    ctx.restore();
  }

  function draw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    drawSherd(imgA, mA, A, 0.45, `A · ${esc(sherdA.label)}`);
    drawSherd(imgB, mB, B, 1, `B · ${esc(sherdB.label)}`);
    const t = seamParams();
    txInput.value = t.tx;
    tyInput.value = t.ty;
  }
  draw();

  let drag = null;
  function localHitB(e) {
    const r = cv.getBoundingClientRect();
    const mx = (e.clientX - r.left) / pxPerMm;
    const my = (e.clientY - r.top) / pxPerMm;
    const dx = mx - B.x, dy = my - B.y;
    const th = -B.theta * DEG;
    const c = Math.cos(th), si = Math.sin(th);
    const lx = c * dx - si * dy;
    const ly = si * dx + c * dy;
    return lx >= 0 && ly >= 0 && lx <= mB.wMm && ly <= mB.hMm;
  }
  cv.addEventListener('mousedown', (e) => {
    if (!localHitB(e)) return;
    const r = cv.getBoundingClientRect();
    drag = { x: e.clientX - r.left, y: e.clientY - r.top, bx: B.x, by: B.y };
  });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const r = cv.getBoundingClientRect();
    B.x = drag.bx + (e.clientX - r.left - drag.x) / pxPerMm;
    B.y = drag.by + (e.clientY - r.top - drag.y) / pxPerMm;
    draw();
  });
  window.addEventListener('mouseup', () => { drag = null; });

  // 以 B 自身中心为支点旋转
  function rotateB(thetaDeg) {
    const cx = B.x + mB.wMm / 2;
    const cy = B.y + mB.hMm / 2;
    const old = B.theta;
    B.theta = thetaDeg;
    const th = (old - thetaDeg) * DEG;
    const c = Math.cos(th), si = Math.sin(th);
    const dx = B.x - cx, dy = B.y - cy;
    B.x = cx + c * dx - si * dy;
    B.y = cy + si * dx + c * dy;
    draw();
  }
  thetaInput.addEventListener('change', () => {
    const v = parseFloat(thetaInput.value);
    if (Number.isFinite(v)) rotateB(v);
  });
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    rotateB(B.theta + (e.deltaY > 0 ? -2 : 2));
    thetaInput.value = Math.round(B.theta * 10) / 10;
  }, { passive: false });

  body.querySelector('#al-reset').onclick = () => {
    B.x = A.x + mA.wMm + 10; B.y = A.y; B.theta = 0;
    thetaInput.value = 0;
    draw();
  };
  body.querySelector('#al-cancel').onclick = close;
  body.querySelector('#al-submit').onclick = async () => {
    const t = seamParams();
    const note = body.querySelector('#al-note').value;
    await onSubmit({
      from_id: sherdA.id, to_id: sherdB.id,
      theta_deg: t.theta_deg, tx: t.tx, ty: t.ty, join_note: note,
    }, close);
  };
}
