# MCP-Manager

[English](README.md) | 中文

`@mcp-manager/mcp-manager` —— 面向 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（dsh，基于 [Cordis](https://cordis.js.org)）的**双面 Model Context Protocol 管理插件**。单包、双入口、一行组合：宿主侧监管任意数量的 MCP 服务器，浏览器侧呈现服务管理面板与 JSON 配置编辑器。
以配置文件的方式完成MCP-Server的配置（类似WorkBuddy的方式）
![img.png](img.png)

## 版本适配

`@deepseek-ai/dsh-*` `0.1.5-rc.2` 同版本线或更新（见 `package.json` 对等依赖）。

## 快速开始

```sh
dsh plugin --profile web add @mcp-manager/mcp-manager
```

重启 `dsh web`，打开 **设置 → MCP**。安装时自动插入组合行，面板作为独立侧边栏条目出现。

## 架构

同一个 npm 包暴露两个入口：

| 入口 | 平面 | 职责 |
|---|---|---|
| `.` | 宿主（Node） | 从 `~/.dsh/mcp.json` 监管 MCP 连接（stdio / streamable-http、工具发现与调用、自动重连）；暴露 `mcp` Remote 命名空间。 |
| `./client` | 客户端（web） | MCP 服务管理面板 + JSON 配置编辑器，注入 `settings.section`。 |

**宿主面**：`McpRegistry`（继承 `TypertRemoteService`）把入口配置叠加在 `mcp.json` 用户配置之上，交给内部 `ServerSupervisor` 监管——每个服务器一条连接，只重建变化的部分。工具注册在 `ctx.tools` 的 `mcp__<serverName>__` 命名空间下。

**客户端面**：`apply` 自挂载 `mcp` Remote 命名空间，创建 `McpManagerController`，将面板注入 `settings.section`。所有 RPC 调用串行化在一条 queue 上，避免并发答案互相覆盖。

## 许可

MIT
