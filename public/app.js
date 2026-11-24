// Copyright (c) 2026 CodeForce-Lab
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
// 使用、修改或分发时须保留本声明并署名 CodeForce-Lab。

const $ = (id) => document.getElementById(id);
const layouts = { cover: '封面', section: '章节过渡', content: '正文要点', columns: '分栏内容', metrics: '数据指标', timeline: '时间线', photo: '图片展示', closing: '结束页', reference: '保留参考原页' };
const statuses = { draft: '草稿', analyzing: '正在分析', planned: '提纲就绪', generating: '正在生成', ready: '已生成', error: '出错' };
const defaults = { topic: '', audience: '', purpose: '', pageCount: 19, style: 'launch', extra: '', mode: 'basic', referenceFileId: '', referenceKeepCount: 0 };
const state = {
  online: false, capabilities: {}, settings: {}, jobs: new Map(), currentId: null,
  plan: null, selectedSlide: 0, editorMode: 'form', step: 1, view: 'workspace',
  requirementsDirty: false, planDirty: false, operation: '', settingsBusy: false,
  pollTimer: null, polling: false, pollFailures: new Map(), bootstrapBusy: false,
  invalidatedPlans: new Set(),
  images: [], imageIndex: 0, imageInternal: false, toastTimer: null,
  pages: { files: 0, slides: 0, history: 0, metrics: 0, columns: 0 },
  previewIndex: 0, previews: [], reader: null,
};
const listLayouts = {
  files: { id: 'file-list', row: '--file-row', size: 4 },
  slides: { id: 'slide-list', row: '--slide-row', size: 7 },
  history: { id: 'history-list', row: '--history-row', size: 5 },
};
const currentJob = () => state.jobs.get(state.currentId);
const processing = (job) => ['analyzing', 'generating'].includes(job?.status);
const dirty = () => state.requirementsDirty || state.planDirty;
const clone = (value) => JSON.parse(JSON.stringify(value));
const lines = (text) => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
const jobPath = (id = state.currentId) => `/api/jobs/${encodeURIComponent(id)}`;

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}
function button(label, className, handler, iconName) {
  const element = node('button', className);
  element.type = 'button';
  element.setAttribute('aria-label', label);
  element.title = label;
  if (iconName) element.append(icon(iconName));
  else element.textContent = label;
  element.addEventListener('click', () => run(handler));
  return element;
}
function sameOriginUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const url = new URL(raw, location.origin);
    if (url.origin !== location.origin || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}
function imageElement(url, alt) {
  const image = node('img');
  image.alt = alt;
  image.loading = 'lazy';
  image.decoding = 'async';
  image.src = url;
  image.addEventListener('error', () => {
    const fallback = node('span', 'image-fallback', '图片加载失败');
    image.replaceWith(fallback);
  }, { once: true });
  return image;
}
function alertMessage(message, retry = false) {
  $('global-alert-text').textContent = message;
  $('retry-bootstrap').hidden = !retry;
  $('global-alert').hidden = false;
}
function listCapacity(key) {
  const layout = listLayouts[key];
  const list = $(layout.id);
  if (!list.clientHeight) return layout.shown ?? layout.size;
  const style = getComputedStyle(list);
  const row = parseFloat(style.getPropertyValue(layout.row));
  const gap = parseFloat(style.rowGap) || 0;
  return Math.max(1, Math.floor((list.clientHeight + gap) / (row + gap)));
}
function paginate(key, entries, size = listCapacity(key)) {
  const total = entries.length;
  const last = Math.max(0, Math.ceil(total / size) - 1) * size;
  const start = Math.min(last, Math.floor(state.pages[key] / size) * size);
  if (listLayouts[key]) listLayouts[key].shown = size;
  state.pages[key] = start;
  const end = Math.min(total, start + size);
  $(key + '-range').textContent = total ? `${start + 1}–${end} / ${total}` : '0 项';
  $(key + '-prev').disabled = start === 0;
  $(key + '-next').disabled = end >= total;
  return entries.slice(start, end).map((item, offset) => [item, start + offset]);
}
function setMaterialsPane(pane) {
  $('materials-step').dataset.pane = pane;
  for (const name of ['requirements', 'materials']) {
    const selected = name === pane;
    $(`show-${name}`).classList.toggle('active', selected);
    $(`show-${name}`).setAttribute('aria-pressed', String(selected));
  }
}
function openReader(title, text, code = false) {
  state.reader = { text: String(text || '暂无内容。'), starts: [0], index: 0 };
  $('reader-title').textContent = title;
  $('reader-page').classList.toggle('code', code);
  $('reader-dialog').showModal();
  renderReaderPage();
}
function renderReaderPage() {
  const { text, starts, index } = state.reader;
  const page = $('reader-page');
  const start = starts[index];
  let low = start + 1;
  let high = Math.min(text.length, start + 4096);
  let end = low;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    page.textContent = text.slice(start, mid);
    if (page.scrollHeight <= page.clientHeight) { end = mid; low = mid + 1; }
    else high = mid - 1;
  }
  if (end < text.length) {
    const newline = text.lastIndexOf('\n', end - 1);
    if (newline > start + (end - start) * .8) end = newline + 1;
    if (end - start > 1 && /[\uD800-\uDBFF]/.test(text[end - 1])) end -= 1;
  }
  page.textContent = text.slice(start, end);
  starts.splice(index + 1, starts.length, end);
  $('reader-position').textContent = `第 ${index + 1} 页`;
  $('reader-prev').disabled = index === 0;
  $('reader-next').disabled = end >= text.length;
}
function moveReader(direction) {
  state.reader.index += direction;
  renderReaderPage();
}
function toast(message) {
  clearTimeout(state.toastTimer);
  $('toast-text').textContent = message;
  $('toast').hidden = false;
  state.toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3500);
}
async function run(action) {
  try { await action(); }
  catch (error) { alertMessage(error.message || '操作失败，请重试。'); }
}
async function api(path, { method = 'GET', body, timeout = 30000 } = {}) {
  if (!path.startsWith('/api/')) throw new Error('只允许访问本机 API。');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const multipart = body instanceof FormData;
    const response = await fetch(path, {
      method, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      signal: controller.signal,
      headers: body !== undefined && !multipart ? { 'Content-Type': 'application/json' } : {},
      body: body === undefined ? undefined : multipart ? body : JSON.stringify(body),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(data?.error || `本机服务返回错误 (${response.status})。`);
      error.httpStatus = response.status;
      throw error;
    }
    if (!data) throw new Error('本机服务未返回有效 JSON。');
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('本机请求超时。任务可能已提交，请刷新项目状态后再重试。');
    if (error instanceof TypeError) throw new Error('无法连接本机服务，请确认服务已启动后重新连接。');
    throw error;
  } finally { clearTimeout(timer); }
}
async function mutate(name, action, allowProcessing = false) {
  if (!state.online) throw new Error('本机服务尚未连接，请先重新连接。');
  if (state.operation) return;
  if (!allowProcessing && processing(currentJob())) throw new Error('当前项目正在处理，请等待任务完成。');
  state.operation = name;
  syncControls();
  try { return await action(); }
  finally { state.operation = ''; syncControls(); }
}
let confirmResolve = null;
function confirmAction(title, description, accept = '继续') {
  if (confirmResolve) return Promise.resolve(false);
  $('confirm-title').textContent = title;
  $('confirm-description').textContent = description;
  $('confirm-accept').textContent = accept;
  $('confirm-dialog').showModal();
  return new Promise((resolve) => { confirmResolve = resolve; });
}
function finishConfirm(accepted) {
  const resolve = confirmResolve;
  confirmResolve = null;
  $('confirm-dialog').close();
  resolve?.(accepted);
}
async function canLeave() {
  if (state.operation) return false;
  if (!dirty()) return true;
  return confirmAction('放弃未保存的编辑？', '当前需求或提纲有尚未保存的修改。继续会丢弃这些修改；取消后可先保存。', '放弃并继续');
}

