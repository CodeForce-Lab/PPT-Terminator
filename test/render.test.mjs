// Copyright (c) 2026 CodeForce-Lab
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
// 使用、修改或分发时须保留本声明并署名 CodeForce-Lab。

import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import PptxGenJS from 'pptxgenjs';
import sharp from 'sharp';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { generatePresentation } from '../lib/render.mjs';

// No test may open COM or interfere with the user's PowerPoint session.
process.env.PPT_STUDIO_SKIP_OFFICE = '1';
const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false });
const EMU = 914400;
const layouts = ['cover', 'section', 'content', 'columns', 'metrics', 'timeline', 'photo', 'closing'];
const styles = ['launch', 'broadcast', 'executive', 'minimal'];
const array = value => value == null ? [] : Array.isArray(value) ? value : [value];
const xml = (zip, name) => zip.readAsText(name);
const textOf = source => Array.from(source.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g), match => parser.parse(`<text>${match[1]}</text>`).text).join('\n');

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ppt-studio-render-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const imagePath = path.join(root, 'photo.png');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300"><path fill="#e03030" d="M0 0h200v300H0z"/><path fill="#30b060" d="M200 0h200v300H200z"/><path fill="#3050e0" d="M400 0h200v300H400z"/></svg>';
  await sharp(Buffer.from(svg)).png().toFile(imagePath);
  return {
    root,
    asset: { id: 'stored-photo', name: '原始照片 & 客户现场', path: imagePath },
    async output(name = 'output') {
      const outputDir = path.join(root, name);
      await mkdir(outputDir);
      return outputDir;
    },
  };
}

function makeJob(style, withPhotos = true) {
  return {
    requirements: { style, pageCount: 8, topic: '大客户座谈会' },
    plan: {
      title: '携手共进 & 2026',
      subtitle: '面向未来，持续创造客户价值',
      slides: layouts.map((layout, i) => ({
        layout,
        title: `${i + 1} ${layout}：完整事实`,
        kicker: `座谈会 / ${i + 1}`,
        notes: `讲者原始备注 ${i + 1}\n保留 <事实> & 数字 123.45`,
        body: layout === 'timeline' ? ['2024：完成建设', '2025：全面覆盖', '2026：交付升级', '2027：持续服务', '2028：下一阶段'] : ['客户服务覆盖全国', '投资 123.45 亿元，时间 2026 年'],
        ...(layout === 'columns' ? { columns: [
          { title: '核心客户', body: ['服务机制', '全过程保障', '持续协同'] },
          { title: '服务质量', body: ['交付准时', '响应及时', '事实全部保留'] },
          { title: '长期价值', body: ['合作共赢', '稳健发展', '隐藏也入备注'] },
        ] } : {}),
        ...(layout === 'metrics' ? { metrics: [
          { value: '98%', label: '满意度' }, { value: '26', label: '服务区域' },
          { value: '12', label: '战略伙伴' }, { value: '8', label: '创新项目' },
        ] } : {}),
        ...(withPhotos && ['cover', 'section', 'photo', 'closing'].includes(layout) ? { imageId: 'stored-photo' } : {}),
      })),
    },
  };
}

function assertPackage(zip, count, sectionCount = 3) {
  const entries = zip.getEntries();
  assert.equal(entries.filter(entry => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName)).length, count);
  assert.equal(entries.filter(entry => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(entry.entryName)).length, count);
  for (const entry of entries.filter(entry => /\.(xml|rels)$/.test(entry.entryName))) {
    const source = entry.getData().toString('utf8');
    assert.equal(XMLValidator.validate(source), true, `invalid XML: ${entry.entryName}`);
    if (!entry.entryName.endsWith('.rels')) continue;
    for (const relation of array(parser.parse(source).Relationships.Relationship)) {
      if (relation['@_TargetMode'] === 'External') continue;
      const target = relation['@_Target'];
      const resolved = target.startsWith('/') ? target.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(path.posix.dirname(entry.entryName)), target));
      assert.ok(zip.getEntry(resolved), `${entry.entryName} -> ${resolved}`);
    }
  }
  const presentation = xml(zip, 'ppt/presentation.xml');
  assert.match(presentation, /<p14:sectionLst\b/);
  const sectionIds = Array.from(presentation.matchAll(/<p14:sldId id="(\d+)"\s*\/>/g), match => match[1]);
  assert.equal(sectionIds.length, count);
  assert.equal(new Set(sectionIds).size, count);
  assert.equal((presentation.match(/<p14:section\s/g) || []).length, sectionCount);
  const frameLayouts = entries.filter(entry => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(entry.entryName) && /name="studio-/.test(entry.getData().toString('utf8')));
  assert.equal(frameLayouts.length, 4);
  assert.equal(entries.filter(entry => /^ppt\/charts\/chart\d+\.xml$/.test(entry.entryName)).length, 0);
}

function bounds(shape) {
  const transform = shape['p:spPr']?.['a:xfrm'];
  if (!transform) return null;
  return {
    x: Number(transform['a:off']['@_x']) / EMU,
    y: Number(transform['a:off']['@_y']) / EMU,
    w: Number(transform['a:ext']['@_cx']) / EMU,
    h: Number(transform['a:ext']['@_cy']) / EMU,
  };
}

