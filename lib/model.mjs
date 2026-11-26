// Copyright (c) 2026 CodeForce-Lab
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
// 使用、修改或分发时须保留本声明并署名 CodeForce-Lab。

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

const keyScript = fileURLToPath(new URL('../scripts/protect-key.ps1', import.meta.url));
const secretFile = dataDir => path.join(dataDir || process.env.PPT_STUDIO_DATA || path.join(process.cwd(), 'data'), 'secret.key');
function readSecretKey(file, create) {
  try { return fsSync.readFileSync(file); }
  catch (e) {
    if (e.code !== 'ENOENT' || !create) throw new Error('本机密钥文件不可用，请在当前服务器重新保存密钥。');
    const key = crypto.randomBytes(32);
    fsSync.mkdirSync(path.dirname(file), { recursive: true });
    fsSync.writeFileSync(file, key, { mode: 0o600 });
    return key;
  }
}
export function protectKeyFile(value, action = 'protect', dataDir) {
  const file = secretFile(dataDir);
  if (action === 'protect') {
    const key = readSecretKey(file, true);
    if (key.length !== 32) throw new Error('本机密钥文件格式无效，请删除 secret.key 后重新保存。');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  }
  const payload = Buffer.from(String(value), 'base64');
  if (payload.length < 29) throw new Error('本机密钥格式无效，请重新保存。');
  const key = readSecretKey(file, false);
  if (key.length !== 32) throw new Error('本机密钥文件格式无效，请删除 secret.key 后重新保存。');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, payload.subarray(0, 12));
  decipher.setAuthTag(payload.subarray(12, 28));
  try { return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString('utf8'); }
  catch { throw new Error('密钥无法解密，请重新保存密钥。'); }
}
export async function protectKey(value, action = 'protect', dataDir) {
  if (process.platform !== 'win32') return protectKeyFile(value, action, dataDir);
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', keyScript, '-Action', action], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.resume();
    child.on('error', () => reject(new Error('Windows 密钥加解密服务不可用。')));
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error('密钥加解密失败，请在当前 Windows 账号重新保存密钥。')));
    child.stdin.on('error', () => {});
    child.stdin.end(value);
  });
}
function addressType(address) {
  let a = address.toLowerCase().split('%')[0];
  if (net.isIPv6(a)) a = new URL(`http://[${a}]`).hostname.slice(1, -1);
  if (a.startsWith('::ffff:')) {
    const segments = a.slice(7).split(':');
    if (segments.length !== 2) return 'blocked';
    const [hi, lo] = segments.map(n => Number.parseInt(n, 16));
    return addressType([hi >> 8, hi & 255, lo >> 8, lo & 255].join('.'));
  }
  if (net.isIPv4(a)) {
    const [x, y] = a.split('.').map(Number);
    if (x === 169 && y === 254 || x === 0 || x >= 224) return 'blocked';
    if (x === 127 || x === 10 || x === 192 && y === 168 || x === 172 && y >= 16 && y <= 31 || x === 100 && y >= 64 && y <= 127) return 'private';
    return 'public';
  }
  if (a === '::' || /^fe[89ab][0-9a-f]:/.test(a) || a.startsWith('ff') || a === 'fd00:ec2::254') return 'blocked';
  if (a === '::1' || /^(fc|fd)/.test(a)) return 'private';
  return 'public';
}
export function validateSettings(input) {
  const baseUrl = String(input.baseUrl || '').trim();
  const model = String(input.model || '').trim();
  const allowLocalApi = input.allowLocalApi === true;
  if (baseUrl.length > 2048 || model.length > 160 || /[\r\n\u0000]/.test(model)) throw new Error('模型配置格式无效。');
  if (baseUrl) {
    let url;
    try { url = new URL(baseUrl); } catch { throw new Error('请填写有效的 API Base URL。'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('API 地址不允许凭据、查询参数或片段。');
    if (url.protocol === 'http:' && !allowLocalApi) throw new Error('HTTP API 需要显式允许受信任的本地服务。');
  }
  return { baseUrl, model, allowLocalApi };
}
export async function requestProvider(endpoint, { allowLocalApi = false, payload, contentType = 'application/json', key = '', maxBytes = 2 * 1024 * 1024, timeout = 90_000 } = {}) {
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) throw new Error('服务地址无效。');
  const hostname = endpoint.hostname.replace(/^\[|\]$/g, '');
  const signal = AbortSignal.timeout(timeout);
  let addresses, onAbort;
  try {
    addresses = await Promise.race([dns.lookup(hostname, { all: true }), new Promise((_, reject) => {
      onAbort = () => reject(new Error('解析超时'));
      signal.addEventListener('abort', onAbort, { once: true });
    })]);
  } catch { throw new Error('无法解析服务地址。'); }
  finally { signal.removeEventListener('abort', onAbort); }
  if (!addresses.length || addresses.some(a => addressType(a.address) === 'blocked')) throw new Error('不允许访问元数据或特殊网络地址。');
  if (!allowLocalApi && addresses.some(a => addressType(a.address) === 'private')) throw new Error('需显式允许访问受信任的本机或局域网 API。');
  if (endpoint.protocol === 'http:' && (!allowLocalApi || addresses.some(a => addressType(a.address) !== 'private'))) throw new Error('远程服务必须使用 HTTPS。');
  const selected = addresses[0];
  return new Promise((resolve, reject) => {
    const request = (endpoint.protocol === 'https:' ? https : http).request(endpoint, {
      method: payload ? 'POST' : 'GET', signal, agent: false,
      lookup: (_host, options, callback) => options?.all ? callback(null, [selected]) : callback(null, selected.address, selected.family),
      headers: { ...(payload ? { 'Content-Type': contentType, 'Content-Length': payload.length } : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    }, response => {
      const status = response.statusCode || 0;
      const fail = message => { reject(new Error(message)); request.destroy(); };
      if (status < 200 || status >= 300) { fail(`服务返回 HTTP ${status}，请核对接口、模型和权限。`); return; }
      if (Number(response.headers['content-length']) > maxBytes) { fail('服务响应超过大小上限。'); return; }
      let bytes = 0;
      const chunks = [];
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) fail('服务响应超过大小上限。');
        else chunks.push(chunk);
      });
      response.on('aborted', () => reject(new Error('服务响应连接中断。')));
      response.on('error', () => reject(new Error('服务响应连接中断。')));
      response.on('end', () => resolve(Buffer.concat(chunks)));
    });
    request.on('error', () => reject(new Error(signal.aborted ? '服务请求超时，请核对服务状态后再重试。' : '无法连接服务，请检查网络和服务配置。')));
    request.end(payload);
  });
}

