# API 连接与计费能力（2026-09-22）

版本：0.10.47。这里的“支持联网”是服务端搜索接口或原生工具，模型决定何时调用；实际返回必须包含搜索记录，不能用生成文字冒充搜索结果。搜索调用可能另计费，具体以服务商账单为准。

| 连接 | 接入方式 | 联网 | 余额 / 额度 |
| --- | --- | --- | --- |
| Qwen / 百炼 | 按量付费，默认北京 DashScope | 支持模型原生搜索；启用来源返回 | 未找到仅凭模型 API Key 查询现金余额的公开接口，控制台查看 |
| Qwen / 百炼 | Token Plan 个人版，专属端点和 Key | 本次不接入独立 Harness 权益工具（需要另一把百炼 Key），默认关闭 | 控制台查看 Credits |
| Qwen / 百炼 | Token Plan 团队版，专属端点和 Key | 通过套餐 Responses 原生工具；取决于模型能力并消耗 Credits | 控制台查看 Credits |
| Kimi | 开放平台按量付费 | 官方 Search Basic，国内/国际分别使用对应站点 | 自动查询 available_balance，含现金和赠金；国内 CNY、国际 USD |
| GLM | 智谱开放平台按量付费 | 官方 search_pro | 未找到已公开且适用于模型 API Key 的余额接口，控制台查看 |
| MiniMax | 普通 API Key | Responses 原生 web_search（Beta），取决于模型支持 | 官方 CLI 同用的 account/query_balance，可用余额含现金、券及信用 |
| MiniMax | Token Plan / 订阅 Key | 同站点原生工具，具体权益由服务决定 | token_plan/remains，当前模型或通用池的 5h / week 剩余比例和重置时间 |

Qwen 和 MiniMax 的计费方式在连接表单中选择。切换后清空表单中的旧 Key、模型及请求附加参数，保存前不修改已保存凭据。MiniMax 国际端点可手动填写，切换计费方式保留其地域。不会因为套餐耗尽而自动改用按量 API；MiniMax **服务端**可能使用已购积分承接订阅超额，这由其订阅规则决定。

Kimi Code 与 GLM Coding Plan 并非通用 API 套餐。官方限制其在指定编程场景/工具中使用，Inthes 不伪装客户端身份，也不将这些套餐端点的搜索转发到按量端点。旧百炼 Coding Plan 同样不作为通用论文阅读套餐提供。

模型优先从服务的 `/models` 接口获取。智谱或套餐端点未提供列表时，在“手动填写模型 ID”中按官方文档添加，再使用“测试连接”验证权限。添加 ID 不代表已确认该模型可用，也不推断其图片能力。

额度复用既有自动刷新机制：请求合并，约一分钟检查一次，对话运行时继续刷新；切换计费方式或套餐模型会失效旧查询。MiniMax 采用明确的 remaining_percent，不用重置倒计时或含义不稳定的 usage_count 推算额度；未知数据报错，保留上次有效结果，不显示虚构的 0% / 100%。自定义余额 GET 配置仍限同源，不自动使用控制台 Cookie、云账户 AccessKey 或第三方查询服务。

## 官方依据

- [百炼按量调用](https://help.aliyun.com/zh/model-studio/first-api-call-to-qwen)、[联网搜索](https://help.aliyun.com/zh/model-studio/web-search)
- [Token Plan 个人版接入](https://help.aliyun.com/zh/model-studio/token-plan-personal-quick-start)、[团队版接入及模型内置工具](https://help.aliyun.com/zh/model-studio/token-plan-team-quickstart)、[Responses 套餐端点示例](https://help.aliyun.com/zh/model-studio/codex)
- [百炼 Coding Plan 限制](https://help.aliyun.com/zh/model-studio/coding-plan-faq)
- [Kimi 搜索接口](https://platform.kimi.com/docs/api/tools-search)、[国内余额](https://platform.kimi.com/docs/api/balance)、[国际余额及币种](https://platform.kimi.ai/docs/api/balance)、[Kimi Code 适用范围](https://www.kimi.com/code/docs/en/)
- [GLM 接入](https://docs.bigmodel.cn/cn/guide/start/quick-start)、[联网工具](https://docs.bigmodel.cn/cn/guide/tools/web-search)、[Coding Plan 指定工具](https://docs.bigmodel.cn/cn/coding-plan/tool/others)
- [MiniMax 原生工具](https://platform.minimax.io/docs/guides/server-tools)、[Token Plan Key、额度接口与积分规则](https://platform.minimax.cn/docs/token-plan/faq)
- MiniMax 官方开源 CLI：[余额/额度端点](https://github.com/MiniMax-AI/cli/blob/main/src/client/endpoints.ts)、[返回类型](https://github.com/MiniMax-AI/cli/blob/main/src/types/api.ts)、[余额接口测试](https://github.com/MiniMax-AI/cli/blob/main/test/sdk/quota.test.ts)。使用 API 同站点的官方实现路径，避免将 Key 发送给控制台或跟随重定向。

## 验证范围

定向测试覆盖官方端点、认证方式、套餐切换、跨站点凭据边界、区域币种、零额度、周额度倍率、模型范围、来源记录缺失和 API 业务错误。安装包构建并进行 Zotero 表单验证；没有用这四家的真实 Key 发起付费调用，实际模型权限、套餐权益及线上返回仍需用户配置凭据后验证。