function aiConfigured() {
  return Boolean(state.settings.baseUrl && state.settings.model && (state.settings.hasApiKey || state.settings.allowLocalApi));
}
function updateCapabilities() {
  const caps = state.capabilities;
  function capability(id, label, available) {
    const element = $(id);
    element.classList.toggle('available', available);
    element.classList.toggle('unavailable', !available);
    element.replaceChildren(node('span', 'status-dot'), document.createTextNode(label));
  }
  capability('cap-pptx', state.online ? '可编辑 PPTX 生成' : '本地服务未连接', state.online);
  capability('cap-office', caps.powerPoint ? '页面预览（PowerPoint 可用）' : '页面预览需要 Microsoft PowerPoint', Boolean(caps.powerPoint));
  capability('cap-ai', aiConfigured() ? 'AI 辅助分析已配置' : 'AI 辅助分析未配置', aiConfigured());
  $('ai-mode-description').textContent = aiConfigured() ? `已配置模型：${state.settings.model}` : '使用 AI 前请先配置模型。';
  const formats = supportedExtensions();
  $('file-input').accept = formats.join(',');
  $('folder-input').accept = formats.join(',');
  $('supported-formats').textContent = formats.length ? `可上传：${formats.join('  ')}` : '服务未提供素材格式，请重新连接。';
  $('upload-limits').textContent = `每批最多 12 个文件${caps.maxFileMb ? ` · 单文件 ${caps.maxFileMb} MB` : ''}${caps.maxTotalMb ? ` · 项目总计 ${caps.maxTotalMb} MB` : ''}`;
}
function supportedExtensions() {
  const source = state.capabilities.formats;
  const result = [];
  function collect(value) {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
    else if (typeof value === 'string') {
      value.split(/[\s,;|/]+/).forEach((part) => {
        const extension = part.trim().toLowerCase().replace(/^\*?\.?/, '');
        if (/^[a-z0-9]{2,8}$/.test(extension)) result.push(`.${extension}`);
      });
    }
  }
  collect(source);
  return [...new Set(result)];
}
function syncControls() {
  const active = processing(currentJob());
  const locked = !state.online || Boolean(state.operation) || active;
  const reference = isReferenceSlide(activeSlide());
  const prefixCount = referencePrefixCount();
  const rebuild = Boolean(state.plan && planStructureChanged());
  syncReferenceKeepCount();
  updateRequirementSummary();
  $('reference-keep-count').disabled = locked || !$('reference-file').value || referenceKeepLimit() === 0;
  $('duplicate-project').disabled = locked || !state.currentId;
  $('outline-rebuild-notice').hidden = !rebuild;
  document.querySelectorAll('[data-mutation]').forEach((element) => { element.disabled = locked; });
  ['new-project', 'history-create'].forEach((id) => { $(id).disabled = !state.online || Boolean(state.operation); });
  $('requirements-fields').disabled = locked;
  $('advanced-fields').disabled = locked;
  $('plan-meta-fields').disabled = locked || !state.plan;
  $('slide-fields').disabled = locked || !state.plan?.slides?.length || reference;
  $('slide-note-fields').disabled = locked || !state.plan || reference;
  $('slide-json').disabled = locked || !state.plan || reference;
  $('apply-json').disabled = locked || !state.plan || reference;
  $('ai-consent').disabled = locked || state.settingsBusy;
  $('outline-jump').disabled = !state.plan || Boolean(state.operation);
  $('outline-prev').disabled = $('outline-jump').disabled || state.selectedSlide === 0;
  $('outline-next').disabled = $('outline-jump').disabled || state.selectedSlide >= state.plan.slides.length - 1;
  $('dropzone').setAttribute('aria-disabled', String(locked));
  $('file-input').disabled = locked;
  $('folder-input').disabled = locked;
  $('step-2').disabled = !state.plan;
  $('step-3').disabled = !state.plan && !currentJob()?.outputs && !active;
  $('analyze').disabled = locked || (selectedMode() === 'ai' && state.settingsBusy);
  $('generate').disabled = locked || !state.plan || rebuild;
  $('save-plan').disabled = locked || !state.plan;
  $('add-slide').disabled = locked || !state.plan || rebuild || state.plan.slides.length >= 40;
  $('delete-slide').disabled = locked || !state.plan || rebuild || reference || state.plan.slides.length <= Math.max(5, prefixCount + 2);
  $('move-slide-up').disabled = locked || !state.plan || rebuild || reference || state.selectedSlide <= prefixCount;
  $('move-slide-down').disabled = locked || !state.plan || rebuild || reference || state.selectedSlide >= state.plan.slides.length - 1;
  $('add-metric').disabled = locked || !state.plan || reference;
  $('add-column').disabled = locked || !state.plan || reference;
  document.querySelectorAll('[data-file-delete]').forEach((element) => { element.disabled = locked; });
  document.querySelectorAll('[data-structured-delete], #metric-rows input, #column-rows input, #column-rows textarea').forEach((element) => { element.disabled = locked || !state.plan || reference; });
  document.querySelectorAll('.slide-list-button, .history-open').forEach((element) => { element.disabled = Boolean(state.operation); });
  document.querySelectorAll('[data-job-duplicate]').forEach((element) => { element.disabled = !state.online || Boolean(state.operation) || processing(state.jobs.get(element.dataset.jobDuplicate)); });
  $('refresh-history').disabled = !state.online || Boolean(state.operation);
  $('settings-fields').disabled = !state.online || state.settingsBusy;
  $('save-settings').disabled = !state.online || state.settingsBusy;
  $('test-api').disabled = !state.online || state.settingsBusy || !aiConfigured();
  $('clear-api-key').disabled = !state.settings.hasApiKey || state.settingsBusy || !state.online;
  $('api-key').disabled = state.settingsBusy || !state.online || $('clear-api-key').checked;
  $('close-settings').disabled = state.settingsBusy;
  updateSaveState();
}
function updateSaveState() {
  const job = currentJob();
  $('project-name').textContent = state.plan?.title || $('topic').value || job?.title || '新建演示文稿';
  $('save-status').textContent = dirty() ? '有未保存的编辑 · 仅在当前页面内存中' : job ? `已保存到本机 · ${dateLabel(job.updatedAt)}` : '尚未创建项目 · 仅在本机创作';
  $('outline-save-state').textContent = state.plan && planStructureChanged() ? '页面 / 参考设置已变更 · 保存前需确认重新编排' : dirty() ? '编辑尚未保存' : state.plan ? '当前提纲已保存到本机' : '尚无提纲';
  $('outline-save-state').classList.toggle('dirty', dirty());
}
function markDirty(kind) {
  if (kind === 'requirements') {
    state.requirementsDirty = true;
    $('ai-consent').checked = false;
  } else state.planDirty = true;
  syncControls();
}
function selectedMode() {
  return document.querySelector('input[name="mode"]:checked')?.value || 'basic';
}
function updateConsentPanel() {
  $('ai-consent-panel').hidden = selectedMode() !== 'ai';
  syncControls();
}
function readRequirements(requireTopic = false) {
  const pageCount = Number($('page-count').value);
  if (!Number.isInteger(pageCount) || pageCount < 5 || pageCount > 40 || !$('page-count').checkValidity()) {
    setMaterialsPane('requirements');
    $('page-count').reportValidity();
    throw new Error('预期页数必须为 5–40 的整数。');
  }
  const topic = $('topic').value.trim();
  if (requireTopic && !topic) {
    setMaterialsPane('requirements');
    $('topic').reportValidity();
    $('topic').focus();
    throw new Error('请先填写演示主题。');
  }
  const requirements = {
    topic, audience: $('audience').value.trim(), purpose: $('purpose').value.trim(),
    pageCount,
    style: document.querySelector('input[name="style"]:checked')?.value || 'launch',
    extra: $('extra').value.trim(), mode: selectedMode(),
  };
  // Explicit empty/zero values also clear old references in a merge-based PUT.
  requirements.referenceFileId = $('reference-file').value || '';
  requirements.referenceKeepCount = syncReferenceKeepCount();
  return requirements;
}
function fillRequirements(requirements = defaults) {
  const values = { ...defaults, ...requirements };
  for (const [id, key] of [['topic', 'topic'], ['audience', 'audience'], ['purpose', 'purpose'], ['page-count', 'pageCount'], ['extra', 'extra']]) $(id).value = values[key];
  document.querySelectorAll('input[name="style"]').forEach((input) => { input.checked = input.value === values.style; });
  document.querySelectorAll('input[name="mode"]').forEach((input) => { input.checked = input.value === values.mode; });
  $('ai-consent').checked = false;
  renderReferenceOptions(values.referenceFileId || '', values.referenceKeepCount);
  updateConsentPanel();
}
function selectedReferenceFile() {
  return (currentJob()?.files || []).find((file) => file.id === $('reference-file').value && file.kind === 'reference');
}
function referenceKeepLimit() {
  const slideCount = Number(selectedReferenceFile()?.slideCount);
  const pageCount = Number($('page-count').value);
  if (!Number.isInteger(slideCount) || slideCount < 1 || !Number.isInteger(pageCount)) return 0;
  return Math.max(0, Math.min(5, slideCount, pageCount - 2));
}
function syncReferenceKeepCount(value = $('reference-keep-count').value) {
  const select = $('reference-keep-count');
  const limit = referenceKeepLimit();
  const count = Math.max(0, Math.min(limit, Math.trunc(Number(value) || 0)));
  select.value = String(count);
  for (const option of select.options) option.disabled = Number(option.value) > limit;
  const file = selectedReferenceFile();
  $('reference-keep-help').textContent = !file ? '先选择已上传的参考 PPTX；默认不保留原页。' : !Number.isInteger(Number(file.slideCount)) || Number(file.slideCount) < 1 ? '参考 PPTX 页数尚不可用，暂不能保留原页；仍可参考风格。' : `参考共 ${file.slideCount} 页，最多可保留 ${limit} 页。${count ? `前 ${count} 页会原样保留，并固定在提纲最前面。` : '当前不保留原页。'}`;
  select.disabled = !state.online || Boolean(state.operation) || processing(currentJob()) || !file || limit === 0;
  return count;
}
function updateRequirementSummary() {
  const ai = selectedMode() === 'ai';
  const mode = ai ? ($('ai-consent').checked && aiConfigured() ? 'AI 分析 · 本次已授权' : 'AI 分析 · 等待授权') : '本机基础分析';
  const extras = [$('reference-file').value ? '已选参考风格' : '', $('extra').value.trim() ? '已有补充要求' : ''].filter(Boolean);
  const summary = [mode, ...extras].join(' · ');
  $('requirements-summary').textContent = summary;
  $('requirements-summary').title = summary;
  $('analyze-label').textContent = ai ? '生成 AI 提纲' : '生成提纲';
  $('apply-launch-preset').hidden = Number($('page-count').value) === 19 && document.querySelector('input[name="style"]:checked')?.value === 'launch';
  $('analysis-hint').textContent = state.online && !state.capabilities.powerPoint ? '未检测到 PowerPoint，仍可生成 PPTX。' : '先生成提纲，再制作 PPTX。';
}
function isReferenceSlide(slide) { return slide?.layout === 'reference'; }
function referencePrefixCount(plan = state.plan) {
  let count = 0;
  while (isReferenceSlide(plan?.slides?.[count])) count += 1;
  return count;
}
function planMatchesRequirements(plan, requirements = defaults) {
  if (!plan?.slides || plan.slides.length !== Number(requirements.pageCount)) return false;
  const count = Number(requirements.referenceKeepCount) || 0;
  return plan.slides.every((slide, index) => index < count ? isReferenceSlide(slide) && slide.referenceSlideIndex === index : !isReferenceSlide(slide));
}
function planStructureChanged() {
  if (!state.plan) return false;
  const requirements = currentJob()?.requirements || defaults;
  const keepCount = Number($('reference-keep-count').value) || 0;
  return Number($('page-count').value) !== state.plan.slides.length || ($('reference-file').value || '') !== (requirements.referenceFileId || '') || keepCount !== (Number(requirements.referenceKeepCount) || 0) || keepCount !== referencePrefixCount();
}
function renderReferenceOptions(selected = $('reference-file').value, keepCount = $('reference-keep-count').value) {
  const select = $('reference-file');
  select.replaceChildren(new Option('不使用参考风格', ''));
  (currentJob()?.files || []).filter((file) => file.kind === 'reference' && /\.pptx$/i.test(file.name)).forEach((file) => {
    const count = Number(file.slideCount);
    select.add(new Option(`${file.relativePath || file.name}${Number.isInteger(count) && count > 0 ? ` · ${count} 页` : ''}`, file.id));
  });
  select.value = selected;
  if (select.selectedIndex === -1) select.value = '';
  syncReferenceKeepCount(keepCount);
}
function dateLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', { hour12: false });
}
function bytesLabel(size = 0) {
  return size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(size / 1024)} KB`;
}
function setView(view) {
  state.view = view;
  $('workspace-view').hidden = view !== 'workspace';
  $('history-view').hidden = view !== 'history';
  $('view-label').textContent = view === 'history' ? '项目历史' : '创作工作台';
  ['workspace', 'history'].forEach((name) => {
    const element = $(`nav-${name}`);
    element.classList.toggle('active', view === name);
    if (view === name) element.setAttribute('aria-current', 'page');
    else element.removeAttribute('aria-current');
  });
  if (view === 'history') renderHistory();
}
function showStep(step, validate = true) {
  if (state.operation && validate) return false;
  if (validate && !commitSlide()) return false;
  if (step === 2 && !state.plan) return false;
  state.step = step;
  ['materials', 'outline', 'delivery'].forEach((name, index) => { $(`${name}-step`).hidden = step !== index + 1; });
  [1, 2, 3].forEach((number) => {
    const element = $(`step-${number}`);
    element.classList.toggle('active', number === step);
    element.classList.toggle('complete', number === 1 ? Boolean(state.plan) : number === 2 ? currentJob()?.status === 'ready' : false);
    if (number === step) element.setAttribute('aria-current', 'step');
    else element.removeAttribute('aria-current');
  });
  if (step === 2) renderOutline();
  if (step === 3) renderDelivery();
  syncControls();
  return true;
}
function rememberJob(job) {
  if (!job || typeof job.id !== 'string') throw new Error('服务返回的项目缺少 ID。');
  state.jobs.set(job.id, job);
  if (!processing(job)) state.pollFailures.delete(job.id);
  renderHistory();
  schedulePoll();
  return job;
}
function hydrateJob(job) {
  state.currentId = job.id;
  state.plan = !state.invalidatedPlans.has(job.id) && planMatchesRequirements(job.plan, job.requirements || defaults) ? clone(job.plan) : null;
  state.pages.files = state.pages.slides = state.pages.metrics = state.pages.columns = 0;
  state.previewIndex = 0;
  state.selectedSlide = 0;
  state.editorMode = 'form';
  setMaterialsPane('requirements');
  state.requirementsDirty = false;
  state.planDirty = false;
  fillRequirements(job.requirements || defaults);
  $('plan-title').value = state.plan?.title || '';
  $('plan-subtitle').value = state.plan?.subtitle || '';
  renderFiles();
  renderProgress();
  showStep(job.status === 'ready' || job.status === 'generating' ? 3 : state.plan ? 2 : 1, false);
  setView('workspace');
  renderHistory();
  syncControls();
}
async function openJob(id) {
  if (id === state.currentId) { setView('workspace'); return; }
  if (!await canLeave()) return;
  await mutate('正在打开项目', async () => {
    const job = await api(jobPath(id));
    rememberJob(job);
    hydrateJob(job);
  }, true);
}
async function newProject() {
  if (!await canLeave()) return;
  // Creating another project is allowed even while the previous one runs.
  if (!state.online || state.operation) return;
  state.operation = '正在新建项目';
  syncControls();
  try {
    const job = rememberJob(await api('/api/jobs', { method: 'POST', body: { requirements: { ...defaults } } }));
    hydrateJob(job);
    toast('已创建本机草稿');
  } finally { state.operation = ''; syncControls(); }
}
async function applyLaunchPreset() {
  if (!state.online || state.operation || processing(currentJob())) return;
  if (state.plan && state.plan.slides.length !== 19 && !await confirmAction('恢复默认设置？', '将视觉风格设为「发布会」，目标总页数设为 19。保留已有素材与文字需求；原提纲需重新生成后才能交付，不会自动逐像素复刻原稿。', '使用预设')) return;
  document.querySelector('input[name="style"][value="launch"]').checked = true;
  $('page-count').value = '19';
  syncReferenceKeepCount();
  markDirty('requirements');
  toast('已恢复默认：发布会风格 · 19 页');
}
async function duplicateProject(id = state.currentId) {
  if (!id || !state.online || state.operation || processing(state.jobs.get(id))) return;
  if (state.invalidatedPlans.has(id)) throw new Error('此项目的新需求尚未生成对应提纲，请先完成重新分析后再复用。');
  const saveFirst = id === state.currentId && dirty();
  if (saveFirst) {
    if (planStructureChanged()) throw new Error('请先重新生成与当前页数、参考设置一致的提纲，再复用项目；不会把旧提纲与新需求混合保存。');
    if (!await confirmAction('保存编辑并复用此项目？', '将先保存当前需求与提纲，再复制素材、需求和提纲到一个独立本机项目。新副本不含旧输出文件，不会覆盖原项目，也不会调用 AI。', '保存并复用')) return;
  } else if (!await canLeave()) return;
  await mutate('正在复用项目', async () => {
    if (saveFirst) await saveCurrent();
    const job = await api(`${jobPath(id)}/duplicate`, { method: 'POST', body: {}, timeout: 120000 });
    if (job.id === id || !['draft', 'planned'].includes(job.status) || job.outputs != null) throw new Error('服务未返回有效的独立项目副本，请刷新项目历史核对，勿重复提交。');
    rememberJob(job);
    hydrateJob(job);
    toast('已创建独立副本 · 素材、需求与提纲可继续复用，未复制输出');
  }, true);
}
async function ensureDraft(requirements) {
  if (state.currentId) return currentJob();
  const job = rememberJob(await api('/api/jobs', { method: 'POST', body: { title: requirements.topic || '新建演示文稿', requirements } }));
  state.currentId = job.id;
  renderFiles();
  renderHistory();
  return job;
}
async function saveCurrent(requireTopic = false, discardPlan = false) {
  const requirements = readRequirements(requireTopic);
  if (state.plan && !discardPlan && planStructureChanged()) throw new Error('目标页数或参考原页设置已变更，请先重新生成提纲；未发送与新需求不一致的旧提纲。');
  if (!discardPlan && !commitSlide()) throw new Error('请先修正当前页 JSON。');
  if (state.plan && !discardPlan) {
    state.plan.title = $('plan-title').value.trim();
    state.plan.subtitle = $('plan-subtitle').value.trim();
    validatePlan(state.plan, requirements);
  }
  await ensureDraft(requirements);
  const body = { title: (!discardPlan && state.plan?.title) || requirements.topic || currentJob().title, requirements };
  // Re-analysis saves requirements only; never pair a new structure with the old plan.
  if (!discardPlan && state.plan) body.plan = clone(state.plan);
  const saved = rememberJob(await api(jobPath(), { method: 'PUT', body }));
  if (discardPlan) state.invalidatedPlans.add(saved.id);
  else if (state.plan) state.invalidatedPlans.delete(saved.id);
  state.plan = !discardPlan && saved.plan && !state.invalidatedPlans.has(saved.id) ? clone(saved.plan) : null;
  state.selectedSlide = Math.max(0, Math.min(state.selectedSlide, (state.plan?.slides.length || 1) - 1));
  state.requirementsDirty = false;
  state.planDirty = false;
  fillRequirements(saved.requirements || requirements);
  $('plan-title').value = state.plan?.title || '';
  $('plan-subtitle').value = state.plan?.subtitle || '';
  if (!state.plan) {
    renderSlideList();
    showStep(1, false);
  } else if (state.step === 2) renderOutline();
  if (state.step === 3) renderDelivery();
  renderProgress();
  updateSaveState();
  return saved;
}
async function saveDraft() {
  if (state.plan && planStructureChanged()) throw new Error('目标页数或参考原页设置已变更。请在「素材与要求」点击生成提纲，确认替换旧提纲；或恢复原设置后再保存。');
  await mutate('正在保存', async () => { await saveCurrent(); toast('需求与提纲已保存到本机'); });
}
async function analyze() {
  readRequirements(true);
  const mode = selectedMode();
  const consent = mode === 'ai' && $('ai-consent').checked;
  if (mode === 'ai' && (!consent || !aiConfigured())) {
    $('requirements-dialog').showModal();
    $(aiConfigured() ? 'ai-consent' : 'configure-ai').focus();
    return;
  }
  const discardPlan = Boolean(state.plan && planStructureChanged());
  if (state.plan && !await confirmAction('重新生成提纲？', discardPlan ? '目标页数或参考原页设置已改变。将保存新需求并清除旧提纲和旧输出，再重新编排；未保存的旧提纲编辑也会被丢弃，素材保留。' : '新的分析结果会替换现有提纲。现有编辑将先保存，但请确认确实需要重新分析。', '重新分析')) return;
  await mutate('正在提交分析', async () => {
    await saveCurrent(true, discardPlan);
    $('ai-consent').checked = false;
    try {
      const accepted = await api(`${jobPath()}/analyze`, { method: 'POST', body: { mode, consent } });
      if (!['analyzing', 'planned', 'error'].includes(accepted.status)) throw new Error('服务未确认分析任务，请刷新项目状态。');
      const job = { ...currentJob(), status: accepted.status, progress: 0, stage: '分析已提交，等待本机处理', error: null };
      rememberJob(job);
      renderProgress();
      showStep(1, false);
      // Refresh only this job: do not fetch bootstrap/settings while processing.
      await refreshCurrent();
    } catch (error) {
      if (!error.httpStatus || error.httpStatus >= 500) {
        rememberJob({ ...currentJob(), status: 'analyzing', stage: '提交结果待确认，正在查询本机状态，请勿重复提交' });
        renderProgress();
      }
      await refreshCurrent().catch(() => {});
      throw error;
    }
  });
}
async function generate() {
  await mutate('正在提交生成', async () => {
    await saveCurrent(true);
    try {
      const accepted = await api(`${jobPath()}/generate`, { method: 'POST', body: {} });
      if (!['generating', 'ready', 'error'].includes(accepted.status)) throw new Error('服务未确认生成任务，请刷新项目状态。');
      rememberJob({ ...currentJob(), status: accepted.status, progress: 0, stage: '生成已提交，等待本机处理', error: null, outputs: undefined });
      showStep(3, false);
      renderProgress();
      await refreshCurrent();
    } catch (error) {
      if (!error.httpStatus || error.httpStatus >= 500) {
        rememberJob({ ...currentJob(), status: 'generating', stage: '提交结果待确认，正在查询本机状态，请勿重复提交', outputs: undefined });
        showStep(3, false);
        renderProgress();
      }
      await refreshCurrent().catch(() => {});
      throw error;
    }
  });
}

function renderHistory() {
  const jobs = [...state.jobs.values()].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  $('history-count').textContent = jobs.length;
  const search = $('history-search').value.trim().toLocaleLowerCase();
  const filter = $('history-filter').value;
  const filtered = jobs.filter((job) => {
    const match = `${job.title || ''} ${job.requirements?.topic || ''}`.toLocaleLowerCase().includes(search);
    return match && (filter === 'all' || filter === 'unfinished' && !['ready', 'error'].includes(job.status) || filter === job.status);
  });
  $('history-summary').textContent = filtered.length === jobs.length ? `${jobs.length} 个项目` : `${filtered.length} / ${jobs.length} 个项目`;
  $('history-list').hidden = !filtered.length;
  $('history-pager').hidden = !filtered.length;
  $('history-empty').hidden = filtered.length > 0;
  $('history-empty-title').textContent = jobs.length ? '没有匹配的项目' : '还没有项目';
  $('history-empty-description').textContent = jobs.length ? '试试其他关键词或筛选条件。' : '新建或保存演示后，项目会出现在这里。';
  $('history-create').hidden = Boolean(jobs.length);
  const rows = paginate('history', filtered).map(([job]) => {
    const row = node('article', 'history-row');
    const symbol = node('span', 'history-project-symbol'); symbol.append(icon('file'));
    const copy = node('div', 'history-project-copy');
    const title = node('h3', '', job.title || '未命名演示');
    title.title = title.textContent;
    const topic = node('p', 'history-project-requirements', job.requirements?.topic || '尚未填写主题');
    topic.title = topic.textContent;
    copy.append(title, topic, node('p', 'history-project-description', `${job.files?.length || 0} 份素材 · ${job.plan?.slides?.length || 0} 页提纲 · ${dateLabel(job.updatedAt)}`));
    const status = node('span', 'job-status', statuses[job.status] || job.status);
    if (Object.hasOwn(statuses, job.status)) status.classList.add(job.status);
    const actions = node('div', 'history-actions');
    const open = button('继续项目', 'button button-outline button-small history-open', () => openJob(job.id));
    open.disabled = Boolean(state.operation);
    const duplicate = button('复用项目', 'button button-quiet button-small', () => duplicateProject(job.id));
    duplicate.dataset.jobDuplicate = job.id;
    duplicate.disabled = !state.online || Boolean(state.operation) || processing(job);
    duplicate.title = processing(job) ? '项目处理完成后可复用' : '复制素材、需求与提纲；新副本不包含旧输出';
    actions.append(open, duplicate);
    row.append(symbol, copy, status, actions);
    return row;
  });
  $('history-list').replaceChildren(...rows);
}
async function refreshHistory() {
  if (state.operation || !state.online) return;
  const result = await api('/api/jobs');
  for (const job of result.jobs || []) {
    if (job.id === state.currentId) receiveJob(job);
    else rememberJob(job);
  }
  renderHistory();
}
function fileDeleteButton(file) {
  const remove = button(`删除 ${file.name}`, 'icon-button danger-text', () => deleteFile(file), 'trash');
  remove.dataset.fileDelete = file.id;
  remove.disabled = !state.online || Boolean(state.operation) || processing(currentJob());
  return remove;
}
function uploadedImages() {
  return (currentJob()?.files || []).filter((file) => file.kind === 'image').map((file) => ({ ...file, url: sameOriginUrl(file.imageUrl) })).filter((file) => file.url);
}
function renderFileList() {
  const files = currentJob()?.files || [];
  $('file-count').textContent = `${files.length} 份`;
  $('mobile-file-count').textContent = files.length;
  $('materials-empty').hidden = files.length > 0;
  $('file-library').hidden = !files.length;
  const rows = paginate('files', files).map(([file]) => {
    const item = node('li', 'file-item');
    const url = file.kind === 'image' ? sameOriginUrl(file.imageUrl) : null;
    const symbol = url ? button(`预览 ${file.name}`, 'file-thumb', () => {
      const gallery = uploadedImages();
      openImages(gallery, gallery.findIndex((image) => image.id === file.id));
    }) : node('span', 'file-symbol');
    symbol.replaceChildren(url ? imageElement(url, file.name) : icon('file'));
    const copy = node('div', 'file-copy');
    const path = file.relativePath || file.name;
    const metadata = `${file.kind === 'reference' ? '参考 PPTX' : file.kind === 'image' ? '图片' : '文档'} · ${bytesLabel(file.size)}`;
    const name = button(file.name, 'file-name', () => openReader('素材详情', `${path}\n${metadata}`));
    name.title = path;
    copy.append(name, node('span', 'file-details', metadata));
    item.append(symbol, copy, fileDeleteButton(file));
    return item;
  });
  $('file-list').replaceChildren(...rows);
}
function renderFiles() {
  renderFileList();
  renderReferenceOptions();
  renderImageOptions();
  syncControls();
}
function adoptMaterialJob(job, requirements, requirementsDirty) {
  rememberJob(job);
  state.invalidatedPlans.delete(job.id);
  // File mutations invalidate the server outline. Never resurrect it from UI memory.
  state.plan = job.plan ? clone(job.plan) : null;
  state.planDirty = false;
  state.selectedSlide = 0;
  state.editorMode = 'form';
  fillRequirements(requirements);
  const retained = readRequirements();
  state.requirementsDirty = requirementsDirty || Object.keys(defaults).some((key) => retained[key] !== (job.requirements?.[key] ?? defaults[key]));
  $('ai-consent').checked = false;
  renderFiles();
  renderOutline();
  if (!state.plan || state.step === 3 && !job.outputs) showStep(state.plan ? 2 : 1, false);
  renderDelivery();
  renderProgress();
}
async function deleteFile(file) {
  const invalidates = Boolean(state.plan || currentJob()?.outputs);
  if (!await confirmAction('删除素材？', `将从本机项目移除「${file.relativePath || file.name}」。${invalidates ? '素材变更会清除当前提纲（含未保存编辑）和旧输出，需重新生成提纲；' : ''}未保存的需求会保留。参考选择可能被解除，不会删除你的原始文件。`, '删除素材')) return;
  const requirements = readRequirements();
  const requirementsDirty = state.requirementsDirty;
  await mutate('正在删除素材', async () => {
    const job = await api(`${jobPath()}/files/${encodeURIComponent(file.id)}`, { method: 'DELETE' });
    adoptMaterialJob(job, requirements, requirementsDirty);
    toast(invalidates ? '素材已移除，旧提纲已清除；请重新生成提纲' : '素材已从本机项目移除');
  });
}
function normalizedRelativePath(path, name) {
  const parts = (path || name).replace(/\\/g, '/').split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /[\u0000-\u001f:]/.test(part))) throw new Error(`文件路径无效：${name}`);
  return parts.join('/');
}
async function uploadFiles(entries, folder = false) {
  if (!entries.length) return;
  const formats = supportedExtensions();
  if (!formats.length) throw new Error('尚未获取支持格式，不能上传。请重新连接。');
  const accepted = [], skipped = [];
  entries.forEach((entry) => {
    const extension = `.${entry.file.name.split('.').pop().toLowerCase()}`;
    if (formats.includes(extension)) accepted.push({ file: entry.file, path: normalizedRelativePath(entry.path, entry.file.name) });
    else skipped.push(entry.file.name);
  });
  if (skipped.length && !folder) throw new Error(`不支持的素材格式：${skipped.slice(0, 5).join('、')}。本次尚未上传。`);
  if (skipped.length) toast(`已跳过 ${skipped.length} 个不支持的文件`);
  if (!accepted.length) throw new Error('没有可上传的支持格式文件。');
  const caps = state.capabilities;
  const large = accepted.find((entry) => caps.maxFileMb && entry.file.size > caps.maxFileMb * 1024 * 1024);
  if (large) throw new Error(`「${large.file.name}」超过单文件 ${caps.maxFileMb} MB 限制。`);
  const total = (currentJob()?.files || []).reduce((sum, file) => sum + file.size, 0) + accepted.reduce((sum, entry) => sum + entry.file.size, 0);
  if (caps.maxTotalMb && total > caps.maxTotalMb * 1024 * 1024) throw new Error(`项目素材总计超过 ${caps.maxTotalMb} MB 限制，请先减少文件。`);
  const invalidates = Boolean(state.plan || currentJob()?.outputs);
  if (invalidates && !await confirmAction('添加素材并重新编排？', '上传成功后会清除当前提纲（含未保存编辑）与旧输出，需重新生成提纲。已有素材和当前未保存的文字需求会保留；取消不会上传文件。', '添加并清除旧提纲')) return;
  const requirements = readRequirements();
  const requirementsDirty = state.requirementsDirty;
  await mutate('正在上传素材', async () => {
    $('ai-consent').checked = false;
    await ensureDraft(requirements);
    $('upload-progress').hidden = false;
    let uploaded = 0;
    try {
      for (let offset = 0; offset < accepted.length; offset += 12) {
        const batch = accepted.slice(offset, offset + 12);
        const data = new FormData();
        batch.forEach((entry) => data.append('files', entry.file, entry.file.name));
        data.append('relativePaths', JSON.stringify(batch.map((entry) => entry.path)));
        $('upload-progress-text').textContent = `正在上传第 ${offset + 1}–${offset + batch.length} 个，共 ${accepted.length} 个（已完成 ${uploaded} 个）`;
        const job = await api(`${jobPath()}/files`, { method: 'POST', body: data, timeout: 120000 });
        uploaded += batch.length;
        adoptMaterialJob(job, requirements, requirementsDirty);
      }
      $('ai-consent').checked = false;
      toast(`已上传 ${uploaded} 个文件到本机${skipped.length ? `，跳过 ${skipped.length} 个` : ''}${invalidates ? '；旧提纲已清除，请重新生成' : ''}`);
    } catch (error) {
      throw new Error(`${error.message} 已完成 ${uploaded} / ${accepted.length} 个，请核对素材列表，勿重复上传已完成的批次。`);
    } finally { $('upload-progress').hidden = true; renderProgress(); }
  });
}
async function droppedEntries(dataTransfer) {
  const items = [...dataTransfer.items].filter((item) => item.kind === 'file');
  const roots = items.map((item) => ({ entry: item.webkitGetAsEntry?.(), file: item.getAsFile() }));
  const entries = [];
  let folder = false;
  async function walk(entry, parent = '') {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      entries.push({ file, path: `${parent}${file.name}` });
    } else if (entry.isDirectory) {
      folder = true;
      const reader = entry.createReader();
      // readEntries returns batches; keep reading until exhausted.
      while (true) {
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await walk(child, `${parent}${entry.name}/`);
      }
    }
  }
  if (!roots.length) return { entries: [...dataTransfer.files].map((file) => ({ file, path: file.webkitRelativePath || file.name })), folder: false };
  for (const root of roots) {
    if (root.entry) await walk(root.entry);
    else if (root.file) entries.push({ file: root.file, path: root.file.webkitRelativePath || root.file.name });
  }
  return { entries, folder };
}

function validateSlide(slide, prefix = '当前页') {
  if (!slide || typeof slide !== 'object' || Array.isArray(slide)) throw new Error(`${prefix}必须是 JSON 对象。`);
  const allowed = ['title', 'kicker', 'layout', 'body', 'metrics', 'columns', 'notes', 'imageId', 'referenceSlideIndex', 'chapterNumber'];
  for (const key of Object.keys(slide)) if (!allowed.includes(key)) throw new Error(`${prefix}包含不支持字段：${key}`);
  if (slide.chapterNumber !== undefined && (!Number.isInteger(slide.chapterNumber) || slide.chapterNumber < 1 || slide.chapterNumber > 40)) throw new Error(`${prefix}章节序号必须为1–40的整数。`);
  if (typeof slide.title !== 'string' || !slide.title.trim()) throw new Error(`${prefix}标题不能为空。`);
  if (!Object.hasOwn(layouts, slide.layout)) throw new Error(`${prefix}版式无效。`);
  if (isReferenceSlide(slide)) {
    if (!Number.isInteger(slide.referenceSlideIndex) || slide.referenceSlideIndex < 0 || slide.referenceSlideIndex > 4) throw new Error(`${prefix}参考原页序号必须为 0–4 的整数。`);
  } else if (slide.referenceSlideIndex !== undefined) throw new Error(`${prefix}仅参考原页支持 referenceSlideIndex。`);
  if (!Array.isArray(slide.body) || !slide.body.every((item) => typeof item === 'string')) throw new Error(`${prefix} body 必须是字符串数组。`);
  for (const key of ['kicker', 'notes']) if (slide[key] !== undefined && typeof slide[key] !== 'string') throw new Error(`${prefix} ${key} 必须是字符串。`);
  if (slide.metrics !== undefined) {
    if (!Array.isArray(slide.metrics) || !slide.metrics.every((metric) => metric && typeof metric === 'object' && !Array.isArray(metric) && typeof metric.value === 'string' && typeof metric.label === 'string' && Object.keys(metric).every((key) => ['value', 'label'].includes(key)))) throw new Error(`${prefix} metrics 必须是 {value: 字符串, label: 字符串} 数组。`);
  }
  if (slide.columns !== undefined) {
    if (!Array.isArray(slide.columns) || !slide.columns.every((column) => column && typeof column === 'object' && !Array.isArray(column) && typeof column.title === 'string' && Array.isArray(column.body) && column.body.every((item) => typeof item === 'string') && Object.keys(column).every((key) => ['title', 'body'].includes(key)))) throw new Error(`${prefix} columns 必须是 {title: 字符串, body: 字符串数组} 数组。`);
  }
  if (slide.imageId !== undefined && (typeof slide.imageId !== 'string' || slide.imageId && !(currentJob()?.files || []).some((file) => file.kind === 'image' && file.id === slide.imageId))) throw new Error(`${prefix} imageId 必须指向本项目已上传的图片。`);
  return slide;
}
function validatePlan(plan, requirements = readRequirements()) {
  if (typeof plan.title !== 'string' || !plan.title.trim()) throw new Error('演示标题不能为空。');
  if (!Array.isArray(plan.slides) || plan.slides.length < 5 || plan.slides.length > 40) throw new Error('提纲必须包含 5–40 页。');
  if (plan.slides.length !== requirements.pageCount) throw new Error('提纲页数与目标页数不一致，请增删正文页或重新生成提纲。');
  const count = requirements.referenceKeepCount || 0;
  if (count > referenceKeepLimit() || count && !requirements.referenceFileId) throw new Error('参考原页设置无效，请重新选择参考 PPTX。');
  plan.slides.forEach((slide, index) => {
    validateSlide(slide, `第 ${index + 1} 页`);
    if (index < count && (!isReferenceSlide(slide) || slide.referenceSlideIndex !== index)) throw new Error('保留的参考原页须按原始顺序固定在最前，不能编辑、移动或删除。');
    if (index >= count && isReferenceSlide(slide)) throw new Error('保留参考原页只能位于设定的开头区域。');
  });
}
function commitSlide() {
  if (!state.plan?.slides?.length || state.editorMode !== 'json' || isReferenceSlide(activeSlide())) return true;
  try {
    const slide = validateSlide(JSON.parse($('slide-json').value));
    if (isReferenceSlide(slide)) throw new Error('不能在 JSON 中把正文改成参考原页；请返回素材与要求设置保留页数并重新生成。');
    if (JSON.stringify(state.plan.slides[state.selectedSlide]) !== JSON.stringify(slide)) {
      state.plan.slides[state.selectedSlide] = clone(slide);
      markDirty('plan');
    }
    $('json-error').hidden = true;
    $('slide-json').removeAttribute('aria-invalid');
    return true;
  } catch (error) {
    $('json-error').textContent = error.message;
    $('json-error').hidden = false;
    $('slide-json').setAttribute('aria-invalid', 'true');
    $('slide-json').focus();
    return false;
  }
}
function activeSlide() { return state.plan?.slides[state.selectedSlide]; }
function renderOutline() {
  if (!state.plan) {
    $('plan-title').value = '';
    $('plan-subtitle').value = '';
    $('slide-json').value = '';
    $('reference-slide-warning').hidden = true;
    renderSlideList();
    syncControls();
    return;
  }
  $('plan-title').value = state.plan.title || '';
  $('plan-subtitle').value = state.plan.subtitle || '';
  renderSlideList(true);
  renderSlideEditor();
  syncControls();
}
function renderSlideList(followSelection = false) {
  const slides = state.plan?.slides || [];
  const jump = $('outline-jump');
  $('outline-count').textContent = `${slides.length} 页`;
  if (jump.options.length !== slides.length) jump.replaceChildren(...slides.map((_, index) => new Option(`第 ${index + 1} / ${slides.length} 页`, index)));
  jump.value = String(state.selectedSlide);
  if (followSelection) state.pages.slides = state.selectedSlide;
  const rows = paginate('slides', slides).map(([slide, index]) => {
    const item = node('li', 'slide-list-item');
    const select = button(`第 ${index + 1} 页：${slide.title}`, `slide-list-button${index === state.selectedSlide ? ' active' : ''}`, () => selectSlide(index));
    select.setAttribute('aria-pressed', String(index === state.selectedSlide));
    select.disabled = Boolean(state.operation);
    const copy = node('span', 'slide-list-copy');
    copy.append(node('span', 'slide-list-title', slide.title || '未命名页面'), node('span', 'slide-list-layout', layouts[slide.layout] || slide.layout));
    select.replaceChildren(node('span', 'slide-list-index', String(index + 1).padStart(2, '0')), copy);
    item.append(select);
    return item;
  });
  $('slide-list').replaceChildren(...rows);
}
function selectSlide(index) {
  if (state.operation || !state.plan?.slides[index] || !commitSlide()) {
    $('outline-jump').value = String(state.selectedSlide);
    return;
  }
  state.selectedSlide = index;
  state.pages.metrics = state.pages.columns = 0;
  renderSlideList(true); renderSlideEditor(); syncControls();
}
function renderSlideEditor() {
  const slide = activeSlide();
  if (!slide) return;
  const reference = isReferenceSlide(slide);
  $('reference-slide-warning').hidden = !reference;
  $('reference-slide-origin').textContent = reference ? `参考 PPT 第 ${slide.referenceSlideIndex + 1} 页` : '';
  for (const [id, key] of [['slide-title', 'title'], ['slide-kicker', 'kicker'], ['slide-notes', 'notes'], ['slide-layout', 'layout']]) $(id).value = slide[key] || '';
  $('slide-body').value = (slide.body || []).join('\n');
  $('slide-body').scrollTop = 0;
  $('slide-notes').scrollTop = 0;
  updateStructuredButtons();
  renderImageOptions();
  $('slide-json').value = JSON.stringify(slide, null, 2);
  $('json-error').hidden = true;
  $('slide-json').removeAttribute('aria-invalid');
  updateEditorTabs();
}
function updateEditorTabs() {
  const json = state.editorMode === 'json';
  $('slide-fields').hidden = json;
  $('slide-details').hidden = json;
  $('json-editor').hidden = !json;
  ['form', 'json'].forEach((mode) => {
    const tab = $(`editor-${mode}-tab`);
    tab.classList.toggle('active', state.editorMode === mode);
    tab.setAttribute('aria-pressed', String(state.editorMode === mode));
  });
}
function switchEditor(mode) {
  if (state.operation || !commitSlide()) return;
  state.editorMode = mode;
  renderSlideEditor(); syncControls();
}
function structuredInput(value, label, handler, multiline = false) {
  const input = node(multiline ? 'textarea' : 'input');
  if (!multiline) input.type = 'text';
  else input.rows = 3;
  input.value = value;
  input.placeholder = label;
  input.setAttribute('aria-label', label);
  input.addEventListener('input', () => {
    if (!canEditOutline() || isReferenceSlide(activeSlide())) return;
    handler(input.value); markDirty('plan');
  });
  return input;
}
function updateStructuredButtons() {
  const slide = activeSlide();
  $('open-metrics').hidden = slide?.layout !== 'metrics';
  $('open-columns').hidden = slide?.layout !== 'columns';
  $('open-metrics').textContent = `编辑指标（${slide?.metrics?.length || 0}）`;
  $('open-columns').textContent = `编辑分栏（${slide?.columns?.length || 0}）`;
}
function structuredField(label, input, action) {
  const field = node('div', 'form-field');
  const heading = node('label', '', label);
  input.id = `structured-${label === '分栏内容' ? 'body' : label === '指标名称' ? 'label' : 'value'}`;
  heading.htmlFor = input.id;
  const top = node('div', 'label-row');
  top.append(heading);
  if (action) top.append(action);
  field.append(top, input);
  return field;
}
function renderMetrics() {
  const container = $('metric-rows');
  container.replaceChildren();
  const metrics = activeSlide()?.metrics || [];
  for (const [metric, index] of paginate('metrics', metrics, 1)) {
    const row = node('div', 'metric-row');
    const remove = button(`删除第 ${index + 1} 个指标`, 'icon-button danger-text', () => {
      if (!canEditOutline()) return;
      metrics.splice(index, 1); markDirty('plan'); renderMetrics();
    }, 'trash');
    remove.dataset.structuredDelete = 'metric';
    row.append(structuredField('指标数值', structuredInput(metric.value, '指标数值', (value) => { metric.value = value; })), structuredField('指标名称', structuredInput(metric.label, '指标名称', (value) => { metric.label = value; })), remove);
    container.append(row);
  }
  if (!metrics.length) container.append(node('p', 'empty-structured', '尚无指标。'));
  updateStructuredButtons();
  syncControls();
}
function renderColumns() {
  const container = $('column-rows');
  container.replaceChildren();
  const columns = activeSlide()?.columns || [];
  for (const [column, index] of paginate('columns', columns, 1)) {
    const row = node('div', 'column-row');
    const body = structuredInput(column.body.join('\n'), '每行一条', (value) => { column.body = lines(value); }, true);
    const remove = button(`删除第 ${index + 1} 个分栏`, 'icon-button danger-text', () => {
      if (!canEditOutline()) return;
      columns.splice(index, 1); markDirty('plan'); renderColumns();
    }, 'trash');
    remove.dataset.structuredDelete = 'column';
    row.append(structuredField('分栏标题', structuredInput(column.title, '分栏标题', (value) => { column.title = value; }), remove), structuredField('分栏内容', body, button('看全文', 'text-button', () => openReader('分栏内容', body.value))));
    container.append(row);
  }
  if (!columns.length) container.append(node('p', 'empty-structured', '尚无分栏。'));
  updateStructuredButtons();
  syncControls();
}
function renderImageOptions() {
  const select = $('slide-image');
  select.replaceChildren(new Option('不指定图片', ''));
  const files = (currentJob()?.files || []).filter((file) => file.kind === 'image');
  files.forEach((file) => select.add(new Option(file.relativePath || file.name, file.id)));
  $('image-selection-help').textContent = isReferenceSlide(activeSlide()) ? '参考原页只读。' : files.length ? '从已上传的图片中选择。' : '暂无已上传图片。';
  select.title = $('image-selection-help').textContent;
  select.value = activeSlide()?.imageId || '';
  if (select.selectedIndex === -1) select.value = '';
  renderSelectedImage();
}
function renderSelectedImage() {
  const preview = $('selected-image-preview'); preview.replaceChildren(); preview.hidden = true;
  const gallery = uploadedImages();
  const index = gallery.findIndex((file) => file.id === $('slide-image').value);
  if (index < 0) return;
  const file = gallery[index];
  const open = button('看图', 'text-button', () => openImages(gallery, index));
  open.title = `预览 ${file.name}`;
  preview.append(open); preview.hidden = false;
}
function canEditOutline() { return state.online && !state.operation && !processing(currentJob()) && Boolean(state.plan); }
function alignOutlineCount() {
  $('page-count').value = String(state.plan.slides.length);
  syncReferenceKeepCount();
  markDirty('requirements');
  markDirty('plan');
}
function addSlide() {
  if (!canEditOutline() || planStructureChanged() || state.plan.slides.length >= 40 || !commitSlide()) return;
  const insertion = Math.max(referencePrefixCount(), state.selectedSlide + 1);
  state.plan.slides.splice(insertion, 0, { title: '新页面', kicker: '', layout: 'content', body: [], notes: '' });
  state.selectedSlide = insertion;
  alignOutlineCount(); renderOutline();
}
function moveSlide(direction) {
  if (!canEditOutline() || planStructureChanged() || isReferenceSlide(activeSlide()) || ![-1, 1].includes(direction) || !commitSlide()) return;
  const destination = state.selectedSlide + direction;
  if (destination < referencePrefixCount() || destination >= state.plan.slides.length) return;
  const [slide] = state.plan.slides.splice(state.selectedSlide, 1);
  state.plan.slides.splice(destination, 0, slide);
  state.selectedSlide = destination;
  markDirty('plan'); renderOutline();
}
async function deleteSlide() {
  if (!canEditOutline() || planStructureChanged() || isReferenceSlide(activeSlide()) || state.plan.slides.length <= Math.max(5, referencePrefixCount() + 2) || !commitSlide()) return;
  const plan = state.plan;
  const index = state.selectedSlide;
  const slide = activeSlide();
  if (!await confirmAction('删除当前页？', `将移除第 ${index + 1} 页「${slide.title}」，并同步目标总页数。保留的参考原页不会变动；保存后才写入本机项目。`, '删除本页')) return;
  if (!canEditOutline() || state.plan !== plan || activeSlide() !== slide || planStructureChanged()) return;
  state.plan.slides.splice(index, 1);
  state.selectedSlide = Math.min(index, state.plan.slides.length - 1);
  alignOutlineCount(); renderOutline();
}

function renderProgress() {
  const job = currentJob();
  const active = processing(job);
  $('task-progress').hidden = !active && job?.status !== 'error';
  $('task-progress').classList.toggle('has-error', job?.status === 'error');
  $('progress-symbol').hidden = !active;
  $('progress-title').textContent = job?.status === 'analyzing' ? '正在整理素材与提纲' : job?.status === 'generating' ? '正在制作演示文稿' : '任务需要处理';
  const progress = Math.max(0, Math.min(100, Number(job?.progress) || 0));
  $('progress-percent').textContent = `${Math.round(progress)}%`;
  $('progress-bar').value = progress;
  const pollWarning = state.pollFailures.get(state.currentId);
  const stage = pollWarning || job?.stage || (active ? '等待本机服务更新进度' : '请检查错误后重试');
  $('progress-stage').textContent = stage;
  $('progress-stage').title = stage;
  $('read-task-error').hidden = !job?.error;
  $('retry-poll').hidden = !pollWarning;
  const warnings = Array.isArray(job?.warnings) ? job.warnings : [];
  $('job-warnings').hidden = !warnings.length;
  $('job-warnings').textContent = `提示（${warnings.length}）`;
  syncControls();
}
function receiveJob(job) {
  const previous = state.jobs.get(job.id);
  if (previous?.status === 'analyzing' && job.status === 'planned' && planMatchesRequirements(job.plan, job.requirements || defaults)) state.invalidatedPlans.delete(job.id);
  rememberJob(job);
  if (job.id !== state.currentId) return;
  // A server-side file reset is authoritative even when the old outline was dirty.
  // Keep the brief fields untouched; only remove an unavailable reference selection.
  if (job.plan == null && state.plan && !processing(job)) {
    const referenceId = $('reference-file').value;
    const keepCount = $('reference-keep-count').value;
    state.plan = null;
    state.planDirty = false;
    state.selectedSlide = 0;
    state.editorMode = 'form';
    state.invalidatedPlans.delete(job.id);
    $('ai-consent').checked = false;
    renderFiles();
    if (referenceId !== $('reference-file').value || keepCount !== $('reference-keep-count').value) state.requirementsDirty = true;
    renderOutline();
    showStep(1, false);
    renderDelivery();
    alertMessage('本机项目的旧提纲已失效，已同步清除；未保存的文字需求仍保留，请重新生成提纲。');
  }
  // Polling updates server metadata, never rehydrates an unsaved brief or outline.
  if (!state.invalidatedPlans.has(job.id) && job.status !== 'analyzing' && planMatchesRequirements(job.plan, job.requirements || defaults) && !state.planDirty && (previous?.status === 'analyzing' || !state.plan)) {
    state.plan = clone(job.plan);
    state.selectedSlide = Math.min(state.selectedSlide, state.plan.slides.length - 1);
    $('plan-title').value = state.plan.title || '';
    $('plan-subtitle').value = state.plan.subtitle || '';
    if (previous?.status === 'analyzing' && job.status === 'planned') showStep(2, false);
    else if (state.step === 2) renderOutline();
  }
  renderProgress();
  if (state.step === 3) renderDelivery();
  if (previous?.status === 'generating' && job.status === 'ready') toast('演示文件已生成，可下载 PPTX');
  updateSaveState();
}
async function refreshCurrent() {
  if (!state.currentId) return;
  const id = state.currentId;
  const job = await api(jobPath(id));
  state.pollFailures.delete(id);
  receiveJob(job);
}
function schedulePoll() {
  if (state.pollTimer || state.polling || !state.online || ![...state.jobs.values()].some(processing)) return;
  state.pollTimer = setTimeout(() => { state.pollTimer = null; run(pollJobs); }, document.hidden ? 3000 : 1000);
}
async function pollJobs() {
  if (state.polling || !state.online) return;
  const jobs = [...state.jobs.values()].filter(processing);
  if (!jobs.length) return;
  state.polling = true;
  try {
    await Promise.all(jobs.map(async (job) => {
      try {
        const fresh = await api(jobPath(job.id), { timeout: 15000 });
        // Ignore stale in-flight results if another explicit action updated the job.
        if (state.jobs.get(job.id) !== job) return;
        state.pollFailures.delete(job.id);
        receiveJob(fresh);
      } catch (error) {
        state.pollFailures.set(job.id, `状态更新失败：${error.message} 将自动重连，不会重复提交任务。`);
      }
    }));
  } finally { state.polling = false; renderProgress(); schedulePoll(); }
}
function renderDelivery() {
  const job = currentJob();
  const outputs = job?.status === 'ready' ? job.outputs : null;
  const pptxUrl = sameOriginUrl(outputs?.pptxUrl);
  const available = Boolean(pptxUrl);
  $('delivery-empty').hidden = available;
  $('delivery-result').hidden = !available;
  $('delivery-empty-title').textContent = job?.status === 'generating' ? '正在生成，请稍候' : job?.status === 'error' ? '本次生成未完成' : '还没有生成文件';
  $('delivery-empty-description').textContent = job?.status === 'generating' ? '生成完成后会在这里显示预览。' : job?.status === 'error' ? '请查看错误详情，修正后可重新生成。' : '核对提纲并点击「生成 PPTX」后，即可预览和下载。';
  $('delivery-back-outline').hidden = !state.plan;
  if (!available) { state.previews = []; state.previewIndex = 0; return; }
  const download = node('a', 'button button-dark');
  download.href = pptxUrl;
  download.download = `${(job.title || '演示文稿').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')}.pptx`;
  download.append(icon('download'), document.createTextNode('下载 PPTX'));
  $('download-links').replaceChildren(download);
  $('delivery-summary').textContent = `${job.plan?.slides?.length || 0} 页 · 可在 PowerPoint 中继续编辑`;
  state.previews = (outputs.slides || []).map((slide) => ({ number: slide.number, url: sameOriginUrl(slide.url), name: `第 ${slide.number} 页` })).filter((slide) => slide.url && /\.png$/i.test(new URL(slide.url).pathname));
  const hasPreviews = state.previews.length > 0;
  $('preview-pane').hidden = !hasPreviews;
  $('preview-unavailable').hidden = hasPreviews;
  $('audit-panel').hidden = outputs.audit == null;
  $('preview-jump').replaceChildren(...state.previews.map((slide, index) => new Option(`第 ${slide.number} / ${state.previews.length} 页`, index)));
  if (hasPreviews) showPreview(Math.min(state.previewIndex, state.previews.length - 1));
}
function showPreview(index) {
  const slide = state.previews[index];
  if (!slide) return;
  state.previewIndex = index;
  const stage = $('preview-stage');
  const image = imageElement(slide.url, slide.name);
  image.loading = 'eager';
  stage.replaceChildren(image);
  stage.setAttribute('aria-label', `放大${slide.name}`);
  stage.title = '点击放大 · 方向键翻页';
  const title = currentJob()?.plan?.slides?.[slide.number - 1]?.title || slide.name;
  $('preview-caption').textContent = title;
  $('preview-caption').title = title;
  $('preview-jump').value = String(index);
  $('preview-prev').disabled = index === 0;
  $('preview-next').disabled = index === state.previews.length - 1;
}
function openImages(images, index, internal = false) {
  if (index < 0 || !images.length) return;
  state.images = images;
  state.imageIndex = index;
  state.imageInternal = internal;
  renderImageDialog();
  if (!$('image-dialog').open) $('image-dialog').showModal();
}
function renderImageDialog() {
  const item = state.images[state.imageIndex];
  if (!item) return;
  const url = sameOriginUrl(item.url);
  if (!url) return;
  $('image-dialog-title').textContent = `${state.imageInternal ? '内部 PNG 预览 · ' : ''}${item.name}`;
  $('image-dialog-img').alt = item.name;
  $('image-dialog-img').hidden = false;
  $('image-load-error').hidden = true;
  $('image-dialog-img').src = url;
  $('image-original').hidden = state.imageInternal;
  if (state.imageInternal) $('image-original').removeAttribute('href');
  else $('image-original').href = url;
  $('previous-image').disabled = state.imageIndex === 0;
  $('next-image').disabled = state.imageIndex >= state.images.length - 1;
  $('image-dialog-counter').textContent = `${state.imageIndex + 1} / ${state.images.length}`;
}
function moveImage(direction) {
  const next = state.imageIndex + direction;
  if (next < 0 || next >= state.images.length) return;
  state.imageIndex = next; renderImageDialog();
}

