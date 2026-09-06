# Fumie 简体中文语言包

Fumie 的内置简体中文语言包。翻译由两部分组成：

1. **上游底料**：`translations/` 下与上游 Code OSS 同源的字符串翻译，取自
   [microsoft/vscode-loc](https://github.com/microsoft/vscode-loc)（MIT 许可）
   `i18n/vscode-language-pack-zh-hans/`。
2. **Fumie 增量**：Fumie 自有模块（kimi/deepseek 工具展示名、`node/fumie/`、
   `vs/sessions` 中 Fumie 新增部分等）的词条，直接合并在
   `translations/main.i18n.json` 里。

## 更新方式

- 上游底料：从 vscode-loc 重新下载对应文件覆盖，再重跑增量合并。
- Fumie 增量：跑 `node --experimental-strip-types scripts/fumie-l10n-extract.ts`
  得到缺口清单，翻译后用 `scripts/fumie-l10n-merge.ts --write` 合并进
  `translations/main.i18n.json`。

`fumie-l10n-extract.ts` 只比对**键是否存在**，不看值翻没翻。值仍是英文原文的
词条它算「已覆盖」，所以补完它报的缺口并不等于界面全中文——一块面板里
"Model" 和「思考层级」并排，多半就是这种词条。补完缺口后另外扫一遍：值里没有
汉字、而英文原文含单词的 Fumie 自有词条（`vs/sessions/**`、
`vs/platform/agentHost/**`），逐条判断是漏翻还是专有名词。

产品名、协议名和纯格式串保持英文：Codex、Claude、Kimi、Pi、DeepSeek、ChatGPT、
Copilot、GitHub、Microsoft、SSH、WSL、URL、`npm run {0}`、`Alt+Enter`。同一个
英文原文在壳里应当只有一种译法；改词条前先搜一下现有译法，别再引入第二种。

语言包在打包构建中随内置扩展一起分发；首次启动后语言服务会把它注册进
`languagepacks.json`，中文系统下次启动即生效，也可用 `--locale=zh-cn` 或
"Configure Display Language" 显式切换。源码启动（dev 模式）不加载语言包，属上游
既有行为。
