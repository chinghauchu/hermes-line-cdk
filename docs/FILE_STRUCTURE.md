# 檔案架構說明

這份文件說明目前 repo 裡每個檔案/目錄的用途,方便之後回來看的時候快速找到該改哪裡。整體設計理由見 [`DESIGN.md`](DESIGN.md);LINE 串接步驟見 [`LINE_INTEGRATION.md`](LINE_INTEGRATION.md)。

```
hermes-line-cdk/
├── bin/hermes.ts                  CDK App 進入點
├── lib/
│   ├── config.ts                  租戶設定的型別定義 + 讀取/驗證邏輯
│   ├── shared-stack.ts            所有租戶共用的基礎設施(SharedStack)
│   └── tenant-stack.ts            每個租戶各自一份的基礎設施(TenantStack)
├── lambda/
│   ├── usage-aggregator/index.py  月報:讀 EFS 上的用量資料,寫 S3
│   ├── report-notifier/index.py   月報:把摘要推播到 LINE
│   ├── efs-backup/index.py        每日:把 EFS 資料備份到 S3
│   └── write-tenant-config/       部署時:把 model.default 寫進租戶 EFS 上的 config.yaml
│       index.py                   (CDK Custom Resource,見 DESIGN.md 說明)
├── test/hermes.test.ts            CDK assertion 測試
├── scripts/set-tenant-secret.sh   把租戶的 LINE 憑證寫進 SSM 的小工具
├── docs/
│   ├── DESIGN.md                  架構設計與決策理由(最完整的文件)
│   ├── LINE_INTEGRATION.md        怎麼串接一個新的 LINE 官方帳號
│   └── FILE_STRUCTURE.md          本文件
├── tenants.example.json           租戶設定檔範本(進版控)
├── tenants.json                   實際的租戶設定檔(不進版控,你自己維護)
├── README.md
├── package.json / package-lock.json
├── tsconfig.json                  TypeScript 編譯設定
├── cdk.json                       CDK App 設定(告訴 cdk 怎麼執行 bin/hermes.ts)
├── cdk.context.json               CDK 的環境查詢快取(不進版控)
├── jest.config.js                 測試框架設定
├── .gitignore / .npmignore
└── .claude/settings.local.json    你這台機器上的 Claude Code 權限設定(不進版控)
```

## `bin/hermes.ts` — CDK App 進入點

`cdk` 指令實際執行的檔案。做三件事:

1. 呼叫 `loadConfig()` 讀 `tenants.json`
2. 建立一份 `SharedStack`(所有租戶共用的東西)
3. 對 `tenants.json` 裡的每個租戶,各自建立一份 `TenantStack`

跑 `cdk deploy`/`cdk synth` 時,CDK 就是從這裡開始組出整個 App 要部署哪些 CloudFormation stack。

## `lib/config.ts` — 設定檔的型別與驗證

定義了兩個 TypeScript interface:

- `HermesAppConfig`:整個 App 層級的設定(AWS 帳號/region、網域、預算、預設模型...)
- `TenantConfig`:單一租戶的設定(id、白名單、管理者 LINE userId...)

`loadConfig()` 讀 `tenants.json`(或找不到時退回 `tenants.example.json`)並做基本驗證(租戶 id 格式、必填欄位、id 不可重複)。

也放了兩個小函式 `lineChannelSecretParamName()` / `lineChannelAccessTokenParamName()`,把「租戶的 LINE 憑證存在 SSM 的哪個路徑」這個命名規則集中定義在一個地方——`tenant-stack.ts` 讀取時、`scripts/set-tenant-secret.sh` 寫入時都照這個規則,才不會兩邊路徑對不上。

## `lib/shared-stack.ts` — 共用基礎設施

所有租戶共用、只需要建一次的資源:

- **網路**:VPC(只有 public subnet,沒有 NAT Gateway,省錢)、Security Group
- **EFS**:所有租戶的資料實際上放在同一個 EFS 檔案系統上,只是每個租戶各自有獨立的 access point(在 `tenant-stack.ts` 裡建立,隔離靠 access point 的路徑範圍,不是分開的檔案系統)
- **S3**:備份/報表用的 bucket
- **ALB + WAF + ACM 憑證 + Route53**:公開的 HTTPS 入口,萬用字元憑證/DNS 讓新增租戶不用動到這一層
- **ECS Cluster**:所有租戶的 Fargate service 都跑在這個 cluster 底下
- **AWS Budgets**:帳單警報
- **三個 Lambda + 兩個 EventBridge 排程**:對應 `lambda/` 底下那三支程式(見下方)

`TenantStack` 建立時會拿這個 stack 的輸出(`vpc`、`cluster`、`fileSystem`、`bucket`、`httpsListener`...)來掛自己的資源。

