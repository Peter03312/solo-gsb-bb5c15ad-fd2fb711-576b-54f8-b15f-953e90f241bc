'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');

const crypto = require('crypto');
const { openDb } = require('./src/db');
const layout = require('./src/layout');

const PORT = parseInt(process.env.PORT || '8080', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'workbench.db');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(DATA_DIR, 'uploads');
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || '20', 10);

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = openDb(DB_FILE);
db.prepare("INSERT OR IGNORE INTO schema_meta(key, value) VALUES ('schema_version', '1')").run();

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function num(v, field, { min, max, allowNull = false } = {}) {
  if (v === null || v === undefined || v === '') {
    if (allowNull) return null;
    throw new HttpError(400, `缺少参数 ${field}`);
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw new HttpError(400, `${field} 必须是数字`);
  if (min !== undefined && n < min) throw new HttpError(400, `${field} 不能小于 ${min}`);
  if (max !== undefined && n > max) throw new HttpError(400, `${field} 不能大于 ${max}`);
  return n;
}

function str(v, field, { max = 2000, required = true } = {}) {
  if (v === undefined || v === null) {
    if (required) throw new HttpError(400, `缺少参数 ${field}`);
    return '';
  }
  const s = String(v);
  if (s.length > max) throw new HttpError(400, `${field} 过长（最多 ${max} 字符）`);
  return s;
}

function getProjectOr404(id) {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!p) throw new HttpError(404, '方案不存在');
  return p;
}

// 解析接缝修订入参（旋转角、毫米平移、说明）。
// 说明缺省时沿用原接缝说明；身份（from/to）与排序（id）不接受修改。
function parseRevisionBody(body, seam) {
  const theta = num(body.theta_deg, 'theta_deg', { min: -360, max: 360 });
  const tx = num(body.tx, 'tx', { min: -100000, max: 100000 });
  const ty = num(body.ty, 'ty', { min: -100000, max: 100000 });
  const joinNote = body.join_note === undefined
    ? seam.join_note
    : str(body.join_note, 'join_note', { max: 2000, required: false });
  return { theta_deg: theta, tx, ty, join_note: joinNote };
}

// 把布局引擎算出的超差闭合环整理为对外错误体：逐条超差接缝 + 冲突链。
// 用“修订后”的接缝集合标注说明，使冲突链与预览所见一致。
function buildRevisionViolations(result, sherds, toleranceMm) {
  const seamsById = new Map(result.revised_seams.map((s) => [s.id, s]));
  const sherdById = new Map(sherds.map((s) => [s.id, s]));
  return result.violations.map((v) => ({
    reason: 'cycle_tolerance_exceeded',
    seam_id: v.seam_id,
    from_id: v.from_id,
    to_id: v.to_id,
    deviation_mm: v.distance_mm,
    rotation_deg: v.rotation_deg,
    tolerance_mm: toleranceMm,
    conflict_chain: {
      sherds: v.conflict_chain.sherd_path.map((id) => ({ id, label: sherdById.get(id).label })),
      seams: v.conflict_chain.seam_path.map((sid) => {
        const se = seamsById.get(sid);
        return { id: sid, from_id: se.from_id, to_id: se.to_id, join_note: se.join_note };
      }),
      closing_seam: { id: v.seam_id, from_id: v.from_id, to_id: v.to_id },
    },
  }));
}

// ---------- 批量试拼（候选接缝一批：先只读试算，后单事务确认）----------

const BATCH_MAX_CANDIDATES = 100;

