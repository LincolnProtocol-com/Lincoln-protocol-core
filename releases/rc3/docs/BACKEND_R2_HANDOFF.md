# RC.2 后端／前端接线说明

> RC.3 forward revision: the pool cap-increase delay is now **12 hours (43,200 seconds)**. Lowering caps remains immediate, every replacement proposal starts its own full delay, and caps/pause never block spending or exits. Any RC.2 reports and run identifiers retained below are historical evidence, not proof that RC.3 has passed; fresh RC.3 evidence must be generated against its rebuilt artifacts. The immutable RC.2 source archive keeps the original 24-hour rule.

交接仓库：[LincolnProtocol-com/Lincoln-protocol-core](https://github.com/LincolnProtocol-com/Lincoln-protocol-core)。接入时锁定最终推送的 RC.2 commit/tag；本文件不代表 EC2 或原业务仓库已经升级，也不包含上线／重启／广播授权。

## 固定发布资料

| 文件 | SHA256 |
| --- | --- |
| `artifacts/phase2-mainnet/contracts.json` | `6bea6c23a5a6e80aec8411d8269978a584058e40a4cdf14e4eb231e4f7b7f41e` |
| `artifacts/phase2-fees-mainnet/contracts.json` | `52f71b538b613ec315727afce2eb4f86604adcce698be58a1ff12d8ab256a36a` |
| `artifacts/phase2-mainnet/release-candidate-20261016-r2.json` | `abbb1064147919a7936569cd6f8105b39f885835ba19c002be75960b69aa58e3` |

核心／收费两组 ABI 共 **10** 个，分别在 `abi/phase2-mainnet/`、`abi/phase2-fees-mainnet/`。使用相匹配的产物、ABI 和 profile，不能只替换 ABI 后继续用旧地址。note 格式、电路、最终 zkey／verifier 证明绑定保持原版本；Pool 字节码和 constructor 已改变，需要新部署实例。Registry 的 16 epoch 窗口已在 RC.1 完成，RC.2 保留。

## Pool 接口与存款限制

新 constructor：

```text
(address verifier, address holderExitVerifier, address aspRegistry, address asset,
 uint128 initialMaxDeposit, uint128 initialMaxTotal)
```

| 只读方法 | 返回 |
| --- | --- |
| `maxDeposit()` / `maxTotal()` | `uint128`，资产原始单位 |
| `accountedBalance()` | `uint256`，note 对应的账面负债 |
| `pendingCaps()` | 三个返回值：`uint128 maxDeposit, uint128 maxTotal, uint64 eta` |
| `depositsPaused()` | `bool` |
| `CAP_INCREASE_DELAY()` | `uint64`，43,200 秒 |

Guardian 操作：`setCaps(uint128,uint128)` 仅允许立即降低或保持；`proposeCapIncrease(uint128,uint128)` 提议非降低且至少一项提高；满 12 小时后由 Guardian 调用 `acceptCapIncrease()`。`cancelCapIncrease()` 取消提议。`pauseDeposits()`／`unpauseDeposits()` 只影响新入池。

新增事件为 `CapsUpdated(uint128 maxDeposit,uint128 maxTotal)`、`CapIncreaseProposed(uint128 maxDeposit,uint128 maxTotal,uint64 eta)`、`CapIncreaseCancelled()`、`DepositsPaused(bool paused)`。这些参数均非 indexed。存款错误包括 `DepositCapExceeded`、`PoolCapExceeded`、`DepositsArePaused`；按冻结 ABI 解码，不要将它们归为普通 RPC 不可用。

ETH 初始 raw caps 为 `1000000000000000000`／`20000000000000000000`；USDG 六位小数，为 `2500000000`／`50000000000`。股票仍待真实固定块估值及报价，不能把约 2,500／25,000 美元直接填成股数或原始单位。

## State / UI 数据

`src/phase2-asp/state.mjs` 的 `syncPhase2State` 新增以下字段；上层 API 需要显式透传，不能假定现有云端 `/v3/state` 已经提供：

```json
{
  "depositCaps": {
    "maxDeposit": "1000000000000000000",
    "maxTotal": "20000000000000000000",
    "accountedBalance": "0",
    "pendingCaps": {"maxDeposit": "0", "maxTotal": "0", "eta": "0"},
    "depositsPaused": false,
    "capIncreaseDelaySeconds": "43200"
  }
}
```

数值均为十进制字符串；无提议时三个 pending 值为零。旧 Pool ABI 完全没有这些 getter 时返回 `depositCaps:null`，表示没有这版链上 cap 接口，不能显示“有保护”或把 null 当成余额零。部分／签名不完整的新 ABI 会失败关闭；新 getter 读取失败不能降级为“无 caps”。

state 保留 cap 事件的完整 receipt／规范链校验，并在同一个 pinned block 读取 caps。必须满足 `accountedBalance ===` 日志重放的 `reserve`，实际托管余额可因捐赠而更高。不要用实际余额计算 headroom。Guardian 降低 maxTotal 后允许 `accountedBalance > maxTotal`；此时存款空间为零，退出仍可用。UI 的可存空间可显示 `max(0, maxTotal - accountedBalance)`。

**每次 swap 都要检查目标池**的暂停、单笔上限和净额入池后的总上限；报价时检查只是提示，提交前仍需新状态，合约执行时最终强制检查。目标池满／暂停会使整笔 source withdrawal → swap → target deposit 原子回滚，源 note 不会被单独花掉。`minAmountOut` 是扣除 DEX 服务费后的净回池下限。

`depositsPaused` 不应被接成全局私密花费开关。正常池内转账、普通提现、`holderExit`、`ragequit` 不受这项暂停／cap 降低限制；普通花费仍受 ASP 和规范状态检查。`transact.extData.publicOut` 已含 `fee`，账面只扣 publicOut 一次，不能再加 fee。holderExit／ragequit 扣完整 note 价值。

## Service fees v2：需要另行接入业务服务

`src/phase2-fees/policy.mjs` 是纯报价／校验模块，不包含托管 API 部署。可用导出为 `normalizeServiceFeePolicy`、`createLaunchServiceFeePolicy`、`quoteServiceFee`、`validateCommercialFee`。

- 新 launch policy 为 `lincoln-service-fees/v2`：提现和中继 holderExit **30 bps + 固定 gas 报价**；新收费 swap adapter **30 bps**，treasury 为 Safe `0x9CF17a6E3c75D200f58283A165C442a8A3994555`，每个 adapter 的费率／treasury 不可变。
- 存款、私密转账、ragequit 的 launch 服务费均为零。合约 ragequit 继续要求 `fee == 0`；官方免费中继承担其 gas。30 bps 是官方中继商业政策，不是强制写入所有自行提交的 holderExit。
- `createLaunchServiceFeePolicy({asset:'ETH'})` 的固定 gas 默认 `20000000000000` wei，上限 `200000000000000` wei；这不是实时网络 gas 透传。ERC20 必须显式提供其本币原始单位的 `gasFeeUnits`，模块不自动换价。
- `quoteServiceFee` 的 kind 使用 `withdrawal`、`holder-exit`、`private-transfer`、`ragequit`、`deposit`、`swap`；校验入口的 intent kind 沿用 `holderExit` 等现有结构。金额和 fee 用精确整数，客户端须使用同一 floor 规则。
- 把 policy schema／id 和报价条款绑定到**新** job。已证明、已签名、在恢复／确认中的旧 job 保留原证明绑定费用；不能用当前 v2 重新定价，也不能让重启恢复重新收费。未指定 schema 继续按原 v1 的 20-bps 默认语义解析，不能静默升级旧测试网记录。
- swap 比较 adapter 类型、链上费率和 treasury；提现费率与 swap 的 immutable 费率拆开维护。具体 API 的 `serviceFees` 输出与新 job 校验需业务后端另行接入并验收，当前 EC2 尚未因此收费或升级。

## 部署恢复与剩余事项

部署器传六个 Pool constructor 参数，并逐字节核对 CREATE calldata。初始 caps 通过规范构造回执中本池唯一 `CapsUpdated` 验证；恢复时不再把实时余额、暂停、待处理 caps 或已轮换 provider 强制等于初始值。生成的 profile 保留原 provider 绑定，链上轮换后仍需显式更新运行配置，不能自动放宽。

现有测试网旧 Pool／Registry／relay 保留原 artifact/profile，不能直接换成 RC.2 主网合约或覆盖原资料。**本轮未修改原 monorepo 或 EC2，也未重启、迁移入口或广播主网交易。**

主网 deployer 地址／账户仍为 null；NVDA 等股票 raw caps 仍为 valuation-required／null；主网预算仍为 null；收费部署执行器与路由激活尚未完成。后续需要新主网独立 signer、真实报价与原始单位估值、收费路由部署、主网 API／ASP 配置及明确预算下的真实 A/B＋DEX 验收。此文档不授权运行广播或重启命令。
