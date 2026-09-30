'use strict';

// 布局引擎：
// 1. 以“接缝”为无向边求连通组。
// 2. 每组的生成树按接缝采纳先后（接缝 id 升序，等同 Kruskal 次序）确定：
//    先采纳的接缝优先决定布局，之后加入的边若连接同组两片则为“成环边”，
//    只用于闭合残差校验，不会改写已确定的位置。
// 3. 每组取最小陶片 id 为根，沿生成树把每片的局部毫米坐标位姿传播为世界位姿。
// 4. 新接缝两端已连通 => 成环，比较“沿新边推算的位姿”与“现有位姿”，
//    偏差超容差则拒绝（由 API 层返回，本模块只计算）。

const geo = require('./geo');

function sherdMetrics(sh) {
  if (!sh.scale_px || !sh.scale_mm) return null;
  const ppm = sh.scale_px / sh.scale_mm;
  return { ppm, wMm: sh.img_w / ppm, hMm: sh.img_h / ppm };
}

// 沿一条接缝，从已知位姿的一端求另一端位姿。
// movingFromTo=true：已知 from 端，求 to 端（pB = T pA，用 T 的逆）。
// movingFromTo=false：已知 to 端，求 from 端（直接把 T 当 from->to 的位姿增量）。
function propagate(pose, seam, movingFromTo) {
  if (movingFromTo) return geo.poseAcrossSeam(pose, seam);
  const c = Math.cos(geo.deg2rad(pose.theta));
  const si = Math.sin(geo.deg2rad(pose.theta));
  return {
    x: pose.x + c * seam.tx - si * seam.ty,
    y: pose.y + si * seam.tx + c * seam.ty,
    theta: pose.theta + seam.theta_deg,
  };
}

// 并查集
function makeDsu(ids) {
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (x) => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(x) !== r) { const n = parent.get(x); parent.set(x, r); x = n; }
    return r;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra === rb) return false;
    // 让较小 id 的陶片所在根做组件根，确定性更好
    if (ra < rb) parent.set(rb, ra); else parent.set(ra, rb);
    return true;
  };
  return { find, union };
}

// 按接缝采纳顺序（id 升序）确定各连通组及其生成树（Kruskal 式并查集）：
// 先采纳的接缝优先决定布局；后加入的边若两端已连通则归为成环边。
function componentsInSeamOrder(sherdIds, sortedSeams) {
  const dsu = makeDsu(sherdIds);
  const mergedFlag = new Map(); // seam -> 是否桥接两个组件
  for (const s of sortedSeams) mergedFlag.set(s.id, dsu.union(s.from_id, s.to_id));

  const compMembers = new Map();
  for (const id of sherdIds) {
    const r = dsu.find(id);
    if (!compMembers.has(r)) compMembers.set(r, new Set());
    compMembers.get(r).add(id);
  }
  const compEdges = new Map();
  const cycleEdges = [];
  for (const s of sortedSeams) {
    const r = dsu.find(s.from_id);
    if (mergedFlag.get(s.id)) {
      if (!compEdges.has(r)) compEdges.set(r, []);
      compEdges.get(r).push(s);
    } else {
      cycleEdges.push(s);
    }
  }

  return {
    componentMembers: compMembers,
    componentTreeEdges: compEdges,
    cycleEdges,
  };
}

// 在给定生成树边上做 BFS，从 root 传播位姿。
function spanFromTree(rootId, treeEdges) {
  const adj = new Map();
  const addAdj = (u, e) => {
    if (!adj.has(u)) adj.set(u, []);
    adj.get(u).push(e);
  };
  for (const s of treeEdges) {
    addAdj(s.from_id, { seamId: s.id, other: s.to_id, movingFromTo: true });
    addAdj(s.to_id, { seamId: s.id, other: s.from_id, movingFromTo: false });
  }
  for (const list of adj.values()) list.sort((a, b) => a.seamId - b.seamId);

  const seamById = new Map(treeEdges.map((s) => [s.id, s]));
  const poses = new Map([[rootId, { x: 0, y: 0, theta: 0 }]]);
  const parent = new Map();
  const treeSeamIds = [];
  const queue = [rootId];
  while (queue.length) {
    const u = queue.shift();
    for (const e of adj.get(u) || []) {
      if (poses.has(e.other)) continue;
      const seam = seamById.get(e.seamId);
      poses.set(e.other, propagate(poses.get(u), seam, e.movingFromTo));
      parent.set(e.other, { from: u, viaSeam: e.seamId });
      treeSeamIds.push(e.seamId);
      queue.push(e.other);
    }
  }

  const chains = new Map();
  for (const node of poses.keys()) {
    const chain = [];
    let cur = node;
    while (cur !== rootId) {
      const p = parent.get(cur);
      chain.push(p.viaSeam);
      cur = p.from;
    }
    chain.reverse();
    chains.set(node, chain);
  }
  return { root: rootId, poses, parent, treeSeamIds, chains };
}