// 解析一批候选接缝入参并做全部前置校验（陶片属于本方案、已标比例尺、
// 不得连接同一片、参数合法）。任何一条不合法都整批拒绝（400），
// errors[] 按候选填写序号（1 起）逐条给出原因；不改动任何状态。
function parseBatchCandidates(body, pid) {
  const raw = body && body.candidates;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HttpError(400, 'candidates 必须是非空数组（至少一条候选接缝）');
  }
  if (raw.length > BATCH_MAX_CANDIDATES) {
    throw new HttpError(400, `每批最多 ${BATCH_MAX_CANDIDATES} 条候选接缝`);
  }
  const sherdRows = db.prepare('SELECT * FROM sherds WHERE project_id = ?').all(pid);
  const sherdById = new Map(sherdRows.map((s) => [s.id, s]));

  const errors = [];
  const numField = (v, field, lo, hi) => {
    if (v === null || v === undefined || v === '') return { error: `缺少参数 ${field}` };
    const n = Number(v);
    if (!Number.isFinite(n)) return { error: `${field} 必须是数字` };
    if (n < lo || n > hi) return { error: `${field} 超出允许范围（${lo} ~ ${hi}）` };
    return { value: n };
  };

  const candidates = raw.map((item, i) => {
    const idx = i + 1;
    const itemErrors = [];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push({ index: idx, message: '候选必须是对象' });
      return null;
    }
    const fromR = numField(item.from_id, `from_id`, 1, Number.MAX_SAFE_INTEGER);
    const toR = numField(item.to_id, `to_id`, 1, Number.MAX_SAFE_INTEGER);
    const thetaR = numField(item.theta_deg, `theta_deg`, -360, 360);
    const txR = numField(item.tx, `tx`, -100000, 100000);
    const tyR = numField(item.ty, `ty`, -100000, 100000);
    if (fromR.error) itemErrors.push(fromR.error);
    if (toR.error) itemErrors.push(toR.error);
    if (thetaR.error) itemErrors.push(thetaR.error);
    if (txR.error) itemErrors.push(txR.error);
    if (tyR.error) itemErrors.push(tyR.error);
    let note = '';
    if (item.join_note !== undefined && item.join_note !== null) {
      const ns = String(item.join_note);
      if (ns.length > 2000) itemErrors.push('join_note 过长（最多 2000 字符）');
      else note = ns;
    }
    if (!fromR.error && !toR.error && fromR.value === toR.value) {
      itemErrors.push('接缝必须连接两片不同的陶片');
    }
    if (!fromR.error && !toR.error) {
      const from = sherdById.get(fromR.value);
      const to = sherdById.get(toR.value);
      if (!from || !to) itemErrors.push('接缝两端的陶片不属于该方案或不存在');
      else if (!from.scale_px || !from.scale_mm || !to.scale_px || !to.scale_mm) {
        itemErrors.push('两片陶片都必须先标记毫米比例尺，才能建立接缝');
      }
    }
    if (itemErrors.length) {
      itemErrors.forEach((message) => errors.push({ index: idx, message }));
      return null;
    }
    return {
      from_id: fromR.value, to_id: toR.value,
      theta_deg: thetaR.value, tx: txR.value, ty: tyR.value, join_note: note,
    };
  });

  if (errors.length) {
    throw new HttpError(400, `批次中有 ${errors.length} 条候选接缝不合法，整批不予试算`, {
      reason: 'batch_invalid_candidates',
      errors: errors.sort((a, b) => a.index - b.index),
    });
  }
  return { candidates, sherds: sherdRows };
}

// 同一批内容的指纹：确认时必须原样回传，服务器据此拒绝“批内容被改动”的确认，
// 强制“确认使用与试算完全相同的一批内容”。指纹只刻画批内容本身；
// “试算所基于的方案版本是否已变化”由 Base-Version 头与事务内版本复核负责（409）。
function batchFingerprint(candidates) {
  const norm = candidates.map((c) => [c.from_id, c.to_id, c.theta_deg, c.tx, c.ty, c.join_note || '']);
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ c: norm }))
    .digest('hex');
}

// 把试算出的超差闭合环整理为对外结构：指出候选序号、偏差与冲突链。
function buildBatchViolations(result, sherds, toleranceMm) {
  const seamsById = new Map(result.all_seams.map((s) => [s.id, s]));
  const sherdById = new Map(sherds.map((s) => [s.id, s]));
  return result.violations.map((v) => ({
    reason: 'cycle_tolerance_exceeded',
    candidate_index: (v.candidate_index ?? 0) + 1, // 对外序号 1 起
    seam_id: v.seam_id < 0 ? null : v.seam_id,
    virtual_seam_id: v.seam_id,
    from_id: v.from_id,
    to_id: v.to_id,
    deviation_mm: v.distance_mm,
    rotation_deg: v.rotation_deg,
    tolerance_mm: toleranceMm,
    conflict_chain: {
      sherds: v.conflict_chain.sherd_path.map((id) => ({ id, label: sherdById.get(id).label })),
      seams: v.conflict_chain.seam_path.map((sid) => {
        const se = seamsById.get(sid);
        return {
          id: se.id < 0 ? null : se.id,
          candidate_index: Number.isInteger(se.candidate_index) ? se.candidate_index + 1 : null,
          virtual_seam_id: se.id,
          from_id: se.from_id,
          to_id: se.to_id,
          join_note: se.join_note,
        };
      }),
      closing_seam: {
        id: v.seam_id < 0 ? null : v.seam_id,
        candidate_index: (v.candidate_index ?? 0) + 1,
        virtual_seam_id: v.seam_id,
        from_id: v.from_id,
        to_id: v.to_id,
      },
    },
  }));
}

