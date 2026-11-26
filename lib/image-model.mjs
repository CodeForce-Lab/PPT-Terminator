// Copyright (c) 2026 CodeForce-Lab
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
// 使用、修改或分发时须保留本声明并署名 CodeForce-Lab。

import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { protectKey, requestProvider, validateSettings } from './model.mjs';

export const MAX_IMAGE_BATCH = 4;
export const MAX_STYLE_PAGES = 4;
const MAX_IMAGE = 16 * 1024 * 1024;
const validation = { limitInputPixels: 32_000_000, failOn: 'warning' };
export const imageDefaults = { baseUrl: '', model: 'gpt-image-1', allowLocalApi: false, method: 'edits', size: '1536x1024', quality: 'high', encryptedKey: '' };

export function validateImageSettings(input) {
  const fields = validateSettings(input);
  const { method = imageDefaults.method, size = imageDefaults.size, quality = imageDefaults.quality } = input;
  if (!['edits', 'generations'].includes(method) || !['auto', '1536x1024', '1024x1536', '1024x1024'].includes(size) || !['low', 'medium', 'high', 'auto'].includes(quality)) throw new Error('作图接口模式、尺寸或画质无效。');
  const baseUrl = fields.baseUrl.replace(/\/+$/, '').replace(/\/images\/(edits|generations)$/i, '');
  return { ...fields, baseUrl, method, size, quality };
}

export function summarizeImageSettings(settings) {
  const { encryptedKey, ...fields } = settings;
  return { ...validateImageSettings(fields), hasApiKey: Boolean(encryptedKey), configured: Boolean(fields.baseUrl && fields.model && (encryptedKey || fields.allowLocalApi)) };
}

function multipart(fields, sourceImages) {
  const boundary = `studio-${randomUUID()}`;
  const lines = Object.entries(fields).map(([key, value]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
  const field = sourceImages.length === 1 ? 'image' : 'image[]';
  sourceImages.forEach((img, i) => {
    lines.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="reference-${i + 1}.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`), img, Buffer.from('\r\n'));
  });
  lines.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(lines), contentType: `multipart/form-data; boundary=${boundary}` };
}

export async function requestImage(settings, prompt, sourceImages = []) {
  const config = validateImageSettings(settings);
  if (!summarizeImageSettings(settings).configured) throw new Error('请先配置作图接口、模型和密钥（或允许受信任的本地 API）。');
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 12000) throw new Error('生图提示词须为 1–12000 字符。');
  const fields = { model: config.model, prompt, n: '1', quality: config.quality, size: config.size };
  if (config.method === 'edits' && (!sourceImages.length || sourceImages.length > MAX_STYLE_PAGES + 1 || sourceImages.some(b => !Buffer.isBuffer(b) || b.length > 2 * 1024 * 1024))) throw new Error('参考图模式需要有效的本地页面图；如网关仅支持文生图，可切换接口模式。');
  const body = config.method === 'edits' ? multipart(fields, sourceImages) : { payload: Buffer.from(JSON.stringify({ ...fields, n: 1 })) };
  const key = settings.encryptedKey ? await protectKey(settings.encryptedKey, 'unprotect', settings.dataDir) : '';
  const endpoint = new URL(`${config.baseUrl}/images/${config.method}`);
  const response = await requestProvider(endpoint, { ...body, key, allowLocalApi: config.allowLocalApi, maxBytes: 24 * 1024 * 1024, timeout: 150_000 });
  let data;
  try { data = JSON.parse(response.toString('utf8')).data?.[0]; } catch { throw new Error('接口未返回兼容的图片 JSON。'); }
  let image;
  if (typeof data?.b64_json === 'string' && data.b64_json.length <= Math.ceil(MAX_IMAGE / 3) * 4 && /^[A-Za-z0-9+/]+={0,2}$/.test(data.b64_json)) {
    image = Buffer.from(data.b64_json, 'base64');
  } else if (typeof data?.url === 'string' && data.url.length < 4096) {
    let url;
    try { url = new URL(data.url); } catch { throw new Error('生图接口返回了无效的图片地址。'); }
    if (url.protocol !== 'https:') throw new Error('下载图片只支持公网 HTTPS；本地网关请返回 b64_json。');
    image = await requestProvider(url, { maxBytes: MAX_IMAGE, timeout: 22_000 });
  } else throw new Error('接口未返回可用的 b64_json 或 HTTPS 图片地址。');
  if (!image.length || image.length > MAX_IMAGE) throw new Error('生成图片为空或超过 16 MB。');
  return normalizeImage(image);
}

export async function normalizeImage(buffer) {
  try {
    const image = sharp(buffer, validation);
    const m = await image.metadata();
    if (!['jpeg', 'png', 'webp'].includes(m.format) || (m.pages || 1) !== 1 || m.width < 1 || m.height < 1) throw new Error();
    return await image.rotate().flatten({ background: '#102035' }).resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 94 }).toBuffer();
  } catch { throw new Error('无法读取图片：请检查返回格式、像素或文件完整性。'); }
}

export async function referenceJpeg(buffer) {
  const safe = await normalizeImage(buffer);
  return sharp(safe).resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
}

export async function fitPageImage(buffer, width, height) {
  const longest = 1920;
  const scale = longest / Math.max(width, height);
  const image = sharp(buffer, validation);
  const { data: rgb } = await image.clone().resize(1, 1).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const background = { r: rgb[0], g: rgb[1], b: rgb[2] };
  return image.resize(Math.round(width * scale), Math.round(height * scale), { fit: 'contain', background }).jpeg({ quality: 94 }).toBuffer();
}

export async function testImage(settings) {
  const source = settings.method === 'edits' ? [await sharp({ create: { width: 512, height: 512, channels: 3, background: '#102035' } }).jpeg().toBuffer()] : [];
  await requestImage(settings, 'A dark navy slide with one centered gold circle. Connection test only. No text or logos.', source);
}
