// Copyright (c) 2026 CodeForce-Lab
// All rights reserved.
// 未经许可禁止商用、二次分发

import fs from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';
import sharp from 'sharp';
import { PDFParse } from 'pdf-parse';

export const FORMATS = ['.docx', '.pptx', '.pdf', '.txt', '.md', '.png', '.jpg', '.jpeg'];
export const MAX_FILE = 80 * 1024 * 1024;
export const MAX_TOTAL = 300 * 1024 * 1024;
const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, trimValues: false });
const clean = text => String(text ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

function allText(nodes, tags) {
  let text = '';
  for (const node of Array.isArray(nodes) ? nodes : []) {
    for (const [key, value] of Object.entries(node)) {
      if (key === '#text' && tags.includes('#text')) text += clean(value);
      else if (tags.includes(key)) text += allText(value, ['#text']);
      else if (key !== ':@' && Array.isArray(value)) text += allText(value, tags);
    }
  }
  return text;
}
function paragraphs(nodes, tag, textTag) {
  const result = [];
  for (const node of Array.isArray(nodes) ? nodes : []) {
    for (const [key, value] of Object.entries(node)) {
      if (key === tag) {
        const text = allText(value, [textTag]).trim();
        if (text) result.push(text);
      } else if (key !== ':@' && Array.isArray(value)) result.push(...paragraphs(value, tag, textTag));
    }
  }
  return result;
}
function openPackage(buffer) {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  if (entries.length > 5000 || entries.reduce((sum, e) => sum + e.header.size, 0) > 180 * 1024 * 1024) {
    throw new Error('Office 文件解压体积过大，请精简后上传。');
  }
  return zip;
}
function normalizeColor(value) {
  return /^[0-9A-F]{6}$/i.test(value || '') ? value.toUpperCase() : null;
}
async function referencePalette(zip) {
  const fallback = { dark: '020B1D', ink: '09274A', accent: 'FFD26B', secondary: '30D9F4', light: 'EFF6FF', muted: '6E8CAC', pale: 'BDDEFC' };
  const slide = zip.readAsText('ppt/slides/slide1.xml');
  const rid = slide.match(/<a:blip\b[^>]*r:embed="([^"]+)"/)?.[1];
  const rels = zip.readAsText('ppt/slides/_rels/slide1.xml.rels');
  let target;
  for (const tag of rels.match(/<Relationship\b[^>]*\/?\s*>/g) || []) {
    if (tag.match(/\bId="([^"]+)"/)?.[1] === rid && !tag.includes('TargetMode="External"')) {
      target = tag.match(/\bTarget="([^"]+)"/)?.[1];
    }
  }
  if (target) {
    const mediaPath = path.posix.normalize(path.posix.join('ppt/slides', target.replaceAll('\\', '/')));
    const entry = zip.getEntry(mediaPath);
    if (entry && /\.(png|jpe?g)$/i.test(mediaPath)) {
      try {
        const { data, info } = await sharp(entry.getData(), { limitInputPixels: 80_000_000 }).resize(96, 54, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        const buckets = new Map();
        for (let i = 0; i < data.length; i += info.channels) {
          const rgb = [data[i], data[i + 1], data[i + 2]];
          const lum = rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
          if (lum > 80 || Math.max(...rgb) - Math.min(...rgb) < 12) continue;
          const key = rgb.map(v => Math.floor(v / 16)).join(',');
          const item = buckets.get(key) || { count: 0, sums: [0, 0, 0] };
          item.count++; rgb.forEach((v, j) => { item.sums[j] += v; }); buckets.set(key, item);
        }
        const primary = [...buckets.values()].sort((a, b) => b.count - a.count)[0];
        if (primary) fallback.dark = primary.sums.map(v => Math.round(v / primary.count).toString(16).padStart(2, '0')).join('').toUpperCase();
        return { ...fallback, source: '首张参考页的深色主色；金色与青色强调框架', approximate: true };
      } catch { }
    }
  }
  const theme = zip.getEntries().find(e => /^ppt\/theme\/theme\d+\.xml$/.test(e.entryName));
  if (theme) {
    const xml = theme.getData().toString('utf8');
    const slot = name => normalizeColor(xml.match(new RegExp(`<a:${name}>[\\s\\S]*?<a:srgbClr[^>]*val="([^"]+)"`))?.[1]);
    const dark = slot('dk1');
    if (dark && parseInt(dark.slice(0, 2), 16) + parseInt(dark.slice(2, 4), 16) + parseInt(dark.slice(4), 16) < 250) fallback.dark = dark;
    if (slot('accent1')) fallback.accent = slot('accent1');
    if (slot('accent2')) fallback.secondary = slot('accent2');
  }
  return { ...fallback, source: '参考演示主题色', approximate: true };
}

export async function parseMaterial(file) {
  const extension = path.extname(file.path).toLowerCase();
  const warnings = [];
  if (['.png', '.jpg', '.jpeg'].includes(extension)) {
    const metadata = await sharp(file.path, { limitInputPixels: 80_000_000 }).metadata();
    if (!['png', 'jpeg'].includes(metadata.format)) throw new Error('图片格式与扩展名不匹配。');
    return { kind: 'image', text: '', width: metadata.width, height: metadata.height, warnings };
  }
  const buffer = await fs.readFile(file.path);
  let text = '';
  let referenceStyle;
  let slideCount;
  if (extension === '.docx') {
    const zip = openPackage(buffer);
    if (!zip.getEntry('word/document.xml')) throw new Error('不是有效的 DOCX 文档。');
    text = paragraphs(parser.parse(zip.readAsText('word/document.xml')), 'w:p', 'w:t').join('\n');
  } else if (extension === '.pptx') {
    const zip = openPackage(buffer);
    const slides = zip.getEntries().filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName)).sort((a, b) => Number(a.entryName.match(/slide(\d+)/)[1]) - Number(b.entryName.match(/slide(\d+)/)[1]));
    if (!slides.length) throw new Error('不是有效的 PPTX 文档。');
    slideCount = slides.length;
    text = slides.map((e, i) => `第${i + 1}页\n${paragraphs(parser.parse(e.getData().toString('utf8')), 'a:p', 'a:t').join('\n')}`).join('\n\n');
    referenceStyle = await referencePalette(zip);
    warnings.push('参考 PPT 只解析原生文字与视觉配色；图片中的文字不会自动识别，也不会自动还原为原生对象。');
  } else if (extension === '.pdf') {
    const pdf = new PDFParse({ data: buffer });
    try { text = (await pdf.getText()).text; } finally { await pdf.destroy(); }
    if (!text.trim()) warnings.push('PDF 未检测到文本层；扫描件请先转为可复制文字的文档。');
  } else text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  text = clean(text);
  if (text.length > 500_000) throw new Error('文档正文超过50万字符，请拆分或精简。');
  return { kind: extension === '.pptx' ? 'reference' : 'document', text, referenceStyle, ...(slideCount ? { slideCount } : {}), warnings };
}