## `lib/tenant-stack.ts` — 單一租戶的基礎設施

每個租戶(= 一個 LINE 官方帳號)各自一份,彼此獨立:

- **EFS Access Point**:路徑限定在 `/tenants/{tenantId}`,這個租戶的 Fargate 容器只看得到自己這一段
- **IAM Task Role**:只能碰這個租戶自己的 EFS access point、S3 前綴、被允許的 Bedrock 模型
- **IAM Execution Role**:ECS 啟動容器時用,能讀這個租戶在 SSM 的 LINE 憑證
- **Fargate TaskDefinition + Service**:實際跑官方 `nousresearch/hermes-agent` image 的地方
- **ALB TargetGroup + ListenerRule**:依 `{tenantId}.{domainName}` 這個子網域,把流量從共用的 ALB 轉進這個租戶的 Fargate service

新增一個租戶,就是在 `tenants.json` 加一筆設定,`cdk deploy HermesTenant-<id>` 會照這份程式碼生出上面這一整套資源。

## `lambda/` — 三支背景任務

都是純 Python(用標準函式庫,`sqlite3`/`csv`/`json`/`urllib`,不用額外套件),各自職責單一:

- **`usage-aggregator/index.py`**(VPC 內,掛 EFS,每月跑一次):對每個租戶,直接讀它 EFS 上的 `state.db`(Hermes 自己記的 `session_model_usage` 表),彙總上個月的 token 用量/成本,寫成 CSV 到 S3,最後寫一份 `summary.json`——這個檔案的出現會觸發下一支
- **`report-notifier/index.py`**(不在 VPC 內,需要打外部 LINE API,由 S3 事件觸發):讀 `summary.json`,對每個有設定管理者 LINE userId 的租戶,去 SSM 拿它的 channel access token,呼叫 LINE Push API 推播用量摘要
- **`efs-backup/index.py`**(VPC 內,掛 EFS,每天跑一次):把每個租戶在 EFS 上的檔案原封不動複製一份到 S3,當作備份

三支之所以分開,是因為「需要碰 EFS」跟「需要連外部網路」這兩個需求互斥(這個 VPC 沒有 NAT Gateway),拆開之後兩支都不需要額外花錢買 NAT 出口。細節理由在 `DESIGN.md`。

## `test/hermes.test.ts` — CDK assertion 測試

不是端對端測試(那個要真的部署才能測),是驗證「CDK 生出來的 CloudFormation 樣板長得對不對」,例如:S3 是不是真的擋掉公開存取、ALB 是不是真的只開 HTTPS、Fargate 容器是不是真的吃官方 image 跟正確的 port、IAM 權限是不是真的限定在單一 access point 等等。改動 `lib/` 底下的程式碼後,跑 `npx jest` 確認沒改壞既有的安全設定。

## `scripts/set-tenant-secret.sh` — 寫入租戶的 LINE 憑證

一個很小的 bash 腳本,互動式地把某個租戶的 `LINE_CHANNEL_SECRET`/`LINE_CHANNEL_ACCESS_TOKEN` 寫進 SSM Parameter Store(SecureString)。刻意獨立在 CDK 之外執行——這些是機密值,不應該出現在 `tenants.json` 或任何 CloudFormation 樣板裡。部署一個新租戶前,要先跑這支腳本,`tenant-stack.ts` 裡的 `ecs.Secret.fromSsmParameter(...)` 才讀得到值。

## `tenants.example.json` / `tenants.json`

前者是範本(進版控,給任何 fork 這個專案的人看要填哪些欄位);後者是你實際在用的設定(被 `.gitignore` 排除,因為裡面會有你的 AWS 帳號 ID、網域、白名單等)。`lib/config.ts` 的 `loadConfig()` 優先讀 `tenants.json`,不存在才退回範本。

## 其他設定檔

- **`tsconfig.json`**:TypeScript 編譯設定,`cdk init` 產生的預設值,沒特別改動
- **`cdk.json`**:告訴 CDK CLI 用 `npx ts-node bin/hermes.ts` 當 App 的進入點,以及一些 CDK 的 feature flag
- **`cdk.context.json`**:CDK 查詢 AWS 環境資訊(例如 AZ 清單)時的本機快取,目前這個專案刻意避開所有需要查詢的 API(VPC 用明確指定的 AZ、Route53 用 `fromHostedZoneAttributes` 而不是 `fromLookup`),所以這個檔案應該一直是空的
- **`.gitignore`**:排除 `node_modules`、`cdk.out`、`tenants.json`(機密設定)、`.claude/settings.local.json`(你個人的權限設定)等不該進版控的東西