function assertCanvas(box) {
  assert.ok(box && Object.values(box).every(Number.isFinite));
  assert.ok(box.x >= 0 && box.y >= 0 && box.w > 0 && box.h > 0);
  assert.ok(box.x + box.w <= 13.334 && box.y + box.h <= 7.501);
}

function assertTextGeometry(zip, index) {
  const tree = parser.parse(xml(zip, `ppt/slides/slide${index}.xml`))['p:sld']['p:cSld']['p:spTree'];
  const texts = [];
  for (const shape of array(tree['p:sp'])) {
    const box = bounds(shape);
    assertCanvas(box);
    const paragraphs = array(shape['p:txBody']?.['a:p']);
    const lines = paragraphs.filter(p => array(p['a:r']).some(run => run['a:t'] !== '' && run['a:t'] != null));
    if (!lines.length) continue;
    const name = shape['p:nvSpPr']['p:cNvPr']['@_name'];
    const sizes = lines.flatMap(p => array(p['a:r']).map(run => Number(run['a:rPr']?.['@_sz'] || p['a:pPr']?.['a:defRPr']?.['@_sz'] || 0) / 100));
    const size = Math.max(...sizes);
    assert.ok(size >= 10, `${name}: expected native font size`);
    assert.ok(lines.length * size * 1.35 + 5 <= box.h * 72 + 0.1, `${name}: text height too small`);
    texts.push({ ...box, name });
  }
  const photos = array(tree['p:pic']).filter(pic => pic['p:nvPicPr']['p:cNvPr']['@_name'].startsWith('photo-')).map(pic => {
    const box = bounds(pic);
    assertCanvas(box);
    return { ...box, name: 'photo' };
  });
  const overlap = (a, b) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.002 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.002;
  texts.forEach((a, i) => {
    for (const b of [...texts.slice(i + 1), ...photos]) assert.equal(overlap(a, b), false, `${a.name} overlaps ${b.name}`);
  });
  return { tree, texts, photos };
}

function pictureBytes(zip, index, picture) {
  const id = picture['p:blipFill']['a:blip']['@_r:embed'];
  const relations = array(parser.parse(xml(zip, `ppt/slides/_rels/slide${index}.xml.rels`)).Relationships.Relationship);
  const relation = relations.find(item => item['@_Id'] === id);
  assert.ok(relation);
  const target = path.posix.normalize(path.posix.join('ppt/slides', relation['@_Target']));
  return zip.getEntry(target).getData();
}

const shapeText = shape => array(shape['p:txBody']?.['a:p']).flatMap(paragraph => array(paragraph['a:r']).map(run => run['a:t'] ?? '')).join('');
const fontSizes = shape => array(shape['p:txBody']?.['a:p']).flatMap(paragraph => array(paragraph['a:r']).map(run => Number(run['a:rPr']?.['@_sz']) / 100));
const placeholderShape = (tree, type) => array(tree['p:sp']).find(shape => shape['p:nvSpPr']?.['p:nvPr']?.['p:ph']?.['@_type'] === type);

function mockOffice(t, spawn) {
  const originalSpawn = childProcess.spawn;
  const originalSkip = process.env.PPT_STUDIO_SKIP_OFFICE;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  process.env.PPT_STUDIO_SKIP_OFFICE = '0';
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  childProcess.spawn = spawn;
  syncBuiltinESMExports();
  t.after(() => {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
    Object.defineProperty(process, 'platform', originalPlatform);
    if (originalSkip == null) delete process.env.PPT_STUDIO_SKIP_OFFICE;
    else process.env.PPT_STUDIO_SKIP_OFFICE = originalSkip;
  });
}