function settingsFeedback(message, type = '') {
  $('settings-feedback-text').textContent = message;
  $('settings-feedback').className = `settings-feedback${type ? ` ${type}` : ''}`;
  $('settings-feedback').hidden = !message;
  $('read-settings-feedback').hidden = message.length < 24;
}
function publicSettings(settings) {
  // Deliberately whitelist public fields: never retain an API key from a response.
  return { baseUrl: settings.baseUrl || '', model: settings.model || '', hasApiKey: Boolean(settings.hasApiKey), allowLocalApi: Boolean(settings.allowLocalApi) };
}
function fillSettings() {
  $('api-base-url').value = state.settings.baseUrl || '';
  $('api-model').value = state.settings.model || '';
  $('api-key').value = '';
  $('clear-api-key').checked = false;
  $('allow-local-api').checked = Boolean(state.settings.allowLocalApi);
  $('api-key-state').textContent = state.settings.hasApiKey ? '已由本机 DPAPI 保存' : '未保存密钥';
  syncControls();
}
async function openSettings() {
  if (state.settingsBusy) return;
  fillSettings(); settingsFeedback('');
  if (!$('settings-dialog').open) $('settings-dialog').showModal();
  if (!state.online) { settingsFeedback('请先启动并连接本机服务。', 'error'); return; }
  state.settingsBusy = true; syncControls();
  try {
    state.settings = publicSettings(await api('/api/settings'));
    fillSettings(); updateCapabilities();
  } catch (error) { settingsFeedback(error.message, 'error'); }
  finally { state.settingsBusy = false; syncControls(); }
}
function closeSettings() {
  if (state.settingsBusy) return;
  $('api-key').value = '';
  $('clear-api-key').checked = false;
  $('settings-dialog').close();
}
function settingsChanged() {
  return $('api-base-url').value.trim() !== (state.settings.baseUrl || '') || $('api-model').value.trim() !== (state.settings.model || '') || $('allow-local-api').checked !== Boolean(state.settings.allowLocalApi) || Boolean($('api-key').value) || $('clear-api-key').checked;
}
async function saveSettings(event) {
  event.preventDefault();
  if (state.settingsBusy || !state.online) return;
  const removing = $('clear-api-key').checked;
  if (!removing && !$('settings-form').reportValidity()) return;
  const baseUrl = $('api-base-url').value.trim();
  if (baseUrl) {
    let url;
    try { url = new URL(baseUrl); } catch { settingsFeedback('请填写有效的 API Base URL。', 'error'); return; }
    if (url.username || url.password || !['https:', 'http:'].includes(url.protocol)) { settingsFeedback('只支持无内嵌凭据的 HTTPS / HTTP API 地址。', 'error'); return; }
    if (url.protocol === 'http:' && !$('allow-local-api').checked) { settingsFeedback('HTTP API 需要显式允许受信任的本地 HTTP 服务。', 'error'); return; }
  }
  const body = { baseUrl, model: $('api-model').value.trim(), allowLocalApi: $('allow-local-api').checked, clearApiKey: removing };
  if (!removing && $('api-key').value) body.apiKey = $('api-key').value;
  $('ai-consent').checked = false;
  state.settingsBusy = true; syncControls();
  try {
    state.settings = publicSettings(await api('/api/settings', { method: 'PUT', body }));
    fillSettings(); updateCapabilities();
    $('ai-consent').checked = false;
    settingsFeedback(removing ? '已移除本机保存的密钥。' : '设置已保存到本机；尚未测试连接。', 'success');
  } catch (error) { settingsFeedback(error.message, 'error'); }
  finally {
    // No localStorage, sessionStorage, IndexedDB or client persistence for secrets.
    delete body.apiKey;
    $('api-key').value = '';
    state.settingsBusy = false; syncControls();
  }
}
async function testSettings() {
  if (state.settingsBusy || !state.online) return;
  if (settingsChanged()) { settingsFeedback('测试使用已保存设置。请先保存当前修改，或关闭后重新打开设置。', 'error'); return; }
  if (!aiConfigured()) { settingsFeedback('基础模式无需测试；测试 AI 连接前请保存完整的 API 地址、模型和密钥（或受信任本地 API 设置）。', 'error'); return; }
  if (!await confirmAction('发起真实模型测试？', `将由本机服务向已保存的 API 地址 ${state.settings.baseUrl} 发起真实测试请求，可能产生费用；不发送项目素材。`, '同意并测试')) return;
  state.settingsBusy = true; syncControls(); settingsFeedback('正在通过本机服务测试已保存设置…');
  try {
    const result = await api('/api/settings/test', { method: 'POST', body: {}, timeout: 60000 });
    if (result.ok !== true || result.success === false) throw new Error(result.error || result.message || '服务未确认收到模型的真实响应，不能判定测试通过。');
    settingsFeedback(result.message || '真实请求成功，已保存模型连接测试通过。', 'success');
  } catch (error) { settingsFeedback(error.message, 'error'); }
  finally { state.settingsBusy = false; syncControls(); }
}
async function bootstrap() {
  if (state.bootstrapBusy) return;
  state.bootstrapBusy = true;
  $('retry-bootstrap').disabled = true;
  $('service-status').className = 'service-status pending';
  $('service-status-text').textContent = '正在连接本地服务';
  try {
    const result = await api('/api/bootstrap');
    state.online = true;
    state.capabilities = result.capabilities || {};
    state.settings = publicSettings(result.settings || {});
    for (const job of result.jobs || []) {
      if (job.id === state.currentId) receiveJob(job);
      else rememberJob(job);
    }
    $('service-status').className = 'service-status';
    $('service-status-text').textContent = '本地服务已连接';
    $('global-alert').hidden = true;
    updateCapabilities(); renderHistory(); renderProgress();
    schedulePoll();
  } catch (error) {
    state.online = false;
    $('service-status').className = 'service-status offline';
    $('service-status-text').textContent = '本地服务未连接';
    alertMessage(`${error.message} 页面会保留未保存编辑；服务启动后点击重新连接。`, true);
    updateCapabilities();
  } finally {
    state.bootstrapBusy = false;
    $('retry-bootstrap').disabled = false;
    syncControls();
  }
}

