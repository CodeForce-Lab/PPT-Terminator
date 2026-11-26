// Copyright (c) 2026 CodeForce-Lab
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
// 使用、修改或分发时须保留本声明并署名 CodeForce-Lab。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import AdmZip from 'adm-zip';
import { createApp } from '../server.mjs';
import { validateRequirements, validatePlan, validateReferencePrefix, basicPlan } from '../lib/planner.mjs';
import { protectKey, protectKeyFile, callModel } from '../lib/model.mjs';

const requirements = { topic: '年度合作伙伴汇报', pageCount: 5, style: 'launch', mode: 'basic' };
test('requirements and native outline validate at boundary', () => {
  assert.throws(() => validateRequirements({ pageCount: 41 }));
  assert.throws(() => validatePlan({ slides: [] }));
  const plan = basicPlan({ title: '示例', requirements: validateRequirements(requirements), files: [{ id: 'document', kind: 'document', name: 'report', text: '安全保供。\n服务升级。\n协同发展。' }] }).plan;
  assert.equal(plan.slides.length, 5);
  assert.ok(plan.slides.some(s => s.notes.includes('服务升级')));
  assert.throws(() => validatePlan({ ...plan, slides: plan.slides.map((s, i) => i === 2 ? { ...s, imageId: 'missing' } : s) }));
});
test('local API persists documents and plans; rejects cross-site, invalid upload and unauthorized AI', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ppt-studio-api-'));
  const app = await createApp({ dataDir, renderer: async ({ outputDir }) => {
    const pptxPath = path.join(outputDir, 'presentation.pptx');
    await fs.writeFile(pptxPath, 'unit-test-output');
    return { pptxPath, pdfPath: null, slideImages: [], audit: { test: true }, warnings: [] };
  } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(r => server.close(r)); await fs.rm(dataDir, { recursive: true, force: true }); });
  const api = async (route, body, method = 'POST') => fetch(base + route, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body) });
  const bootstrap = await (await fetch(base + '/api/bootstrap')).json();
  assert.equal(bootstrap.jobs.length, 0);
  assert.ok(!('encryptedKey' in bootstrap.settings));
  const crossSite = await fetch(base + '/api/bootstrap', { headers: { Origin: 'https://untrusted.invalid' } });
  assert.equal(crossSite.status, 403);
  const hostStatus = await new Promise((resolve, reject) => {
    http.get(base + '/api/bootstrap', { headers: { Host: 'attacker.invalid' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(hostStatus, 403);
  process.env.PPT_STUDIO_ALLOWED_HOSTS = '10.66.66.1';
  const vpnStatus = await new Promise((resolve, reject) => {
    http.get(base + '/api/bootstrap', { headers: { Host: '10.66.66.1' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  const vpnWrongOrigin = await new Promise((resolve, reject) => {
    http.get(base + '/api/bootstrap', { headers: { Host: '10.66.66.1', Origin: 'http://evil.invalid' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  delete process.env.PPT_STUDIO_ALLOWED_HOSTS;
  assert.equal(vpnStatus, 200);
  assert.equal(vpnWrongOrigin, 403);
  const job = await (await api('/api/jobs', { requirements })).json();
  assert.ok(job.id);
  assert.equal((await api(`/api/jobs/${job.id}/analyze`, { mode: 'ai', consent: false })).status, 403);
  const zip = new AdmZip();
  zip.addFile('word/document.xml', Buffer.from('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>保障供应，服务伙伴。</w:t></w:r></w:p><w:p><w:r><w:t>数字100%来自原稿。</w:t></w:r></w:p><w:p><w:r><w:t>规划项目，不写成投运。</w:t></w:r></w:p></w:body></w:document>'));
  const form = new FormData();
  form.append('files', new Blob([zip.toBuffer()]), 'report.docx');
  form.append('relativePaths', JSON.stringify(['资料/report.docx']));
  const uploaded = await (await fetch(`${base}/api/jobs/${job.id}/files`, { method: 'POST', headers: { Origin: base }, body: form })).json();
  assert.equal(uploaded.files[0].relativePath, '资料/report.docx');
  assert.equal(uploaded.files[0].kind, 'document');
  assert.ok(!('path' in uploaded.files[0]));
  const unsafe = new FormData();
  unsafe.append('files', new Blob(['hello']), 'unsafe.txt');
  unsafe.append('relativePaths', JSON.stringify(['../escape.txt']));
  assert.equal((await fetch(`${base}/api/jobs/${job.id}/files`, { method: 'POST', body: unsafe })).status, 400);
  assert.equal((await api(`/api/jobs/${job.id}/analyze`, { mode: 'basic' })).status, 202);
  let current;
  for (let i = 0; i < 30; i++) {
    current = await (await fetch(`${base}/api/jobs/${job.id}`)).json();
    if (current.status !== 'analyzing') break;
    await new Promise(r => setTimeout(r, 20));
  }
  assert.equal(current.status, 'planned');
  assert.ok(current.plan.slides.some(s => s.notes.includes('100%')), JSON.stringify(current.plan));
  current.plan.slides[1].title = '已编辑的安全供应';
  const saved = await (await api(`/api/jobs/${job.id}`, { plan: current.plan }, 'PUT')).json();
  assert.equal(saved.plan.slides[1].title, '已编辑的安全供应');
  assert.equal((await api(`/api/jobs/${job.id}/generate`, {})).status, 202);
  for (let i = 0; i < 30; i++) {
    current = await (await fetch(`${base}/api/jobs/${job.id}`)).json();
    if (current.status !== 'generating') break;
    await new Promise(r => setTimeout(r, 20));
  }
  assert.equal(current.status, 'ready');
  assert.ok(current.outputs.pptxUrl);
  assert.ok(!('pdfUrl' in current.outputs));
  assert.equal((await fetch(base + current.outputs.pptxUrl)).status, 200);
  const duplicated = await (await api(`/api/jobs/${job.id}/duplicate`, {})).json();
  assert.notEqual(duplicated.id, job.id);
  assert.equal(duplicated.status, 'planned');
  assert.equal(duplicated.outputs, null);
  assert.notEqual(duplicated.files[0].id, current.files[0].id);
  assert.equal(duplicated.plan.slides[1].title, '已编辑的安全供应');
  assert.equal((await api(`/api/jobs/${duplicated.id}/files/${duplicated.files[0].id}`, {}, 'DELETE')).status, 200);
  assert.equal((await (await fetch(`${base}/api/jobs/${job.id}`)).json()).files.length, 1);
  const restoredApp = await createApp({ dataDir });
  assert.ok(restoredApp);
  const settings = await (await api('/api/settings', { baseUrl: '', model: '', allowLocalApi: false }, 'PUT')).json();
  assert.equal(settings.hasApiKey, false);
  assert.equal((await api('/api/settings/test', {})).status, 400);
});
test('reference prefixes are explicit and section numbering comes from source headings', () => {
  assert.throws(() => validateRequirements({ pageCount: 5, referenceFileId: 'ref', referenceKeepCount: 5 }));
  assert.throws(() => validateRequirements({ referenceKeepCount: 1 }));
  const requirements = validateRequirements({ topic: '汇报', pageCount: 12, referenceFileId: 'ref', referenceKeepCount: 5 });
  const job = { title: '汇报', requirements, files: [{ id: 'doc', kind: 'document', name: '正文', text: '各位领导、各位伙伴，朋友们：\n守初心，与伙伴分享使命底色\n安全保供，数字100%来自原稿。\n践承诺，介绍服务能力\n以专属专班保障服务。\n谋共生，开创协同生态\n共同探索低碳转型路径。' }] };
  const plan = basicPlan(job).plan;
  assert.equal(plan.slides.length, 12);
  assert.equal(plan.slides.filter(s => s.layout === 'reference').length, 5);
  assert.deepEqual(plan.slides.filter(s => s.layout === 'section').map(s => s.title), ['践承诺', '谋共生']);
  assert.ok(plan.slides.every(s => !s.title.startsWith('各位')));
  const intro = '今年已保障供应覆盖100%重点客户。';
  const withIntro = { ...job, files: job.files.map(f => ({ ...f, text: `${intro}\n${f.text}` })) };
  const generated = basicPlan(withIntro).plan;
  const firstContent = generated.slides.find(s => s.layout === 'content');
  assert.equal(firstContent.title, intro.replace(/。$/, ''));
  assert.ok(generated.slides.every(s => !s.title.endsWith('…') || s.layout !== 'content'));
  assert.ok(firstContent.notes.includes(intro));
  const invalid = structuredClone(plan);
  invalid.slides[0].layout = 'content';
  assert.throws(() => validateReferencePrefix(invalid, requirements));
  const noReference = basicPlan({ ...job, requirements: validateRequirements({ topic: '汇报', pageCount: 12 }) }).plan;
  assert.equal(noReference.slides.length, 12);
  assert.deepEqual(noReference.slides.filter(s => s.layout === 'section').map(s => s.title), ['守初心', '践承诺', '谋共生']);
});
test('DPAPI roundtrip encrypts without plaintext on Windows', { skip: process.platform !== 'win32' }, async () => {
  const key = 'test-secret-not-a-real-account';
  const protectedValue = await protectKey(key);
  assert.ok(!protectedValue.includes(key));
  assert.equal(await protectKey(protectedValue, 'unprotect'), key);
});
test('file-based key roundtrip covers servers without DPAPI', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ppt-studio-key-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const protectedValue = protectKeyFile('test-secret-not-a-real-account', 'protect', dir);
  assert.ok(!protectedValue.includes('test-secret'));
  assert.equal(protectKeyFile(protectedValue, 'unprotect', dir), 'test-secret-not-a-real-account');
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(dir, 'secret.key'))).mode & 0o777, 0o600);
  await assert.rejects(async () => protectKeyFile(protectedValue, 'unprotect', path.join(dir, 'other')));
});
test('compatible response validated against a local mock, not a user AI account', async t => {
  let seen;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => { seen = JSON.parse(body); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })); });
  });
  server.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(() => new Promise(r => server.close(r)));
  const settings = { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'unit-test-only', allowLocalApi: true };
  assert.equal(await callModel(settings, [{ role: 'user', content: 'test' }]), 'OK');
  assert.equal(seen.model, 'unit-test-only');
  await assert.rejects(callModel({ ...settings, allowLocalApi: false }, []));
  await assert.rejects(callModel({ ...settings, baseUrl: 'http://169.254.169.254/v1' }, []));
});