for (const style of styles) {
  test(`${style}: eight layouts, editable text, embedded photos, original notes and theme`, async t => {
    const f = await fixture(t);
    const job = makeJob(style);
    const result = await generatePresentation({ job, outputDir: await f.output(), assets: [f.asset] });
    assert.deepEqual(Object.keys(result).sort(), ['audit', 'pdfPath', 'pptxPath', 'slideImages', 'warnings'].sort());
    assert.equal(result.pdfPath, null);
    assert.deepEqual(result.slideImages, []);
    assert.deepEqual(result.audit.office, { status: 'skipped', verified: false });
    assert.equal(result.audit.packageSlideCount, 8);
    assert.equal(result.audit.nativeEditable, true);
    assert.equal(result.audit.charts, 0);
    assert.ok(result.warnings.every(warning => !/PDF|图片插入失败|不存在|无法读取/i.test(warning)));
    assert.deepEqual(await readdir(path.dirname(result.pptxPath)), ['presentation.pptx']);
    const zip = new AdmZip(await readFile(result.pptxPath));
    assertPackage(zip, 8);
    const presetHashes = style === 'launch' ? Object.fromEntries(await Promise.all(['chapter', 'content'].map(async name => [name, createHash('sha256').update(await readFile(fileURLToPath(new URL(`../public/presets/jincai/${name}.png`, import.meta.url)))).digest('hex')]))) : null;
    const darkContent = ['launch', 'broadcast'].includes(style);
    for (const entry of zip.getEntries().filter(entry => /^ppt\/theme\/theme\d+\.xml$/.test(entry.entryName))) {
      const theme = parser.parse(entry.getData().toString('utf8'))['a:theme']['a:themeElements'];
      assert.equal(theme['a:clrScheme']['a:lt1']['a:srgbClr']['@_val'], 'FFFFFF');
      assert.equal(theme['a:clrScheme']['a:dk1']['a:srgbClr']['@_val'], result.audit.palette.ink);
      assert.equal(theme['a:clrScheme']['a:accent1']['a:srgbClr']['@_val'], result.audit.palette.accent);
      assert.equal(theme['a:fontScheme']['a:majorFont']['a:ea']['@_typeface'], style === 'launch' ? 'Microsoft YaHei' : '微软雅黑');
    }
    for (let i = 0; i < 8; i++) {
      const item = result.audit.slides[i];
      const source = job.plan.slides[i];
      assert.equal(item.layout, layouts[i]);
      assert.ok(item.nativeTextCount >= 3);
      assert.deepEqual(item.textOverlaps, []);
      assert.deepEqual(item.estimatedTextOverflows, []);
      assert.equal(item.imageCount, source.imageId ? 1 : 0);
      assert.equal(item.imageError, undefined);
      const notes = textOf(xml(zip, `ppt/notesSlides/notesSlide${i + 1}.xml`));
      assert.ok(notes.includes(source.title));
      for (const line of source.notes.split('\n')) assert.ok(notes.includes(line));
      for (const fact of source.body) assert.ok(notes.includes(fact));
      for (const column of source.columns || []) for (const fact of [column.title, ...column.body]) assert.ok(notes.includes(fact));
      for (const metric of source.metrics || []) for (const fact of [metric.value, metric.label]) assert.ok(notes.includes(fact));
      if (i === 0) assert.ok(notes.includes(job.plan.subtitle));
      const { tree } = assertTextGeometry(zip, i + 1);
      const background = array(tree['p:pic']).filter(pic => pic['p:nvPicPr']['p:cNvPr']['@_name'].startsWith('background-'));
      assert.equal(background.length, style === 'launch' ? 1 : 0);
      if (style === 'launch') {
        const preset = source.layout === 'section' ? 'chapter' : 'content';
        assert.equal(createHash('sha256').update(pictureBytes(zip, i + 1, background[0])).digest('hex'), presetHashes[preset]);
        assert.equal(item.backgroundPreset, `jincai/${preset}.png`);
        const backgroundBox = bounds(background[0]);
        assert.equal(backgroundBox.x, 0);
        assert.equal(backgroundBox.y, 0);
        assert.ok(Math.abs(backgroundBox.w - 13.333) < 1 / EMU);
        assert.equal(backgroundBox.h, 7.5);
      }
      const pictures = array(tree['p:pic']).filter(pic => pic['p:nvPicPr']['p:cNvPr']['@_name'].startsWith('photo-'));
      assert.equal(pictures.length, source.imageId ? 1 : 0);
      for (const pic of pictures) {
        assert.equal(pic['p:nvPicPr']['p:cNvPr']['@_descr'], f.asset.name);
        const image = pictureBytes(zip, i + 1, pic);
        const metadata = await sharp(image).metadata();
        const box = bounds(pic);
        assert.equal(metadata.format, 'png');
        assert.ok(Math.abs(metadata.width / metadata.height - box.w / box.h) < 0.003, 'photo must not be stretched');
        const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        const offset = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
        assert.deepEqual([...data.subarray(offset, offset + 3)], [48, 176, 96], 'real source pixels preserved');
      }
      if (darkContent && i >= 2 && i <= 6) {
        const slideSource = xml(zip, `ppt/slides/slide${i + 1}.xml`);
        assert.match(slideSource, /<a:schemeClr val="bg1"/);
        assert.doesNotMatch(slideSource, /<a:schemeClr val="bg2"/);
      }
    }
    for (const entry of zip.getEntries().filter(entry => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(entry.entryName))) {
      const layout = parser.parse(entry.getData().toString('utf8'))['p:sldLayout']['p:cSld'];
      if (!layout['@_name'].startsWith('studio-')) continue;
      if (darkContent) assert.equal(layout['p:bg']['p:bgPr']['a:solidFill']['a:srgbClr']['@_val'], result.audit.palette.dark);
      const footer = array(layout['p:spTree']['p:sp']).find(shape => shape['p:txBody'] && array(shape['p:txBody']['a:p']).some(p => p['a:fld']));
      assert.ok(footer, 'native slide number remains on the layout');
      assert.equal(array(footer['p:txBody']['a:p'])[0]['a:pPr']['@_algn'], 'l');
      assertCanvas(bounds(footer));
      assert.ok(bounds(footer).h >= 0.30);
    }
    if (style === 'launch') {
      assert.equal(result.audit.palette.dark, '020B1D');
      assert.equal(result.audit.palette.ink, '09274A');
      assert.equal(result.audit.palette.accent, 'FFD26B');
      assert.equal(result.audit.palette.secondary, '30D9F4');
      assert.ok(result.audit.slides.every(item => item.decorativeImageCount === 1));
      assert.match(xml(zip, 'ppt/slides/slide7.xml'), /<a:outerShdw/);
    }
    const metricsText = xml(zip, 'ppt/slides/slide5.xml');
    assert.match(metricsText, /sz="4800"/);
    assert.ok(textOf(metricsText).includes('98%'));
  });
}

