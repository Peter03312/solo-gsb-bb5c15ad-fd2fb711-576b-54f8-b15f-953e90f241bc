'use strict';

// 纯几何模块：陶片局部毫米坐标 <-> 世界坐标的刚性变换。
//
// 约定：
//   pose { x, y, theta } 表示一片陶片在世界坐标系中的位姿，
//   世界坐标 = R(theta) * 局部坐标 + (x, y)。
//   seam { theta_deg, tx, ty } 是有向边 fromId -> toId，
//   表示 to 片局部坐标 = R(theta) * from 片局部坐标 + (tx, ty)。
//   即：to 系中观察 from 系的刚体变换。

function deg2rad(d) {
  return (d * Math.PI) / 180;
}

function rad2deg(r) {
  return (r * 180) / Math.PI;
}

// 把局部点按 pose 变换到世界坐标
function applyPose(pose, px, py) {
  const c = Math.cos(deg2rad(pose.theta));
  const s = Math.sin(deg2rad(pose.theta));
  return {
    x: c * px - s * py + pose.x,
    y: s * px + c * py + pose.y,
  };
}

// 点 p 经过刚体变换 T(theta, tx, ty)
function applyT(t, px, py) {
  const c = Math.cos(deg2rad(t.theta_deg));
  const s = Math.sin(deg2rad(t.theta_deg));
  return {
    x: c * px - s * py + t.tx,
    y: s * px + c * py + t.ty,
  };
}

// 刚体变换求逆：T = R*t+a 的逆为 R^-1 * (p - a)
function invertT(t) {
  const th = (-t.theta_deg * Math.PI) / 180;
  const c = Math.cos(th);
  const s = Math.sin(th);
  return {
    theta_deg: -t.theta_deg,
    tx: c * (-t.tx) - s * (-t.ty),
    ty: s * (-t.tx) + c * (-t.ty),
  };
}

// 变换复合：先做 a 再做 b，返回 b(a(p)) 的刚体参数
function composeT(b, a) {
  const theta = b.theta_deg + a.theta_deg;
  const p = applyT(b, a.tx, a.ty);
  return { theta_deg: theta, tx: p.x, ty: p.y };
}

// pose 复合：先按 a 取位姿再叠加 b（世界系位姿的链式推导）
// 本项目中位姿沿有向 seam 传播，统一用 transformFromAToB + applyT 处理，
// pose 复合仅在测试中使用。
function composePose(parent, local) {
  const c = Math.cos(deg2rad(parent.theta));
  const s = Math.sin(deg2rad(parent.theta));
  return {
    x: parent.x + c * local.x - s * local.y,
    y: parent.y + s * local.x + c * local.y,
    theta: parent.theta + local.theta,
  };
}

// 归一化角度差到 [-180, 180]
function angleDiffDeg(a, b) {
  let d = ((a - b + 540) % 360) - 180;
  return d;
}

// 给定 A 片世界位姿 poseA，以及有向边 A->B 的接缝 T，求 B 片世界位姿。
// pB = T pA ；pW = poseA(pA) = poseB(pB)
// => poseB = poseA ∘ T^{-1}，T^{-1} 的平移需按 poseA 的旋转转进世界系。
function poseAcrossSeam(poseA, seamFromAtoB) {
  const inv = invertT(seamFromAtoB);
  const c = Math.cos(deg2rad(poseA.theta));
  const s = Math.sin(deg2rad(poseA.theta));
  return {
    x: poseA.x + c * inv.tx - s * inv.ty,
    y: poseA.y + s * inv.tx + c * inv.ty,
    theta: poseA.theta + inv.theta_deg,
  };
}

// 两片特征点之间的预测/实际最大偏差（毫米）。
// predicted：B 沿新边推算出的位姿；existing：B 在现有布局中的位姿。
// 用片上采样点（中心点 + 四角，单位毫米）在两位姿下的最大平面距离衡量，
// 这样旋转误差也会被四角位移捕获。
function poseDeviationMm(predicted, existing, featurePtsMm) {
  let maxD = 0;
  for (const p of featurePtsMm) {
    const a = applyPose(predicted, p.x, p.y);
    const b = applyPose(existing, p.x, p.y);
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (d > maxD) maxD = d;
  }
  const rotErr = Math.abs(angleDiffDeg(predicted.theta, existing.theta));
  return { distanceMm: maxD, rotationDeg: rotErr };
}

// 陶片四角 + 中心（局部毫米坐标）。wMm/hMm 为片的毫米尺寸。
function featurePoints(wMm, hMm) {
  const cx = wMm / 2;
  const cy = hMm / 2;
  return [
    { x: cx, y: cy },
    { x: 0, y: 0 },
    { x: wMm, y: 0 },
    { x: wMm, y: hMm },
    { x: 0, y: hMm },
  ];
}

module.exports = {
  deg2rad,
  rad2deg,
  applyPose,
  applyT,
  invertT,
  composeT,
  composePose,
  angleDiffDeg,
  poseAcrossSeam,
  poseDeviationMm,
  featurePoints,
};
