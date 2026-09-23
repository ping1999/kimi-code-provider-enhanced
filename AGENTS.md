# kimi-code-provider-enhanced

Kimi 原生插件：在 WebUI 对话中发现供应商模型、按 models.dev 目录建议思考档位、预览并选择性写入模型配置。

## 布局

- `kimi.plugin.json`：插件清单（MCP server + skills 目录）。
- `skills/provider-enhanced/SKILL.md`：对话流程说明，由主代理维护，不要改动。
- `src/`：TypeScript 源码。`server.ts` MCP stdio 入口；`kimi-client.ts` 本地 Kimi API；`discovery.ts` 供应商 `/models` 发现与分页；`catalog.ts` models.dev 拉取/缓存；`match.ts` 确定性匹配规则；`changes.ts` 预览/应用/读回；`storage.ts` 主目录/实例表/原子写；`http.ts` 限额 fetch；`errors.ts` 受控错误。
- `test/`：Node 测试运行器（`.test.ts`，Node24 原生 strip-types）。
- `scripts/`：`build.mjs`（esbuild 打 `dist/server.mjs`）、`package.mjs`（`artifacts/*.zip`）、`integration.mjs`（隔离 home 的原生 API 冒烟）。
- `web/`：Playwright 测试，`playwright.config.ts`。
- 分发包只含 `kimi.plugin.json`、`dist/`、`skills/`、`LICENSES/`；运行时不依赖 `node_modules`。

## 命令

- `npm run typecheck` — tsc noEmit 严格检查。
- `npm run build` — 打 `dist/server.mjs`。
- `npm run test:unit` — `node --test "test/*.test.ts"`。
- `npm run test:integration` — 起全新隔离 `KIMI_CODE_HOME` 的 kimi.exe（`KPE_KIMI_EXE` 可指定路径）+ 假供应商，跑 discover→preview→apply 读回；默认每次运行用独立 `.tmp/run-*` 并清理，`--keep-running` 保留该目录并写 `.tmp/integration-state.json`。
- `npm run test` — 单元 + 集成（最终验证用）。
- `npm run test:web` — 自建独立 `.tmp/web-run-*` 隔离 fixture（kimi.exe + 假供应商 + 已装插件），再跑 Playwright（本机 Edge/Chrome channel）。
- `npm run package` — 生成 `artifacts/kimi-code-provider-enhanced-<version>.zip`，默认名已存在时自动改用唯一后缀名，绝不覆盖。

## 约束

- 源码不写注释；不写 README/说明文档。
- stdout 只走 JSON-RPC；日志只走 stderr。
- 凭证仅用于已配置端点的本地认证，不写入日志、工具返回值或审计记录；Kimi API 仅本机回环；供应商请求只发白名单字段。