test('default launch chapters reuse the exact bundled background and fixed native title frame', async t => {
  const f = await fixture(t);
  const chapterPositions = [5, 10, 15];
  const job = {
    requirements: { pageCount: 19 },
    plan: { slides: Array.from({ length: 19 }, (_, i) => ({
      layout: chapterPositions.includes(i) ? 'section' : i === 0 ? 'cover' : 'content',
      title: chapterPositions.includes(i) ? ['服务保障', '携手共进', '未来展望'][chapterPositions.indexOf(i)] : `客户交流 ${i + 1}`,
      body: ['携手客户，持续创造价值'], notes: `原始备注 ${i + 1}`,
    })) },
  };
  const result = await generatePresentation({ job, outputDir: await f.output() });
  const zip = new AdmZip(await readFile(result.pptxPath));
  assert.equal(result.audit.style, 'launch');
  assert.equal(result.audit.font, 'Microsoft YaHei');
  assertPackage(zip, 19, 4);
  const expected = createHash('sha256').update(await readFile(fileURLToPath(new URL('../public/presets/jincai/chapter.png', import.meta.url)))).digest('hex');
  const hashes = [];
  const titleFrames = [];
  for (const position of chapterPositions) {
    const index = position + 1;
    const { tree } = assertTextGeometry(zip, index);
    const pictures = array(tree['p:pic']);
    assert.equal(pictures.length, 1, 'no generated decoration or text image');
    hashes.push(createHash('sha256').update(pictureBytes(zip, index, pictures[0])).digest('hex'));
    assert.ok(Math.abs(bounds(pictures[0]).w - 13.333) < 1 / EMU);
    assert.equal(bounds(pictures[0]).h, 7.5);
    const title = placeholderShape(tree, 'title');
    assert.equal(shapeText(title), job.plan.slides[position].title);
    assert.ok(fontSizes(title).every(size => size === 54));
    assert.ok(Math.abs(bounds(title).x * 96 - 114) < 0.001);
    assert.ok(Math.abs(bounds(title).y * 96 - 270) < 0.001);
    titleFrames.push(bounds(title));
    const body = array(tree['p:sp']).find(shape => shapeText(shape) === job.plan.slides[position].body[0]);
    assert.ok(Math.abs(bounds(body).x * 96 - 114) < 0.001);
    assert.ok(Math.abs(bounds(body).y * 96 - 396) < 0.001);
  }
  assert.deepEqual(hashes, [expected, expected, expected]);
  assert.deepEqual(titleFrames, [titleFrames[0], titleFrames[0], titleFrames[0]]);
  assert.ok(!result.warnings.some(warning => /缩短|缺失或无效/.test(warning)));
});

test('chapter indices are 01/02/03 rather than absolute slide numbers', async t => {
  const f = await fixture(t);
  for (const style of styles) {
    const job = { requirements: { style }, plan: { slides: ['cover', 'content', 'section', 'content', 'content', 'section', 'content', 'section'].map((layout, i) => ({ layout, title: '章节标题', body: ['要点'], notes: `保留备注 ${i}` })) } };
    const result = await generatePresentation({ job, outputDir: await f.output(style) });
    const zip = new AdmZip(await readFile(result.pptxPath));
    const chapters = result.audit.slides.filter(item => item.layout === 'section');
    assert.deepEqual(chapters.map(item => item.slide), [3, 6, 8]);
    assert.deepEqual(chapters.map(item => item.chapterNumber), [1, 2, 3]);
    for (const [i, chapter] of chapters.entries()) {
      const { tree } = assertTextGeometry(zip, chapter.slide);
      const indexShape = array(tree['p:sp']).find(shape => shapeText(shape) === `0${i + 1}`);
      assert.ok(indexShape, `${style}: chapter ${i + 1} is native text`);
      if (style === 'launch') {
        assert.ok(Math.abs(bounds(indexShape).x * 96 - 112) < 0.001);
        assert.ok(Math.abs(bounds(indexShape).y * 96 - 129) < 0.001);
        assert.ok(fontSizes(indexShape).every(size => size === 54));
      }
    }
  }
});