// 试算返回体：与 GET /api/projects/:id 同构，但 seams 为“既有接缝 + 候选虚拟接缝”
// （候选 id 为负、带 candidate_index），layout 为整批加入后的现算结果。
function batchPayload(project, sherds, result, toleranceMm, { previewOnly }) {
  const fakeState = { project, sherds, seams: result.all_seams, computed: result.layout };
  const payload = statePayload(fakeState);
  payload.seams = result.all_seams.map((s) => ({
    id: s.id < 0 ? null : s.id,
    virtual_seam_id: s.id,
    candidate_index: Number.isInteger(s.candidate_index) ? s.candidate_index + 1 : null,
    from_id: s.from_id,
    to_id: s.to_id,
    theta_deg: s.theta_deg,
    tx: s.tx,
    ty: s.ty,
    join_note: s.join_note,
    created_at: s.created_at,
  }));
  payload.batch_trial = true;
  payload.preview_only = !!previewOnly;
  payload.base_version = project.version;
  payload.candidate_results = result.candidate_results.map((r) => ({
    index: r.index + 1,
    virtual_seam_id: r.virtual_id,
    from_id: r.from_id,
    to_id: r.to_id,
    role: r.role, // tree：生成树接缝（决定布局）；cycle：成环接缝（仅闭合校验）
  }));
  payload.violations = buildBatchViolations(result, sherds, toleranceMm);
  return payload;
}

// 所有写操作必须携带 Base-Version 头；与库中版本不一致即冲突，拒绝写入。
function checkVersion(req, project) {
  const raw = req.header('Base-Version');
  if (raw === undefined || raw === null || raw === '') {
    throw new HttpError(428, '缺少 Base-Version，请先刷新方案数据');
  }
  const base = parseInt(raw, 10);
  if (!Number.isInteger(base)) throw new HttpError(400, 'Base-Version 必须是整数');
  if (base !== project.version) {
    throw new HttpError(409, '版本冲突：方案已被其他人修改，请刷新后基于最新版本重试', {
      current_version: project.version,
      your_version: base,
    });
  }
}

const bump = (pid) => {
  db.prepare("UPDATE projects SET version = version + 1, updated_at = datetime('now') WHERE id = ?").run(pid);
};

function loadState(projectId) {
  const project = getProjectOr404(projectId);
  const sherds = db
    .prepare('SELECT * FROM sherds WHERE project_id = ? ORDER BY id')
    .all(projectId);
  const seams = db
    .prepare('SELECT * FROM seams WHERE project_id = ? ORDER BY id')
    .all(projectId);
  const computed = layout.computeLayout(sherds, seams, project.tolerance_mm);
  return { project, sherds, seams, computed };
}

function statePayload(state) {
  return {
    project: {
      id: state.project.id,
      name: state.project.name,
      tolerance_mm: state.project.tolerance_mm,
      version: state.project.version,
      updated_at: state.project.updated_at,
    },
    sherds: state.sherds.map((s) => ({
      id: s.id,
      label: s.label,
      image_url: `/api/sherds/${s.id}/image`,
      img_w: s.img_w,
      img_h: s.img_h,
      scale_px: s.scale_px,
      scale_mm: s.scale_mm,
      note: s.note,
    })),
    seams: state.seams.map((s) => ({
      id: s.id,
      from_id: s.from_id,
      to_id: s.to_id,
      theta_deg: s.theta_deg,
      tx: s.tx,
      ty: s.ty,
      join_note: s.join_note,
      created_at: s.created_at,
    })),
    layout: state.computed,
  };
}

