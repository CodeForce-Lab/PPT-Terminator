// Copyright (c) 2026 CodeForce-Lab
// All rights reserved.
// 未经许可禁止商用、二次分发

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const mergeScript = fileURLToPath(new URL('../scripts/merge-reference.ps1', import.meta.url));
const exportScript = fileURLToPath(new URL('../scripts/export-presentation.ps1', import.meta.url));
function powerShell(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.resume();
    child.once('error', () => reject(new Error('本机PowerPoint处理服务不可用。')));
    child.once('close', code => code === 0 ? resolve() : reject(new Error('PowerPoint未能完成参考原页合并，请确认参考PPT可以正常打开。')));
  });
}
export async function finalizeReference({ generated, reference, count, outputDir, slideCount }) {
  if (!count) return generated;
  if (process.platform !== 'win32') throw new Error('保留参考PPT原页需要Windows与Microsoft PowerPoint。');
  const pptxPath = path.join(outputDir, 'presentation-reference.pptx');
  await powerShell(mergeScript, ['-InputPath', generated.pptxPath, '-ReferencePath', reference.path, '-OutputPath', pptxPath, '-KeepCount', String(count), '-ExpectedCount', String(slideCount)]);
  await powerShell(exportScript, ['-InputPath', pptxPath, '-OutputDir', outputDir, '-SkipPdf']);
  const qa = JSON.parse(await fs.readFile(path.join(outputDir, 'qa.json'), 'utf8'));
  const warnings = [...generated.warnings.filter(w => !w.includes('等待主进程合并')), `已原样保留参考PPT前${count}页；原页图片中的文字仍是图片，旧日期、数据和页码请在原PPT中核对。`];
  if (qa.warnings?.length) warnings.push(...qa.warnings);
  const overflows = qa.slides.filter(s => s.slide > count).reduce((sum, s) => sum + s.textOverflows.length + (s.textIntersections?.length || 0), 0);
  if (overflows) warnings.push(`新增页面有${overflows}处实测文字问题，请核对预览后修改提纲。`);
  const slideImages = qa.imageFiles.map(name => path.join(outputDir, name));
  if (!qa.completed || !qa.auditComplete || qa.slideCount !== slideCount || slideImages.length !== slideCount) throw new Error('参考原页已合并，但最终预览或页数校验不完整，请重试。');
  return { pptxPath, pdfPath: null, slideImages, warnings, audit: { ...generated.audit, preservedReferenceCount: count, office: { status: 'completed', verified: true, qa } } };
}