test('launch content fits a long title at readable size and keeps aligned larger body text', async t => {
  const f = await fixture(t);
  const title = '持续优化服务保障机制携手核心客户共创长期合作新局面推动区域服务品质提升形成发展新优势';
  const job = { requirements: { style: 'launch' }, plan: { slides: [{ layout: 'content', title, body: ['服务更及时，协同更高效', '保障客户需求，深化长期合作'], notes: '原始讲者备注' }] } };
  const result = await generatePresentation({ job, outputDir: await f.output() });
  const zip = new AdmZip(await readFile(result.pptxPath));
  const { tree } = assertTextGeometry(zip, 1);
  const titleShape = placeholderShape(tree, 'title');
  assert.equal(shapeText(titleShape), title);
  assert.ok(fontSizes(titleShape).every(size => size >= 26 && size < 36));
  assert.ok(Math.abs(bounds(titleShape).x * 96 - 114) < 0.001);
  for (const value of job.plan.slides[0].body) {
    const body = array(tree['p:sp']).find(shape => shapeText(shape) === value);
    assert.ok(body);
    assert.ok(fontSizes(body).every(size => size >= 24));
    assert.ok(Math.abs(bounds(body).x - bounds(titleShape).x) < 1 / EMU);
  }
  assert.deepEqual(result.audit.slides[0].truncatedFields, []);
  assert.ok(result.audit.slides[0].adjustedFontSizes.some(item => item.field === 'title'));
  assert.ok(!result.warnings.some(warning => /缩短/.test(warning)));
});

test('reference prefixes from one to five pages stay blank and keep exactly 19 slides with native notes', async t => {
  const f = await fixture(t);
  let officeCalls = 0;
  mockOffice(t, () => { officeCalls++; throw new Error('reference generation must never start Office'); });
  for (let count = 1; count <= 5; count++) {
    const job = {
      requirements: { style: 'launch', pageCount: 19 },
      referenceDeck: { path: path.join(f.root, 'reference-original.pptx'), count },
      plan: { title: '参考原稿', subtitle: '保留原始副标题', slides: Array.from({ length: 19 }, (_, i) => ({
        layout: i < count ? 'reference' : i === count ? 'section' : 'content',
        ...(i < count ? { referenceSlideIndex: i, imageId: 'must-not-load' } : {}),
        title: `原始标题 ${i + 1}`, kicker: '不应出现在参考占位页', body: [`完整正文 ${i + 1} & <事实>`], notes: `原始备注 ${i + 1}\n保留全部讲者信息`,
      })) },
    };
    const outputDir = await f.output(`prefix-${count}`);
    await writeFile(path.join(outputDir, 'slide-01.png'), 'old preview');
    await writeFile(path.join(outputDir, 'qa.json'), '{"completed":true}');
    const result = await generatePresentation({ job, outputDir });
    const zip = new AdmZip(await readFile(result.pptxPath));
    assertPackage(zip, 19, 2);
    assert.equal(result.audit.packageSlideCount, 19);
    assert.deepEqual(result.audit.office, { status: 'pending-reference-merge', verified: false });
    assert.deepEqual(result.audit.referenceDeck, { count, placeholderSlides: count });
    assert.equal(result.pdfPath, null);
    assert.deepEqual(result.slideImages, []);
    assert.ok(result.warnings.some(warning => /等待主进程合并/.test(warning)));
    assert.ok(!result.warnings.some(warning => /must-not-load|不存在|跳过 PowerPoint|layout 无效/.test(warning)));
    assert.deepEqual(await readdir(outputDir), ['presentation.pptx']);
    for (let i = 0; i < count; i++) {
      const source = xml(zip, `ppt/slides/slide${i + 1}.xml`);
      const tree = parser.parse(source)['p:sld']['p:cSld']['p:spTree'];
      assert.equal(textOf(source), '');
      assert.equal(array(tree['p:sp']).length, 0);
      assert.equal(array(tree['p:pic']).length, 0);
      assert.doesNotMatch(source, /<p:ph\b|<a:fld\b/);
      const relation = array(parser.parse(xml(zip, `ppt/slides/_rels/slide${i + 1}.xml.rels`)).Relationships.Relationship).find(item => item['@_Type'].endsWith('/slideLayout'));
      const layoutPath = path.posix.normalize(path.posix.join('ppt/slides', relation['@_Target']));
      const blankLayout = parser.parse(xml(zip, layoutPath))['p:sldLayout']['p:cSld']['p:spTree'];
      assert.equal(array(blankLayout['p:sp']).length, 0, 'blank layout must not inherit a title or page number');
      const notes = textOf(xml(zip, `ppt/notesSlides/notesSlide${i + 1}.xml`));
      for (const value of [job.plan.slides[i].title, ...job.plan.slides[i].body, ...job.plan.slides[i].notes.split('\n'), `referenceSlideIndex: ${i}`]) assert.ok(notes.includes(value));
      assert.equal(result.audit.slides[i].layout, 'reference');
      assert.equal(result.audit.slides[i].referenceSlideIndex, i);
      assert.equal(result.audit.slides[i].nativeTextCount, 0);
      assert.equal(result.audit.slides[i].nativeShapeCount, 0);
      assert.equal(result.audit.slides[i].imageCount, 0);
    }
    assert.equal(result.audit.slides[count].chapterNumber, 1);
    for (let i = count + 1; i <= 19; i++) assertTextGeometry(zip, i);
  }
  assert.equal(officeCalls, 0);
});

