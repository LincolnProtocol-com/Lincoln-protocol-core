# Robinhood 主网合约候选版本

本轮只固定合约、最终证明参数、ABI 和可复现构建。Robinhood 主网 chain ID 为 **4663**。尚未部署主网，也没有把测试网 gas 授权用于主网。后端性能修改与 Docker 准备保留为独立工作，不在本轮迁移线上服务。

## 已定参数

| 项目 | 定稿 |
| --- | --- |
| Guardian | Safe `0x9CF17a6E3c75D200f58283A165C442a8A3994555`，RH 主网验证为 Safe 1.5.0、2/3 |
| DEX 服务费收款 | 同一个 Safe；原生 ETH 输出的服务费以 WETH 收取 |
| DEX 服务费 | 部署配置 20 bps（0.20%）；费率和 treasury 在每个新 adapter 中不可修改 |
| ASP | 自建 provider `0xce6770154D793dF78FbfA0D3615B2946366E6612`；普通花费需要当前 note 在可接受集合中 |
| ASP 可接受窗口 | 包含最新在内的 16 个 epoch；旧 epoch 还必须未过期、被替换未满 1 小时 |
| ASP 暂停 | Guardian 立即撤销已发布的全部 epoch，恢复不会使已撤销 epoch 重新有效 |
| Provider 轮换 | Guardian 提议，公开等待 3 天，由新 provider 接受 |
| 主网中继单笔 gas 上限 | 5,000,000；覆盖最旧 epoch 的估算及 20% + 10,000 余量，累计费用仍受独立预算约束 |
| 池 | 两输入／两输出、任意金额、动态收款、Groth16、20 层 Merkle 树 |
| 紧急退出 | `holderExit` 不需要 ASP；原充值 `ragequit` 只能原路全额退款、零协议费用 |
| DEX | UP Slipstream 与 Uniswap Router02，exact input、1–4 跳、ETH/WETH 自动包装与解包 |
| 管理边界 | 池和 adapter 没有 owner 提款、升级或任意 calldata 入口；Guardian 不持有池资金，也不能发布 ASP root |

普通转账／提现的官方中继服务费仍按服务政策结算到中继账户，归集至 Safe 属于后端运营流程；此处 Safe treasury 是新 DEX 收费 adapter 的直接收款人。

16 个 epoch 不保证四分钟：若每 15 秒持续发布，刚生成的最新 epoch 证明通常还有约 225–240 秒的窗口；发布更快时可用时间会更短，1 小时仍是旧 epoch 的时间上限。名单移除不能立即撤销所有旧证明；紧急情况由 Guardian 暂停，影响全部普通花费。

公开充值、公开退出及外部 DEX 的金额、路径和时间可见；股票的发行方权限不受本协议消除。首批示例部署选择 ETH、USDG、NVDA 三池以及 UP／Uniswap 六条路线；配置中列出的 SPY/AAPL 不代表已部署对应池或已验证实际流动性。

## 构建与证明参数

核心候选由 `scripts/phase2-mainnet/build.mjs` 从版本管理中的源码精确派生，仅允许 4663。最终 JoinSplit／holder-exit key 已包含两次操作者贡献和最终 beacon，不改变电路就无需重做参数。派生源码或产物有变化时，构建命令拒绝覆盖，必须保留旧候选后重新生成。

收费合约采用独立生产包 `artifacts/phase2-fees-mainnet/contracts.json`，严格绑定同一核心构建与最终参数；不把开发版改标记充作主网版本。合约每次按实际毛输出扣费，`minAmountOut` 是净回池下限，`maxServiceFee` 和 treasury 由证明绑定。失败整笔回滚。

最终文件和测试证据的 SHA256 以 `artifacts/phase2-mainnet/release-candidate-20261016.json` 为准。`node scripts/phase2-mainnet/freeze-release.mjs --check` 离线核对该清单；它也固定部署配置，后续填写已批准预算时须保留旧清单并显式更新配置快照，不改变合约／电路就无需重做证明参数。ABI 分别在 `abi/phase2-mainnet/` 与 `abi/phase2-fees-mainnet/`，由 `scripts/abi/sync.mjs` 导出，禁止手工改 ABI。

## 部署前剩余操作

1. 按发布清单再次核对源码、参数和字节码哈希。
2. 确认真实 ETH 的部署 gas 上限、各运营账户充值与端到端本金；当前配置全部保持未授权。
3. 部署核心与新收费 adapter，核对规范回执、实际 runtime、全部 immutable getters；收费计划尚不替代部署执行器或路由启用。
4. 用正式部署地址运行独立 A/B 的主网小额验收，再启用云端签名和公网入口。

借贷、TVL 生息、额外桥接合约和无 ASP 新池不加入此版。审计按当前决定后置；候选冻结不表示独立审计通过，也不表示主网已经上线。

用户等待时间的待验证目标见 [延迟目标](../docs/LATENCY_TARGETS.md)；15 秒发布尚未在云端启用。
