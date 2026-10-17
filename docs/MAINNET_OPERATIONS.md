# 主网运营配置：地址登记与离线计划

本轮仅登记用户提供的新主网部署地址和本地账户名称，不部署合约、不启用签名，也不更新 EC2。运营配置独立放在 `config/phase2-mainnet-operations.json`，绑定 `v0.1.0-rc.2` 的发布清单；它不修改合约、证明参数或已冻结配置。

| 项目 | 登记值 |
| --- | --- |
| 链 | Robinhood Chain，4663 |
| Deployer 地址 | `0x555998Ba2B2723C97d91FB20Da0ddb896749797e` |
| 本地账户名称 | `lincoln-deployer` |
| 地址来源 | 用户提供，`user-supplied` |
| Keystore 所有权验证 | 尚未完成，`keystoreOwnershipVerified:false` |
| 签名开关 | 关闭，`signingEnabled:false` |
| gas、总充值、验收本金、gas price 与保留余额授权 | 全部为 null |

绑定的候选文件为 `artifacts/phase2-mainnet/release-candidate-20261016-r2.json`，SHA256 为 `abbb1064147919a7936569cd6f8105b39f885835ba19c002be75960b69aa58e3`。

## 只生成计划

```sh
node scripts/core/mainnet-operations.mjs --plan
```

该入口只校验公开运营资料和候选绑定，在内存中的配置副本里填入登记地址，生成离线计划。它不访问 signer、RPC 或 cast，不读取密码、解锁 keystore、创建可执行部署目录或广播交易。无需 `prepare` 步骤。登记账户名称本身不证明该 keystore 控制了登记地址。

原冻结文件 `config/phase2-mainnet.json` 中的 deployer 地址和账户名称继续为 **null**，这是刻意保留的发布快照。不要直接填写该文件、重写冻结清单，或因地址已登记而运行原部署入口的 `--deploy`。之后真正部署须另行明确主网预算、完成账户验证及其余部署准备；本次计划不是部署授权。

## 公开观测与保留边界

本次交接的只读主网观测记录为：区块 **90,598,679**，该地址余额 **0.005 ETH**，nonce **0**。这是该区块时点的账户观测，不是 gas 预算授权，也不是可用余额的持续承诺；离线计划命令不会刷新它。不能把账户余额自动写成支出上限。

本地已观察到账户对应的 V3 加密 keystore 文件存在，但文件没有可直接核对的 `address` 属性，且没有解锁验证。公开配置和文档不保存密码、私钥、密码文件路径或 keystore 路径；`keystoreOwnershipVerified` 保持 false。

股票 raw caps 估值、实际主网部署、收费路由执行器与激活、云端主网服务及明确预算下的真实端到端验收仍是后续工作。现有测试网服务和 EC2 不因新增这份运营配置发生切换。