test('reference layout works without a referenceDeck and rejects invalid source indices or prefixes', async t => {
  const f = await fixture(t);
  const outputDir = await f.output();
  const job = { requirements: { style: 'minimal' }, plan: { slides: [{ layout: 'reference', referenceSlideIndex: 4, title: '仅备注原文', body: ['原始正文'], notes: '原始备注' }] } };
  const result = await generatePresentation({ job, outputDir });
  assert.deepEqual(result.audit.office, { status: 'skipped', verified: false });
  const zip = new AdmZip(await readFile(result.pptxPath));
  assert.equal(textOf(xml(zip, 'ppt/slides/slide1.xml')), '');
  assert.ok(textOf(xml(zip, 'ppt/notesSlides/notesSlide1.xml')).includes('原始正文'));
  for (const referenceSlideIndex of [-1, 5, 1.5, '0', null, undefined]) {
    const invalid = structuredClone(job);
    invalid.plan.slides[0].referenceSlideIndex = referenceSlideIndex;
    await assert.rejects(generatePresentation({ job: invalid, outputDir }), /referenceSlideIndex/);
  }
  for (const referenceDeck of [{ path: 'relative.pptx', count: 1 }, { path: path.join(f.root, 'original.pptx'), count: 0 }, { path: path.join(f.root, 'original.pptx'), count: 6 }]) {
    await assert.rejects(generatePresentation({ job: { ...job, referenceDeck }, outputDir }), /referenceDeck/);
  }
  const referenceDeck = { path: path.join(f.root, 'original.pptx'), count: 1 };
  await assert.rejects(generatePresentation({ job: { ...job, referenceDeck }, outputDir }), /referenceSlideIndex 从 0/);
  const wrongPrefix = structuredClone(job);
  wrongPrefix.referenceDeck = referenceDeck;
  wrongPrefix.plan.slides = [{ layout: 'content', title: '不是占位页' }];
  await assert.rejects(generatePresentation({ job: wrongPrefix, outputDir }), /referenceDeck/);
});

test('preview gaps preserve original slide numbers and retain actual Office overflow audit', async t => {
  const f = await fixture(t);
  const outputDir = await f.output();
  const image = await readFile(f.asset.path);
  const qa = { completed: true, slideCount: 3, slides: [{ slide: 1, textOverflows: [{ shape: 'title' }], shapeOverflows: [{ shape: 'photo' }] }], warnings: ['实际审计警告'] };
  let officeCalls = 0;
  let exporterError;
  mockOffice(t, (command, args) => {
    officeCalls++;
    assert.equal(command, 'powershell.exe');
    assert.ok(args.includes('-SkipPdf'));
    const child = new EventEmitter();
    setImmediate(async () => {
      try {
        await writeFile(path.join(outputDir, 'slide-01.png'), image);
        await writeFile(path.join(outputDir, 'slide-02.png'), 'invalid PNG');
        await writeFile(path.join(outputDir, 'slide-03.png'), image);
        await writeFile(path.join(outputDir, 'qa.json'), JSON.stringify(qa));
      } catch (error) { exporterError = error; }
      child.emit('close', exporterError ? 1 : 0);
    });
    return child;
  });
  const job = { requirements: { style: 'minimal' }, plan: { slides: Array.from({ length: 3 }, () => ({ layout: 'content', title: '内容', body: ['原始要点'] })) } };
  const result = await generatePresentation({ job, outputDir });
  assert.ifError(exporterError);
  assert.equal(officeCalls, 1);
  assert.deepEqual(result.slideImages.map(file => path.basename(file)), ['slide-01.png', 'slide-03.png']);
  assert.deepEqual(result.audit.office.previewSlides, [{ number: 1, fileName: 'slide-01.png' }, { number: 3, fileName: 'slide-03.png' }]);
  assert.deepEqual(result.audit.office.qa, qa);
  assert.ok(result.warnings.some(warning => /PNG 预览不完整：2\/3/.test(warning)));
  assert.ok(result.warnings.some(warning => /2 处文本或形状越界/.test(warning)));
  assert.ok(result.warnings.includes('实际审计警告'));
});

test('photo-only containment and EXIF orientation preserve the aspect ratio', async t => {
  const f = await fixture(t);
  const rotatedPath = path.join(f.root, 'rotated.jpg');
  await sharp(f.asset.path).jpeg().withMetadata({ orientation: 6 }).toFile(rotatedPath);
  const job = { requirements: { style: 'launch' }, plan: { slides: [{ layout: 'photo', title: '原始方向', imageId: 'rotated', notes: '不能拉伸或丢失照片' }] } };
  const result = await generatePresentation({ job, outputDir: await f.output(), assets: [{ id: 'rotated', name: '旋转照片', path: rotatedPath }] });
  const zip = new AdmZip(await readFile(result.pptxPath));
  const { tree } = assertTextGeometry(zip, 1);
  const pic = array(tree['p:pic']).find(item => item['p:nvPicPr']['p:cNvPr']['@_name'] === 'photo-1');
  const metadata = await sharp(pictureBytes(zip, 1, pic)).metadata();
  assert.equal(metadata.width, 300);
  assert.equal(metadata.height, 600);
  assert.ok(Math.abs(bounds(pic).w / bounds(pic).h - 0.5) < 0.0001);
  assert.equal(result.audit.slides[0].imageCount, 1);
});

