'use strict';

// 端到端冒烟测试：启动服务，走一遍核心业务流。
// node test/smoke.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sherd-smoke-'));
process.env.DB_FILE = path.join(process.env.DATA_DIR, 't.db');
process.env.UPLOAD_DIR = path.join(process.env.DATA_DIR, 'uploads');
process.env.PORT = '8791';

function req(method, url, { body, version, raw } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    let payload;
    if (raw) {
      payload = raw;
      Object.assign(headers, body.getHeaders());
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
    if (version !== undefined) headers['Base-Version'] = String(version);
    const r = http.request({ host: '127.0.0.1', port: process.env.PORT, path: url, method, headers }, (res) => {
      let chunks = '';
      res.on('data', (d) => (chunks += d));
      res.on('end', () => {
        let json = null;
        try { json = chunks ? JSON.parse(chunks) : null; } catch {}
        resolve({ status: res.statusCode, json });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function assert(cond, msg) {
  if (!cond) { console.error('✘', msg); process.exit(1); }
  console.log('✔', msg);
}

function multipart(fields, fileBuf) {
  const boundary = '----smoke' + Math.random().toString(16).slice(2);
  const crlf = '\r\n';
  let head = '';
  for (const [k, v] of Object.entries(fields)) {
    head += `--${boundary}${crlf}Content-Disposition: form-data; name="${k}"${crlf}${crlf}${v}${crlf}`;
  }
  head += `--${boundary}${crlf}Content-Disposition: form-data; name="photo"; filename="a.png"${crlf}Content-Type: image/png${crlf}${crlf}`;
  const tail = `${crlf}--${boundary}--${crlf}`;
  const payload = Buffer.concat([Buffer.from(head), fileBuf, Buffer.from(tail)]);
  return {
    getHeaders() {
      return { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': payload.length };
    },
    payload,
  };
}

async function main() {
  require('../server.js');
  await new Promise((r) => setTimeout(r, 400));

  // 健康检查 + 建表版本
  let r = await req('GET', '/api/health');
  assert(r.status === 200 && r.json.ok, '服务启动 / schema_meta 就绪');

  // 建方案（容差 2mm）
  r = await req('POST', '/api/projects', { body: { name: '冒烟方案', tolerance_mm: 2 } });
  assert(r.status === 201, '创建方案');
  const pid = r.json.project.id;
  let ver = r.json.project.version;
  assert(ver === 1, '初始版本 v1');

  // 造 4 张极小 PNG（1x1 红点），逻辑尺寸按 100x100 上报
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  async function addSherd(label) {
    const form = multipart({ label, img_w: '100', img_h: '100' }, png);
    const rr = await req('POST', `/api/projects/${pid}/sherds`, { version: ver, raw: form.payload, body: form });
    if (rr.status !== 201) throw new Error('上传失败: ' + JSON.stringify(rr.json));
    ver = rr.json.project.version;
    return rr.json.sherds[rr.json.sherds.length - 1].id;
  }
  const a = await addSherd('A');
  const b = await addSherd('B');
  const c = await addSherd('C');
  const d = await addSherd('D');
  assert([a, b, c, d].every((x) => x), '上传 4 片陶片，每次写操作推进版本');

  // 未设比例尺时建接缝 => 400
  r = await req('POST', `/api/projects/${pid}/seams`, { version: ver, body: { from_id: a, to_id: b, theta_deg: 0, tx: 10, ty: 0 } });
  assert(r.status === 400, '未标定比例尺禁止建接缝');

  // 比例尺：100px = 10mm => 10px/mm，每片 10mm×10mm
  for (const id of [a, b, c, d]) {
    r = await req('PATCH', `/api/sherds/${id}/scale`, { version: ver, body: { scale_px: 100, scale_mm: 10 } });
    assert(r.status === 200, `陶片 #${id} 比例尺保存`);
    ver = r.json.project.version;
  }

  // 接缝 A->B：B 相对 A 仅平移 10mm（并排放置）。
  // pB = pA - (10,0) => theta=0, tx=-10, ty=0
  r = await req('POST', `/api/projects/${pid}/seams`, { version: ver, body: { from_id: a, to_id: b, theta_deg: 0, tx: -10, ty: 0, join_note: '口沿 A-B' } });
  assert(r.status === 201, '采纳接缝 A->B');
  ver = r.json.project.version;
  assert(r.json.layout.groups.length === 1, 'A、B 构成一个连通组');
  assert(r.json.layout.unconnected.length === 2, 'C、D 未连通，单独显示');
  const g1 = r.json.layout.groups[0];
  assert(g1.poses[a].x === 0 && g1.poses[b].x === 10, 'B 世界位姿为 x=10mm（与 A 拼接）');

  // B->C 再平移 10
  r = await req('POST', `/api/projects/${pid}/seams`, { version: ver, body: { from_id: b, to_id: c, theta_deg: 0, tx: -10, ty: 0, join_note: '腹部 B-C' } });
  assert(r.status === 201, '采纳接缝 B->C');
  ver = r.json.project.version;
  const seamBCId = r.json.seams[r.json.seams.length - 1].id;
  const g2 = r.json.layout.groups[0];
  assert(g2.poses[c].x === 20, 'C 沿接缝链推导到 x=20mm');
  assert(g2.chains[c].length === 2, 'C 的位置依据为 2 条接缝的链');

  // ---------- 撤销：删除 B->C 后必须断组并重算，不沿用旧布局 ----------
  r = await req('DELETE', `/api/seams/${seamBCId}`, { version: ver });
  assert(r.status === 200, '撤销接缝 B->C');
  ver = r.json.project.version;
  assert(r.json.layout.groups.length === 1 && r.json.layout.groups[0].member_ids.length === 2,
    '撤销后仅剩 A-B 一个连通组');
  assert(r.json.layout.unconnected.sort().join(',') === [c, d].sort().join(','),
    'C、D 变为未连通陶片，单独显示');
  const gAB = r.json.layout.groups[0];
  assert(gAB.poses[b].x === 10, '保留组内 B 仍由接缝 A-B 重新推导为 x=10mm（不持久化布局）');

  // ---------- 重新拼回，再验成环 ----------
  r = await req('POST', `/api/projects/${pid}/seams`, { version: ver, body: { from_id: b, to_id: c, theta_deg: 0, tx: -10, ty: 0, join_note: '腹部 B-C（重新采纳）' } });
  assert(r.status === 201, '重新采纳接缝 B->C');
  ver = r.json.project.version;
  assert(r.json.layout.groups[0].poses[c].x === 20, 'C 再次沿接缝链推导到 x=20mm');

  // 成环且闭合：A->C，平移 -20（偏差 0），应采纳
  r = await req('POST', `/api/projects/${pid}/seams`, { version: ver, body: { from_id: a, to_id: c, theta_deg: 0, tx: -20, ty: 0, join_note: '复核 A-C' } });
  assert(r.status === 201 && r.json.closed_cycle === true, '闭合环且残差为 0：采纳为成环接缝');
  ver = r.json.project.version;
  const resRow = r.json.layout.residuals.find((x) => x.from_id === a && x.to_id === c);
  assert(resRow && resRow.distance_mm === 0 && resRow.within_tolerance, '成环接缝残差 0，在容差内');

  // C->D 平移 10，四片连通
  r = await req('POST', `/api/projects/${pid}/seams`, { version: ver, body: { from_id: c, to_id: d, theta_deg: 0, tx: -10, ty: 0 } });
  assert(r.status === 201, '采纳接缝 C->D，四片连通');
  ver = r.json.project.version;

  // 制造超差成环：B->D 链上期望 tx=-20（D 在 x=30），给 tx=-16 => 偏差 4mm > 2mm
  r = await req('POST', `/api/projects/${pid}/seams`, { version: ver, body: { from_id: b, to_id: d, theta_deg: 0, tx: -16, ty: 0, join_note: '错误试拼 B-D' } });
  assert(r.status === 422, '成环偏差 4mm > 容差 2mm：拒绝（422）');
  assert(r.json.error.conflict_chain, '返回冲突链信息');
  const chain = r.json.error.conflict_chain;
  const chainSeams = chain.seams
    .map((s) => `${s.from_id}>${s.to_id}`)
    .join('|');
  assert(chain.seams.length === 2 && chainSeams === `${b}>${c}|${c}>${d}`,
    `冲突链沿既有接缝 B->C->D（实际：${chainSeams}）`);
  assert(chain.sherds[0].id === b && chain.sherds[chain.sherds.length - 1].id === d,
    '冲突链陶片路径起于 B、止于 D');
  assert(r.json.error.deviation_mm === 4, `偏差报告为 4mm（实际 ${r.json.error.deviation_mm}）`);

  // 拒绝后布局不变：仍 4 条接缝、D 在 30
  r = await req('GET', `/api/projects/${pid}`);
  assert(r.json.seams.length === 4, '拒绝不写入接缝，接缝数仍为 4');
  assert(r.json.project.version === ver, '拒绝不推进版本');
  assert(r.json.layout.groups[0].poses[d].x === 30, '原布局保持（D 在 x=30）');

  // 基于过期版本写入 => 409
  r = await req('PATCH', `/api/projects/${pid}`, { version: ver - 1, body: { tolerance_mm: 3 } });
  assert(r.status === 409, '过期 Base-Version 写入被拒绝（版本冲突）');
  assert(r.json.error.current_version === ver, '冲突响应给出服务器当前版本');

  // 缺少 Base-Version => 428
  r = await req('PATCH', `/api/projects/${pid}`, { body: { tolerance_mm: 3 } });
  assert(r.status === 428, '缺少 Base-Version 被拒绝');

  // ---------- 旋转误差也要被捕获：A->B 再给一个带角度偏差的环 ----------
  // 用 1mm 平移容差已经超了就不测旋转了；这里校验调小容差后原闭合边变红
  r = await req('PATCH', `/api/projects/${pid}`, { version: ver, body: { tolerance_mm: 0.5 } });
  assert(r.status === 200, '用正确版本把容差调到 0.5mm');
  ver = r.json.project.version;
  const acRes = r.json.layout.residuals.find((x) => x.from_id === a && x.to_id === c);
  assert(acRes && acRes.distance_mm === 0 && acRes.within_tolerance, '残差为 0 仍在 0.5mm 容差内');

  // ===================== 接缝修订（预览 + 原子确认） =====================
  // 独立建一个 6 片、含两个独立闭合环的方案，便于同时制造多条超差。
  r = await req('POST', '/api/projects', { body: { name: '修订方案', tolerance_mm: 2 } });
  assert(r.status === 201, '创建修订测试方案');
  const rpid = r.json.project.id;
  let rver = r.json.project.version;
  const s = [];
  for (let i = 0; i < 6; i++) {
    const form = multipart({ label: `R${i}`, img_w: '100', img_h: '100' }, png);
    const rr = await req('POST', `/api/projects/${rpid}/sherds`, { version: rver, raw: form.payload, body: form });
    if (rr.status !== 201) throw new Error('上传失败: ' + JSON.stringify(rr.json));
    rver = rr.json.project.version;
    s.push(rr.json.sherds[rr.json.sherds.length - 1].id);
  }
  for (const id of s) {
    r = await req('PATCH', `/api/sherds/${id}/scale`, { version: rver, body: { scale_px: 100, scale_mm: 10 } });
    assert(r.status === 200, '修订方案比例尺');
    rver = r.json.project.version;
  }
  // 链：0->1->2（成环 0->2，残差 0）；独立链 3->4->5（成环 3->5，残差 0）。
  // 约定 theta=0,tx=-10,ty=0 表示 B 在 A 右侧 10mm。
  async function addSeamR(pair, tx, note) {
    const rr = await req('POST', `/api/projects/${rpid}/seams`,
      { version: rver, body: { from_id: pair[0], to_id: pair[1], theta_deg: 0, tx, ty: 0, join_note: note || '' } });
    if (rr.status !== 201) throw new Error('建接缝失败: ' + JSON.stringify(rr.json));
    rver = rr.json.project.version;
    return rr.json;
  }
  await addSeamR([s[0], s[1]], -10, 'r0-1');
  await addSeamR([s[1], s[2]], -10, 'r1-2');
  const closed1 = await addSeamR([s[0], s[2]], -20, '闭合 r0-2');
  await addSeamR([s[3], s[4]], -10, 'r3-4');
  await addSeamR([s[4], s[5]], -10, 'r4-5');
  const closed2 = await addSeamR([s[3], s[5]], -20, '闭合 r3-5');
  const seam01 = closed1.seams.find((x) => x.from_id === s[0] && x.to_id === s[1]);
  const seam12 = closed1.seams.find((x) => x.from_id === s[1] && x.to_id === s[2]);
  const seam02 = closed1.seams.find((x) => x.from_id === s[0] && x.to_id === s[2]);
  const seam34 = closed2.seams.find((x) => x.from_id === s[3] && x.to_id === s[4]);
  const seam45 = closed2.seams.find((x) => x.from_id === s[4] && x.to_id === s[5]);
  const seam35 = closed2.seams.find((x) => x.from_id === s[3] && x.to_id === s[5]);
  assert(closed1.layout.residuals.some((x) => x.seam_id === seam02.id && x.distance_mm === 0),
    '修订方案环 0-2 初始残差 0');
  assert(closed2.layout.residuals.some((x) => x.seam_id === seam35.id && x.distance_mm === 0),
    '修订方案环 3-5 初始残差 0');

  // 1) 预览：改生成树接缝 0->1 为 tx=-14（下游整体多移 4mm，环 0-2 残差 4mm 超差）。
  r = await req('POST', `/api/seams/${seam01.id}/revision-preview`,
    { body: { theta_deg: 0, tx: -14, ty: 0, join_note: 'r0-1 改' } });
  assert(r.status === 200 && r.json.preview_only === true, '返回修订预览（只读）');
  assert(r.json.seams.find((x) => x.id === seam01.id).tx === -14, '预览中的接缝参数为修订值');
  assert(r.json.seams.map((x) => x.id).join(',') === closed2.seams.map((x) => x.id).join(','),
    '预览接缝 ID 与排序不变');
  assert(r.json.violations.length === 1 && r.json.violations[0].seam_id === seam02.id,
    '预览仅环 0-2 超差（成环接缝为被报告对象）');
  const v02 = r.json.violations[0];
  assert(v02.deviation_mm === 4 && v02.conflict_chain.closing_seam.id === seam02.id,
    `超差 4mm 且闭合接缝为 #${seam02.id}`);
  assert(v02.conflict_chain.seams.map((x) => x.id).join(',') === [seam01.id, seam12.id].join(','),
    '冲突链沿生成树 0->1->2 的树路径（经修订接缝 0-1、1-2）');
  assert(v02.conflict_chain.sherds.map((x) => x.id).join(',') === [s[0], s[1], s[2]].join(','),
    '冲突链陶片路径 0→1→2');
  // 环 3-5 不受影响
  assert(r.json.layout.residuals.find((x) => x.seam_id === seam35.id).distance_mm === 0,
    '另一连通组的环 3-5 残差仍为 0');
  // 预览不改方案
  r = await req('GET', `/api/projects/${rpid}`);
  assert(r.json.project.version === rver, '预览不推进版本');
  assert(r.json.seams.find((x) => x.id === seam01.id).tx === -10, '预览不写入接缝（tx 仍为 -10）');

  // 2) 参数无效 / 接缝不存在
  r = await req('POST', `/api/seams/${seam01.id}/revision-preview`, { body: { theta_deg: 'abc', tx: 0, ty: 0 } });
  assert(r.status === 400, '预览参数非法 => 400');
  r = await req('POST', `/api/seams/999999/revision-preview`, { body: { theta_deg: 0, tx: 0, ty: 0 } });
  assert(r.status === 404, '预览不存在的接缝 => 404');

  // 3) 确认超差修订 => 422，接缝/版本/布局均不变
  r = await req('PATCH', `/api/seams/${seam01.id}`,
    { version: rver, body: { theta_deg: 0, tx: -14, ty: 0, join_note: 'r0-1 改' } });
  assert(r.status === 422, '确认超差修订 => 422 拒绝');
  assert(r.json.error.reason === 'revision_cycle_tolerance_exceeded', '422 带修订拒绝原因');
  assert(r.json.error.violations.length === 1 && r.json.error.violations[0].seam_id === seam02.id,
    '422 返回超差接缝与冲突链');
  r = await req('GET', `/api/projects/${rpid}`);
  assert(r.json.project.version === rver, '422 不推进版本');
  assert(r.json.seams.find((x) => x.id === seam01.id).tx === -10, '422 后原接缝参数不变');
  assert(r.json.layout.groups.find((g) => g.member_ids.includes(s[2])).poses[s[2]].x === 20,
    '422 后布局不变（R2 仍在 x=20）');

  // 4) 缺 Base-Version => 428；过期版本 => 409（不得套用旧预览）
  r = await req('PATCH', `/api/seams/${seam01.id}`, { body: { theta_deg: 0, tx: -11, ty: 0 } });
  assert(r.status === 428, '确认缺少 Base-Version => 428');
  r = await req('PATCH', `/api/seams/${seam01.id}`,
    { version: rver - 1, body: { theta_deg: 0, tx: -11, ty: 0 } });
  assert(r.status === 409, '确认基于过期版本 => 409');
  assert(r.json.error.current_version === rver, '409 给出当前版本');
  r = await req('GET', `/api/projects/${rpid}`);
  assert(r.json.project.version === rver, '428/409 均不改变版本');

  // 5) 容差内修订成功：接缝 ID/排序不变，版本只 +1，读取布局与预览一致
  r = await req('POST', `/api/seams/${seam01.id}/revision-preview`,
    { body: { theta_deg: 0, tx: -11, ty: 0, join_note: 'r0-1 微调' } });
  assert(r.status === 200 && r.json.violations.length === 0, '容差内修订预览无超差');
  const preview = r.json;
  r = await req('PATCH', `/api/seams/${seam01.id}`,
    { version: rver, body: { theta_deg: 0, tx: -11, ty: 0, join_note: 'r0-1 微调' } });
  assert(r.status === 200, '确认容差内修订成功');
  assert(r.json.project.version === rver + 1, '成功后版本只递增一次');
  rver = r.json.project.version;
  const after = r.json;
  assert(after.seams.map((x) => x.id).join(',') === preview.seams.map((x) => x.id).join(','),
    '成功后接缝 ID 与排序不变');
  const updated = after.seams.find((x) => x.id === seam01.id);
  assert(updated.tx === -11 && updated.join_note === 'r0-1 微调', '接缝参数与说明已更新');
  assert(JSON.stringify(after.layout) === JSON.stringify(preview.layout),
    '读取布局与预览完全一致');
  const gA = after.layout.groups.find((gg) => gg.member_ids.includes(s[0]));
  assert(gA.poses[s[1]].x === 11 && gA.poses[s[2]].x === 21, '下游位姿按修订重算（R1=11,R2=21）');
  const res02 = after.layout.residuals.find((x) => x.seam_id === seam02.id);
  assert(res02.distance_mm === 1 && res02.within_tolerance, '环 0-2 残差变为 1mm，在 2mm 容差内');

  // 6) 修订成环接缝本身（0-2 tx=-19 => 预测 R2 在 19，与树推导 21 偏差 2mm，恰在容差内）
  r = await req('PATCH', `/api/seams/${seam02.id}`,
    { version: rver, body: { theta_deg: 0, tx: -19, ty: 0, join_note: '闭合 r0-2 微调' } });
  assert(r.status === 200, '修订成环接缝本身成功');
  rver = r.json.project.version;
  const res02b = r.json.layout.residuals.find((x) => x.seam_id === seam02.id);
  assert(res02b.distance_mm === 2 && res02b.within_tolerance,
    `成环接缝残差随其修订变为 2mm（容差边界内，实际 ${res02b.distance_mm}）`);
  // 生成树身份未变（0-1、1-2 仍是树，0-2 仍是成环边）
  const tree = new Set(r.json.layout.groups.find((gg) => gg.member_ids.includes(s[0])).tree_seam_ids);
  assert(tree.has(seam01.id) && !tree.has(seam02.id), '修订不改变生成树/成环边身份与排序');

  // 7) 同一方案中制造“两个”超差环：先以合规提交把第二组的 3-4 改为 tx=-11
  //    （此时环 3-5 残差 1mm，容差内），再把它进一步改坏并连同第一组一起预览。
  r = await req('PATCH', `/api/seams/${seam34.id}`,
    { version: rver, body: { theta_deg: 0, tx: -11, ty: 0 } });
  assert(r.status === 200, '先把另一组树接缝 3-4 微调到 tx=-11（环 3-5 残差 1mm，仍容差内）');
  rver = r.json.project.version;
  // 3-4 再改到 -13（残差 3mm）单条已超差，确认应 422 且给出环 3-5 冲突链
  r = await req('PATCH', `/api/seams/${seam34.id}`,
    { version: rver, body: { theta_deg: 0, tx: -13, ty: 0 } });
  assert(r.status === 422 && r.json.error.violations.length === 1
    && r.json.error.violations[0].seam_id === seam35.id, '改另一组树接缝 3-4 到 -13 => 仅环 3-5 超差（互不影响）');
  assert(r.json.error.violations[0].conflict_chain.seams.map((x) => x.id).join(',')
    === [seam34.id, seam45.id].join(','), '环 3-5 冲突链沿 3-4、4-5');
  r = await req('GET', `/api/projects/${rpid}`);
  assert(r.json.seams.find((x) => x.id === seam34.id).tx === -11 && r.json.project.version === rver,
    '422 后 3-4 维持 tx=-11、版本不变');

  // 此时方案中：第一组环 0-2 残差 1mm（容差内），第二组环 3-5 残差 1mm（容差内）。
  // 预览把 0-1 改到 -14（环 0-2 变 4mm 超差）：只应报第一组。
  r = await req('POST', `/api/seams/${seam01.id}/revision-preview`,
    { body: { theta_deg: 0, tx: -14, ty: 0 } });
  assert(r.json.violations.length === 1 && r.json.violations[0].seam_id === seam02.id,
    '预览 0-1 改坏：只第一组环 0-2 超差');
  // 预览把 3-4 改到 -14（环 3-5 变 4mm 超差）：只应报第二组（两条环相互独立，不同时出现）。
  r = await req('POST', `/api/seams/${seam34.id}/revision-preview`,
    { body: { theta_deg: 0, tx: -14, ty: 0 } });
  assert(r.json.violations.length === 1 && r.json.violations[0].seam_id === seam35.id,
    '预览 3-4 改坏：只第二组环 3-5 超差');

  // 8) 只改说明（几何不变）：成功且布局、残差完全不变，版本 +1
  const beforeNote = await req('GET', `/api/projects/${rpid}`);
  const layoutBefore = JSON.stringify(beforeNote.json.layout);
  const cur02 = beforeNote.json.seams.find((x) => x.id === seam02.id);
  r = await req('PATCH', `/api/seams/${seam02.id}`,
    { version: rver, body: { theta_deg: cur02.theta_deg, tx: cur02.tx, ty: cur02.ty, join_note: '仅改说明' } });
  assert(r.status === 200, '几何不变、仅改说明可成功');
  rver = r.json.project.version;
  assert(JSON.stringify(r.json.layout) === layoutBefore, '仅改说明后布局与残差不变');
  assert(r.json.seams.find((x) => x.id === seam02.id).join_note === '仅改说明', '说明已更新');
  assert(r.json.seams.length === 6, '全程接缝数保持 6');

  console.log('\n全部冒烟检查通过 ✅');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
