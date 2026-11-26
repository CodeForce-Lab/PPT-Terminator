// Copyright (c) 2026 CodeForce-Lab
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
// 使用、修改或分发时须保留本声明并署名 CodeForce-Lab。

import { XMLValidator } from 'fast-xml-parser';
import { openDeck, inspectShapes, insertTiming } from './pptx-deck.mjs';

const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const decor = /^(?:background|chapter-index|page.?number|footer|logo|s\d+-(?:title|kicker|page|footer))(?:-|$)/i;
const horizontalOverlap = (a, b) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
const verticalOverlap = (a, b) => Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
const contains = (parent, item, e) => parent.x - e <= item.x && parent.y - e <= item.y && parent.x + parent.w + e >= item.x + item.w && parent.y + parent.h + e >= item.y + item.h;
const area = s => s.w * s.h;
const order = (a, b) => a.y - b.y || a.x - b.x || a.id - b.id;
const hasContents = s => s.text.trim().length > 0 || ['picture', 'graphicFrame', 'group'].includes(s.kind);

function cuesFor(page, deck, style) {
  const { cx: W, cy: H } = deck;
  const inView = s => !s.hidden && Number.isInteger(s.id) && s.id > 0 && (s.w > 0 && s.h > 0 || (s.kind === 'connector' || s.geometry === 'line') && (s.w > 0 || s.h > 0)) && s.x < W && s.y < H && s.x + s.w > 0 && s.y + s.h > 0;
  const full = s => s.w > .92 * W && s.h > .9 * H;
  const isLine = s => (s.geometry === 'line' || s.kind === 'connector') && s.w > W * .043 && s.h < H * .04;
  const shapes = inspectShapes(page).filter(inView);
  const heading = shapes.filter(s => s.text.trim() && s.y >= H * .073 && s.y < H * .30 && s.w > W * .52).sort(order)[0];
  const header = new Set(shapes.filter(s => s.placeholder && ['title', 'ctrTitle', 'subTitle', 'hdr', 'ftr', 'dt', 'sldNum'].includes(s.placeholder) || decor.test(s.name) || s.y < H * .065 || s.y >= H * .925 || full(s)).map(s => s.id));
  if (heading) {
    header.add(heading.id);
    const subtitle = shapes.find(s => s.id !== heading.id && s.text.trim() && s.w > W * .65 && s.y >= heading.y + heading.h - H * .008 && s.y <= H * .295 && s.y - heading.y - heading.h <= H * .082);
    if (subtitle) header.add(subtitle.id);
  }
  const body = shapes.filter(s => !header.has(s.id));
  if (!body.length || body.length > 70 || (shapes.some(s => s.kind === 'picture' && full(s)) && body.filter(hasContents).length < 2)) return [];

  const assigned = new Set();
  const groups = [];
  const add = members => {
    const sorted = members.filter(s => !assigned.has(s.id)).sort(order);
    if (!sorted.some(hasContents)) return;
    sorted.forEach(s => assigned.add(s.id));
    groups.push({ x: Math.min(...sorted.map(s => s.x)), y: Math.min(...sorted.map(s => s.y)), shapes: sorted });
  };
  const useful = body.filter(hasContents);
  const cards = body.filter(s => s.filled && !s.text.trim() && s.w > W * .095 && s.w <= W * .86 && s.h > H * .08 && s.h <= H * .72).sort((a, b) => area(a) - area(b));
  for (const card of cards) add([card, ...useful.filter(x => x.id !== card.id && contains(card, x, H * .012))]);
  for (const visual of useful.filter(s => ['picture', 'graphicFrame'].includes(s.kind) && !assigned.has(s.id))) {
    const caption = useful.find(s => !assigned.has(s.id) && s.kind === 'shape' && s.text.trim() && s.h < H * .075 && s.y >= visual.y + visual.h - H * .016 && s.y - visual.y - visual.h < H * .035 && horizontalOverlap(s, visual) >= Math.min(s.w, visual.w) * .7);
    const labels = visual.kind === 'graphicFrame' ? useful.filter(s => !assigned.has(s.id) && s.kind === 'shape' && s.text.trim() && s.x >= visual.x + visual.w - W * .018 && s.x - visual.x - visual.w < W * .105 && verticalOverlap(s, visual) > 0) : [];
    add([visual, ...(caption ? [caption] : []), ...labels]);
  }
  for (const first of useful.filter(s => !assigned.has(s.id)).sort(order)) {
    if (assigned.has(first.id)) continue;
    const next = useful.filter(s => s.id !== first.id && !assigned.has(s.id) && s.kind === 'shape' && s.text.trim() && s.y >= first.y + first.h - H * .012 && s.y - first.y - first.h <= H * .045 && Math.abs(s.x - first.x) <= W * .038 && horizontalOverlap(s, first) > Math.min(s.w, first.w) * .58).sort(order)[0];
    const marker = body.find(s => !assigned.has(s.id) && !hasContents(s) && s.filled && s.h < H * .14 && s.w < W * .14 && contains(s, first, H * .012));
    add([...(marker ? [marker] : []), first, ...(next ? [next] : [])]);
  }
  if (!groups.length) return [];
  // Keep captions, labels and their card/visual together when collapsing dense slides.
  const rows = [];
  for (const group of groups.sort((a, b) => a.y - b.y)) {
    const row = rows.at(-1);
    if (row && Math.abs(row.y - group.y) <= H * .075) row.groups.push(group);
    else rows.push({ y: group.y, groups: [group] });
  }
  const arranged = rows.flatMap(row => row.groups.sort((a, b) => a.x - b.x));
  for (const line of body.filter(s => !assigned.has(s.id) && isLine(s))) {
    const group = arranged.find(g => g.x >= line.x + line.w - W * .025 && Math.abs(g.y - line.y) < H * .13);
    if (group) { group.shapes.push(line); assigned.add(line.id); }
  }
  const count = Math.min(4, arranged.length);
  return Array.from({ length: count }, (_, i) => arranged.slice(Math.floor(i * arranged.length / count), Math.floor((i + 1) * arranged.length / count)).flatMap(g => g.shapes.map(s => ({ id: s.id, kind: s.kind, text: Boolean(s.text.trim()), effect: style === 'guided' && isLine(s) ? 'wipe' : 'fade' }))));
}