function componentBounds(memberIds, poses, metricsById) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const id of memberIds) {
    const m = metricsById.get(id);
    if (!m) continue;
    const pose = poses.get(id);
    for (const [lx, ly] of [[0, 0], [m.wMm, 0], [m.wMm, m.hMm], [0, m.hMm]]) {
      const w = geo.applyPose(pose, lx, ly);
      minX = Math.min(minX, w.x);
      minY = Math.min(minY, w.y);
      maxX = Math.max(maxX, w.x);
      maxY = Math.max(maxY, w.y);
    }
  }
  if (minX === Infinity) return null;
  return { minX, minY, maxX, maxY, widthMm: maxX - minX, heightMm: maxY - minY };
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

// 主入口：计算全方案布局（含每个成环接缝的闭合残差与冲突链细节）。
// 布局不持久化——每次都从接缝现算，撤销/修订接缝后不可能残留旧位姿。
function computeLayoutDetailed(sherds, seams, toleranceMm) {
  const sherdIds = sherds.map((s) => s.id).sort((a, b) => a - b);
  const sortedSeams = seams.slice().sort((a, b) => a.id - b.id);
  const metricsById = new Map(sherds.map((s) => [s.id, sherdMetrics(s)]));

  const { componentMembers, componentTreeEdges, cycleEdges } =
    componentsInSeamOrder(sherdIds, sortedSeams);

  const degree = new Map(sherdIds.map((id) => [id, 0]));
  for (const s of sortedSeams) {
    degree.set(s.from_id, (degree.get(s.from_id) || 0) + 1);
    degree.set(s.to_id, (degree.get(s.to_id) || 0) + 1);
  }

  const groups = [];
  const unconnected = [];
  const residuals = [];
  const cycleDetails = []; // 与 residuals 对应，额外携带闭合环冲突链

  for (const root of [...componentMembers.keys()].sort((a, b) => a - b)) {
    const memberSet = componentMembers.get(root);
    if (memberSet.size === 1 && degree.get(root) === 0) {
      unconnected.push(root);
      continue;
    }
    const memberIds = [...memberSet].sort((a, b) => a - b);
    const actualRoot = memberIds[0];
    const treeEdges = componentTreeEdges.get(root) || [];
    const tree = spanFromTree(actualRoot, treeEdges);

    const poses = {};
    const chains = {};
    for (const mid of memberIds) {
      const p = tree.poses.get(mid);
      poses[mid] = { x: round3(p.x), y: round3(p.y), theta: round3(p.theta) };
      chains[mid] = tree.chains.get(mid);
    }

    for (const s of cycleEdges) {
      if (!memberSet.has(s.from_id)) continue;
      const poseFrom = tree.poses.get(s.from_id);
      const poseToExisting = tree.poses.get(s.to_id);
      if (!poseFrom || !poseToExisting) continue;
      const predicted = geo.poseAcrossSeam(poseFrom, s);
      const m = metricsById.get(s.to_id);
      const dev = geo.poseDeviationMm(predicted, poseToExisting, geo.featurePoints(m.wMm, m.hMm));
      // 闭合环冲突链：生成树上 from→to 的陶片/接缝路径，再由该成环接缝闭合成环。
      const path = treePath(tree, s.from_id, s.to_id);
      const within = dev.distanceMm <= toleranceMm;
      residuals.push({
        seam_id: s.id,
        from_id: s.from_id,
        to_id: s.to_id,
        distance_mm: round3(dev.distanceMm),
        rotation_deg: round3(dev.rotationDeg),
        within_tolerance: within,
      });
      cycleDetails.push({
        seam_id: s.id,
        from_id: s.from_id,
        to_id: s.to_id,
        distance_mm: round3(dev.distanceMm),
        rotation_deg: round3(dev.rotationDeg),
        within_tolerance: within,
        conflict_chain: {
          sherd_path: path.sherdPath,
          seam_path: path.seamPath,
          cycle_seam_id: s.id,
        },
      });
    }

    groups.push({
      root_sherd_id: actualRoot,
      member_ids: memberIds,
      poses,
      chains,
      tree_seam_ids: tree.treeSeamIds.slice().sort((a, b) => a - b),
      bounds: componentBounds(memberIds, tree.poses, metricsById),
    });
  }

  residuals.sort((a, b) => a.seam_id - b.seam_id);
  cycleDetails.sort((a, b) => a.seam_id - b.seam_id);
  groups.sort((a, b) => a.root_sherd_id - b.root_sherd_id);
  unconnected.sort((a, b) => a - b);
  return { groups, unconnected, residuals, cycleDetails };
}