export async function callModel(settings, messages, { maxTokens = 7000, tool } = {}) {
  const validated = validateSettings(settings);
  if (!validated.baseUrl || !validated.model) throw new Error('请先保存 API 地址和模型名称。');
  const endpoint = new URL(validated.baseUrl.replace(/\/+$/, '') + '/chat/completions');
  const key = settings.encryptedKey ? await protectKey(settings.encryptedKey, 'unprotect', settings.dataDir) : '';
  const payload = Buffer.from(JSON.stringify({ model: validated.model, messages, temperature: .25, max_tokens: maxTokens, ...(tool ? { tools: [{ type: 'function', function: tool }], tool_choice: { type: 'function', function: { name: tool.name } } } : {}) }));
  const bytes = await requestProvider(endpoint, { allowLocalApi: validated.allowLocalApi, key, payload });
  try {
    const message = JSON.parse(bytes.toString('utf8')).choices?.[0]?.message;
    if (tool) {
      const calls = message?.tool_calls;
      if (!Array.isArray(calls) || calls.length !== 1 || calls[0]?.function?.name !== tool.name) throw new Error();
      const args = JSON.parse(calls[0].function.arguments);
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error();
      return args;
    }
    const content = message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error();
    return content;
  } catch { throw new Error(tool ? '文本模型未返回兼容的工具调用。' : '服务未返回兼容的模型文字响应。'); }
}
