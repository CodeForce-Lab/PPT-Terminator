# PPT-Terminator

把会议材料、文稿和照片，编排成可编辑 PPTX 的本地演示文稿工作台。上传素材后生成提纲、核对调整、一键出稿，全流程可在浏览器里完成。

## 功能

- **素材解析**：支持 DOCX、PPTX、PDF、TXT/Markdown 与 JPG/PNG，自动提取文字、页数与图片。
- **提纲编排**：两种模式——本机规则分配原文与匹配照片（不联网）；或接入 OpenAI 兼容的模型服务做 AI 编排（按次授权）。
- **原生出稿**：文字、图形、照片均为 PowerPoint 原生元素，产出的 PPTX 可直接编辑，不是图片拼贴。
- **逐页预览**：在装有 Microsoft PowerPoint 的 Windows 上生成每页 PNG 预览与版式审计报告。
- **参考风格**：读取参考 PPT 的主题色与版式风格；按页数保留参考原页（需 PowerPoint）。
- **安全边界**：默认只允许本机访问，校验 Host 与 Origin，启用 CSP；API 密钥加密存储；素材留在本机，只有显式授权的 AI 调用会发送内容。

## 运行

要求 Node.js 22 或更新版本。

```bash
npm install
npm start
```

打开 http://127.0.0.1:3210 。首次使用在"模型设置"里填写 API 地址、模型名和密钥（仅 AI 模式需要）。

Windows 用户也可以直接运行 `scripts/start-studio.ps1` 启动。逐页预览与参考原页合并需要本机安装 Microsoft PowerPoint，并且只在 Windows 上可用。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PPT_STUDIO_PORT` | `3210` | 监听端口 |
| `PPT_STUDIO_DATA` | `./data` | 数据目录（项目、上传、设置） |
| `PPT_STUDIO_ALLOWED_HOSTS` | 空 | 额外允许的 Host，逗号分隔，用于反向代理部署 |
| `PPT_STUDIO_PUBLIC_PORT` | 空 | 反向代理对外端口，用于放行 Host 校验 |

部署到服务器时请置于反向代理之后，并只向可信网络开放；`data/` 包含用户素材与加密密钥，不应对外暴露。

## 目录结构

```
server.mjs          Express 入口与接口
lib/materials.mjs   素材解析
lib/planner.mjs     提纲生成（规则 / AI）
lib/model.mjs       模型调用与密钥保护
lib/render.mjs      PPTX 渲染
lib/finalize.mjs    预览导出与参考原页合并
public/             前端页面、样式与预设背景
scripts/            PowerPoint 导出、参考页合并、密钥加密、本地启动
test/               接口与渲染测试
```

## 测试

```bash
npm test
```

## 友链

- [LINUX DO](https://linux.do/) — 新的理想型社区

## 许可与署名

本项目以 [Apache License 2.0](LICENSE) 开源：你可以自由使用、修改、商用和再分发，但必须保留版权声明与 [NOTICE](NOTICE) 文件，并注明出处。

在文档、关于页面或其他公开材料中对本项目的署名示例：

> 本项目基于 CodeForce-Lab 的 [PPT-Terminator](https://github.com/CodeForce-Lab/PPT-Terminator) 开发。

Copyright (c) 2026 CodeForce-Lab.