test('referenceStyle accepts only six-digit hex colors and safely applies overrides', async t => {
  const f = await fixture(t);
  const job = makeJob('launch', false);
  job.referenceStyle = { dark: '031122', ink: '123456', accent: 'aabbcc', secondary: '22ccee', light: 'F1F3F5', muted: '6789ab', pale: 'ccddee', unexpected: 'FF0000' };
  const result = await generatePresentation({ job, outputDir: await f.output('valid') });
  assert.deepEqual(result.audit.palette, { dark: '031122', ink: '123456', accent: 'AABBCC', secondary: '22CCEE', light: 'F1F3F5', muted: '6789AB', pale: 'CCDDEE' });
  const zip = new AdmZip(await readFile(result.pptxPath));
  assert.match(xml(zip, 'ppt/theme/theme1.xml'), /<a:accent1><a:srgbClr val="AABBCC"/);
  const coverFrame = zip.getEntries().find(entry => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(entry.entryName) && /name="studio-launch-cover"/.test(entry.getData().toString('utf8')));
  assert.ok(coverFrame);
  assert.match(coverFrame.getData().toString('utf8'), /<a:srgbClr val="031122"/);
  job.referenceStyle = { dark: '#000000', ink: '11223344', accent: '"/><bad/>', secondary: 123456, light: null, muted: ' ABCDEF ', pale: 'xyzxyz' };
  const invalid = await generatePresentation({ job, outputDir: await f.output('invalid') });
  assert.equal(invalid.warnings.filter(w => w.startsWith('referenceStyle.')).length, 7);
  assert.equal(invalid.audit.palette.dark, '020B1D');
  assert.equal(invalid.audit.palette.accent, 'FFD26B');
  for (const entry of new AdmZip(await readFile(invalid.pptxPath)).getEntries().filter(entry => entry.entryName.endsWith('.xml'))) assert.equal(XMLValidator.validate(entry.getData().toString('utf8')), true);
  job.referenceStyle = ['invalid'];
  const malformed = await generatePresentation({ job, outputDir: await f.output('malformed') });
  assert.ok(malformed.warnings.some(w => /referenceStyle 无效/.test(w)));
});

test('dense content is shortened without overlap; every original fact remains in native notes', async t => {
  const f = await fixture(t);
  const job = makeJob('launch', false);
  const original = '长文本原文：预算 123456789.123 元，日期 2026-11-26，责任人 张先生。\n第二行 & <事实>。'.repeat(30);
  for (const slide of job.plan.slides) {
    slide.title = original;
    slide.kicker = original;
    slide.body = Array.from({ length: 12 }, (_, i) => `事实 ${i}: ${original}`);
    slide.metrics = Array.from({ length: 7 }, (_, i) => ({ value: `${i} ${original}`, label: original }));
    slide.columns = Array.from({ length: 5 }, (_, i) => ({ title: `列 ${i} ${original}`, body: [original, original, original, original] }));
  }
  const result = await generatePresentation({ job, outputDir: await f.output() });
  const zip = new AdmZip(await readFile(result.pptxPath));
  for (let i = 0; i < 8; i++) {
    assertTextGeometry(zip, i + 1);
    assert.deepEqual(result.audit.slides[i].textOverlaps, []);
    assert.deepEqual(result.audit.slides[i].estimatedTextOverflows, []);
    assert.ok(result.audit.slides[i].truncatedFields.length);
    assert.ok(result.audit.slides[i].truncatedFields.some(item => item.field === 'title'));
    assert.ok(result.warnings.some(warning => warning.startsWith(`第 ${i + 1} 页：`) && /缩短或移至备注/.test(warning)));
    assert.ok(textOf(xml(zip, `ppt/slides/slide${i + 1}.xml`)).includes('…'));
    const notes = textOf(xml(zip, `ppt/notesSlides/notesSlide${i + 1}.xml`));
    assert.ok(notes.includes(original));
    assert.ok(notes.includes(job.plan.slides[i].body[11]));
    assert.ok(notes.includes(job.plan.slides[i].metrics[6].value));
    assert.ok(notes.includes(job.plan.slides[i].columns[4].title));
  }
});

test('structured photo requests embed the photo and retain all metrics and columns in notes', async t => {
  const f = await fixture(t);
  const job = makeJob('executive', false);
  for (const slide of job.plan.slides) slide.imageId = f.asset.id;
  const result = await generatePresentation({ job, outputDir: await f.output(), assets: [f.asset] });
  const zip = new AdmZip(await readFile(result.pptxPath));
  for (let i = 0; i < 8; i++) {
    assert.equal(result.audit.slides[i].imageCount, 1);
    assertTextGeometry(zip, i + 1);
  }
  assert.equal(result.audit.slides[4].layout, 'photo');
  assert.ok(textOf(xml(zip, 'ppt/notesSlides/notesSlide5.xml')).includes('98%'));
  assert.ok(textOf(xml(zip, 'ppt/notesSlides/notesSlide4.xml')).includes('隐藏也入备注'));
});

