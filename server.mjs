// Copyright (c) 2026 CodeForce-Lab
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
// 使用、修改或分发时须保留本声明并署名 CodeForce-Lab。

import express from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FORMATS, MAX_FILE, MAX_TOTAL, parseMaterial } from './lib/materials.mjs';
import { validateRequirements, validatePlan, validateReferencePrefix, basicPlan, aiPlan } from './lib/planner.mjs';
import { validateSettings, protectKey, callModel } from './lib/model.mjs';
import { generatePresentation } from './lib/render.mjs';
import { finalizeReference } from './lib/finalize.mjs';
import { imageDefaults, summarizeImageSettings, validateImageSettings, testImage } from './lib/image-model.mjs';
import { openDeck, summarizeDeck } from './lib/pptx-deck.mjs';
import { buildShow } from './lib/studio-show.mjs';
import { remixPages } from './lib/studio-remix.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUSY = new Set(['analyzing', 'generating']);
const error = (message, status = 400) => Object.assign(new Error(message), { status });
const decodeName = value => {
  if (/[^\u0000-\u00ff]/.test(value)) return value;
  const decoded = Buffer.from(value, 'latin1').toString('utf8');
  return decoded.includes('\uFFFD') ? value : decoded;
};
function relativeName(value) {
  const result = String(value).replaceAll('\\', '/');
  if (!result || result.length > 500 || /[\u0000-\u001f]/.test(result) || result.startsWith('/') || /^[a-z]:/i.test(result) || result.split('/').some(p => p === '..' || p === '.' || !p)) throw error('文件名或文件夹路径无效。');
  return result;
}
async function atomicJson(file, value) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, file);
}