// 对外契约保持 { groups, unconnected, residuals } 不变。
function computeLayout(sherds, seams, toleranceMm) {
  const { groups, unconnected, residuals } = computeLayoutDetailed(sherds, seams, toleranceMm);
  return { groups, unconnected, residuals };
}

// 接缝修订：仅替换指定接缝的旋转角/平移/说明（接缝身份与采纳排序均不变），
// 按同一套规则重算全方案布局，并对“每一个”闭合环给出残差与冲突链。
// 预览与确认共用此函数，因此成功后读取到的布局必然与预览一致。
// 返回 null 表示目标接缝不存在（由 API 层转 404）。
function evaluateSeamRevision(sherds, seams, seamId, revised, toleranceMm) {
  if (!seams.some((s) => s.id === seamId)) return null;
  const revisedSeams = seams.map((s) => (s.id === seamId
    ? {
        ...s,
        theta_deg: revised.theta_deg,
        tx: revised.tx,
        ty: revised.ty,
        join_note: revised.join_note,
      }
    : s));
  const detailed = computeLayoutDetailed(sherds, revisedSeams, toleranceMm);
  return {
    revised_seams: revisedSeams,
    layout: { groups: detailed.groups, unconnected: detailed.unconnected, residuals: detailed.residuals },
    violations: detailed.cycleDetails.filter((c) => !c.within_tolerance),
  };
}

// 生成树中 a -> b 的接缝链
function treePath(tree, a, b) {
  const ancA = [];
  let cur = a;
  while (true) {
    ancA.push(cur);
    if (cur === tree.root) break;
    cur = tree.parent.get(cur).from;
  }
  const ancBSet = new Set();
  cur = b;
  while (true) {
    ancBSet.add(cur);
    if (cur === tree.root) break;
    cur = tree.parent.get(cur).from;
  }
  const lca = ancA.find((n) => ancBSet.has(n));

  const sherdPath = [];
  const seamPath = [];
  cur = a;
  while (cur !== lca) {
    sherdPath.push(cur);
    seamPath.push(tree.parent.get(cur).viaSeam);
    cur = tree.parent.get(cur).from;
  }
  sherdPath.push(lca);
  const upSherds = [];
  const upSeams = [];
  cur = b;
  while (cur !== lca) {
    upSherds.push(cur);
    upSeams.push(tree.parent.get(cur).viaSeam);
    cur = tree.parent.get(cur).from;
  }
  upSherds.reverse();
  upSeams.reverse();
  seamPath.push(...upSeams);
  sherdPath.push(...upSherds);
  return { sherdPath, seamPath };
}

// 新接缝成环检查（不含候选边本身）。
function evaluateNewSeam(sherds, seams, candidate, toleranceMm) {
  const sortedSeams = seams.slice().sort((a, b) => a.id - b.id);
  const sherdIds = sherds.map((s) => s.id);
  const metricsById = new Map(sherds.map((s) => [s.id, sherdMetrics(s)]));

  const { componentMembers, componentTreeEdges } = componentsInSeamOrder(sherdIds, sortedSeams);

  let rootOfA = null;
  for (const [root, set] of componentMembers) {
    if (set.has(candidate.from_id)) { rootOfA = root; break; }
  }
  if (rootOfA === null || !componentMembers.get(rootOfA).has(candidate.to_id)) {
    return { closes_cycle: false };
  }

  const memberIds = [...componentMembers.get(rootOfA)].sort((a, b) => a - b);
  const actualRoot = memberIds[0];
  const tree = spanFromTree(actualRoot, componentTreeEdges.get(rootOfA) || []);

  const poseA = tree.poses.get(candidate.from_id);
  const poseBExisting = tree.poses.get(candidate.to_id);
  const predicted = geo.poseAcrossSeam(poseA, candidate);
  const m = metricsById.get(candidate.to_id);
  const dev = geo.poseDeviationMm(predicted, poseBExisting, geo.featurePoints(m.wMm, m.hMm));
  const path = treePath(tree, candidate.from_id, candidate.to_id);

  return {
    closes_cycle: true,
    acceptable: dev.distanceMm <= toleranceMm,
    distance_mm: round3(dev.distanceMm),
    rotation_deg: round3(dev.rotationDeg),
    tolerance_mm: toleranceMm,
    conflict_chain: {
      sherd_path: path.sherdPath,
      seam_path: path.seamPath,
      new_seam_from: candidate.from_id,
      new_seam_to: candidate.to_id,
    },
  };
}

module.exports = { computeLayout, computeLayoutDetailed, evaluateNewSeam, evaluateSeamRevision, sherdMetrics };