test('missing, corrupt and unsafe image paths always produce explicit warnings and audit errors', async t => {
  const f = await fixture(t);
  const corrupt = path.join(f.root, 'corrupt.png');
  await writeFile(corrupt, 'not an image');
  const assets = [f.asset, { id: 'corrupt', name: '损坏照片', path: corrupt }, { id: 'relative', name: '相对路径', path: 'photo.png' }, { id: 'absent-file', name: '不存在的文件', path: path.join(f.root, 'missing.jpg') }];
  const ids = ['missing-asset', 'corrupt', 'relative', 'absent-file', f.asset.id];
  const job = { requirements: { style: 'minimal' }, plan: { slides: ids.map(imageId => ({ layout: 'photo', title: imageId, imageId, body: ['原始文本不得丢失'], notes: '失败必须明确报告' })) } };
  const result = await generatePresentation({ job, outputDir: await f.output(), assets });
  assert.ok(result.warnings.some(w => /missing-asset.*不存在/.test(w)));
  for (const name of ['损坏照片', '相对路径', '不存在的文件']) assert.ok(result.warnings.some(w => w.includes(name) && w.includes('原因：')));
  assert.deepEqual(result.audit.slides.map(item => item.imageCount), [0, 0, 0, 0, 1]);
  assert.deepEqual(result.audit.slides.slice(0, 4).map(item => item.imageError), [true, true, true, true]);
  const zip = new AdmZip(await readFile(result.pptxPath));
  for (let i = 1; i <= ids.length; i++) assert.ok(textOf(xml(zip, `ppt/notesSlides/notesSlide${i}.xml`)).includes('原始文本不得丢失'));
});

test('Sharp crop errors and addImage failures are never swallowed', async t => {
  const f = await fixture(t);
  const job = { requirements: { style: 'minimal' }, plan: { slides: [{ layout: 'photo', title: '明确错误', imageId: f.asset.id, body: ['图片与原文'] }] } };
  const resize = sharp.prototype.resize;
  sharp.prototype.resize = function (...args) {
    if (typeof args[0] === 'number') throw new Error('injected crop failure');
    return resize.apply(this, args);
  };
  try {
    await assert.rejects(generatePresentation({ job, outputDir: await f.output('crop-failure'), assets: [f.asset] }), /第 1 页图片.*插入失败.*injected crop failure/);
  } finally {
    sharp.prototype.resize = resize;
  }
  const addSlide = PptxGenJS.prototype.addSlide;
  PptxGenJS.prototype.addSlide = function (...args) {
    const slide = addSlide.apply(this, args);
    const addImage = slide.addImage;
    slide.addImage = function (options) {
      if (options.objectName?.startsWith('photo-')) throw new Error('injected addImage failure');
      return addImage.call(this, options);
    };
    return slide;
  };
  try {
    await assert.rejects(generatePresentation({ job, outputDir: await f.output('insert-failure'), assets: [f.asset] }), /第 1 页图片.*插入失败.*injected addImage failure/);
  } finally {
    PptxGenJS.prototype.addSlide = addSlide;
  }
});

test('PPTX-only previews preserve the Office PNG/audit contract without terminating Office', async () => {
  const source = await readFile(fileURLToPath(new URL('../lib/render.mjs', import.meta.url)), 'utf8');
  assert.match(source, /'-OutputDir', outputDir, '-SkipPdf'/);
  assert.doesNotMatch(source, /imageSizingContain|imageSizingCrop|%PDF-|\.kill\s*\(|taskkill|Stop-Process/);
  assert.doesNotMatch(source, /warnings\.push\([^\n]*(?:PDF|preview\.pdf)/i);
  assert.match(source, /qa\.json/);
  assert.match(source, /textOverflows/);
  assert.match(source, /shapeOverflows/);
  assert.match(source, /PNG 预览不完整/);
});

test('invalid plans reject, unknown layouts/styles fall back without losing notes', async t => {
  const f = await fixture(t);
  const outputDir = await f.output();
  await assert.rejects(generatePresentation({ job: { plan: { slides: [] } }, outputDir }), /非空数组/);
  await assert.rejects(generatePresentation({ job: makeJob('minimal'), outputDir: 'relative' }), /绝对目录/);
  const job = { requirements: { style: 'unknown', pageCount: 99 }, plan: { slides: [{ layout: 'unknown', title: '保留事实', body: ['预算 100 万元'], notes: '完整备注' }] } };
  const result = await generatePresentation({ job, outputDir });
  assert.equal(result.audit.style, 'minimal');
  assert.equal(result.audit.slides[0].layout, 'content');
  assert.ok(result.warnings.some(w => /未知风格/.test(w)));
  assert.ok(result.warnings.some(w => /layout 无效/.test(w)));
  assert.ok(result.warnings.some(w => /pageCount 与 plan 不一致/.test(w)));
  const zip = new AdmZip(await readFile(result.pptxPath));
  assert.ok(textOf(xml(zip, 'ppt/notesSlides/notesSlide1.xml')).includes('预算 100 万元'));
});
