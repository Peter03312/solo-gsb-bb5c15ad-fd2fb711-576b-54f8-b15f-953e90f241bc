// 前端几何/布局工具。单位约定与后端一致：陶片局部坐标为毫米。

export const DEG = Math.PI / 180;
export const FALLBACK_SPAN_MM = 80; // 未设比例尺的孤立片：按 80mm 占位显示
const PAD = 30; // 卡片内边距
const TITLE_H = 30; // 卡片标题栏高度
const CARD_GAP = 70; // 卡片间距
const CARD_MAX_W = 720;

export function sherdPpm(sh) {
  if (sh.scale_px && sh.scale_mm) return sh.scale_px / sh.scale_mm;
  return Math.max(sh.img_w, sh.img_h) / FALLBACK_SPAN_MM;
}

export function sherdMm(sh) {
  const ppm = sherdPpm(sh);
  return { wMm: sh.img_w / ppm, hMm: sh.img_h / ppm, ppm };
}

export function applyPose(p, x, y) {
  const c = Math.cos(p.theta * DEG), s = Math.sin(p.theta * DEG);
  return { x: c * x - s * y + p.x, y: s * x + c * y + p.y };
}

export function normAngle180(a) {
  return ((a + 540) % 360) - 180;
}

// 依据服务器给出的各组包围盒/孤立片，计算卡片在“画布世界坐标(px=mm)”中的位置。
export function computeCards(layout, sherds) {
  const shById = new Map(sherds.map((s) => [s.id, s]));
  const cards = []; // {key, kind, title, x,y,w,h, memberIds}

  const wrap = (w) => Math.min(w, CARD_MAX_W);

  let cursorX = PAD;
  let cursorY = PAD;
  let rowH = 0;
  const availW = 2400; // 虚拟排步行宽，超出换行

  const placeCard = (widthMm, heightMm, make) => {
    const w = wrap(widthMm + PAD * 2);
    const h = heightMm + PAD * 2 + TITLE_H;
    if (cursorX + w > availW && cursorX > PAD) {
      cursorX = PAD;
      cursorY += rowH + CARD_GAP;
      rowH = 0;
    }
    make(cursorX, cursorY, w, h);
    cursorX += w + CARD_GAP;
    rowH = Math.max(rowH, h);
  };

  for (const g of layout.groups) {
    const b = g.bounds || { minX: 0, minY: 0, widthMm: 100, heightMm: 100 };
    placeCard(b.widthMm || 100, b.heightMm || 100, (x, y, w, h) => {
      cards.push({
        kind: 'group',
        key: `g${g.root_sherd_id}`,
        title: `连通组 · 根 #${g.root_sherd_id} · ${g.member_ids.length} 片`,
        x, y, w, h,
        originX: x + PAD - b.minX,
        originY: y + PAD + TITLE_H - b.minY,
        group: g,
      });
    });
  }

  // 未连通片单独显示，每片一张卡片
  const singles = layout.unconnected.map((id) => shById.get(id)).filter(Boolean);
  for (const sh of singles) {
    const m = sherdMm(sh);
    const scaled = !!(sh.scale_px && sh.scale_mm);
    placeCard(m.wMm, m.hMm, (x, y, w, h) => {
      cards.push({
        kind: 'single',
        key: `s${sh.id}`,
        title: `${sh.label} #${sh.id}${scaled ? '' : '（未设比例尺）'}`,
        x, y, w, h,
        originX: x + PAD,
        originY: y + PAD + TITLE_H,
        sherdId: sh.id,
        scaled,
      });
    });
  }

  const contentW = Math.max(80, ...cards.map((c) => c.x + c.w));
  const contentH = Math.max(80, ...cards.map((c) => c.y + c.h));
  return { cards, contentW, contentH };
}

// 某片在画布世界(mm)中的位姿（叠加卡片偏移）；未设比例尺的孤立片给恒等位姿
export function sherdWorldPose(_layout, card, sherdId) {
  if (card.kind === 'group') {
    const p = card.group.poses[sherdId];
    if (!p) return null;
    return { x: p.x + card.originX, y: p.y + card.originY, theta: p.theta };
  }
  return { x: card.originX, y: card.originY, theta: 0 };
}

export function findCardAt(cards, wx, wy) {
  // 逆序（后绘制的在上）
  for (let i = cards.length - 1; i >= 0; i--) {
    const c = cards[i];
    if (wx >= c.x && wx <= c.x + c.w && wy >= c.y && wy <= c.y + c.h) return c;
  }
  return null;
}

// 命中检测某片：把世界点逆变换到该片局部，检查是否在 [0,w]×[0,h] 图像矩形内
export function hitSherd(worldX, worldY, sherds, layout, cards) {
  const card = findCardAt(cards, worldX, worldY);
  if (!card) return null;
  const ids = card.kind === 'group' ? card.group.member_ids : [card.sherdId];
  const byId = new Map(sherds.map((s) => [s.id, s]));
  for (const id of ids) {
    const sh = byId.get(id);
    const pose = sherdWorldPose(layout, card, id);
    if (!pose) continue;
    const dx = worldX - pose.x, dy = worldY - pose.y;
    const th = -pose.theta * DEG;
    const c = Math.cos(th), s = Math.sin(th);
    const lx = c * dx - s * dy;
    const ly = s * dx + c * dy;
    const m = sherdMm(sh);
    if (lx >= 0 && ly >= 0 && lx <= m.wMm && ly <= m.hMm) {
      return { sherd: sh, card, local: { x: lx, y: ly } };
    }
  }
  return { sherd: null, card, local: null };
}
