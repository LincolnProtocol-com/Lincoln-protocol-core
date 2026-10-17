# 主网收费组件候选

RC.2 主网收费组件采用独立命名空间，**新部署 adapter 的选定费率为 30 bps（0.30%）**。已推送的 `v0.1.0-rc.1` 是 20 bps 历史快照，不能用其产物或旧验收报告证明 RC.2。开发收费产物、旧 adapter 的不可变费率和当前测试网服务保持原版本；此流程不部署合约、不签名，也不启用公网收费。

`node scripts/phase2-fees/build-mainnet.mjs` 先完整验证当前核心生产发布（最终参数、公开贡献／beacon 证据与重编译字节码），再从现有收费源码派生仅允许链 `4663` 的版本。派生只修改构造函数链限制和两个接口 import；接口来自同一份已验证核心发布。旧的单参数 registry 构建会被拒绝，不能将开发产物改几个标志后用到主网。RC.2 必须绑定增加存款上限与暂停后的核心构建；不允许继续引用 RC.1 的核心 artifact。

生成文件为：

- `protocol/phase2-fees/mainnet/Phase2FeeRouteAdapter.sol`：派生源码。
- `artifacts/phase2-fees-mainnet/contracts.json`：两个收费 adapter 的完整 ABI、creation/runtime 模板和 immutable 引用。
- `contracts/phase2-fees-mainnet.standard-input.json`：包含全部依赖的独立编译输入。
- `contracts/phase2-fees-mainnet.manifest.json`：源码派生、ABI、编译输入、字节码和最终核心发布绑定。

`node scripts/phase2-fees/build-mainnet.mjs --check` 重新验证并逐字节比较以上文件。组件标记为 `releaseCandidate:true, testOnly:false, productionReady:false`；这表示明确的主网候选，不表示审计或公网资金验收完成。运行时 `loadFeeComponents` 验证生产核心、当前源码和可复现的组件 ABI／字节码，拒绝翻转开发标志、旧核心绑定和修改过的源码。

## Safe、费率与离线计划

本轮待部署方案使用用户指定的 Robinhood 主网 Safe `0x9CF17a6E3c75D200f58283A165C442a8A3994555` 为 treasury，选定 **30 bps**。费率和 treasury 是每个新 adapter 的不可变构造参数；升级文档或服务配置不会改变已部署旧 adapter 的 20 bps。本离线工具不验证 Safe 的签名人、阈值或链上代码，相关只读核验应与核心发布资料一起保存。

```sh
node scripts/phase2-fees/build-mainnet.mjs
node scripts/phase2-fees/build-mainnet.mjs --check

# 核心尚未部署时，生成显式待办模板，池地址及 initcode 留空。
node scripts/phase2-fees/plan-mainnet.mjs \
  --treasury 0x9CF17a6E3c75D200f58283A165C442a8A3994555 \
  --fee-bps 30 \
  --output artifacts/phase2-fees-mainnet/launch-plan.json

# 真实核心部署完成后，使用其已核验 profiles 生成准确的未签名 CREATE。
node scripts/phase2-fees/plan-mainnet.mjs \
  --core-deployment config/phase2-mainnet-deployed.json \
  --treasury 0x9CF17a6E3c75D200f58283A165C442a8A3994555 \
  --fee-bps 30 \
  --output artifacts/phase2-fees-mainnet/create-plan.json
```

默认路线来自 `config/phase2-mainnet-routes-example.json`，包含 UP／Uniswap 的 ETH↔USDG，以及 Uniswap 的 ETH↔NVDA 两跳；可通过 `--selection` 显式选择其他受核心规划器支持的路线。股票仍须用固定区块估值核定原始代币单位存款上限，并验收实际流动性；示例路线不表示 NVDA 的 raw cap 已解决或已部署。未部署核心时不会猜测或虚构池地址。即使准确 initcode 已生成，新 adapter 地址、实际 runtime hash、nonce 和 gas 仍未确定，`executionEnabled:false`。

核心部署器当前仅部署免费 adapter。此组件计划没有自动执行器，也不直接生成可执行服务路由。实际收费部署仍需明确主网 gas 授权、共享 nonce／费用账本、规范回执、完整 runtime 模板和全部 immutable getter 校验，再创建绑定**新地址**的收费路线。