function onClick(id, handler) { $(id).addEventListener('click', (event) => { event.preventDefault(); run(handler); }); }
onClick('new-project', newProject);
onClick('history-create', newProject);
onClick('duplicate-project', () => duplicateProject());
onClick('apply-launch-preset', applyLaunchPreset);
onClick('brand-home', () => setView('workspace'));
onClick('nav-workspace', () => setView('workspace'));
onClick('nav-history', async () => { setView('history'); if (state.online) await refreshHistory(); });
['nav-settings', 'configure-ai'].forEach((id) => onClick(id, openSettings));
onClick('retry-bootstrap', bootstrap);
onClick('dismiss-alert', () => { $('global-alert').hidden = true; });
onClick('read-alert', () => openReader('操作提示', $('global-alert-text').textContent));
onClick('job-warnings', () => openReader('素材与生成提示', currentJob().warnings.map((message, index) => `${index + 1}. ${message}`).join('\n\n')));
onClick('read-task-error', () => openReader('任务错误', currentJob().error));
onClick('refresh-history', refreshHistory);
function filterHistory() { state.pages.history = 0; renderHistory(); }
$('history-search').addEventListener('input', filterHistory);
$('history-filter').addEventListener('change', filterHistory);
[1, 2, 3].forEach((step) => onClick(`step-${step}`, () => showStep(step)));
['delivery-back-outline', 'edit-again'].forEach((id) => onClick(id, () => showStep(2)));
for (const pane of ['requirements', 'materials']) onClick(`show-${pane}`, () => setMaterialsPane(pane));
onClick('more-options', () => $('requirements-dialog').showModal());
$('requirements-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!$('analyze').disabled) run(analyze);
});
for (const id of ['requirements-form', 'advanced-fields']) $(id).addEventListener('input', (event) => {
  if (event.target.id === 'ai-consent') { syncControls(); return; }
  markDirty('requirements');
  updateConsentPanel();
});
document.querySelectorAll('[data-close-dialog]').forEach((element) => {
  element.addEventListener('click', () => element.closest('dialog').close());
});
for (const [id, increment] of [['page-minus', -1], ['page-plus', 1]]) onClick(id, () => {
  $('page-count').value = Math.max(5, Math.min(40, (Number($('page-count').value) || 19) + increment));
  markDirty('requirements');
});
onClick('save-draft', saveDraft);
onClick('save-plan', saveDraft);
onClick('analyze', analyze);
onClick('generate', generate);
$('ai-consent').addEventListener('change', syncControls);
onClick('select-files', () => { $('file-input').click(); });
onClick('select-folder', () => { $('folder-input').click(); });
for (const [id, folder] of [['file-input', false], ['folder-input', true]]) $(id).addEventListener('change', (event) => {
  const entries = [...event.target.files].map((file) => ({ file, path: file.webkitRelativePath || file.name }));
  event.target.value = '';
  run(() => uploadFiles(entries, folder));
});
$('dropzone').addEventListener('click', (event) => {
  if (event.target.closest('button, input') || $('dropzone').getAttribute('aria-disabled') === 'true') return;
  $('file-input').click();
});
$('dropzone').addEventListener('keydown', (event) => {
  if (event.target !== $('dropzone') || !['Enter', ' '].includes(event.key)) return;
  event.preventDefault();
  if ($('dropzone').getAttribute('aria-disabled') !== 'true') $('file-input').click();
});
let dragDepth = 0;
$('dropzone').addEventListener('dragenter', (event) => {
  event.preventDefault(); dragDepth += 1;
  if ($('dropzone').getAttribute('aria-disabled') !== 'true') $('dropzone').classList.add('drag-active');
});
$('dropzone').addEventListener('dragover', (event) => { event.preventDefault(); });
$('dropzone').addEventListener('dragleave', (event) => {
  event.preventDefault(); dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('dropzone').classList.remove('drag-active');
});
$('dropzone').addEventListener('drop', (event) => {
  event.preventDefault(); dragDepth = 0; $('dropzone').classList.remove('drag-active');
  if ($('dropzone').getAttribute('aria-disabled') === 'true') return;
  const extracted = droppedEntries(event.dataTransfer);
  run(async () => { const result = await extracted; await uploadFiles(result.entries, result.folder); });
});
// Prevent dropped local files from navigating the whole app away.
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => event.preventDefault());
for (const [id, key] of [['plan-title', 'title'], ['plan-subtitle', 'subtitle']]) $(id).addEventListener('input', () => {
  if (!state.plan) return;
  state.plan[key] = $(id).value; markDirty('plan');
});
for (const [id, key] of [['slide-title', 'title'], ['slide-kicker', 'kicker'], ['slide-body', 'body'], ['slide-notes', 'notes']]) $(id).addEventListener('input', () => {
  if (!canEditOutline() || !activeSlide() || isReferenceSlide(activeSlide())) return;
  activeSlide()[key] = key === 'body' ? lines($(id).value) : $(id).value;
  markDirty('plan');
  if (key === 'title') renderSlideList();
});
$('slide-layout').addEventListener('change', () => {
  if (!canEditOutline() || !activeSlide() || isReferenceSlide(activeSlide())) return;
  if ($('slide-layout').value === 'reference' || !Object.hasOwn(layouts, $('slide-layout').value)) { renderSlideEditor(); return; }
  activeSlide().layout = $('slide-layout').value;
  markDirty('plan'); renderSlideList();
  updateStructuredButtons();
});
$('slide-image').addEventListener('change', () => {
  if (!canEditOutline() || !activeSlide() || isReferenceSlide(activeSlide())) return;
  if ($('slide-image').value && !(currentJob()?.files || []).some((file) => file.kind === 'image' && file.id === $('slide-image').value)) { renderImageOptions(); return; }
  if ($('slide-image').value) activeSlide().imageId = $('slide-image').value;
  else delete activeSlide().imageId;
  markDirty('plan'); renderSelectedImage();
});
onClick('editor-form-tab', () => switchEditor('form'));
onClick('editor-json-tab', () => switchEditor('json'));
$('slide-json').addEventListener('input', () => {
  if (!canEditOutline() || isReferenceSlide(activeSlide())) return;
  markDirty('plan'); $('json-error').hidden = true;
});
onClick('apply-json', () => {
  if (!canEditOutline() || isReferenceSlide(activeSlide())) return;
  if (commitSlide()) { $('slide-json').removeAttribute('aria-invalid'); renderSlideList(); toast('当前页 JSON 校验通过并已应用，尚需保存'); }
});
onClick('add-slide', addSlide);
onClick('move-slide-up', () => moveSlide(-1));
onClick('move-slide-down', () => moveSlide(1));
onClick('delete-slide', deleteSlide);
onClick('outline-prev', () => selectSlide(state.selectedSlide - 1));
onClick('outline-next', () => selectSlide(state.selectedSlide + 1));
$('outline-jump').addEventListener('change', () => selectSlide(Number($('outline-jump').value)));
onClick('open-plan-meta', () => $('plan-meta-dialog').showModal());
onClick('open-slide-notes', () => $('slide-notes-dialog').showModal());
onClick('read-slide-body', () => openReader('正文要点', $('slide-body').value));
onClick('read-slide-notes', () => openReader('演讲备注', $('slide-notes').value));
for (const [dialog, render] of [['metrics', renderMetrics], ['columns', renderColumns]]) {
  onClick(`open-${dialog}`, () => { render(); $(`${dialog}-editor`).showModal(); });
}
onClick('add-metric', () => {
  if (!canEditOutline() || isReferenceSlide(activeSlide())) return;
  state.pages.metrics = (activeSlide().metrics ||= []).push({ value: '', label: '' }) - 1;
  markDirty('plan'); renderMetrics();
  $('metric-rows').querySelector('input')?.focus();
});
onClick('add-column', () => {
  if (!canEditOutline() || isReferenceSlide(activeSlide())) return;
  state.pages.columns = (activeSlide().columns ||= []).push({ title: '', body: [] }) - 1;
  markDirty('plan'); renderColumns();
  $('column-rows').querySelector('input')?.focus();
});
const listRenderers = { files: renderFileList, slides: renderSlideList, history: renderHistory };
for (const [key, render] of Object.entries({ ...listRenderers, metrics: renderMetrics, columns: renderColumns })) {
  for (const [suffix, direction] of [['prev', -1], ['next', 1]]) onClick(`${key}-${suffix}`, () => {
    state.pages[key] = Math.max(0, state.pages[key] + direction * (listLayouts[key]?.shown ?? 1));
    render();
  });
}
const listObserver = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const key = Object.keys(listLayouts).find((name) => listLayouts[name].id === entry.target.id);
    if (entry.contentRect.height && listCapacity(key) !== listLayouts[key].shown) listRenderers[key]();
  }
});
for (const { id } of Object.values(listLayouts)) listObserver.observe($(id));
onClick('preview-stage', () => openImages(state.previews, state.previewIndex, true));
onClick('preview-prev', () => showPreview(state.previewIndex - 1));
onClick('preview-next', () => showPreview(state.previewIndex + 1));
$('preview-jump').addEventListener('change', () => showPreview(Number($('preview-jump').value)));
$('preview-pane').addEventListener('keydown', (event) => {
  if (event.target === $('preview-jump') || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  showPreview(state.previewIndex + (event.key === 'ArrowLeft' ? -1 : 1));
});
onClick('audit-panel', () => {
  const audit = currentJob().outputs.audit;
  openReader('生成详情', typeof audit === 'string' ? audit : JSON.stringify(audit, null, 2), true);
});
onClick('read-settings-feedback', () => openReader('模型设置提示', $('settings-feedback-text').textContent));
onClick('reader-prev', () => moveReader(-1));
onClick('reader-next', () => moveReader(1));
window.addEventListener('resize', () => {
  if (!$('reader-dialog').open) return;
  state.reader.starts = [0];
  state.reader.index = 0;
  renderReaderPage();
});
onClick('retry-poll', async () => {
  if (!state.online) { await bootstrap(); return; }
  await refreshCurrent(); schedulePoll();
});
onClick('close-settings', closeSettings);
$('settings-dialog').addEventListener('cancel', (event) => { event.preventDefault(); closeSettings(); });
$('settings-dialog').addEventListener('close', () => { $('api-key').value = ''; });
$('settings-form').addEventListener('submit', (event) => { run(() => saveSettings(event)); });
$('clear-api-key').addEventListener('change', () => { if ($('clear-api-key').checked) $('api-key').value = ''; syncControls(); });
$('settings-form').addEventListener('input', () => { settingsFeedback('有未保存的设置；测试只使用已保存的配置。'); });
onClick('test-api', testSettings);
onClick('confirm-cancel', () => finishConfirm(false));
onClick('confirm-accept', () => finishConfirm(true));
$('confirm-dialog').addEventListener('cancel', (event) => { event.preventDefault(); finishConfirm(false); });
onClick('close-image', () => $('image-dialog').close());
onClick('previous-image', () => moveImage(-1));
onClick('next-image', () => moveImage(1));
$('image-dialog').addEventListener('keydown', (event) => {
  if (event.key === 'ArrowLeft') { event.preventDefault(); moveImage(-1); }
  if (event.key === 'ArrowRight') { event.preventDefault(); moveImage(1); }
});
$('image-dialog-img').addEventListener('error', () => { $('image-dialog-img').hidden = true; $('image-load-error').hidden = false; });
$('image-dialog-img').addEventListener('load', () => { $('image-dialog-img').hidden = false; $('image-load-error').hidden = true; });
$('image-dialog').addEventListener('close', () => { $('image-dialog-img').removeAttribute('src'); state.images = []; });
window.addEventListener('beforeunload', (event) => {
  $('api-key').value = '';
  if (dirty() || state.operation || state.settingsBusy) { event.preventDefault(); event.returnValue = ''; }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearTimeout(state.pollTimer); state.pollTimer = null; }
  else schedulePoll();
});
fillRequirements();
renderHistory();
syncControls();
run(bootstrap);
