// Copyright (c) 2026 CodeForce-Lab
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
// 使用、修改或分发时须保留本声明并署名 CodeForce-Lab。

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import AdmZip from 'adm-zip';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const O = 'http://schemas.openxmlformats.org/package/2006/relationships';
const parse = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '', parseTagValue: false, trimValues: false });
const tag = n => Object.keys(n || {}).find(k => k !== ':@');
const local = k => k?.split(':').at(-1);
const children = n => n?.[tag(n)] || [];
const find = (n, name) => children(n).find(x => local(tag(x)) === name);
const attrs = n => n?.[':@'] || {};
const all = (n, name) => children(n).flatMap(x => local(tag(x)) === name ? [x] : Array.isArray(children(x)) ? all(x, name) : []);
const value = n => children(n).find(x => Object.hasOwn(x, '#text'))?.['#text'] || '';
const xmlText = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch]));

function root(xml, name) {
  if (!xml || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('PPTX 包内 XML 无效。');
  const n = parse.parse(xml).find(x => !tag(x)?.startsWith('?') && local(tag(x)) === name);
  if (!n) throw new Error('PPTX 缺少必要的页面结构。');
  return n;
}
const beforeClose = (xml, node, block) => {
  const end = xml.lastIndexOf('</' + tag(node) + '>');
  if (end < 0) throw new Error('PPTX 的 XML 容器无效。');
  return xml.slice(0, end) + block + xml.slice(end);
};
function childSpans(xml, rootName) {
  const spans = new Map();
  const stack = [];
  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?[\w:.-]+(?:[^<>"']|"[^"]*"|'[^']*')*>/g;
  let m;
  while ((m = tokens.exec(xml))) {
    if (/^<[!?]/.test(m[0])) continue;
    const name = m[0].match(/^<\/?([\w:.-]+)/)[1];
    if (m[0].startsWith('</')) {
      const entry = stack.pop();
      if (entry?.name !== name) throw new Error('PPTX 页面标签不匹配。');
      if (stack.length === 1 && stack[0].name === rootName) spans.set(name, { start: entry.start, end: tokens.lastIndex });
    } else if (m[0].endsWith('/>')) {
      if (stack.length === 1 && stack[0].name === rootName) spans.set(name, { start: m.index, end: tokens.lastIndex });
    } else stack.push({ name, start: m.index });
  }
  return spans;
}

const relsFor = part => path.posix.join(path.posix.dirname(part), '_rels', `${path.posix.basename(part)}.rels`);
function targetPart(part, target) {
  if (typeof target !== 'string' || /[\\?#\x00-\x1f]/.test(target)) throw new Error('PPTX 内部关系地址无效。');
  const normalized = target.startsWith('/') ? path.posix.normalize(target.slice(1)) : path.posix.join(path.posix.dirname(part), target);
  if (normalized.startsWith('../') || normalized.startsWith('/') || normalized.includes(':')) throw new Error('PPTX 内部关系地址无效。');
  return normalized;
}
const relList = n => children(n).filter(x => local(tag(x)) === 'Relationship').map(attrs);

export function openDeck(buffer) {
  let zip;
  try { zip = new AdmZip(buffer); } catch { throw new Error('无法读取 PPTX 文件，请重新上传。'); }
  const entries = zip.getEntries();
  if (entries.length > 5000 || entries.reduce((n, e) => n + e.header.size, 0) > 180 * 1024 * 1024 || new Set(entries.map(e => e.entryName)).size !== entries.length) throw new Error('PPTX 包过大或内部文件重复。');
  const part = 'ppt/presentation.xml';
  const presentation = root(zip.readAsText(part), 'presentation');
  const relationshipPrefix = Object.keys(attrs(presentation)).find(k => k.startsWith('xmlns:') && attrs(presentation)[k] === R)?.slice(6) || 'r';
  const relationMap = new Map(relList(root(zip.readAsText(relsFor(part)), 'Relationships')).map(r => [r.Id, r]));
  const ids = children(find(presentation, 'sldIdLst')).filter(x => local(tag(x)) === 'sldId');
  if (!ids.length || ids.length > 120) throw new Error('视觉工作台支持 1–120 页的 PPTX。');
  const size = attrs(find(presentation, 'sldSz'));
  const cx = Number(size.cx), cy = Number(size.cy);
  if (![cx, cy].every(v => Number.isInteger(v) && v >= 914400 && v <= 51206400)) throw new Error('PPTX 页面尺寸无效。');
  const slides = ids.map((id, i) => {
    const rel = relationMap.get(attrs(id)[`${relationshipPrefix}:id`]);
    if (rel?.Type !== `${R}/slide` || rel.TargetMode === 'External') throw new Error('PPTX 页面顺序或关系无效。');
    const part = targetPart('ppt/presentation.xml', rel.Target);
    const xml = zip.readAsText(part);
    const page = root(xml, 'sld');
    if (!find(find(page, 'cSld'), 'spTree')) throw new Error(`第 ${i + 1} 页缺少对象容器。`);
    return { number: i + 1, part, xml, page, hidden: ['0', 'false'].includes(attrs(page).show), hasTiming: Boolean(find(page, 'timing')), autoAdvance: Object.hasOwn(attrs(find(page, 'transition')), 'advTm') };
  });
  if (new Set(slides.map(p => p.part)).size !== slides.length) throw new Error('PPTX 页序引用重复。');
  return { zip, slides, cx, cy, propertyXml: zip.readAsText('ppt/presProps.xml') };
}

const KINDS = { sp: 'shape', pic: 'picture', graphicFrame: 'graphicFrame', cxnSp: 'connector', grpSp: 'group' };
function shapeText(n) {
  return all(n, 'p').map(p => all(p, 't').map(value).join('')).filter(Boolean).join('\n');
}
export function inspectShapes(page) {
  const list = children(find(find(page.page, 'cSld'), 'spTree'));
  return list.filter(n => Object.hasOwn(KINDS, local(tag(n)))).map(n => {
    const type = local(tag(n));
    const nv = children(n).find(x => /^nv/.test(local(tag(x)) || ''));
    const pr = attrs(find(nv, 'cNvPr'));
    const placeholder = attrs(find(find(nv, 'nvPr'), 'ph'));
    const props = find(n, type === 'grpSp' ? 'grpSpPr' : 'spPr');
    const transform = find(props, 'xfrm') || find(n, 'xfrm');
    const off = attrs(find(transform, 'off')), ext = attrs(find(transform, 'ext'));
    return { id: Number(pr.id), kind: KINDS[type], name: pr.name || '', text: shapeText(n), x: Number(off.x || 0), y: Number(off.y || 0), w: Number(ext.cx || 0), h: Number(ext.cy || 0), placeholder: placeholder.type || '', geometry: attrs(find(props, 'prstGeom')).prst || '', hidden: ['1', 'true'].includes(pr.hidden), filled: Boolean(find(props, 'solidFill') || find(props, 'gradFill')), embed: Object.entries(attrs(find(find(n, 'blipFill'), 'blip'))).find(([k]) => local(k) === 'embed')?.[1] };
  });
}
export function summarizeDeck(deck) {
  const colors = new Map(), fonts = new Map();
  const add = (map, key) => { if (key) map.set(key, (map.get(key) || 0) + 1); };
  const paletteXml = deck.zip.getEntries().filter(e => /^ppt\/(?:theme|slideLayouts)\/[^/]+\.xml$/i.test(e.entryName)).slice(0, 48).map(e => e.getData().toString('utf8'));
  for (const xml of [...deck.slides.map(p => p.xml), ...paletteXml]) {
    for (const m of xml.matchAll(/<(?:[\w.-]+:)?srgbClr\b[^>]*\bval="([\dA-Fa-f]{6})"/g)) add(colors, '#' + m[1].toUpperCase());
    for (const m of xml.matchAll(/<(?:[\w.-]+:)?(?:latin|ea)\b[^>]*\btypeface="([^"+][^"]{0,70})"/g)) add(fonts, m[1]);
  }
  const top = (map, n) => [...map].sort((a, b) => b[1] - a[1]).slice(0, n).map(v => v[0]);
  const pages = deck.slides.map(p => {
    const shapes = inspectShapes(p).filter(s => !s.hidden && !['ftr', 'dt', 'sldNum', 'hdr'].includes(s.placeholder));
    const text = shapes.filter(s => s.text.trim());
    const primary = text.find(s => ['title', 'ctrTitle'].includes(s.placeholder)) || text.find(s => s.y >= deck.cy * .09 && s.y < deck.cy * .33 && s.text.trim().length >= 4) || text.find(s => s.text.trim().length >= 4);
    const images = shapes.filter(s => s.kind === 'picture');
    return { number: p.number, title: primary?.text.split('\n')[0].trim().slice(0, 90) || `第 ${p.number} 页`, text: text.map(s => s.text.trim()).join('\n').slice(0, 3200), images: images.length, charts: shapes.filter(s => s.kind === 'graphicFrame').length, hidden: p.hidden };
  });
  return { pages, colors: top(colors, 8), fonts: top(fonts, 4), photoPages: pages.filter(p => p.images > 0).length, chartPages: pages.filter(p => p.charts > 0).length, ratio: deck.cx / deck.cy };
}
export function embeddedSlideImage(deck, page) {
  const image = inspectShapes(page).filter(s => s.kind === 'picture' && s.embed && s.w >= deck.cx * .92 && s.h >= deck.cy * .92).at(-1);
  if (!image) return null;
  const relations = deck.zip.readAsText(relsFor(page.part));
  if (!relations) return null;
  const rel = relList(root(relations, 'Relationships')).find(r => r.Id === image.embed && r.Type === `${R}/image` && r.TargetMode !== 'External');
  if (!rel) return null;
  const part = targetPart(page.part, rel.Target);
  if (!/\.(png|jpe?g|webp)$/i.test(part)) return null;
  return deck.zip.readFile(part);
}
export function safeForPreview(deck) {
  return !deck.zip.getEntries().some(e => /(?:vbaProject[^/]*|activeX|embeddings)\//i.test(e.entryName) && !/\.xlsx$/i.test(e.entryName) && !e.isDirectory || /vbaProject\.bin$/i.test(e.entryName) || e.entryName.endsWith('.rels') && relList(root(e.getData().toString('utf8'), 'Relationships')).some(r => r.TargetMode === 'External' && r.Type !== `${R}/hyperlink`));
}
export function insertTiming(page, timing) {
  if (page.hasTiming) throw new Error(`第 ${page.number} 页已有动画。`);
  const extName = tag(find(page.page, 'extLst'));
  if (!extName) return beforeClose(page.xml, page.page, timing);
  const slot = childSpans(page.xml, tag(page.page)).get(extName);
  if (!slot) throw new Error('PPTX 动画插入位置无效。');
  return page.xml.slice(0, slot.start) + timing + page.xml.slice(slot.start);
}

export function buildVisualRemix(buffer, images) {
  const deck = openDeck(buffer);
  if (!images.length || new Set(images.map(v => v.page)).size !== images.length) throw new Error('必须选择不重复的页面图片。');
  const contentPath = '[Content_Types].xml';
  const types = deck.zip.readAsText(contentPath);
  const typeRoot = root(types, 'Types');
  const typePrefix = tag(typeRoot).includes(':') ? tag(typeRoot).split(':')[0] + ':' : '';
  let overrides = '';
  for (const { page, bytes } of images) {
    if (!Number.isInteger(page) || !deck.slides[page - 1] || !Buffer.isBuffer(bytes) || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('导出的页面或 JPEG 数据无效。');
    const source = deck.slides[page - 1];
    const media = `ppt/media/studio-${randomUUID()}.jpeg`;
    const rels = relsFor(source.part);
    const relXml = deck.zip.readAsText(rels) || `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${O}"></Relationships>`;
    const relRoot = root(relXml, 'Relationships');
    const prefix = tag(relRoot).includes(':') ? tag(relRoot).split(':')[0] + ':' : '';
    const used = new Set(relList(relRoot).map(r => r.Id));
    let id = 1;
    while (used.has(`rId${id}`)) id++;
    const relId = `rId${id}`;
    const relTag = `<${prefix}Relationship Id="${relId}" Type="${R}/image" Target="${xmlText(path.posix.relative(path.posix.dirname(source.part), media))}"/>`;
    const patchedRels = relXml.includes(`</${tag(relRoot)}>`)
      ? beforeClose(relXml, relRoot, relTag)
      : relXml.replace(/\/>(\s*)$/, `>${relTag}</${tag(relRoot)}>$1`);
    const outer = source.xml.match(/<(?:[\w.-]+:)?sld(?=[\s>])(?:[^<>"']|"[^"]*"|'[^']*')*>/)?.[0];
    if (!outer) throw new Error('无法定位原页面结构。');
    const patchedOuter = outer.replace(/\s+showMasterSp=(?:"[^"]*"|'[^']*')/, '').replace(/>$/, ' showMasterSp="0">');
    const children = childSpans(source.xml, tag(source.page));
    const keep = ['clrMapOvr', 'transition'].map(key => children.get(tag(find(source.page, key)))).filter(Boolean).map(span => source.xml.slice(span.start, span.end)).join('');
    const name = attrs(find(source.page, 'cSld')).name;
    const pic = `<p:cSld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}"${name ? ` name="${xmlText(name)}"` : ''}><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:pic><p:nvPicPr><p:cNvPr id="2" name="AI 页面图" descr="整页生成图，请核对文字和数据"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${deck.cx}" cy="${deck.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic></p:spTree></p:cSld>`;
    const next = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${patchedOuter}${pic}${keep}</${tag(source.page)}>`;
    if (XMLValidator.validate(next) !== true || XMLValidator.validate(patchedRels) !== true) throw new Error(`第 ${page} 页的图片关系无法写入。`);
    deck.zip.updateFile(source.part, Buffer.from(next));
    deck.zip.addFile(rels, Buffer.from(patchedRels));
    deck.zip.addFile(media, bytes);
    overrides += `<${typePrefix}Override PartName="/${media}" ContentType="image/jpeg"/>`;
  }
  deck.zip.updateFile(contentPath, Buffer.from(beforeClose(types, typeRoot, overrides)));
  return deck.zip.toBuffer();
}