启用收费还需逐资产配置服务政策与固定 gas 报价、明确 treasury 入账资产，并用最终证明和真实 DEX 跑 A/B 净到账、备份恢复、继续花费／提现的端到端。ETH 目标的费用以 WETH 支付 treasury。目标隐私池的存款上限或暂停会使整笔 swap 原子回滚，源 note 和费用转账一起恢复。收费组件不改变现有电路或最终证明参数；交易资产、路径、金额和费用仍公开。1inch 研究路径继续禁用。

## 官方中继策略 v2 与链上 adapter 的区别

`src/phase2-fees/policy.mjs` 和[费用策略文档](FEE_POLICY_V2.md)定义纯整数报价与新任务费用校验：

| 操作 | RC.2 官方中继选定策略 | 结算边界 |
| --- | --- | --- |
| 普通提现／中继 holderExit | `floor(gross × 30 / 10000)` 加证明前固定的本池资产 gas 报价 | 费用与净到账共用同一 gross；`publicOut` 已含 fee，不再重复增加或扣减 |
| DEX swap | `floor(actualGrossOutput × 30 / 10000)` | 按实测输出收取；Safe 收费，净额重新入池；proof 绑定 `maxServiceFee` |
| 私密转账／ragequit | 服务费和 note 扣除 gas 均为零 | 启用这一服务时由中继补贴交易 gas；ragequit 合约仍强制 `fee == 0` |
| 公开充值 | 零服务费 | 钱包直接发交易仍由发送者支付链上 gas |

这不是核心池对所有直接调用强制征收的 0.30% 税。官方中继普通提现费用的接收地址、归集及 Safe 入账仍需后端明确配置；不能把它与 DEX adapter 直接付 treasury 混为一谈。`includesGas` 只表示加上已公开报价的固定数量，不允许提交后按节点估算重新定价。ETH preset 不适用于 USDG 或股票，后两者必须有明确的原始资产单位报价。

未注明 schema 的旧策略仍按 v1 处理，保留历史 20 bps 等语义；不能重解释已有证明、签名、待处理或恢复中的任务。v2 组件进入 core repo 不会更新线上中继。新主网部署者仍未配置，主网资金预算未授权。RC.2 的真实最终证明验收已通过；候选清单已冻结，ABI、字节码／电路复现及公开副本验收均已通过。

RC.2 发布资料路径为 `artifacts/phase2-mainnet/release-candidate-20261016-r2.json`；核心已实际编译的 SHA256 为 `6bea6c23a5a6e80aec8411d8269978a584058e40a4cdf14e4eb231e4f7b7f41e`。收费 artifact 已实际编译并通过真实证明验收，SHA256 为 `52f71b538b613ec315727afce2eb4f86604adcce698be58a1ff12d8ab256a36a`；新 freeze 的最终 hash 仍须以完整性检查与冻结结果为准。初始导入来源见 `audit/upstream-files.json`，相对 RC.1 的修改由 `audit/source-changes-r2.json` 账本记录；不能再将 RC.2 描述为全部字节未改的提取。


## RC.2 实际最终证明验收

`audit/acceptance/standalone-20261016-r2/fees.json`（run `e7cf5b6d-36ec-41cc-9e68-2dcde9f48d3d`）记录 **22 项检查、4 份真实最终证明、73 笔本地交易**通过。UP 与 Router02 两条双跳路线使用真正的候选 pool／verifier／fee adapter，router、token、factory 与流动性是明确的 mock，不是实际市场成交。

每条路线的实测 gross 为 10,000 原始单位，adapter 收 30、净额 9,970 形成 B 可恢复 note；B 再正常提现 gross 9,970，扣百分比费用 29 加**测试夹具固定 gas 3 原始单位**，费用地址收到 32、B 收到 9,938。目标池账面只减 gross 一次并最终归零。测试中的 3 单位不是主网 ETH gas 报价，也不会配置在线中继。

同轮 native 验收为 43 项检查、11 份证明、48 笔本地交易；两份报告合计 15 份真实证明、121 笔本地交易，公网交易为零。RC.1 原报告保留于 `audit/baselines/v0.1.0-rc.1/` 和原 tag，不用于证明 RC.2。