export async function createApp({ dataDir = path.join(ROOT, 'data'), renderer = generatePresentation } = {}) {
  dataDir = path.resolve(dataDir);
  const jobsDir = path.join(dataDir, 'jobs');
  await fs.mkdir(jobsDir, { recursive: true });
  const settingsPath = path.join(dataDir, 'settings.json');
  let settings = { baseUrl: '', model: '', allowLocalApi: false, encryptedKey: '' };
  try { settings = { ...settings, ...JSON.parse(await fs.readFile(settingsPath, 'utf8')) }; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const jobs = new Map();
  const reserved = new Set();
  let generationQueue = Promise.resolve();
  const app = express();
  app.disable('x-powered-by');
  const jobDir = id => path.join(jobsDir, id);
  const persist = job => atomicJson(path.join(jobDir(job.id), 'job.json'), job);
  for (const entry of await fs.readdir(jobsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
    const job = JSON.parse(await fs.readFile(path.join(jobDir(entry.name), 'job.json'), 'utf8'));
    if (job.id !== entry.name) throw new Error('本地项目索引不一致。');
    if (BUSY.has(job.status)) {
      job.status = 'error'; job.error = '上次处理被中断，请重新分析或生成。'; job.stage = job.error; job.updatedAt = new Date().toISOString();
      if (job.workflow?.status === 'running') {
        job.workflow = { ...job.workflow, status: job.outputs ? 'partial' : 'failed', error: job.error, stage: job.stage };
        if (job.outputs) job.status = 'ready';
      }
      await persist(job);
    }
    jobs.set(job.id, job);
  }
  let imageSettings = { ...imageDefaults };
  const imagePath = path.join(dataDir, 'image-settings.json');
  try { imageSettings = { ...imageSettings, ...JSON.parse(await fs.readFile(imagePath, 'utf8')) }; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let imageBusy = false;
  const publicSettings = () => ({ baseUrl: settings.baseUrl, model: settings.model, allowLocalApi: settings.allowLocalApi, hasApiKey: Boolean(settings.encryptedKey), image: summarizeImageSettings(imageSettings) });
  const publicJob = job => ({
    id: job.id, title: job.title, status: job.status, requirements: job.requirements,
    files: job.files.map(f => ({ id: f.id, name: f.name, relativePath: f.relativePath, kind: f.kind, size: f.size, ...(f.slideCount ? { slideCount: f.slideCount } : {}), ...(f.kind === 'image' ? { imageUrl: `/api/jobs/${job.id}/assets/${f.id}` } : {}) })),
    plan: job.plan, progress: job.progress, stage: job.stage, warnings: job.warnings, error: job.error,
    createdAt: job.createdAt, updatedAt: job.updatedAt,
    workflow: job.outputs || ['running', 'failed'].includes(job.workflow?.status) ? job.workflow || null : null,
    outputs: job.outputs ? { pptxUrl: `/api/jobs/${job.id}/download`, slides: job.outputs.slideImages.map(file => { const number = Number(path.basename(file).match(/slide-(\d+)\.png$/)?.[1]); return { number, url: `/api/jobs/${job.id}/previews/${number}.png` }; }).filter(s => s.number), audit: job.outputs.audit } : null,
  });
  const allJobs = () => [...jobs.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(publicJob);
  const getJob = id => {
    if (!UUID.test(id || '') || !jobs.has(id)) throw error('项目不存在。', 404);
    return jobs.get(id);
  };
  const update = async (job, patch) => {
    if (patch.outputs === null && !Object.hasOwn(patch, 'workflow')) job.workflow = null;
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    await persist(job);
  };
  const modification = (req, res, next) => {
    try {
      req.job = getJob(req.params.id);
      if (BUSY.has(req.job.status) || reserved.has(req.job.id)) throw error('项目正在处理，请完成后再修改。', 409);
      reserved.add(req.job.id);
      res.once('finish', () => reserved.delete(req.job.id));
      res.once('close', () => reserved.delete(req.job.id));
      next();
    } catch (e) { next(e); }
  };
  app.use((req, res, next) => {
    const port = req.socket.localPort;
    const extraHosts = String(process.env.PPT_STUDIO_ALLOWED_HOSTS || '').split(',').map(h => h.trim()).filter(h => /^[a-z0-9.\-\[\]:]+$/i.test(h));
    const hosts = new Set([...extraHosts, ...[port, process.env.PPT_STUDIO_PUBLIC_PORT].filter(p => p && /^\d{1,5}$/.test(String(p))).flatMap(p => [`127.0.0.1:${p}`, `localhost:${p}`])]);
    if (!hosts.has(req.headers.host) || req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: '仅允许从本机工作台访问。' });
    if (req.headers.origin && ![...hosts].some(h => req.headers.origin === `http://${h}`)) return res.status(403).json({ error: '跨站请求已拒绝。' });
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'" });
    next();
  });
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (['POST', 'PUT'].includes(req.method) && !req.is('application/json') && !(req.method === 'POST' && /\/files$/.test(req.path) && req.is('multipart/form-data'))) return res.status(415).json({ error: '请求必须为 JSON 或素材上传表单。' });
    next();
  });
  app.use(express.json({ limit: '3mb' }));
  const officePath = path.join(process.env.ProgramFiles || 'C:/Program Files', 'Microsoft Office/Root/Office16/POWERPNT.EXE');
  let powerPoint = false;
  try { await fs.access(officePath); powerPoint = true; } catch { }
  const capabilities = { appId: 'local-ppt-studio', powerPoint, nodeVersion: process.version, formats: FORMATS, maxFileMb: 80, maxTotalMb: 300 };
  app.get('/api/bootstrap', (_req, res) => res.json({ capabilities, settings: publicSettings(), jobs: allJobs() }));
  app.get('/api/jobs', (_req, res) => res.json({ jobs: allJobs() }));
  app.post('/api/jobs', async (req, res) => {
    const requirements = validateRequirements(req.body.requirements || {});
    const title = typeof req.body.title === 'string' ? req.body.title.trim() : requirements.topic || '新建演示文稿';
    if (!title || title.length > 300) throw error('项目标题长度无效。');
    const id = randomUUID();
    const now = new Date().toISOString();
    const job = { id, title, requirements, files: [], plan: null, status: 'draft', progress: 0, stage: '等待素材和需求', warnings: [], error: '', outputs: null, createdAt: now, updatedAt: now };
    await fs.mkdir(path.join(jobDir(id), 'uploads'), { recursive: true });
    await persist(job); jobs.set(id, job); res.status(201).json(publicJob(job));
  });
  app.get('/api/jobs/:id', (req, res) => res.json(publicJob(getJob(req.params.id))));
  app.post('/api/jobs/:id/duplicate', modification, async (req, res) => {
    const source = req.job;
    const id = randomUUID(), now = new Date().toISOString();
    const uploads = path.join(jobDir(id), 'uploads');
    await fs.mkdir(uploads, { recursive: true });
    const remap = new Map(), files = [];
    for (const file of source.files) {
      const fileId = randomUUID();
      const copyPath = path.join(uploads, fileId + path.extname(file.path));
      await fs.copyFile(file.path, copyPath);
      remap.set(file.id, fileId);
      files.push({ ...file, id: fileId, path: copyPath });
    }
    const requirements = { ...source.requirements, referenceFileId: remap.get(source.requirements.referenceFileId) || '' };
    const plan = source.plan ? structuredClone(source.plan) : null;
    if (plan) for (const slide of plan.slides) slide.imageId = remap.get(slide.imageId) || '';
    const job = { ...source, id, title: (source.title + ' · 复用').slice(0, 300), files, requirements, plan, outputs: null, workflow: null, status: plan ? 'planned' : 'draft', progress: 0, error: '', stage: '已复制为独立项目，请更新稿件与要求', createdAt: now, updatedAt: now };
    await persist(job); jobs.set(id, job); res.status(201).json(publicJob(job));
  });
  app.put('/api/jobs/:id', modification, async (req, res) => {
    const job = req.job;
    const patch = {};
    if (req.body.title != null) {
      if (typeof req.body.title !== 'string' || !req.body.title.trim() || req.body.title.length > 300) throw error('项目标题无效。');
      patch.title = req.body.title.trim();
    }
    if (req.body.requirements) patch.requirements = validateRequirements({ ...job.requirements, ...req.body.requirements });
    const requirements = patch.requirements || job.requirements;
    const reference = job.files.find(f => f.id === requirements.referenceFileId && f.kind === 'reference');
    if (requirements.referenceFileId && !reference) throw error('参考PPT不存在。');
    if (requirements.referenceKeepCount > (reference?.slideCount || 0)) throw error('保留页数超过参考PPT实际页数。');
    if (requirements.referenceKeepCount && !powerPoint) throw error('保留参考原页需要本机Microsoft PowerPoint。');
    if (req.body.plan) {
      patch.plan = validateReferencePrefix(validatePlan(req.body.plan, new Set(job.files.filter(f => f.kind === 'image').map(f => f.id))), requirements);
      patch.requirements = { ...requirements, pageCount: patch.plan.slides.length };
    }
    const structureChanged = patch.requirements && ['pageCount', 'referenceFileId', 'referenceKeepCount'].some(key => (patch.requirements[key] || 0) !== (job.requirements[key] || 0));
    if (structureChanged && !patch.plan) patch.plan = null;
    if (patch.plan || patch.requirements) { patch.status = patch.plan || (!structureChanged && job.plan) ? 'planned' : 'draft'; patch.outputs = null; patch.error = ''; patch.progress = 0; patch.stage = '已保存，等待确认'; }
    await update(job, patch); res.json(publicJob(job));
  });
  const upload = multer({
    storage: multer.diskStorage({ destination: (req, _file, done) => done(null, path.join(jobDir(req.job.id), 'uploads')), filename: (_req, file, done) => done(null, randomUUID() + path.extname(file.originalname).toLowerCase()) }),
    limits: { fileSize: MAX_FILE, files: 12, fields: 4, fieldSize: 20000 },
    fileFilter: (_req, file, done) => FORMATS.includes(path.extname(file.originalname).toLowerCase()) ? done(null, true) : done(error('不支持此文件格式，请上传DOCX、PPTX、PDF、文字或JPG/PNG。')),
  }).array('files', 12);
  app.post('/api/jobs/:id/files', modification, (req, res, next) => upload(req, res, next), async (req, res) => {
    const incoming = req.files || [];
    const accepted = [];
    try {
      if (!incoming.length) throw error('请选择要上传的文件。');
      if (req.job.files.reduce((n, f) => n + f.size, 0) + incoming.reduce((n, f) => n + f.size, 0) > MAX_TOTAL) throw error('项目素材总计超过300 MB。');
      let relativePaths = [];
      if (req.body.relativePaths) {
        try { relativePaths = JSON.parse(req.body.relativePaths); } catch { throw error('文件夹路径参数无效。'); }
        if (!Array.isArray(relativePaths) || relativePaths.length !== incoming.length || relativePaths.some(p => typeof p !== 'string')) throw error('文件夹路径与文件数量不一致。');
      }
      for (let i = 0; i < incoming.length; i++) {
        const file = incoming[i];
        const relativePath = relativeName(relativePaths[i] || decodeName(file.originalname));
        const entry = { id: path.basename(file.filename, path.extname(file.filename)), name: path.posix.basename(relativePath), relativePath, path: file.path, size: file.size };
        accepted.push({ ...entry, ...await parseMaterial(entry) });
      }
      await update(req.job, { files: [...req.job.files, ...accepted], status: 'draft', plan: null, outputs: null, progress: 0, error: '', stage: '素材已保存在本机', warnings: [...req.job.warnings, ...accepted.flatMap(f => f.warnings.map(w => `${f.name}：${w}`))] });
      res.json(publicJob(req.job));
    } catch (e) {
      await Promise.all(incoming.map(f => fs.unlink(f.path).catch(() => {})));
      throw e;
    }
  });
  app.delete('/api/jobs/:id/files/:fileId', modification, async (req, res) => {
    const job = req.job;
    const file = job.files.find(f => f.id === req.params.fileId);
    if (!file) throw error('素材不存在。', 404);
    const requirements = { ...job.requirements };
    if (requirements.referenceFileId === file.id) { requirements.referenceFileId = ''; requirements.referenceKeepCount = 0; }
    await update(job, { files: job.files.filter(f => f.id !== file.id), requirements, status: 'draft', plan: null, outputs: null, stage: '素材已移除', progress: 0 });
    await fs.unlink(file.path);
    res.json(publicJob(job));
  });
  app.get('/api/jobs/:id/assets/:fileId', (req, res) => {
    const job = getJob(req.params.id);
    const file = job.files.find(f => f.id === req.params.fileId && f.kind === 'image');
    if (!file) throw error('图片不存在。', 404);
    res.sendFile(file.path);
  });
  const processTask = async (job, work) => {
    try { await work(); } catch (e) { await update(job, { status: 'error', error: e.status || !/^(EN|EP|ERR_)/.test(e.code || '') ? e.message : '本机处理失败，请检查资料或重新尝试。', stage: '处理未完成' }); }
  };
  app.post('/api/jobs/:id/analyze', modification, async (req, res) => {
    const job = req.job;
    if (!job.requirements.topic.trim()) throw error('请填写演示主题。');
    const mode = req.body.mode || job.requirements.mode;
    if (!['basic', 'ai'].includes(mode)) throw error('分析模式无效。');
    if (mode === 'ai' && req.body.consent !== true) throw error('AI分析需要本次明确的内容发送授权。', 403);
    if (mode === 'ai' && (!settings.baseUrl || !settings.model)) throw error('请先配置模型地址与名称。');
    const modelSettings = { ...settings, dataDir };
    await update(job, { status: 'analyzing', progress: 15, stage: mode === 'ai' ? '已获本次授权，模型正在编排提纲' : '本机正在分配原文与匹配照片', error: '', outputs: null });
    res.status(202).json({ id: job.id, status: job.status });
    void processTask(job, async () => {
      const result = mode === 'ai' ? await aiPlan(job, modelSettings) : basicPlan(job);
      await update(job, { plan: result.plan, requirements: { ...job.requirements, mode }, status: 'planned', progress: 100, stage: '提纲已生成，请核对内容与配图', warnings: [...job.files.flatMap(f => f.warnings || []), ...result.warnings] });
    });
  });
  const queueExport = (job, draft) => {
    const task = generationQueue.then(async () => {
      const outputDir = path.join(jobDir(job.id), 'outputs', randomUUID());
      await fs.mkdir(outputDir, { recursive: true });
      const reference = draft.files.find(f => f.id === draft.requirements.referenceFileId);
      const count = draft.requirements.referenceKeepCount || 0;
      if (count && (!reference || reference.slideCount < count)) throw error('参考原页配置已失效，请重新选择参考PPT。');
      const generated = await renderer({ job: { ...draft, referenceStyle: reference?.referenceStyle, ...(count ? { referenceDeck: { path: reference.path, count } } : {}) }, outputDir, assets: draft.files.filter(f => f.kind === 'image') });
      return finalizeReference({ generated, reference, count, outputDir, slideCount: draft.plan.slides.length });
    });
    generationQueue = task.catch(() => {});
    return task;
  };
  const checkedPlan = (job, plan, requirements = job.requirements) => validateReferencePrefix(validatePlan(plan, new Set(job.files.filter(f => f.kind === 'image').map(f => f.id))), requirements);
  app.post('/api/jobs/:id/generate', modification, async (req, res) => {
    const job = req.job;
    if (!job.plan) throw error('请先生成并保存提纲。');
    job.plan = checkedPlan(job, job.plan);
    await update(job, { status: 'generating', progress: 10, stage: '已进入本机制作队列', error: '', outputs: null });
    res.status(202).json({ id: job.id, status: job.status });
    void processTask(job, async () => {
      const outputs = await queueExport(job, job);
      await update(job, { status: 'ready', progress: 100, stage: 'PPTX已生成，请逐页检查预览', outputs, warnings: [...job.warnings, ...outputs.warnings] });
    });
  });
  app.get('/api/jobs/:id/download', (req, res) => {
    const job = getJob(req.params.id);
    if (!job.outputs?.pptxPath) throw error('PPTX尚未生成。', 404);
    const name = job.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 80) + '.pptx';
    res.download(job.outputs.pptxPath, name);
  });
  app.get('/api/jobs/:id/previews/:number.png', (req, res) => {
    const job = getJob(req.params.id);
    if (!/^\d{1,2}$/.test(req.params.number)) throw error('页码无效。', 404);
    const file = job.outputs?.slideImages.find(file => Number(path.basename(file).match(/slide-(\d+)\.png$/)?.[1]) === Number(req.params.number));
    if (!file) throw error('本页预览不可用。', 404);
    res.sendFile(file);
  });
  const studioSource = (job, id) => {
    if (id === 'output' && job.outputs?.pptxPath) return { path: job.outputs.pptxPath, previews: job.outputs.slideImages || [] };
    const file = job.files.find(f => f.id === id && f.kind === 'reference');
    if (!file) throw error('请选择已上传的参考 PPTX 或已生成的成稿。', 404);
    return { path: file.path, previews: [] };
  };
  const variantDir = (job, id) => path.join(jobDir(job.id), 'studio', id);
  const saveVariant = async (job, id, kind, bytes) => {
    const dir = variantDir(job, id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${kind}.pptx`), bytes, { flag: 'wx' });
    return `/api/jobs/${job.id}/studio/download/${id}/${kind}`;
  };
  app.get('/api/jobs/:id/studio/deck', async (req, res) => {
    const source = studioSource(getJob(req.params.id), req.query.source);
    const { pages, ...style } = summarizeDeck(openDeck(await fs.readFile(source.path)));
    res.json({ ...style, pages: pages.map(({ text, ...page }) => page) });
  });
  app.post('/api/jobs/:id/studio/show', modification, async (req, res) => {
    const source = studioSource(req.job, req.body.source);
    const { buffer, audit } = buildShow(await fs.readFile(source.path), req.body);
    const url = await saveVariant(req.job, randomUUID(), 'show', buffer);
    res.status(201).json({ url, audit });
  });
  const createRemix = async (job, source, request, config) => {
    if (!summarizeImageSettings(config).configured) throw error('请先配置作图接口。');
    if (imageBusy) throw error('作图接口正在处理另一批任务，请稍后重试。', 409);
    const id = randomUUID();
    const { referenceImageId } = request;
    const reference = job.files.find(f => f.kind === 'image' && f.id === referenceImageId);
    if (referenceImageId && (!reference || config.method !== 'edits')) throw error('请选择当前项目的图片，并启用「参考图＋提示词」。');
    imageBusy = true;
    try {
      const input = await fs.readFile(source.path);
      const deck = openDeck(input);
      const result = await remixPages({ buffer: input, deck, sourcePath: source.path, existingPreviews: source.previews, outputDir: path.join(variantDir(job, id), 'reference-previews'), request, settings: config, referencePath: reference?.path });
      const url = await saveVariant(job, id, 'remix', result);
      return { url, pages: request.pages };
    } finally { imageBusy = false; }
  };
  app.post('/api/jobs/:id/studio/remix', modification, async (req, res) => {
    if (req.body.consent !== true) throw error('请确认本次会将所选素材发送至作图接口，可能计费。', 403);
    const source = studioSource(req.job, req.body.source);
    res.status(201).json(await createRemix(req.job, source, req.body, { ...imageSettings, dataDir }));
  });

  app.post('/api/jobs/:id/workflow', modification, async (req, res) => {
    const job = req.job;
    const { instruction, textConsent, imageConsent } = req.body;
    if (textConsent !== true) throw error('请授权本次文本模型调用。', 403);
    if (typeof instruction !== 'string' || !instruction.trim() || instruction.length > 1200) throw error('请输入 1–1200 字的制作指令。');
    if (!settings.baseUrl || !settings.model) throw error('请先配置文本模型。');
    const model = { ...settings, dataDir };
    const image = { ...imageSettings, dataDir };
    const previousShow = job.workflow?.show || null;
    const workflow = { status: 'running', stage: '理解制作指令', error: '', show: previousShow, remix: job.workflow?.remix || null };
    const progress = (stage, percent, patch = {}) => update(job, { stage, progress: percent, workflow: { ...workflow, stage }, ...patch });
    await progress(workflow.stage, 5, { status: 'analyzing', error: '' });
    res.status(202).json(publicJob(job));
    void processTask(job, async () => {
      try {
        const action = await callModel(model, [
          { role: 'system', content: '把用户指令转成 PPT 工作流。制作新稿选 create；只处理已有稿的动画或重绘选 existing；目标不明确或与 PPT 制作无关选 clarify。新稿默认添加逐步放映，明确不要动画则关闭。仅在用户明确指定重绘页码时填写 pages，勿猜测。缺失页码的重绘请求选 clarify。pageCount 未指定填 0。brief 只保留演示内容与结构要求；visual 只保留重绘视觉要求。不得自行增加重绘。' },
          { role: 'user', content: JSON.stringify({ instruction, topic: job.requirements.topic, pageCount: job.requirements.pageCount, hasDeck: Boolean(job.outputs?.pptxPath) }) },
        ], { maxTokens: 1200, tool: {
          name: 'run_presentation_workflow', description: '安排提纲、可编辑导出、逐步放映和指定页重绘',
          parameters: { type: 'object', additionalProperties: false, required: ['mode', 'pageCount', 'animate', 'pages', 'brief', 'visual'], properties: {
            mode: { type: 'string', enum: ['create', 'existing', 'clarify'] }, pageCount: { type: 'integer', minimum: 0, maximum: 40 }, animate: { type: 'boolean' },
            pages: { type: 'array', maxItems: 4, items: { type: 'integer', minimum: 1, maximum: 40 } }, brief: { type: 'string' }, visual: { type: 'string' },
          } },
        } });
        const { mode, pageCount, animate, pages, brief, visual } = action;
        if (!['create', 'existing', 'clarify'].includes(mode) || typeof animate !== 'boolean' || !Number.isInteger(pageCount) || (pageCount !== 0 && (pageCount < 5 || pageCount > 40)) || !Array.isArray(pages) || pages.length > 4 || new Set(pages).size !== pages.length || pages.some(p => !Number.isInteger(p) || p < 1 || p > 40) || typeof brief !== 'string' || typeof visual !== 'string') throw error('模型返回的制作指令无效，请重试。');
        if (mode === 'clarify' || (mode === 'existing' && !animate && !pages.length)) throw error('请说明要生成演示稿、添加动画，还是重绘指定页。');
        if (mode === 'existing' && !job.outputs?.pptxPath) throw error('请先生成可编辑 PPTX。');
        if (mode === 'create') {
          const requirements = validateRequirements({ ...job.requirements, topic: job.requirements.topic || brief.trim().slice(0, 300) || instruction.trim().slice(0, 300), pageCount: pageCount || job.requirements.pageCount, mode: 'ai' });
          await progress('AI 正在编排提纲', 20);
          const draft = { ...job, requirements: { ...requirements, extra: [requirements.extra, brief].filter(Boolean).join('\n').slice(0, 3000) } };
          const planned = await aiPlan(draft, model);
          draft.plan = checkedPlan(draft, planned.plan);
          await progress('正在导出可编辑 PPTX', 48, { status: 'generating' });
          const outputs = await queueExport(job, draft);
          workflow.show = null;
          workflow.remix = null;
          await progress('可编辑稿已生成', 65, { requirements, plan: draft.plan, outputs, warnings: [...job.files.flatMap(f => f.warnings || []), ...planned.warnings, ...outputs.warnings] });
        }
        let source = studioSource(job, 'output');
        if (animate) {
          await progress('正在添加 PowerPoint 点击动画', 74, { status: 'generating' });
          const bytes = await fs.readFile(source.path);
          const last = openDeck(bytes).slides.length;
          const { buffer, audit } = buildShow(bytes, { style: 'guided', excluded: [1, last] });
          const id = randomUUID();
          workflow.show = { url: await saveVariant(job, id, 'show', buffer), audit, id };
          workflow.remix = null;
          await progress('逐步放映稿已生成', 82);
        }
        if (pages.length) {
          await progress('正在处理指定页重绘', 88, { status: 'generating' });
          if (imageConsent !== true) throw error('未授权本次图像模型调用，重绘未执行。');
          if (workflow.show?.id) source = { ...source, path: path.join(variantDir(job, workflow.show.id), 'show.pptx') };
          workflow.remix = await createRemix(job, source, { pages, instructions: visual.slice(0, 1200) }, image);
        }
        workflow.status = 'complete';
        await progress('制作完成，请核对页面、数据与备注', 100, { status: 'ready' });
      } catch (e) {
        workflow.status = job.outputs ? 'partial' : 'failed';
        workflow.error = /^(EN|EP|ERR_)/.test(e.code || '') ? '本机处理失败，请检查资料或重新尝试。' : e.message;
        await progress(workflow.error, job.progress, { status: job.outputs ? 'ready' : 'error', error: job.outputs ? '' : workflow.error });
      }
    });
  });
  app.get('/api/jobs/:id/studio/download/:variant/:kind', async (req, res) => {
    const job = getJob(req.params.id);
    const { variant, kind } = req.params;
    if (!UUID.test(variant) || !['show', 'remix'].includes(kind)) throw error('成果不存在。', 404);
    const file = path.join(variantDir(job, variant), `${kind}.pptx`);
    try { await fs.access(file); } catch { throw error('成果不存在。', 404); }
    res.download(file, `${job.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 80)}_${kind === 'show' ? '逐步放映版' : 'AI页图版'}.pptx`);
  });
  app.put('/api/settings/image', async (req, res) => {
    const validated = validateImageSettings({ ...imageSettings, ...req.body });
    let encryptedKey = req.body.clearApiKey === true || validated.baseUrl !== imageSettings.baseUrl ? '' : imageSettings.encryptedKey;
    if (req.body.apiKey != null && req.body.apiKey !== '') {
      if (typeof req.body.apiKey !== 'string' || !req.body.apiKey.trim() || req.body.apiKey.length > 4096 || /[\r\n\u0000]/.test(req.body.apiKey)) throw error('作图密钥格式无效。');
      encryptedKey = await protectKey(req.body.apiKey.trim(), 'protect', dataDir);
    }
    const next = { ...validated, encryptedKey };
    await atomicJson(imagePath, next);
    imageSettings = next;
    res.json(publicSettings());
  });
  app.post('/api/settings/image/test', async (req, res) => {
    if (req.body.consent !== true) throw error('作图连接测试需要确认，可能计费。', 403);
    if (imageBusy) throw error('作图接口正在处理另一批任务，请稍后重试。', 409);
    imageBusy = true;
    try {
      await testImage({ ...imageSettings, dataDir });
      res.json({ ok: true, message: '已收到并验证作图接口返回的图片。' });
    } finally { imageBusy = false; }
  });
  app.get('/api/settings', (_req, res) => res.json(publicSettings()));
  app.put('/api/settings', async (req, res) => {
    const validated = validateSettings({ ...settings, ...req.body });
    let encryptedKey = settings.encryptedKey;
    if (req.body.clearApiKey === true) encryptedKey = '';
    if (req.body.apiKey) {
      if (typeof req.body.apiKey !== 'string' || req.body.apiKey.length > 4096 || /[\r\n\u0000]/.test(req.body.apiKey)) throw error('API密钥格式无效。');
      encryptedKey = await protectKey(req.body.apiKey.trim(), 'protect', dataDir);
    }
    settings = { ...validated, encryptedKey };
    await atomicJson(settingsPath, settings);
    res.json(publicSettings());
  });
  app.post('/api/settings/test', async (_req, res) => {
    await callModel({ ...settings, dataDir }, [{ role: 'user', content: '请仅回复OK。' }], { maxTokens: 12 });
    res.json({ ok: true, message: '已收到模型服务的真实响应。' });
  });
  app.use(express.static(path.join(ROOT, 'public'), { index: 'index.html', dotfiles: 'deny' }));
  app.use((_req, res) => res.status(404).json({ error: '接口或页面不存在。' }));
  app.use((e, req, res, _next) => {
    if (res.headersSent) return;
    if (e instanceof multer.MulterError) return res.status(400).json({ error: e.code === 'LIMIT_FILE_SIZE' ? '单个文件不能超过80 MB。' : '上传数量或表单超过限制；每批最多12个文件。' });
    const status = e.status || (e.type === 'entity.too.large' ? 413 : 400);
    res.status(status).json({ error: e.type === 'entity.too.large' ? '请求内容过大，请精简提纲。' : e.type === 'entity.parse.failed' ? 'JSON格式无效。' : e.code ? '本机文件处理失败，请检查文件后重试。' : e.message || '请求未能完成。' });
  });
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.PPT_STUDIO_PORT || 3210);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口必须介于1024与65535。');
  const app = await createApp({ dataDir: process.env.PPT_STUDIO_DATA || path.join(ROOT, 'data') });
  const server = app.listen(port, '127.0.0.1', () => console.log(`启幕 PPT 已启动：http://127.0.0.1:${port}`));
  server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? '端口已占用，请打开已运行的工作台或更换PPT_STUDIO_PORT。' : '本地服务无法启动。'); process.exitCode = 1; });
}
