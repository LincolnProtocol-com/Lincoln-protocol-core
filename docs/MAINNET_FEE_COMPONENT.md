# 主网收费组件候选

主网收费组件采用独立命名空间。开发收费产物和当前测试网服务保持原版本；此流程不部署合约、不签名，也不启用公网收费。

`node scripts/phase2-fees/build-mainnet.mjs` 先完整验证当前核心生产发布（最终参数、公开贡献／beacon 证据与重编译字节码），再从现有收费源码派生仅允许链 `4663` 的版本。派生只修改构造函数链限制和两个接口 import；接口来自同一份已验证核心发布。旧的单参数 registry 构建会被拒绝，不能将开发产物改几个标志后用到主网。

生成文件为：

- `protocol/phase2-fees/mainnet/Phase2FeeRouteAdapter.sol`：派生源码。
- `artifacts/phase2-fees-mainnet/contracts.json`：两个收费 adapter 的完整 ABI、creation/runtime 模板和 immutable 引用。
- `contracts/phase2-fees-mainnet.standard-input.json`：包含全部依赖的独立编译输入。
- `contracts/phase2-fees-mainnet.manifest.json`：源码派生、ABI、编译输入、字节码和最终核心发布绑定。

`node scripts/phase2-fees/build-mainnet.mjs --check` 重新验证并逐字节比较以上文件。组件标记为 `releaseCandidate:true, testOnly:false, productionReady:false`；这表示明确的主网候选，不表示审计或公网资金验收完成。运行时 `loadFeeComponents` 验证生产核心、当前源码和可复现的组件 ABI／字节码，拒绝翻转开发标志、旧核心绑定和修改过的源码。

## Safe、费率与离线计划

本轮待部署方案使用用户指定的 Robinhood 主网 Safe `0x9CF17a6E3c75D200f58283A165C442a8A3994555` 为 treasury，默认 `20 bps`。本离线工具不验证 Safe 的签名人、阈值或链上代码，相关只读核验应与核心发布资料一起保存。

```sh
node scripts/phase2-fees/build-mainnet.mjs
node scripts/phase2-fees/build-mainnet.mjs --check

# 核心尚未部署时，生成显式待办模板，池地址及 initcode 留空。
node scripts/phase2-fees/plan-mainnet.mjs \
  --treasury 0x9CF17a6E3c75D200f58283A165C442a8A3994555 \
  --fee-bps 20 \
  --output artifacts/phase2-fees-mainnet/launch-plan.json

# 真实核心部署完成后，使用其已核验 profiles 生成准确的未签名 CREATE。
node scripts/phase2-fees/plan-mainnet.mjs \
  --core-deployment config/phase2-mainnet-deployed.json \
  --treasury 0x9CF17a6E3c75D200f58283A165C442a8A3994555 \
  --fee-bps 20 \
  --output artifacts/phase2-fees-mainnet/create-plan.json
```

默认路线来自 `config/phase2-mainnet-routes-example.json`，包含 UP／Uniswap 的 ETH↔USDG，以及 Uniswap 的 ETH↔NVDA 两跳；可通过 `--selection` 显式选择其他受核心规划器支持的路线。未部署核心时不会猜测或虚构池地址。即使准确 initcode 已生成，新 adapter 地址、实际 runtime hash、nonce 和 gas 仍未确定，`executionEnabled:false`。

核心部署器当前仅部署免费 adapter。此组件计划没有自动执行器，也不直接生成可执行服务路由。实际收费部署仍需明确主网 gas 授权、共享 nonce／费用账本、规范回执、完整 runtime 模板和全部 immutable getter 校验，再创建绑定**新地址**的收费路线。

启用收费还需逐资产配置服务政策与固定 gas 报价、明确 treasury 入账资产，并用最终证明和真实 DEX 跑 A/B 净到账、备份恢复、继续花费／提现的端到端。ETH 目标的费用以 WETH 支付 treasury。收费组件不改变池级税、现有电路或最终证明参数；交易资产、路径、金额和费用仍公开。1inch 研究路径继续禁用。
