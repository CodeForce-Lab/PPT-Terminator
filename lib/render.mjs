// Copyright (c) 2026 CodeForce-Lab
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
// 使用、修改或分发时须保留本声明并署名 CodeForce-Lab。

import { spawn } from 'node:child_process';
import { readFile, readdir, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PptxGenJS from 'pptxgenjs';
import AdmZip from 'adm-zip';
import sharp from 'sharp';

const WIDTH = 13.333;
const HEIGHT = 7.5;
const LEFT = 0.68;
const INNER = WIDTH - LEFT * 2;
const FONT = '微软雅黑';
const LAUNCH_FONT = 'Microsoft YaHei';
const LAUNCH_LEFT = 114 / 96;
const LAUNCH_INNER = WIDTH - LAUNCH_LEFT * 2;
const OFFICE_SCRIPT = fileURLToPath(new URL('../scripts/export-presentation.ps1', import.meta.url));
const LAUNCH_BACKGROUNDS = {
  chapter: fileURLToPath(new URL('../public/presets/jincai/chapter.png', import.meta.url)),
  content: fileURLToPath(new URL('../public/presets/jincai/content.png', import.meta.url)),
};
const LAYOUTS = new Set(['cover', 'section', 'content', 'columns', 'metrics', 'timeline', 'photo', 'closing', 'reference']);
const STYLES = {
  launch: { dark: '020B1D', ink: '09274A', accent: 'FFD26B', secondary: '30D9F4', light: 'EFF6FF', muted: '6E8CAC', pale: 'C8DDF3' },
  broadcast: { dark: '06142D', ink: '112D53', accent: 'FFD26B', secondary: 'D73042', light: 'EFF4FA', muted: '536A84', pale: 'CBD8ED' },
  executive: { dark: '142B2D', ink: '193638', accent: 'D7BD82', secondary: '4F8A82', light: 'F3F7F6', muted: '536C69', pale: 'CBDCD6' },
  minimal: { dark: '202124', ink: '26282C', accent: 'C4D7FF', secondary: '777E8A', light: 'F5F6F8', muted: '616774', pale: 'D5D7DE' },
};

const raw = value => value == null ? '' : String(value);
const clean = value => raw(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/gu, '').replace(/\r\n?/g, '\n');
const compact = value => clean(value).replace(/\s+/gu, ' ').trim();
const shortLabel = (value, length = 70) => Array.from(compact(value)).slice(0, length).join('');
const LINE_HEIGHT = 1.35;
const TEXT_SLACK = 5;
const contentIsDark = style => style === 'launch' || style === 'broadcast';
const panelColor = ctx => ctx.dark ? ctx.C.text1 : ctx.C.background2;
const minimumTextHeight = size => (size * LINE_HEIGHT + TEXT_SLACK) / 72;

function resolvePalette(style, referenceStyle, warnings) {
  const palette = { ...STYLES[style] };
  if (referenceStyle == null) return palette;
  if (typeof referenceStyle !== 'object' || Array.isArray(referenceStyle)) {
    warnings.push('referenceStyle 无效，已保留默认配色。');
    return palette;
  }
  for (const key of Object.keys(palette)) {
    if (!Object.hasOwn(referenceStyle, key)) continue;
    const value = referenceStyle[key];
    if (typeof value === 'string' && /^[0-9a-f]{6}$/i.test(value)) palette[key] = value.toUpperCase();
    else warnings.push(`referenceStyle.${key} 不是六位十六进制颜色，已保留默认值。`);
  }
  return palette;
}

async function prepareBackgrounds(style, warnings) {
  if (style !== 'launch') return null;
  const backgrounds = {};
  for (const [name, filePath] of Object.entries(LAUNCH_BACKGROUNDS)) {
    try {
      const buffer = await readFile(filePath);
      const metadata = await sharp(buffer, { limitInputPixels: 80_000_000, failOn: 'warning' }).metadata();
      if (metadata.format !== 'png' || !metadata.width || !metadata.height) throw new Error('invalid preset image');
      backgrounds[name] = `image/png;base64,${buffer.toString('base64')}`;
    } catch {
      warnings.push(`launch 内置背景 ${name}.png 缺失或无效，已使用纯色背景；未替换为其他素材。`);
    }
  }
  return backgrounds;
}

function contentBox(style) {
  const launch = style === 'launch';
  return { x: launch ? LAUNCH_LEFT : LEFT, y: launch ? 2.82 : 2.65, w: launch ? LAUNCH_INNER : INNER, h: launch ? 3.83 : 3.93 };
}

function checkBox(box) {
  if (![box.x, box.y, box.w, box.h].every(Number.isFinite) || box.w <= 0 || box.h <= 0 || box.x < 0 || box.y < 0 || box.x + box.w > WIDTH + 0.001 || box.y + box.h > HEIGHT + 0.001) {
    throw new RangeError('Slide geometry must remain inside the 13.333 × 7.5 inch canvas.');
  }
}

function characterWidth(char) {
  if (/\s/u.test(char)) return 0.35;
  if (/[ilI.,'!:;|]/u.test(char)) return 0.36;
  if (/[MW@#%&]/u.test(char)) return 0.95;
  if (/^[\x20-\x7e]$/u.test(char)) return 0.64;
  return 1.08;
}

// Conservative wrapping keeps editable text readable without Office autofit.
function fitText(value, box, fontSize, maxLines) {
  const text = compact(value);
  const capacity = Math.max(1.1, box.w * 72 / fontSize * 0.88);
  const limit = Math.max(0, Math.min(maxLines ?? Infinity, Math.floor((box.h * 72 - TEXT_SLACK) / (fontSize * LINE_HEIGHT))));
  if (!text || !limit) return { text: '', truncated: Boolean(text), lines: 0 };
  const lines = [];
  let line = '';
  let used = 0;
  let truncated = false;
  for (const char of Array.from(text)) {
    const size = characterWidth(char);
    if (used + size > capacity && line) {
      lines.push(line.trimEnd());
      line = '';
      used = 0;
      if (lines.length >= limit) {
        truncated = true;
        break;
      }
    }
    if (!line && /\s/u.test(char)) continue;
    line += char;
    used += size;
  }
  if (!truncated && line) lines.push(line.trimEnd());
  if (truncated) {
    let last = lines.pop() ?? '';
    let width = Array.from(last).reduce((sum, char) => sum + characterWidth(char), 0);
    while (last && width + 1.08 > capacity) {
      const chars = Array.from(last);
      width -= characterWidth(chars.pop());
      last = chars.join('');
    }
    lines.push(`${last.trimEnd()}…`);
  }
  return { text: lines.join('\n'), truncated, lines: lines.length };
}

function readableFontSize(value, box, preferred, minimum, maxLines) {
  for (let size = preferred; size > minimum; size--) {
    if (!fitText(value, box, size, maxLines).truncated) return size;
  }
  return minimum;
}

function textOptions(box, size, color, extra = {}) {
  return {
    ...box, fontFace: '+mn-ea', fontSize: size, color, lang: 'zh-CN',
    isTextBox: true, margin: 0, valign: 'top', breakLine: false,
    lineSpacingMultiple: 1.05, paraSpaceAfter: 0, paraSpaceBefore: 0,
    fit: 'none', ...extra,
  };
}

function frameSpecs(style) {
  const title = style === 'launch'
    ? { x: LAUNCH_LEFT, y: 1.1, w: LAUNCH_INNER, h: 1.42, size: 36, minimumSize: 26, lines: 2 }
    : { x: LEFT, y: 1.01, w: INNER, h: 1.3, size: 32, lines: 2 };
  const cover = {
    launch: { x: LAUNCH_LEFT, y: 2.08, w: 7.8, h: 1.75, size: 40, minimumSize: 28, lines: 2 },
    broadcast: { x: LEFT, y: 1.18, w: 10.95, h: 2.1, size: 40, lines: 3 },
    executive: { x: 1.02, y: 2.12, w: 10.15, h: 1.7, size: 36, lines: 2 },
    minimal: { x: 1.72, y: 2.15, w: 9.89, h: 1.75, size: 38, lines: 2, align: 'center' },
  }[style];
  return {
    content: { title, kicker: { x: style === 'launch' ? LAUNCH_LEFT : LEFT, y: 0.54, w: title.w - 0.6, h: 0.36, size: 11, lines: 1 } },
    cover: {
      title: cover,
      kicker: { x: cover.x, y: style === 'broadcast' ? 0.58 : 1.28, w: cover.w, h: 0.4, size: 12, lines: 1, align: cover.align },
    },
    section: style === 'launch' ? {
      title: { x: LAUNCH_LEFT, y: 270 / 96, w: LAUNCH_INNER, h: 1.15, size: 54, lines: 1 },
      kicker: { x: 2.9, y: 1.65, w: 7.25, h: 0.4, size: 12, lines: 1 },
    } : {
      title: { x: 2.7, y: 2.28, w: 9.85, h: 1.62, size: 38, lines: 2 },
      kicker: { x: 2.7, y: 1.57, w: 9.6, h: 0.4, size: 12, lines: 1 },
    },
    closing: {
      title: { x: style === 'launch' ? LAUNCH_LEFT : LEFT, y: 1.62, w: 10.5, h: 1.7, size: 38, ...(style === 'launch' ? { minimumSize: 28 } : {}), lines: 2 },
      kicker: { x: style === 'launch' ? LAUNCH_LEFT : LEFT, y: 0.92, w: 10.5, h: 0.4, size: 12, lines: 1 },
    },
  };
}

function defineFrames(pptx, style, palette) {
  const specs = frameSpecs(style);
  const colors = pptx.SchemeColor;
  for (const [name, spec] of Object.entries(specs)) {
    const dark = name !== 'content' || contentIsDark(style);
    const placeholders = Object.entries(spec).map(([key, box]) => {
      const { size, minimumSize, lines, align, ...position } = box;
      return {
        placeholder: {
          options: {
            ...textOptions(position, size, key === 'kicker' ? colors.accent1 : dark ? colors.background1 : colors.text1, {
              align: align || 'left', bold: key === 'title', fontFace: key === 'title' ? '+mj-ea' : '+mn-ea',
            }),
            name: key, type: key === 'title' ? 'title' : 'body',
          },
          text: '',
        },
      };
    });
    pptx.defineSlideMaster({
      title: `studio-${style}-${name}`,
      background: { color: dark ? palette.dark : 'FFFFFF' },
      margin: 0,
      objects: placeholders,
      slideNumber: {
        x: 11.98, y: 6.98, w: 0.67, h: 0.32, fontFace: '+mn-ea', fontSize: 10,
        color: dark ? colors.background1 : colors.text2, margin: 0, align: 'left',
      },
    });
  }
  return specs;
}

function sourceFields(source, job, index) {
  const fields = new Map();
  const put = (key, value) => { if (raw(value)) fields.set(key, raw(value)); };
  put('title', source.title || (index === 0 ? job.plan.title || job.title : ''));
  put('kicker', source.kicker);
  if (index === 0) put('subtitle', job.plan.subtitle);
  (source.body ?? []).forEach((value, i) => put(`body[${i}]`, value));
  (source.metrics ?? []).forEach((metric, i) => {
    put(`metrics[${i}].value`, metric.value);
    put(`metrics[${i}].label`, metric.label);
  });
  (source.columns ?? []).forEach((column, i) => {
    put(`columns[${i}].title`, column.title);
    (column.body ?? []).forEach((value, j) => put(`columns[${i}].body[${j}]`, value));
  });
  return fields;
}

function addSourceNotes(slide, source, fields, reduced = new Map()) {
  const originals = [...fields].map(([key, value]) => `${key}:\n${clean(value)}`).join('\n\n');
  const changes = [...reduced].map(([key, reason]) => `${key}: ${reason}`).join('\n');
  slide.addNotes([
    clean(source.notes),
    '【完整原文 / Source content】', originals,
    source.imageId ? `imageId: ${clean(source.imageId)}` : '',
    source.layout === 'reference' ? `referenceSlideIndex: ${source.referenceSlideIndex}` : '',
    changes ? `【版面处理】\n${changes}` : '',
  ].filter(Boolean).join('\n\n'));
}

function slideContext(pptx, slide, source, fields, audit, warnings, dark, palette, style) {
  const consumed = new Set();
  const reduced = new Map();
  const C = pptx.SchemeColor;
  const foreground = dark ? C.background1 : C.text1;
  const muted = dark ? C.accent6 : C.text2;
  const textBoxes = [];
  const photoBoxes = [];
  function recordText(fit, box, size) {
    if (!fit.text) return;
    textBoxes.push({ x: box.x, y: box.y, w: box.w, h: box.h, fontSize: size, lines: fit.lines });
  }
  function reduce(key, reason) {
    if (fields.has(key)) reduced.set(key, reason);
  }
  function drawText(value, box, size = 18, color = foreground, options = {}) {
    checkBox(box);
    const fit = fitText(value, box, size, options.maxLines);
    if (fit.text) {
      const { maxLines, ...extra } = options;
      slide.addText(fit.text, textOptions(box, size, color, { objectName: `s${audit.slide}-text-${audit.nativeTextCount + 1}`, ...extra }));
      audit.nativeTextCount++;
      audit.nativeShapeCount++;
      recordText(fit, box, size);
    }
    return fit;
  }
  function field(key, box, size = 18, color = foreground, options = {}) {
    consumed.add(key);
    const fit = drawText(fields.get(key) ?? '', box, size, color, options);
    if (fit.truncated) reduce(key, '文字超出可读区域，已缩短');
    return fit;
  }
  function placeholder(key, spec) {
    consumed.add(key);
    checkBox(spec);
    const value = fields.get(key) ?? '';
    const size = spec.minimumSize ? readableFontSize(value, spec, spec.size, spec.minimumSize, spec.lines) : spec.size;
    const fit = fitText(value, spec, size, spec.lines);
    recordText(fit, spec, size);
    slide.addText([{ text: fit.text, options: { fontSize: size } }], { placeholder: key, isTextBox: true, margin: 0, objectName: `s${audit.slide}-${key}` });
    if (size !== spec.size) (audit.adjustedFontSizes ??= []).push({ field: key, fontSize: size, preferredSize: spec.size });
    if (fit.text) audit.nativeTextCount++;
    audit.nativeShapeCount++;
    if (fit.truncated) reduce(key, '文字超出占位区域，已缩短');
  }
  function shape(type, box, fill, lineColor, extra = {}) {
    checkBox(box);
    slide.addShape(type, {
      ...box, fill: { color: fill, transparency: extra.transparency ?? 0 },
      line: lineColor ? { color: lineColor, width: 1 } : { type: 'none' },
      objectName: `s${audit.slide}-shape-${audit.nativeShapeCount + 1}`, ...extra,
    });
    audit.nativeShapeCount++;
  }
  function finish() {
    const intersects = (a, b) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.002
      && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.002;
    audit.textOverlaps = [];
    audit.estimatedTextOverflows = [];
    textBoxes.forEach((box, i) => {
      if (box.lines * box.fontSize * LINE_HEIGHT + TEXT_SLACK > box.h * 72 + 0.01) audit.estimatedTextOverflows.push(i);
      for (let j = i + 1; j < textBoxes.length; j++) if (intersects(box, textBoxes[j])) audit.textOverlaps.push([i, j]);
      photoBoxes.forEach((photo, j) => { if (intersects(box, photo)) audit.textOverlaps.push([i, `photo-${j}`]); });
    });
    if (audit.textOverlaps.length || audit.estimatedTextOverflows.length) throw new RangeError(`第 ${audit.slide} 页文本区域重叠或超出可读高度。`);
    for (const [key] of fields) if (!consumed.has(key)) reduce(key, '本页未能展示，完整内容保留在备注');
    audit.truncatedFields = [...reduced].map(([fieldName, reason]) => ({ field: fieldName, reason }));
    if (reduced.size) warnings.push(`第 ${audit.slide} 页：${reduced.size} 个字段已缩短或移至备注，完整原文见 notes。`);
    addSourceNotes(slide, source, fields, reduced);
  }
  return { pptx, slide, source, fields, audit, C, foreground, muted, field, drawText, placeholder, shape, finish, reduce, consumed, dark, palette, photoBoxes, style, contentBox: contentBox(style) };
}

function bodyKeys(ctx) {
  return [...ctx.fields.keys()].filter(key => key.startsWith('body['));
}

function textList(ctx, keys, box, { size = 19, maxItems = 5, numbered = false } = {}) {
  const gap = 0.18;
  const height = Math.max(minimumTextHeight(size), numbered ? 0.38 : 0);
  const visible = keys.slice(0, Math.min(maxItems, Math.floor((box.h + gap) / (height + gap))));
  if (!visible.length) return;
  const rowHeight = (box.h - gap * (visible.length - 1)) / visible.length;
  if (ctx.style === 'launch') {
    const textBox = { w: box.w - (numbered ? 0.56 : 0), h: rowHeight };
    size = Math.min(...visible.map(key => readableFontSize(ctx.fields.get(key), textBox, size, Math.min(size, 20))));
  }
  visible.forEach((key, index) => {
    const y = box.y + index * (rowHeight + gap);
    if (numbered) {
      ctx.shape(ctx.pptx.ShapeType.ellipse, { x: box.x, y: y + 0.02, w: 0.36, h: 0.36 }, panelColor(ctx));
      ctx.drawText(String(index + 1).padStart(2, '0'), { x: box.x + 0.02, y: y + 0.04, w: 0.32, h: 0.30 }, 10, ctx.dark ? ctx.C.accent1 : ctx.foreground, { align: 'center' });
    }
    ctx.field(key, { x: box.x + (numbered ? 0.56 : 0), y, w: box.w - (numbered ? 0.56 : 0), h: rowHeight }, size);
  });
}

function neutralContent(ctx, keys, box) {
  if (!keys.length) return;
  if (ctx.style === 'launch') {
    textList(ctx, keys, box, { size: keys.length === 1 ? 30 : keys.length <= 3 ? 26 : 24, maxItems: 5 });
  } else if (keys.length <= 2) {
    ctx.shape(ctx.pptx.ShapeType.roundRect, { ...box }, panelColor(ctx), null, { radius: 0.18 });
    textList(ctx, keys, { x: box.x + 0.36, y: box.y + 0.4, w: box.w - 0.72, h: box.h - 0.8 }, { size: keys.length === 1 ? 26 : 22, maxItems: 2 });
  } else if (keys.length <= 4 && keys.every(key => Array.from(compact(ctx.fields.get(key))).length < 120)) {
    const gap = 0.28;
    const width = (box.w - gap) / 2;
    const height = (box.h - gap) / 2;
    keys.forEach((key, i) => {
      const x = box.x + i % 2 * (width + gap);
      const y = box.y + Math.floor(i / 2) * (height + gap);
      ctx.shape(ctx.pptx.ShapeType.roundRect, { x, y, w: width, h: height }, panelColor(ctx));
      ctx.drawText(String(i + 1).padStart(2, '0'), { x: x + 0.28, y: y + 0.2, w: 0.55, h: 0.3 }, 11, ctx.muted);
      ctx.field(key, { x: x + 0.28, y: y + 0.68, w: width - 0.56, h: height - 0.88 }, 18);
    });
  } else {
    textList(ctx, keys, box, { size: keys.length > 4 ? 18 : 20, maxItems: 5, numbered: true });
  }
}

async function drawCover(ctx, style, image) {
  const { C, pptx } = ctx;
  if (style === 'broadcast') {
    ctx.shape(pptx.ShapeType.ellipse, { x: 11.95, y: 0.61, w: 0.32, h: 0.32 }, C.accent2);
    ctx.shape(pptx.ShapeType.roundRect, { x: LEFT, y: 3.63, w: INNER, h: 2.95 }, C.text1);
  } else if (style === 'executive') {
    ctx.shape(pptx.ShapeType.rect, { x: 0.7, y: 1.85, w: 11.95, h: 4.35 }, C.text2);
  } else if (style === 'minimal') {
    ctx.shape(pptx.ShapeType.ellipse, { x: 6.37, y: 0.88, w: 0.58, h: 0.58 }, C.accent1);
  }
  const subtitleY = { launch: 4.07, broadcast: 3.93, executive: 4.03, minimal: 4.16 }[style];
  const x = style === 'launch' ? LAUNCH_LEFT : style === 'executive' ? 1.02 : style === 'minimal' ? 1.72 : LEFT;
  const w = style === 'launch' ? 7.8 : style === 'minimal' ? 9.89 : style === 'executive' ? 10.15 : 10.95;
  const photo = style === 'launch' ? { x: 9.35, y: 2.1, w: 3.3, h: 4.45 } : { x: 9.72, y: 4.98, w: 2.88, h: 1.59 };
  const bodyWidth = image ? Math.min(w, photo.x - x - 0.4) : w;
  ctx.field('subtitle', { x, y: subtitleY, w: bodyWidth, h: 0.85 }, 20, ctx.C.accent6, { align: style === 'minimal' ? 'center' : 'left', maxLines: 2 });
  textList(ctx, bodyKeys(ctx), { x, y: subtitleY + 1.07, w: bodyWidth, h: 1.02 }, { size: 17, maxItems: 2 });
  if (image) await addPhoto(ctx, image, photo, style === 'launch' ? 'crop' : 'contain');
}

async function drawDivider(ctx, closing, image) {
  if (ctx.style === 'launch' && !closing) {
    ctx.drawText(String(ctx.audit.chapterNumber).padStart(2, '0'), { x: 112 / 96, y: 129 / 96, w: 1.42, h: 1.15 }, 54, ctx.C.background1, { bold: true, objectName: `chapter-index-${ctx.audit.slide}` });
    const photo = { x: 9.55, y: 4.2, w: 2.45, h: 2.22 };
    textList(ctx, bodyKeys(ctx), { x: LAUNCH_LEFT, y: 396 / 96, w: image ? photo.x - LAUNCH_LEFT - 0.4 : LAUNCH_INNER, h: 2.27 }, { size: 24, maxItems: 3 });
    if (image) await addPhoto(ctx, image, photo, 'contain');
    return;
  }
  const x = closing ? ctx.style === 'launch' ? LAUNCH_LEFT : LEFT : 2.7;
  if (!closing) {
    ctx.shape(ctx.pptx.ShapeType.ellipse, { x: LEFT, y: 2.3, w: 1.48, h: 1.48 }, ctx.C.accent1);
    ctx.drawText(String(ctx.audit.chapterNumber).padStart(2, '0'), { x: LEFT + 0.16, y: 2.66, w: 1.16, h: 0.72 }, 30, ctx.C.text1, { align: 'center', bold: true });
  } else {
    ctx.shape(ctx.pptx.ShapeType.ellipse, { x: 11.78, y: 1.7, w: 0.72, h: 0.72 }, ctx.C.accent1);
  }
  const photo = { x: 10.2, y: 4.2, w: 2.45, h: 2.22 };
  const w = image ? photo.x - x - 0.4 : closing ? 10.8 : 9.65;
  textList(ctx, bodyKeys(ctx), { x, y: closing ? 3.72 : 4.15, w, h: closing ? 2.45 : 2.02 }, { size: 21, maxItems: 3 });
  if (image) await addPhoto(ctx, image, photo, 'contain');
}

function drawColumns(ctx) {
  const { x: left, y: top, w: inner, h: height } = ctx.contentBox;
  const columns = ctx.source.columns ?? [];
  if (!columns.length) {
    const keys = bodyKeys(ctx);
    if (keys.length < 2) return neutralContent(ctx, keys, ctx.contentBox);
    const mid = Math.ceil(keys.length / 2);
    for (let i = 0; i < 2; i++) {
      const x = left + i * (inner + 0.3) / 2;
      const w = (inner - 0.3) / 2;
      ctx.shape(ctx.pptx.ShapeType.roundRect, { x, y: top, w, h: height }, panelColor(ctx));
      textList(ctx, keys.slice(i * mid, (i + 1) * mid), { x: x + 0.32, y: top + 0.37, w: w - 0.64, h: height - 0.81 }, { size: ctx.style === 'launch' ? 22 : 18, maxItems: 4 });
    }
    return;
  }
  const visible = columns.slice(0, 3);
  const gap = 0.3;
  const w = (inner - gap * (visible.length - 1)) / visible.length;
  const hasBody = bodyKeys(ctx).length > 0;
  visible.forEach((column, i) => {
    const x = left + i * (w + gap);
    const h = hasBody ? height - 0.88 : height;
    ctx.shape(ctx.pptx.ShapeType.roundRect, { x, y: top, w, h }, panelColor(ctx));
    ctx.field(`columns[${i}].title`, { x: x + 0.28, y: top + 0.32, w: w - 0.56, h: 0.94 }, 22, ctx.foreground, { bold: true, maxLines: 2 });
    textList(ctx, (column.body ?? []).map((_, j) => `columns[${i}].body[${j}]`), { x: x + 0.28, y: top + 1.47, w: w - 0.56, h: h - 1.77 }, { size: ctx.style === 'launch' ? 20 : 17, maxItems: 3 });
  });
  if (hasBody) textList(ctx, bodyKeys(ctx), { x: left, y: top + height - 0.6, w: inner, h: 0.67 }, { size: ctx.style === 'launch' ? 20 : 17, maxItems: 1 });
}

function drawMetrics(ctx) {
  const { x: left, y: top, w: inner, h: height } = ctx.contentBox;
  const metrics = ctx.source.metrics ?? [];
  if (!metrics.length) return neutralContent(ctx, bodyKeys(ctx), ctx.contentBox);
  const visible = metrics.slice(0, 4);
  const gap = 0.3;
  const w = (inner - gap * (visible.length - 1)) / visible.length;
  visible.forEach((metric, i) => {
    const x = left + i * (w + gap);
    ctx.shape(ctx.pptx.ShapeType.roundRect, { x, y: top, w, h: 2.62 }, panelColor(ctx));
    const units = Array.from(compact(metric.value)).reduce((sum, char) => sum + characterWidth(char), 0);
    const size = Math.max(28, Math.min(visible.length >= 4 ? 48 : 60, Math.floor((w - 0.5) * 72 * 0.88 / Math.max(1, units))));
    ctx.field(`metrics[${i}].value`, { x: x + 0.25, y: top + 0.33, w: w - 0.5, h: 1.30 }, size, ctx.dark ? ctx.C.accent1 : ctx.foreground, { bold: true, maxLines: 1 });
    ctx.field(`metrics[${i}].label`, { x: x + 0.25, y: top + 1.79, w: w - 0.5, h: 0.68 }, 16, ctx.muted, { maxLines: 2 });
  });
  textList(ctx, bodyKeys(ctx), { x: left, y: top + 2.9, w: inner, h: height - 2.83 }, { size: ctx.style === 'launch' ? 22 : 18, maxItems: 2 });
}

function drawTimeline(ctx) {
  const { x: left, y: top, w: inner, h: height } = ctx.contentBox;
  const keys = bodyKeys(ctx).slice(0, 5);
  if (!keys.length) return;
  const vertical = keys.length > 3 || keys.some(key => Array.from(compact(ctx.fields.get(key))).length > 85);
  if (vertical) {
    const gap = 0.18;
    const h = (height - gap * (keys.length - 1)) / keys.length;
    keys.forEach((key, i) => {
      const y = top + i * (h + gap);
      ctx.shape(ctx.pptx.ShapeType.ellipse, { x: left, y: y + 0.04, w: 0.4, h: 0.4 }, panelColor(ctx));
      ctx.drawText(String(i + 1).padStart(2, '0'), { x: left + 0.03, y: y + 0.09, w: 0.34, h: 0.30 }, 10, ctx.foreground, { align: 'center' });
      ctx.field(key, { x: left + 0.75, y, w: inner - 0.75, h }, ctx.style === 'launch' ? 22 : 18);
    });
  } else {
    const gap = 0.35;
    const w = (inner - gap * (keys.length - 1)) / keys.length;
    keys.forEach((key, i) => {
      const x = left + i * (w + gap);
      ctx.shape(ctx.pptx.ShapeType.roundRect, { x, y: top, w, h: height }, panelColor(ctx));
      ctx.drawText(String(i + 1).padStart(2, '0'), { x: x + 0.3, y: top + 0.33, w: 1.05, h: 0.72 }, 30, ctx.foreground, { bold: true });
      ctx.field(key, { x: x + 0.3, y: top + 1.38, w: w - 0.6, h: height - 1.85 }, ctx.style === 'launch' ? 22 : 19);
    });
  }
}

async function photoFrame(image, box, mode) {
  if (!Buffer.isBuffer(image.buffer) || !Number.isFinite(image.aspect) || image.aspect <= 0) throw new TypeError('图片缺少有效缓冲区或宽高信息。');
  if (!['crop', 'contain'].includes(mode)) throw new TypeError(`未知图片缩放模式：${mode}`);
  if (mode === 'contain') {
    const w = Math.min(box.w, box.h * image.aspect);
    const h = w / image.aspect;
    return { data: image.data, x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
  }
  const width = Math.max(1, Math.round(box.w * 180));
  const height = Math.max(1, Math.round(box.h * 180));
  const key = `${width}x${height}`;
  if (!image.crops.has(key)) {
    const frame = await sharp(image.buffer, { failOn: 'warning' }).resize(width, height, { fit: 'cover', position: 'centre' }).png().toBuffer();
    image.crops.set(key, `image/png;base64,${frame.toString('base64')}`);
  }
  return { data: image.crops.get(key), ...box };
}

async function addPhoto(ctx, image, box, mode = 'crop') {
  checkBox(box);
  try {
    const inset = 0.055;
    const inner = { x: box.x + inset, y: box.y + inset, w: box.w - inset * 2, h: box.h - inset * 2 };
    checkBox(inner);
    const frame = await photoFrame(image, inner, mode);
    checkBox(frame);
    ctx.shape(ctx.pptx.ShapeType.rect, box, panelColor(ctx), ctx.C.accent2, ctx.dark ? {
      shadow: { type: 'outer', color: ctx.palette.secondary, blur: 8, angle: 0, offset: 0, opacity: 0.22 },
    } : {});
    ctx.slide.addImage({ ...frame, objectName: `photo-${ctx.audit.slide}`, altText: clean(image.name || '用户照片') });
    ctx.audit.imageCount++;
    ctx.audit.nativeShapeCount++;
    ctx.photoBoxes.push({ ...box });
  } catch (cause) {
    throw new Error(`第 ${ctx.audit.slide} 页图片 ${shortLabel(image.name || ctx.source.imageId)} 插入失败：${cause.message}`, { cause });
  }
}

async function drawPhoto(ctx, image) {
  const { x, y, w, h } = ctx.contentBox;
  const keys = bodyKeys(ctx);
  if (!image) return neutralContent(ctx, keys, ctx.contentBox);
  const hasText = keys.length > 0;
  const textWidth = ctx.style === 'launch' ? (w - 0.47) * 0.43 : 4.85;
  const offset = textWidth + 0.47;
  const box = hasText ? { x: x + offset, y, w: w - offset, h } : { x, y, w, h };
  await addPhoto(ctx, image, box, hasText ? 'crop' : 'contain');
  if (hasText) textList(ctx, keys, { x, y: y + 0.11, w: textWidth, h: h - 0.25 }, { size: ctx.style === 'launch' ? 24 : 19, maxItems: 4 });
}

async function prepareImages(assets, referencedIds, warnings) {
  const available = new Map();
  for (const asset of assets) if (asset?.id != null && !available.has(String(asset.id))) available.set(String(asset.id), asset);
  const images = new Map();
  for (const id of referencedIds) {
    const asset = available.get(id);
    if (!asset) {
      warnings.push(`图片 ${shortLabel(id)} 不存在，已使用原生文本版式。`);
      continue;
    }
    try {
      if (typeof asset.path !== 'string' || !path.isAbsolute(asset.path) || !/\.(png|jpe?g)$/i.test(asset.path)) throw new Error('invalid image path');
      const processor = sharp(asset.path, { limitInputPixels: 80_000_000, failOn: 'warning' });
      const metadata = await processor.metadata();
      if (!['png', 'jpeg'].includes(metadata.format) || !metadata.width || !metadata.height) throw new Error('invalid image format');
      const { data: buffer, info } = await processor.rotate().resize({ width: 2400, height: 1800, fit: 'inside', withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
      images.set(id, { name: asset.name, buffer, width: info.width, height: info.height, aspect: info.width / info.height, data: `image/png;base64,${buffer.toString('base64')}`, crops: new Map() });
    } catch (error) {
      warnings.push(`图片 ${shortLabel(asset.name || id)} 无法读取或不是有效 JPG/PNG，已跳过；PPTX 仍可生成。原因：${shortLabel(error.message, 120)}`);
    }
  }
  return images;
}

// pptxgenjs exposes fonts but not its native theme palette or East Asian fonts.
function applyNativeTheme(buffer, style, palette) {
  const font = style === 'launch' ? LAUNCH_FONT : FONT;
  const zip = new AdmZip(buffer);
  const colors = {
    dk1: palette.ink, lt1: 'FFFFFF', dk2: palette.muted, lt2: palette.light,
    accent1: palette.accent, accent2: palette.secondary, accent3: '8DA8B8',
    accent4: 'C19B6E', accent5: '9AA1AF', accent6: palette.pale,
    hlink: palette.secondary, folHlink: palette.muted,
  };
  for (const entry of zip.getEntries().filter(item => /^ppt\/theme\/theme\d+\.xml$/.test(item.entryName))) {
    let xml = entry.getData().toString('utf8');
    xml = xml.replace(/<a:clrScheme\b[^>]*>[\s\S]*?<\/a:clrScheme>/, `<a:clrScheme name="Studio ${style}">${Object.entries(colors).map(([key, color]) => `<a:${key}><a:srgbClr val="${color}"/></a:${key}>`).join('')}</a:clrScheme>`);
    xml = xml.replace(/<a:fontScheme\b[^>]*>[\s\S]*?<\/a:fontScheme>/, `<a:fontScheme name="Studio Chinese">${['majorFont', 'minorFont'].map(tag => `<a:${tag}><a:latin typeface="${font}"/><a:ea typeface="${font}"/><a:cs typeface="${font}"/><a:font script="Hans" typeface="${font}"/></a:${tag}>`).join('')}</a:fontScheme>`);
    zip.updateFile(entry.entryName, Buffer.from(xml));
  }
  return zip.toBuffer();
}

async function removeOldPreviews(outputDir) {
  const entries = await readdir(outputDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && (entry.name === 'preview.pdf' || entry.name === 'qa.json' || /^slide-\d+\.png$/i.test(entry.name))) {
      await unlink(path.join(outputDir, entry.name));
    }
  }
}

function runOffice(inputPath, outputDir) {
  return new Promise(resolve => {
    let settled = false;
    let timedOut = false;
    let child;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      // Never terminate PowerPoint or its COM host; the protected exporter owns cleanup.
      finish({ status: 'timeout' });
    }, 180_000);
    timer.unref();
    try {
      child = spawn('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', OFFICE_SCRIPT,
        '-InputPath', inputPath, '-OutputDir', outputDir, '-SkipPdf',
      ], { windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'ignore'] });
      child.once('error', () => finish({ status: 'unavailable' }));
      child.once('close', code => finish({ status: timedOut ? 'timeout' : code === 0 ? 'completed' : 'failed' }));
    } catch {
      finish({ status: 'unavailable' });
    }
  });
}

async function validOutput(filePath, prefix) {
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size < prefix.length) return false;
    const data = await readFile(filePath);
    return data.subarray(0, prefix.length).equals(prefix);
  } catch {
    return false;
  }
}

export async function exportPreviews(pptxPath, outputDir, count, warnings) {
  if (process.env.PPT_STUDIO_SKIP_OFFICE === '1') {
    warnings.push('已设置 PPT_STUDIO_SKIP_OFFICE=1：跳过 PowerPoint，未生成 PNG，未执行本机排版审计。');
    return { pdfPath: null, slideImages: [], office: { status: 'skipped', verified: false } };
  }
  if (process.platform !== 'win32') {
    warnings.push('当前不是 Windows：保留可编辑 PPTX，PNG 预览需要本机 PowerPoint。');
    return { pdfPath: null, slideImages: [], office: { status: 'unavailable', verified: false } };
  }
  const run = await runOffice(pptxPath, outputDir);
  let qa = null;
  try { qa = JSON.parse(await readFile(path.join(outputDir, 'qa.json'), 'utf8')); } catch { /* The exporter may fail before COM opens. */ }
  if (run.status !== 'completed') {
    const reason = run.status === 'timeout' ? '超时（180 秒）' : run.status === 'unavailable' ? '不可用' : '失败';
    warnings.push(`PowerPoint 导出${reason}：PPTX 已保留；PNG 可能不完整。`);
  }
  if (qa?.warnings?.length) warnings.push(...qa.warnings.filter(value => typeof value === 'string'));
  const slideImages = [];
  const previewSlides = [];
  for (let i = 1; i <= count; i++) {
    const fileName = `slide-${String(i).padStart(2, '0')}.png`;
    const candidateImage = path.join(outputDir, fileName);
    if (await validOutput(candidateImage, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      slideImages.push(candidateImage);
      previewSlides.push({ number: i, fileName });
    }
  }
  if (slideImages.length !== count) warnings.push(`PNG 预览不完整：${slideImages.length}/${count} 页。`);
  if (qa?.slideCount != null && qa.slideCount !== count) warnings.push(`PowerPoint 实际页数 ${qa.slideCount} 与计划 ${count} 不一致。`);
  const overflowCount = qa?.slides?.reduce((sum, slide) => sum + (slide.textOverflows?.length || 0) + (slide.shapeOverflows?.length || 0), 0) ?? 0;
  if (overflowCount) warnings.push(`PowerPoint 实测发现 ${overflowCount} 处文本或形状越界，详见 audit.office.qa。`);
  const overlapPages = qa?.slides?.filter(slide => slide.textIntersections?.length).map(slide => slide.slide) ?? [];
  if (overlapPages.length) warnings.push(`PowerPoint 实测文字重叠：第 ${overlapPages.join('、')} 页。`);
  if (!qa) warnings.push('PowerPoint 未返回 qa.json，实际文本边界未经验证。');
  else if (!qa.auditComplete) warnings.push('PowerPoint 实测排版审计不完整。');
  const verified = run.status === 'completed' && qa?.completed === true && qa.auditComplete === true && qa.slideCount === count && slideImages.length === count && !overflowCount && !overlapPages.length;
  return {
    pdfPath: null, slideImages,
    office: { status: run.status, verified, previewSlides, qa },
  };
}

function validateReferences(job) {
  if (job.referenceDeck != null) {
    const reference = job.referenceDeck;
    if (!reference || typeof reference !== 'object' || Array.isArray(reference) || typeof reference.path !== 'string' || !path.isAbsolute(reference.path)
      || !Number.isInteger(reference.count) || reference.count < 1 || reference.count > 5 || reference.count > job.plan.slides.length) {
      throw new TypeError('referenceDeck 必须包含绝对 path 和 1–5 的 count，且不得超过计划页数。');
    }
    for (let i = 0; i < job.plan.slides.length; i++) {
      const source = job.plan.slides[i];
      if (i < reference.count ? source.layout !== 'reference' || source.referenceSlideIndex !== i : source.layout === 'reference') {
        throw new TypeError('referenceDeck 的前 count 页必须是按 referenceSlideIndex 从 0 连续排列的 reference 占位页。');
      }
    }
  }
  for (const source of job.plan.slides) {
    if (source.layout === 'reference' && (!Number.isInteger(source.referenceSlideIndex) || source.referenceSlideIndex < 0 || source.referenceSlideIndex > 4)) {
      throw new TypeError('referenceSlideIndex 必须是 0–4 的整数。');
    }
  }
}

export async function generatePresentation({ job, outputDir, assets = [] }) {
  if (!job?.plan || !Array.isArray(job.plan.slides) || job.plan.slides.length === 0) throw new TypeError('job.plan.slides 必须是非空数组。');
  if (typeof outputDir !== 'string' || !path.isAbsolute(outputDir)) throw new TypeError('outputDir 必须是已存在的绝对目录。');
  if (!(await stat(outputDir)).isDirectory()) throw new TypeError('outputDir 必须是目录。');
  outputDir = await realpath(outputDir);
  for (const slide of job.plan.slides) {
    if (!slide || typeof slide !== 'object' || (slide.body != null && !Array.isArray(slide.body)) || (slide.metrics != null && !Array.isArray(slide.metrics)) || (slide.columns != null && !Array.isArray(slide.columns))) throw new TypeError('无效的 slide 数据结构。');
  }
  validateReferences(job);
  const warnings = [];
  const requestedStyle = job.requirements?.style || 'launch';
  const style = Object.hasOwn(STYLES, requestedStyle) ? requestedStyle : 'minimal';
  if (style !== requestedStyle) warnings.push('未知风格，已采用 minimal。');
  const count = job.plan.slides.length;
  if (job.requirements?.pageCount != null && Number(job.requirements.pageCount) !== count) warnings.push(`pageCount 与 plan 不一致；以 plan 的 ${count} 页为准，不增删页面。`);
  const palette = resolvePalette(style, job.referenceStyle, warnings);
  const backgrounds = await prepareBackgrounds(style, warnings);
  const font = style === 'launch' ? LAUNCH_FONT : FONT;
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'STUDIO_WIDE', width: WIDTH, height: HEIGHT });
  pptx.layout = 'STUDIO_WIDE';
  pptx.theme = { headFontFace: font, bodyFontFace: font };
  pptx.author = 'Local PPT Studio';
  pptx.company = 'Local PPT Studio';
  pptx.title = clean(job.plan.title || job.title || 'Presentation');
  pptx.subject = clean(job.requirements?.topic || '');
  pptx.lang = 'zh-CN';
  const specs = defineFrames(pptx, style, palette);
  const images = await prepareImages(Array.isArray(assets) ? assets : [], new Set(job.plan.slides.filter(slide => slide.layout !== 'reference').map(slide => slide.imageId == null ? '' : String(slide.imageId)).filter(Boolean)), warnings);
  const audit = {
    version: 1, style, palette: { ...palette }, slideCount: count, canvas: { width: WIDTH, height: HEIGHT, unit: 'inch' },
    font, nativeEditable: true, charts: 0, geometryChecked: true,
    textFit: 'conservative-estimate; actual TextFrame2 measurements require PowerPoint',
    slides: [], office: null,
  };
  let sectionTitle;
  let chapterNumber = 0;
  for (let i = 0; i < count; i++) {
    const source = job.plan.slides[i];
    let layout = LAYOUTS.has(source.layout) ? source.layout : 'content';
    if (layout !== source.layout) warnings.push(`第 ${i + 1} 页 layout 无效，使用 content。`);
    const image = images.get(String(source.imageId));
    if (image && !['cover', 'section', 'photo', 'closing', 'reference'].includes(layout)) {
      warnings.push(`第 ${i + 1} 页：为容纳独立照片，使用 photo 图文版式；未显示的结构化内容保留在 notes。`);
      layout = 'photo';
    }
    const frame = ['cover', 'section', 'closing'].includes(layout) ? layout : 'content';
    if (i === 0 || layout === 'section' || layout === 'closing') {
      sectionTitle = `${String(i + 1).padStart(2, '0')} ${shortLabel(source.title || job.plan.title || job.title || '演示文稿', 60)}`;
      pptx.addSection({ title: sectionTitle });
    }
    const slide = pptx.addSlide(layout === 'reference' ? { sectionTitle } : { masterName: `studio-${style}-${frame}`, sectionTitle });
    const item = { slide: i + 1, requestedLayout: source.layout, layout, nativeTextCount: 0, nativeShapeCount: layout === 'reference' ? 0 : 1, imageCount: 0, truncatedFields: [] };
    audit.slides.push(item);
    const fields = sourceFields(source, job, i);
    if (layout === 'reference') {
      item.referenceSlideIndex = source.referenceSlideIndex;
      item.textOverlaps = [];
      item.estimatedTextOverflows = [];
      addSourceNotes(slide, source, fields);
      continue;
    }
    if (layout === 'section') { chapterNumber = source.chapterNumber || chapterNumber + 1; item.chapterNumber = chapterNumber; }
    const ctx = slideContext(pptx, slide, source, fields, item, warnings, frame !== 'content' || contentIsDark(style), palette, style);
    const backgroundName = layout === 'section' ? 'chapter' : 'content';
    if (backgrounds?.[backgroundName]) {
      slide.addImage({ data: backgrounds[backgroundName], x: 0, y: 0, w: WIDTH, h: HEIGHT, objectName: `background-${i + 1}`, altText: `锦彩内置 ${backgroundName} 背景（无正文）` });
      item.nativeShapeCount++;
      item.decorativeImageCount = 1;
      item.backgroundPreset = `jincai/${backgroundName}.png`;
    }
    if (source.imageId != null && String(source.imageId) && !image) item.imageError = true;
    if (layout === 'cover') await drawCover(ctx, style, image);
    else if (layout === 'section' || layout === 'closing') await drawDivider(ctx, layout === 'closing', image);
    else if (layout === 'columns') drawColumns(ctx);
    else if (layout === 'metrics') drawMetrics(ctx);
    else if (layout === 'timeline') drawTimeline(ctx);
    else if (layout === 'photo') await drawPhoto(ctx, image);
    else neutralContent(ctx, bodyKeys(ctx), ctx.contentBox);
    for (const [name, spec] of Object.entries(specs[frame])) ctx.placeholder(name, spec);
    if (item.imageError || (image && item.imageCount === 0)) warnings.push(`第 ${i + 1} 页图片插入失败，已保留原生文字内容。`);
    ctx.finish();
  }
  const pptxPath = path.join(outputDir, 'presentation.pptx');
  const data = await pptx.write({ outputType: 'nodebuffer', compression: true });
  await writeFile(pptxPath, applyNativeTheme(data, style, palette));
  const zip = new AdmZip(await readFile(pptxPath));
  audit.packageSlideCount = zip.getEntries().filter(entry => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName)).length;
  if (audit.packageSlideCount !== count) throw new Error('PPTX slide count does not match plan.');
  if (job.referenceDeck) {
    audit.referenceDeck = { count: job.referenceDeck.count, placeholderSlides: audit.slides.filter(item => item.layout === 'reference').length };
    warnings.push(`前 ${job.referenceDeck.count} 页为参考原稿占位页，等待主进程合并；合并前不生成 PNG，也未执行 PowerPoint 实测审计。`);
  }
  try {
    await removeOldPreviews(outputDir);
  } catch {
    warnings.push('无法清理旧预览：为避免返回过期文件，跳过本次 PNG 导出。');
    audit.office = { status: job.referenceDeck ? 'pending-reference-merge' : 'cleanup-failed', verified: false };
    return { pptxPath, pdfPath: null, slideImages: [], warnings, audit };
  }
  if (job.referenceDeck) {
    audit.office = { status: 'pending-reference-merge', verified: false };
    return { pptxPath, pdfPath: null, slideImages: [], warnings, audit };
  }
  try {
    const preview = await exportPreviews(pptxPath, outputDir, count, warnings);
    audit.office = preview.office;
    return { pptxPath, pdfPath: preview.pdfPath, slideImages: preview.slideImages, warnings, audit };
  } catch {
    warnings.push('本机预览/审计发生异常，已保留可编辑 PPTX；PNG 不可用。');
    audit.office = { status: 'failed', verified: false };
    return { pptxPath, pdfPath: null, slideImages: [], warnings, audit };
  }
}