// 接缝修订（预览/确认共用）的返回体：保持与 statePayload 相同的接缝读取契约，
// 但接缝列表为“按原 id 与排序替换参数后”的假设集合，layout 为相应重算结果。
// 预览时该结果不入库；确认成功后 GET /api/projects/:id 与之一致。
function revisionPayload(project, sherds, result, seamId) {
  const fakeState = { project, sherds, seams: result.revised_seams, computed: result.layout };
  const payload = statePayload(fakeState);
  payload.base_version = project.version;
  payload.revised_seam_id = seamId;
  return payload;
}

const ALLOWED_EXT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_req, file, cb) => {
    const ext = (path.extname(file.originalname) || '').toLowerCase();
    const safe = ALLOWED_EXT[ext] ? ext : '.img';
    cb(null, `sherd_${Date.now()}_${Math.round(Math.random() * 1e9)}${safe}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = (path.extname(file.originalname) || '').toLowerCase();
    if (!ALLOWED_EXT[ext]) return cb(new HttpError(400, '仅支持 JPG / PNG / WebP 图片'));
    cb(null, true);
  },
});

function deleteImageFile(file) {
  if (!file) return;
  fs.unlink(path.join(UPLOAD_DIR, path.basename(file)), () => {});
}

// ---------- API: 方案 ----------

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, db: db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() });
});

app.get('/api/projects', wrap((_req, res) => {
  const rows = db.prepare('SELECT id, name, tolerance_mm, version, updated_at FROM projects ORDER BY id').all();
  res.json({ projects: rows });
}));

app.post('/api/projects', wrap((req, res) => {
  const name = str(req.body && req.body.name, 'name').trim() || '未命名方案';
  const tolerance = num(req.body && req.body.tolerance_mm, 'tolerance_mm', { min: 0.01, max: 10000 });
  const info = db
    .prepare('INSERT INTO projects(name, tolerance_mm) VALUES (?, ?)')
    .run(name, tolerance);
  const state = loadState(info.lastInsertRowid);
  res.status(201).json(statePayload(state));
}));

app.get('/api/projects/:id', wrap((req, res) => {
  res.json(statePayload(loadState(num(req.params.id, 'id'))));
}));

app.patch('/api/projects/:id', wrap((req, res) => {
  const pid = num(req.params.id, 'id');
  const project = getProjectOr404(pid);
  checkVersion(req, project);
  const body = req.body || {};
  const name = body.name !== undefined ? str(body.name, 'name').trim() || project.name : project.name;
  const tolerance = body.tolerance_mm !== undefined
    ? num(body.tolerance_mm, 'tolerance_mm', { min: 0.01, max: 10000 })
    : project.tolerance_mm;

  const txn = db.transaction(() => {
    db.prepare('UPDATE projects SET name = ?, tolerance_mm = ? WHERE id = ?').run(name, tolerance, pid);
    bump(pid);
  });
  txn();
  res.json(statePayload(loadState(pid)));
}));

app.delete('/api/projects/:id', wrap((req, res) => {
  const pid = num(req.params.id, 'id');
  const project = getProjectOr404(pid);
  checkVersion(req, project);
  const files = db.prepare('SELECT image_file FROM sherds WHERE project_id = ?').all(pid).map((r) => r.image_file);
  const txn = db.transaction(() => {
    db.prepare('DELETE FROM projects WHERE id = ?').run(pid);
  });
  txn();
  files.forEach(deleteImageFile);
  res.status(204).end();
}));

// ---------- API: 陶片 ----------

app.post('/api/projects/:id/sherds', (req, res, next) => {
  upload.single('photo')(req, res, (err) => {
    if (err) return next(err);
    handleSherdUpload(req, res, next);
  });
});

const handleSherdUpload = wrap(async (req, res) => {
  const pid = num(req.params.id, 'id');
  const project = getProjectOr404(pid);
  checkVersion(req, project);
  if (!req.file) throw new HttpError(400, '缺少照片文件 photo');

  const imgW = num(req.body.img_w, 'img_w', { min: 1, max: 20000 });
  const imgH = num(req.body.img_h, 'img_h', { min: 1, max: 20000 });
  const label = (str(req.body.label, 'label', { required: false }) || '').trim() || `陶片 ${Date.now() % 100000}`;
  const note = str(req.body.note, 'note', { max: 2000, required: false });

  const txn = db.transaction(() => {
    const info = db
      .prepare('INSERT INTO sherds(project_id, label, image_file, img_w, img_h, note) VALUES (?,?,?,?,?,?)')
      .run(pid, label, req.file.filename, imgW, imgH, note);
    bump(pid);
    return info.lastInsertRowid;
  });

  try {
    txn();
  } catch (e) {
    deleteImageFile(req.file.filename);
    throw e;
  }
  res.status(201).json(statePayload(loadState(pid)));
});

app.patch('/api/sherds/:id/scale', wrap((req, res) => {
  const sherd = db.prepare('SELECT * FROM sherds WHERE id = ?').get(num(req.params.id, 'id'));
  if (!sherd) throw new HttpError(404, '陶片不存在');
  const project = getProjectOr404(sherd.project_id);
  checkVersion(req, project);

  const scalePx = num(req.body && req.body.scale_px, 'scale_px', { min: 0.001, max: 100000 });
  const scaleMm = num(req.body && req.body.scale_mm, 'scale_mm', { min: 0.001, max: 100000 });

  const txn = db.transaction(() => {
    db.prepare('UPDATE sherds SET scale_px = ?, scale_mm = ? WHERE id = ?').run(scalePx, scaleMm, sherd.id);
    bump(sherd.project_id);
  });
  txn();
  res.json(statePayload(loadState(sherd.project_id)));
}));

app.delete('/api/sherds/:id', wrap((req, res) => {
  const sherd = db.prepare('SELECT * FROM sherds WHERE id = ?').get(num(req.params.id, 'id'));
  if (!sherd) throw new HttpError(404, '陶片不存在');
  const project = getProjectOr404(sherd.project_id);
  checkVersion(req, project);
  const txn = db.transaction(() => {
    db.prepare('DELETE FROM sherds WHERE id = ?').run(sherd.id);
    bump(sherd.project_id);
  });
  txn();
  deleteImageFile(sherd.image_file);
  res.status(204).end();
}));

app.get('/api/sherds/:id/image', wrap((req, res) => {
  const sherd = db.prepare('SELECT image_file FROM sherds WHERE id = ?').get(num(req.params.id, 'id'));
  if (!sherd) throw new HttpError(404, '陶片不存在');
  const file = path.join(UPLOAD_DIR, path.basename(sherd.image_file));
  if (!fs.existsSync(file)) throw new HttpError(404, '图片文件缺失');
  res.sendFile(file);
}));

// ---------- API: 接缝 ----------

app.post('/api/projects/:id/seams', wrap((req, res) => {
  const pid = num(req.params.id, 'id');
  const project = getProjectOr404(pid);
  checkVersion(req, project);
  const body = req.body || {};

  const fromId = num(body.from_id, 'from_id', { min: 1 });
  const toId = num(body.to_id, 'to_id', { min: 1 });
  if (fromId === toId) throw new HttpError(400, '接缝必须连接两片不同的陶片');
  const theta = num(body.theta_deg, 'theta_deg', { min: -360, max: 360 });
  const tx = num(body.tx, 'tx', { min: -100000, max: 100000 });
  const ty = num(body.ty, 'ty', { min: -100000, max: 100000 });
  const joinNote = str(body.join_note, 'join_note', { max: 2000, required: false });

  const from = db.prepare('SELECT * FROM sherds WHERE id = ? AND project_id = ?').get(fromId, pid);
  const to = db.prepare('SELECT * FROM sherds WHERE id = ? AND project_id = ?').get(toId, pid);
  if (!from || !to) throw new HttpError(400, '接缝两端的陶片不属于该方案或不存在');
  if (!from.scale_px || !to.scale_px) {
    throw new HttpError(400, '两片陶片都必须先标记毫米比例尺，才能建立接缝');
  }

  // 接缝参数以 to 系表达（p_to = R(theta)*p_from + t），前端提交 from->to
  const candidate = { from_id: fromId, to_id: toId, theta_deg: theta, tx, ty };
  const sherds = db.prepare('SELECT * FROM sherds WHERE project_id = ?').all(pid);
  const seams = db.prepare('SELECT * FROM seams WHERE project_id = ?').all(pid);
  const check = layout.evaluateNewSeam(sherds, seams, candidate, project.tolerance_mm);

  if (check.closes_cycle && !check.acceptable) {
    // 成环且超差：拒绝采纳，返回冲突链，布局保持不变（本次未写入）。
    const seamsById = new Map(seams.map((s) => [s.id, s]));
    const sherdById = new Map(sherds.map((s) => [s.id, s]));
    const conflict = {
      reason: 'cycle_tolerance_exceeded',
      message:
        `新接缝形成闭合环，但沿该接缝推算的位置与现有布局偏差 ` +
        `${check.distance_mm} mm（角度差 ${check.rotation_deg}°），超过容差 ` +
        `${check.tolerance_mm} mm。已拒绝采纳，原布局保持不变。`,
      deviation_mm: check.distance_mm,
      rotation_deg: check.rotation_deg,
      tolerance_mm: check.tolerance_mm,
      conflict_chain: {
        sherds: check.conflict_chain.sherd_path.map((id) => ({ id, label: sherdById.get(id).label })),
        seams: check.conflict_chain.seam_path.map((sid) => ({
          id: sid,
          from_id: seamsById.get(sid).from_id,
          to_id: seamsById.get(sid).to_id,
          join_note: seamsById.get(sid).join_note,
        })),
        new_seam: { from_id: fromId, to_id: toId },
      },
    };
    return res.status(422).json({ error: conflict });
  }

  const txn = db.transaction(() => {
    db.prepare(
      'INSERT INTO seams(project_id, from_id, to_id, theta_deg, tx, ty, join_note) VALUES (?,?,?,?,?,?,?)'
    ).run(pid, fromId, toId, theta, tx, ty, joinNote);
    bump(pid);
  });
  txn();

  const state = loadState(pid);
  if (check.closes_cycle) {
    return res.status(201).json({ ...statePayload(state), closed_cycle: true, cycle_residual: {
      distance_mm: check.distance_mm, rotation_deg: check.rotation_deg,
      within_tolerance: true,
    } });
  }
  res.status(201).json(statePayload(state));
}));

app.delete('/api/seams/:id', wrap((req, res) => {
  const seam = db.prepare('SELECT * FROM seams WHERE id = ?').get(num(req.params.id, 'id'));
  if (!seam) throw new HttpError(404, '接缝不存在');
  const project = getProjectOr404(seam.project_id);
  checkVersion(req, project);
  // 删除即重算：布局从不持久化，下次 loadState 由剩余接缝重新推导，
  // 不可能沿用依赖被删接缝的失效位姿。
  const txn = db.transaction(() => {
    db.prepare('DELETE FROM seams WHERE id = ?').run(seam.id);
    bump(seam.project_id);
  });
  txn();
  res.json(statePayload(loadState(seam.project_id)));
}));

// ---------- 接缝修订（已采纳接缝改旋转角/毫米平移/说明）----------
//
// 两步：
//   POST .../seams/:id/revision-preview  只读预览（不校验/不要求 Base-Version，不改动方案）
//   PATCH /api/seams/:id                 确认修订（必须带当前 Base-Version）
//
// 预览与确认都用 layout.evaluateSeamRevision：保持接缝 id 与采纳排序不变，
// 仅替换该接缝参数后重算全部陶片位姿与“每一个”闭合环残差。
// 确认时在同一事务内基于当前版本原子地重新校验：任一闭合环超差即 422
// （返回每条超差接缝与冲突链），接缝、版本、布局均不变。

app.post('/api/seams/:id/revision-preview', wrap((req, res) => {
  const seamId = num(req.params.id, 'id');
  const seam = db.prepare('SELECT * FROM seams WHERE id = ?').get(seamId);
  if (!seam) throw new HttpError(404, '接缝不存在');
  const project = getProjectOr404(seam.project_id);
  const revised = parseRevisionBody(req.body || {}, seam);

  const sherds = db.prepare('SELECT * FROM sherds WHERE project_id = ?').all(seam.project_id);
  const seams = db.prepare('SELECT * FROM seams WHERE project_id = ? ORDER BY id').all(seam.project_id);
  const result = layout.evaluateSeamRevision(sherds, seams, seamId, revised, project.tolerance_mm);
  // 接缝存在时 evaluateSeamRevision 必返回非 null。
  const payload = revisionPayload(project, sherds, result, seamId);
  payload.preview_only = true;
  payload.violations = buildRevisionViolations(result, sherds, project.tolerance_mm);
  res.json(payload);
}));

app.patch('/api/seams/:id', wrap((req, res) => {
  const seamId = num(req.params.id, 'id');
  const seam = db.prepare('SELECT * FROM seams WHERE id = ?').get(seamId);
  if (!seam) throw new HttpError(404, '接缝不存在');
  const project = getProjectOr404(seam.project_id);
  // 确认必须基于当前版本：落后/超前一律 409，且不得套用旧预览。
  checkVersion(req, project);
  const revised = parseRevisionBody(req.body || {}, seam);

  // 单事务：读取当前接缝/陶片 → 全量重算并校验所有闭合环 → 超差则抛错回滚
  // （接缝与版本都不变）；通过才更新该接缝并只 bump 一次版本。
  const txn = db.transaction(() => {
    const current = db.prepare('SELECT * FROM projects WHERE id = ?').get(seam.project_id);
    if (current.version !== project.version) {
      throw new HttpError(409, '版本冲突：方案已被其他人修改，请刷新后基于最新版本重试', {
        current_version: current.version,
        your_version: project.version,
      });
    }
    const sherds = db.prepare('SELECT * FROM sherds WHERE project_id = ?').all(seam.project_id);
    const seams = db.prepare('SELECT * FROM seams WHERE project_id = ? ORDER BY id').all(seam.project_id);
    const result = layout.evaluateSeamRevision(sherds, seams, seamId, revised, current.tolerance_mm);
    if (result.violations.length) {
      const violations = buildRevisionViolations(result, sherds, current.tolerance_mm);
      throw new HttpError(422,
        `修订会使 ${violations.length} 条闭合接缝残差超过 ${current.tolerance_mm} mm 容差，已拒绝修订，原接缝、版本与布局均不变。`,
        {
          reason: 'revision_cycle_tolerance_exceeded',
          violations,
        });
    }
    db.prepare('UPDATE seams SET theta_deg = ?, tx = ?, ty = ?, join_note = ? WHERE id = ?')
      .run(revised.theta_deg, revised.tx, revised.ty, revised.join_note, seamId);
    bump(seam.project_id);
  });
  txn();

  res.json(statePayload(loadState(seam.project_id)));
}));

// ---------- 批量试拼（候选接缝整批试算 + 单事务确认）----------
//
// 用户按顺序填写一批候选接缝（每条：两端陶片、旋转角、毫米平移、说明）。
//   POST /api/projects/:id/seams/batch-preview  只读试算（不需要 Base-Version）：
//       既有接缝优先（采纳序不变），候选按填写顺序参与布局；返回整批加入后的
//       连通组、陶片位姿、每个闭合环残差；超差时指出候选序号、偏差与冲突链。
//       不修改接缝与版本。
//   POST /api/projects/:id/seams/batch-commit   确认（必须带试算时的 Base-Version）：
//       必须回传同一批内容（batch_fingerprint）与试算所基于的 base_version；
//       服务器在单事务内基于当前版本重新读取并重新校验全部闭合环，
//       通过才按填写顺序逐条采纳且版本只 +1；否则整批不生效。
//       方案版本已变化 => 409，要求重新试算；重算超差 => 422 整批回滚。

app.post('/api/projects/:id/seams/batch-preview', wrap((req, res) => {
  const pid = num(req.params.id, 'id');
  const project = getProjectOr404(pid);
  const { candidates, sherds } = parseBatchCandidates(req.body || {}, pid);
  const seams = db.prepare('SELECT * FROM seams WHERE project_id = ? ORDER BY id').all(pid);
  const result = layout.evaluateSeamBatch(sherds, seams, candidates, project.tolerance_mm);
  const payload = batchPayload(project, sherds, result, project.tolerance_mm, { previewOnly: true });
  payload.batch_fingerprint = batchFingerprint(candidates);
  res.json(payload);
}));

app.post('/api/projects/:id/seams/batch-commit', wrap((req, res) => {
  const pid = num(req.params.id, 'id');
  const project = getProjectOr404(pid);
  // 批量确认必须带 Base-Version（= 试算所基于的方案版本）。
  // 版本头缺失/非法沿用统一约定（428/400）；版本落后则返回带批量原因的 409。
  const rawVersion = req.header('Base-Version');
  if (rawVersion === undefined || rawVersion === null || rawVersion === '') {
    throw new HttpError(428, '缺少 Base-Version：请先基于当前版本试算本批接缝后再确认');
  }
  const headerVersion = parseInt(rawVersion, 10);
  if (!Number.isInteger(headerVersion)) throw new HttpError(400, 'Base-Version 必须是整数');
  const body = req.body || {};
  const { candidates } = parseBatchCandidates(body, pid);

  // 确认必须使用与试算完全相同的一批内容（指纹一致），且回传试算所基于的版本。
  const baseVersion = body.base_version === undefined || body.base_version === null
    ? headerVersion
    : num(body.base_version, 'base_version', { min: 1 });
  const fingerprint = body.batch_fingerprint;
  if (typeof fingerprint !== 'string' || !fingerprint) {
    throw new HttpError(400, '缺少 batch_fingerprint：请先对同一批内容做试算，并原样回传其指纹');
  }
  if (fingerprint !== batchFingerprint(candidates)) {
    throw new HttpError(400,
      '批内容与试算时不一致：确认必须使用与试算相同的一批内容，请重新试算后再确认',
      { reason: 'batch_content_mismatch' });
  }
  if (headerVersion !== project.version || baseVersion !== project.version) {
    throw new HttpError(409,
      '版本冲突：方案在试算后已被其他人修改，请基于最新版本重新试算本批接缝后再确认',
      { reason: 'batch_version_conflict', current_version: project.version, your_version: baseVersion });
  }

  // 单事务：再次复核版本未变 → 重新读取当前接缝/陶片 → 重新校验全部闭合环
  // → 超差则抛错回滚（整批不生效，接缝与版本均不变）；
  //   通过才按填写顺序逐条插入，最后只 bump 一次版本。
  const txn = db.transaction(() => {
    const current = db.prepare('SELECT * FROM projects WHERE id = ?').get(pid);
    if (current.version !== project.version) {
      throw new HttpError(409,
        '版本冲突：方案在试算后已被其他人修改，请基于最新版本重新试算本批接缝后再确认',
        { reason: 'batch_version_conflict', current_version: current.version, your_version: baseVersion });
    }
    const sherdsNow = db.prepare('SELECT * FROM sherds WHERE project_id = ?').all(pid);
    const seamsNow = db.prepare('SELECT * FROM seams WHERE project_id = ? ORDER BY id').all(pid);
    // 陶片在试算后被删除/改比例尺等情况在此暴露：仅检查本批候选实际涉及的陶片。
    const byIdNow = new Map(sherdsNow.map((s) => [s.id, s]));
    const endpointsChanged = candidates.some((c) => {
      const a = byIdNow.get(c.from_id);
      const b = byIdNow.get(c.to_id);
      return !a || !b || !a.scale_px || !a.scale_mm || !b.scale_px || !b.scale_mm;
    });
    if (endpointsChanged) {
      throw new HttpError(409,
        '本批候选涉及的陶片在试算后已变化（被删除或比例尺被改动），请重新试算本批接缝后再确认',
        { reason: 'batch_version_conflict', current_version: current.version, your_version: baseVersion });
    }
    const result = layout.evaluateSeamBatch(sherdsNow, seamsNow, candidates, current.tolerance_mm);
    if (result.violations.length) {
      const violations = buildBatchViolations(result, sherdsNow, current.tolerance_mm);
      throw new HttpError(422,
        `整批 ${candidates.length} 条候选接缝中有 ${violations.length} 个闭合环残差超过 ` +
        `${current.tolerance_mm} mm 容差，整批不予采纳，接缝、版本与布局均不变。`,
        { reason: 'batch_cycle_tolerance_exceeded', violations });
    }
    const insert = db.prepare(
      'INSERT INTO seams(project_id, from_id, to_id, theta_deg, tx, ty, join_note) VALUES (?,?,?,?,?,?,?)'
    );
    // 按填写顺序依序采纳（自增 id 即采纳序，与试算中的候选次序一致）。
    for (const c of candidates) {
      insert.run(pid, c.from_id, c.to_id, c.theta_deg, c.tx, c.ty, c.join_note);
    }
    bump(pid);
  });
  txn();

  res.json(statePayload(loadState(pid)));
}));

// ---------- 错误处理 ----------

app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { message: err.message, ...err.extra } });
  }
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: { message: `图片超过 ${MAX_UPLOAD_MB} MB 上限` } });
  }
  console.error(err);
  res.status(500).json({ error: { message: '服务器内部错误' } });
});

app.listen(PORT, () => {
  console.log(`陶片拼接工作台已启动: http://localhost:${PORT} （数据目录 ${DATA_DIR}）`);
});
