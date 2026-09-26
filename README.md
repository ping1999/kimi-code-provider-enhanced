# kimi-code-provider-enhanced

A [Kimi Code](https://github.com/MoonshotAI/kimi-code) plugin that brings two missing capabilities to custom providers in the WebUI: **thinking-effort selection** for provider models, and **conversational model discovery** — fetch all models a provider exposes, pick the ones you want, preview the changes, then add them. English readers: everything below is documented in detail in the Chinese sections; the MCP tools and config keys are identical.

一个 Kimi Code 原生插件，为自定义供应商补齐两块能力：让供应商模型可以在 WebUI 原生菜单中**选择思考强度**，以及在对话中**一键拉取供应商全部模型、挑选后添加**。不注入页面、不修改 Kimi 本体，全部通过插件 MCP 工具与本机 REST API 完成。

## 为什么需要它

- 自定义供应商的模型默认只有思考「开/关」，没有强度档位。根因是模型配置缺少 `support_efforts` 等字段——Kimi 的 `config.toml` 和 WebUI 模型菜单本身就支持这些字段，只是没有地方填写。
- 供应商通常暴露几十个模型（OpenAI-compatible `GET {base_url}/models`），但 Kimi 原生没有「拉取全部模型再勾选」的入口，只能逐一手动添加。

## 功能

- **思考强度配置**：为已添加的模型设置 `support_efforts`、`default_effort`、`off_effort`、`adaptive_thinking`、`reasoning_key`、`protocol` 等字段。配置后 WebUI 模型选择器直接出现 Off + 各档位。
- **对话式模型发现**：`discover_models` 拉取供应商全部模型，分页/筛选展示，标注「已添加」「上下文长度」「协议端点」。
- **档位建议（带来源）**：参考持续维护的 [models.dev](https://models.dev) 目录。精确匹配优先；跨供应商同名模型仅作为「建议」并标明来源；冲突时列出候选由你选择，绝不自动取并集；未知模型不强行补档。
- **预览 → 确认 → 应用**：所有写操作先生成差异预览，用户明确确认后才应用；预览过期或配置漂移（`CONFIG_CHANGED`）会被拒绝。
- **手动覆盖优先**：你手动指定的档位不会被目录刷新覆盖。

## 安装

需要 Kimi Code 2.0.2+。插件运行时使用 Kimi 内嵌 Node，无需单独安装 Node.js（开发构建除外）。

**方式一：安装已打包的 zip**

```text
/plugins install <解压后的目录>
/reload
```

**方式二：从源码构建**

```bash
npm ci
npm run package   # 生成 artifacts/kimi-code-provider-enhanced-<version>.zip
```

解压后在 Kimi 终端会话中执行 `/plugins install <目录>` + `/reload`，然后新建 WebUI 会话。

## 使用

在 WebUI 对话中直接用自然语言，例如：

```text
拉取 <供应商名> 的可用模型，先列出来让我选择，不要直接添加。
```

```text
添加第 2、5、7 个模型；第 5 个的思考档位设为 high、max，默认 high。
```

```text
把已添加的 <模型 ID> 的思考档位改成 low、medium、high，默认 medium。
```

流程：发现 → 清单选择 → 差异预览 → 确认 → 应用。配置写入后 WebUI 模型菜单即时生效（未刷新时手动刷新页面）。

## MCP 工具

| 工具 | 作用 | 写配置 |
|---|---|---|
| `list_providers` | 列出本地自定义供应商脱敏摘要 | 否 |
| `discover_models` | 拉取供应商模型快照（分页/筛选/目录建议） | 否 |
| `preview_changes` | 为选中的模型生成变更预览 | 否 |
| `update_model_thinking` | 为已有模型的档位设置生成预览 | 否 |
| `apply_changes` | 应用已确认的预览（不删模型、不改默认模型） | 是 |

## 支持与限制

- 模型发现支持 `openai` / `openai_responses` / `kimi` 类型的供应商（OpenAI-compatible `GET /models`）；其他网关类型会明确报 `UNSUPPORTED_DISCOVERY`。
- `budget_tokens` 类型的思考控制不会被自动映射成离散档位；只读开关（toggle）模型不会凭空造出强度档位。
- 目录中的档位是供应商声明值，不等于当前网关实测支持；跨供应商建议会明确标注来源。
- 插件不会、也不能向 WebUI 设置页注入按钮或页面——操作入口始终在对话中。

## 安全设计

- 不读取、回显或记录 API Key 与 server token；供应商请求只发白名单字段。
- HTTP 供应商地址仅允许本机回环与内网 IP（10/8、172.16/12、192.168/16、169.254/16、100.64/10、IPv6 ULA/链路本地），公网地址必须使用 HTTPS。
- Kimi REST API 仅访问本机回环地址，通过 `server/instances` 心跳 + 存活 pid + URL 精确匹配定位实例。
- `apply_changes` 是唯一写入口：changeId 有 TTL，应用前校验配置未漂移，写入后读回校验。
- 不自动删除供应商/模型，不修改全局默认模型，不发送真实推理请求探测能力。

## 开发

要求 Node.js >= 24。

| 命令 | 说明 |
|---|---|
| `npm run typecheck` | tsc 严格类型检查 |
| `npm run build` | esbuild 打 `dist/server.mjs` |
| `npm run test:unit` | Node 测试运行器单元测试 |
| `npm run test:integration` | 隔离 `KIMI_CODE_HOME` + 假供应商的原生 API 冒烟 |
| `npm run test:web` | 自建隔离 fixture 后跑 Playwright WebUI 端到端（本机 Edge/Chrome） |
| `npm run package` | 生成 `artifacts/` 安装 zip（含依赖许可证） |

环境变量：`KIMI_CODE_HOME`（默认 `~/.kimi-code`）、`KPE_KIMI_URL` / `KPE_KIMI_TOKEN`（多实例或调试时指定服务器）、`KPE_KIMI_EXE`（集成测试指定 kimi 二进制）、`KPE_BROWSER_CHANNEL`（Web 测试浏览器通道，默认 `msedge`）。

目录说明与更多约束见 [AGENTS.md](AGENTS.md)。

## License

[MIT](LICENSE)