export function planShow(deck, { excluded = [], style = 'fade', pace = 'normal' } = {}) {
  if (!['guided', 'fade'].includes(style) || !['normal', 'fast'].includes(pace) || !Array.isArray(excluded) || excluded.some(p => !Number.isInteger(p) || p < 1 || p > deck.slides.length)) throw new Error('放映风格、节奏或排除页码无效。');
  if (/<(?:[\w.-]+:)?showPr\b[^>]*\bshowAnimation=["'](?:0|false)["']/.test(deck.propertyXml)) throw new Error('原稿设置了“放映时不加动画”，请先在 PowerPoint 中启用动画后再导出。');
  const byPage = new Set(excluded);
  const pages = [], skipped = [];
  for (const page of deck.slides) {
    const reason = byPage.has(page.number) ? 'excluded' : page.hasTiming ? 'existing-timing' : page.hidden ? 'hidden' : page.autoAdvance ? 'auto-advance' : '';
    if (reason) { skipped.push({ page: page.number, reason }); continue; }
    const groups = cuesFor(page, deck, style);
    if (groups.length) pages.push({ page, groups });
    else skipped.push({ page: page.number, reason: 'static' });
  }
  return { pages, skipped, pace, style };
}

function timing(groups, pace) {
  let id = 2;
  const builds = [];
  const t = (conditions, elements, type = '') => `<p:par><p:cTn id="${++id}" fill="hold"${type}>${conditions}<p:childTnLst>${elements()}</p:childTnLst></p:cTn></p:par>`;
  const delay = n => `<p:stCondLst><p:cond delay="${n}"/></p:stCondLst>`;
  function effect(shape, click) {
    const wipe = shape.effect === 'wipe';
    const target = `<p:tgtEl><p:spTgt spid="${shape.id}"/></p:tgtEl>`;
    if (shape.kind === 'graphicFrame') builds.push(`<p:bldGraphic spid="${shape.id}" grpId="0"><p:bldAsOne/></p:bldGraphic>`);
    else if (shape.text) builds.push(`<p:bldP spid="${shape.id}" grpId="0" animBg="1"/>`);
    return `<p:par><p:cTn id="${++id}" presetID="${wipe ? 22 : 10}" presetClass="entr" presetSubtype="${wipe ? 2 : 0}" fill="hold"${shape.text || shape.kind === 'graphicFrame' ? ' grpId="0"' : ''} nodeType="${click ? 'clickEffect' : 'withEffect'}">${delay(0)}<p:childTnLst><p:set><p:cBhvr><p:cTn id="${++id}" dur="1" fill="hold">${delay(0)}</p:cTn>${target}<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set><p:animEffect transition="in" filter="${wipe ? 'wipe(right)' : 'fade'}"><p:cBhvr><p:cTn id="${++id}" dur="${pace === 'fast' ? 230 : wipe ? 430 : 320}"/>${target}</p:cBhvr></p:animEffect></p:childTnLst></p:cTn></p:par>`;
  }
  const blocks = groups.map(group => t(delay('indefinite'), () => t(delay(0), () => group.map((shape, i) => effect(shape, i === 0)).join('')))).join('');
  const click = (tag, event) => `<p:${tag}CondLst><p:cond evt="on${event}" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:${tag}CondLst>`;
  return `<p:timing xmlns:p="${P}"><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>${blocks}</p:childTnLst></p:cTn>${click('prev', 'Prev')}${click('next', 'Next')}</p:seq></p:childTnLst></p:cTn></p:par></p:tnLst>${builds.length ? `<p:bldLst>${builds.join('')}</p:bldLst>` : ''}</p:timing>`;
}

export function buildShow(buffer, options = {}) {
  const deck = openDeck(buffer);
  const plan = planShow(deck, options);
  if (!plan.pages.length) throw new Error('没有适合新增动画的页面：请检查排除页、已有动画或是否全为整页图。');
  for (const { page, groups } of plan.pages) {
    const xml = insertTiming(page, timing(groups, plan.pace));
    if (XMLValidator.validate(xml) !== true) throw new Error(`第 ${page.number} 页的动画格式无法写入。`);
    deck.zip.updateFile(page.part, Buffer.from(xml, 'utf8'));
  }
  const groups = plan.pages.map(({ page, groups }) => ({ page: page.number, steps: groups.length }));
  return { buffer: deck.zip.toBuffer(), audit: { pages: deck.slides.length, animatedPages: groups.map(g => g.page), clickGroups: groups.reduce((n, g) => n + g.steps, 0), effects: plan.pages.reduce((n, p) => n + p.groups.flat().length, 0), skipped: plan.skipped, groups, style: plan.style, pace: plan.pace } };
}
