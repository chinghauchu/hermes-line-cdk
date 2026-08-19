# Hermes Agent × AWS CDK — 多租戶 LINE 部署設計文件

狀態:**設計已定案,開始實作**
最後更新:2026-08-15

> 更新紀錄:確定不用 DynamoDB(用量資料留在各租戶 EFS 上的 SQLite 就好);加入 WAF(rate-based rule)防流量灌爆;白名單預設關閉(`LINE_ALLOW_ALL_USERS=false`),初期僅供家人使用;加入 AWS Budgets 帳單警報當最後一道保險。

## 1. 目標

用 AWS CDK 部署 [Hermes Agent](https://hermes-agent.nousresearch.com/)(Nous Research 開源、MIT 授權的 AI agent 平台)到 AWS 上,讓多個彼此獨立的 LINE 官方帳號(以下稱「租戶」)都能各自跟一份 Hermes 對話,並且:

- 每個租戶的資料、憑證、AWS 權限完全隔離
- 檔案/對話紀錄持久化,且備份到 S3
- 每個租戶的 LLM token 用量能被追蹤,並每月產出報表推播到 LINE
- 整套東西要能被其他人 fork 之後,在自己的 AWS 帳號上輕鬆部署起來(這是一個開源專案,不是內部工具)

**這不是要重新寫一個 agent。** Hermes Agent 本身是現成、成熟的開源軟體,我們的 CDK 專案只負責「基礎設施」與「把設定餵給它」,不碰它的原始碼。

## 2. 已驗證的關鍵事實(直接讀 Hermes Agent 原始碼確認,非文件摘要)

這幾點都會直接決定架構,而且跟一般文件網站寫的不完全一樣,所以是實際 clone repo(`github.com/NousResearch/hermes-agent`)讀 source 驗證過的:

| 主題 | 事實 | 依據 |
|---|---|---|
| **官方 image** | 已發布多架構(amd64+arm64)image 到 Docker Hub:`nousresearch/hermes-agent`。**不需要自己 build**。 | `.github/workflows/docker.yml` |
| **LINE 支援** | 原生支援,`plugins/platforms/line/adapter.py` 是完整的 aiohttp webhook server,內建 HMAC-SHA256 簽章驗證、reply token/Push API 自動切換、慢回應時跳出按鈕。預設監聽 **port 8646**。 | `plugins/platforms/line/plugin.yaml`, `adapter.py` |
| **啟用 LINE** | 只要提供 `LINE_CHANNEL_ACCESS_TOKEN`、`LINE_CHANNEL_SECRET` 兩個環境變數即自動啟用,不需要額外的「啟用」指令。 | `plugins/platforms/line/plugin.yaml` |
| **Bedrock 支援** | 原生支援,`auth_type="aws_sdk"`、`env_vars=()` — 用 AWS SDK 憑證鏈,**完全不需要 API key**,ECS Task Role 給 `bedrock:InvokeModel`/`bedrock:Converse` 權限即可。 | `plugins/model-providers/bedrock/__init__.py` |
| **用量/成本追蹤** | 已內建。本機 SQLite(`~/.hermes/state.db`)有 `session_model_usage` 表,逐 session、逐 model 記錄 `input_tokens`、`output_tokens`、`cache_read_tokens`、`cache_write_tokens`、`estimated_cost_usd`、`actual_cost_usd`。**不需要自己包用量追蹤 proxy。** | `hermes_state_schema.py` |
| **持久化模型** | 單一掛載卷 `~/.hermes` → 容器內 `/opt/data`,裝所有東西:config.yaml、gateway.json、state.db、skills。官方 docker-compose 用 `network_mode: host`。 | `docker-compose.yml` |
| **Dashboard** | image 內還有一個 `dashboard` 指令(本機 web UI,含 API key),官方預設只綁 localhost,**不應該對外暴露**。 | `docker-compose.yml` 註解 |
| **使用者授權/白名單** | Hermes 對 Telegram/Discord/WhatsApp/Slack/Signal 等平台有一套動態「DM Pairing」機制(陌生使用者傳訊息拿到一次性驗證碼,管理者用 CLI 批准,存在 EFS 上,不用重啟)。**但 LINE 目前沒有接上這套機制**——LINE adapter 的白名單只認 `LINE_ALLOWED_USERS` 環境變數(或 config.yaml 的 `extra.allowed_users`),**啟動時讀一次**,不會動態更新。白名單檢查發生在呼叫 Bedrock 之前,不在名單內的訊息會被直接丟棄、不產生 LLM 費用。 | `gateway/pairing.py`, `plugins/platforms/line/adapter.py` |
| **預設模型只能透過 config.yaml 設定** | `gateway/run.py::_resolve_gateway_model()` 的 docstring 直接寫「Read model from config.yaml — single source of truth」——**沒有任何環境變數(包括 `HERMES_MODEL`)能覆寫 gateway 實際跑起來要用的預設模型**,那個環境變數只有 CLI/TUI/cron 路徑會讀。這打破了我們原本「全部用環境變數設定」的假設,不寫 `config.yaml` 就會落回官方範本內建的預設值(`anthropic/claude-opus-4.6`),對 Bedrock 來說是不合法的 model ID,每次呼叫都會失敗(`ValidationException: The provided model identifier is invalid.`)。解法是下方 CDK 結構的 `write-tenant-config` Lambda。**已在 `ap-northeast-1` 實際部署驗證:修好之後 `qwen.qwen3-next-80b-a3b` 正常回覆訊息。** | `gateway/run.py:_resolve_gateway_model`,實際部署踩到並修好 |

**這些發現的直接後果:**原先規劃的「自訂 Webhook Lambda + SQS + DLQ」「用量追蹤 sidecar proxy」「Bedrock Access Gateway」「共用 OpenRouter key」全部不需要 — Hermes 本身就處理掉了。CDK 專案因此比最初設想的精簡很多。

## 3. 最終架構

```
LINE 使用者
   │ HTTPS POST(webhook)
   ▼
Route53(網域)→ ALB(公開,ACM TLS 憑證)
   │
   ├─ AWS WAF(rate-based rule,擋單一 IP 短時間灌爆;掛在 ALB,
   │   請求連 target 都碰不到就先被擋)
   │
   ▼ 依租戶 path routing:/line/{tenantId}/* → 該租戶的 target group
每個租戶各自一個 ECS Fargate Service(單一容器)
┌───────────────────────────────────────────────────┐
│ 容器:nousresearch/hermes-agent:<pinned-tag>        │
│  ├─ command: ["gateway", "run"]                    │
│  ├─ env(來自 SSM SecureString):                    │
│  │    LINE_CHANNEL_ACCESS_TOKEN / LINE_CHANNEL_SECRET│
│  │    HERMES_UID / HERMES_GID                       │
│  │    LINE_ALLOW_ALL_USERS=false(預設關閉)          │
│  │    LINE_ALLOWED_USERS=<白名單 userId,逗號分隔>   │
│  │    (Bedrock 走 AWS SDK,不需要 key)               │
│  ├─ port 8646 對 ALB target group                  │
│  └─ volume: EFS access point → /opt/data           │
│                                                      │
│ IAM Task Role(此租戶專屬,最小權限):                │
│  ├─ elasticfilesystem:ClientMount/ClientWrite       │
│  │    只限這個租戶自己的 EFS access point            │
│  ├─ bedrock:InvokeModel / Converse                  │
│  │    只限允許的 model ARN 清單                      │
│  ├─ s3:PutObject/GetObject                          │
│  │    只限 s3://bucket/tenants/{tenantId}/*         │
│  └─ ssm:GetParameter 只限這個租戶自己的參數路徑        │
└───────────────────────────────────────────────────┘

背景排程(EventBridge,例如每日):
  EFS→S3 備份任務(輕量 ECS Scheduled Task)
  逐租戶把 EFS access point 內容同步到 s3://bucket/tenants/{tenantId}/

每月排程(EventBridge,1 號觸發):
  ReportingLambda(掛載每個租戶的 EFS access point,VPC 內)
  ├─ 對每個租戶,唯讀開啟 state.db,查 session_model_usage
  │   依 last_seen 篩選上個月、SUM 彙總
  ├─ 產出 CSV → s3://bucket/reports/{tenantId}/{yyyy-mm}.csv
  └─ 用該租戶的 LINE Push API,把摘要推播給 manifest 設定的管理者 LINE userId

橫向:AWS Budgets 帳單警報(超過設定金額寄信通知,最後一道保險)
```

**不再需要**:自訂 Webhook Lambda、SQS/DLQ、用量追蹤 sidecar、DynamoDB(用量與租戶清冊都不需要活的資料庫 — 用量在各租戶自己的 SQLite,租戶清冊是部署時的 manifest 檔)。

## 4. 關鍵決策與理由

| 決策 | 理由 |
|---|---|
| **租戶隔離:每租戶獨立一份 Fargate Service** | 唯一能做到「每個 LINE 帳號各自獨立 IAM role」的方式。代價是 infra 數量隨租戶數線性增加,但符合你的明確要求。 |
| **LLM:Amazon Bedrock** | Hermes 原生支援、走 IAM(`auth_type=aws_sdk`),不用管理任何 API key,完全符合最初的目標。 |
| **Image 來源:Docker Hub 官方 image,不自己 build** | 官方已發布多架構 image。自己 build 等於重新維護一份 900MB+ 原始碼的建置流程,沒有必要,也違背「跟官方版本保持同步」的精神。 |
| **租戶上線方式:manifest 驅動的 CDK(`tenants.json` + `cdk deploy`)** | 新增租戶等於新增一整套 infra(Fargate Service + IAM Role + EFS Access Point + ALB 路由規則),用「改設定檔 + 部署」比「動態呼叫 AWS API 建資源」更容易審查、追蹤、回滾,適合這個量級。 |
| **不用 DynamoDB** | 用量資料已經在各租戶的 SQLite;租戶清冊是部署時的靜態 manifest,不需要一個額外的、持續要維護一致性的資料庫。 |
| **前門用 ALB,不是 API Gateway** | 原始草圖畫的是 API Gateway,但 Hermes 本身就是一個完整的 HTTP 應用(有自己的路由、健康檢查),ALB 對 ECS Fargate 是最直接、最少活動零件的整合方式。 |
| **EFS 而非純 S3 做即時儲存** | Hermes 需要一般檔案系統語意(SQLite、config.yaml 即時讀寫),EFS 才能掛載成 POSIX 檔案系統給 Fargate 用。S3 角色改為「定期備份 + 報表產出物存放處」,滿足「檔案存入 S3」但不是即時工作儲存。 |
| **ALB 前面掛 WAF(起步就有,非後續加)** | 目的是防「有人打爆你的 endpoint,造成 Fargate/流量費用暴增」,不是驗證身份(身份驗證是 LINE 簽章 + 白名單的事)。Rate-based rule 在請求連 Fargate 都碰不到之前就擋掉,成本每月數美元,對這個規模的專案值得從一開始就有,不是「之後有需要再加」。 |
| **白名單預設關閉,不用 Lambda 做存取控制** | 初期只給家人用,`LINE_ALLOW_ALL_USERS=false` + `LINE_ALLOWED_USERS` 白名單即可,而且這個檢查在 Hermes 內部發生在呼叫 Bedrock **之前**,不在名單內的訊息不會產生 LLM 費用。不需要額外寫一個 Lambda 當關卡——那樣還要自己重做簽章驗證/reply token 邏輯,而白名單機制 Hermes 已經內建。 |
| **不用 DynamoDB 存用量資料** | 討論過「同步一份到 DynamoDB 方便查」的優化,但目前決定先不做——用量資料留在各租戶 EFS 上的 SQLite(`session_model_usage` 表)就是唯一真相來源,月報 Lambda 直接查那裡。之後真的覺得每次都碰 EFS 太慢/太複雜,可以再加。 |

## 5. 尚待驗證的假設

寫 CDK 的過程中直接讀了 `plugins/platforms/line/adapter.py` 原始碼,解決了大部分原本列在這裡的未知數:

- **健康檢查 endpoint 已確認**:`GET /line/webhook/health`(原始碼 `self._app.router.add_get(f"{self.webhook_path}/health", ...)`),已經接進 TargetGroup 的健康檢查
- **Webhook 路徑是固定的,不能用 path 分租戶**:預設值 `/line/webhook`(`DEFAULT_WEBHOOK_PATH`),而且不是每租戶可各自設定的環境變數,只能透過 `config.yaml` 覆寫。因此改成**每租戶一個子網域**(`{tenantId}.{domainName}`)、ALB 用 Host header 分流,而不是原本設想的 path prefix——見 `lib/tenant-stack.ts` 的註解
- **`state.db` 的實際路徑**:根據 `docker-compose.yml` 的 `~/.hermes:/opt/data` 掛載方式推斷是直接在掛載根目錄(`/opt/data/state.db`),`lambda/usage-aggregator` 照這個假設寫,**部署後第一次跑月報時務必驗證**
- **EFS 上 SQLite 併發寫入已經實際踩到問題,而且比預期嚴重**:部署過程中新舊 task 短暫重疊(原本 `maxHealthyPercent: 200`)導致兩個 process 同時碰同一顆 `state.db`。一開始只看到「session storage could not be written」這種安全拒絕,後來直接演變成 `database disk image is malformed`——**檔案真的壞了,而且壞掉的 DB 會讓 Hermes 開機/健康檢查一直過不了**,導致新的、乾淨的部署也一直失敗(卡在一個「task 起不來 → 沒辦法 exec 進去手動修 → 只能等下一次部署,但部署又因為同一個原因失敗」的迴圈)。已做兩層修正:①`maxHealthyPercent: 100` + 關閉 `availabilityZoneRebalancing`,部署時強制先關舊 task 才開新的,不會再有兩個 process 同時碰同一顆檔案;②`write-tenant-config` Lambda 在 Fargate 啟動前,用 `PRAGMA integrity_check` 檢查 `state.db`,壞掉就自動改名隔離(不是刪除),讓 Hermes 開機時建一個全新的——這樣即使未來又發生一次類似的損毀,部署本身也能自我修復,不會卡死
- Bedrock model 存取:已在 `ap-northeast-1` 用 `qwen.qwen3-next-80b-a3b` 實際驗證成功
- **`config.yaml` 沒帶版本標記會讓 Hermes 開機卡死**:我們自己寫的 `config.yaml` 只有 `model:` 區塊,沒有 `_config_version` 欄位。Hermes 的 `cont-init` 階段偵測到「沒有版本標記」會判定成一份兩年前的舊設定、印出「can no longer be auto-migrated」的警告,接著在這個非互動式環境下**整個 gateway process 卡住,7 分鐘以上完全沒有 log 輸出,最後被 ECS 健康檢查判定失敗而砍掉**——不是慢,是真的卡死,調高健康檢查寬限期也沒用。修法是警告訊息裡自己講的:在 `config.yaml` 加上 `_config_version: 12`,`write-tenant-config` Lambda 已經補上這個欄位

## 5a. 部署前你需要準備/決定的事

| 項目 | 說明 | 何時需要 |
|---|---|---|
| AWS 帳號/憑證 | 決定用哪個 AWS 帳號部署(這台機器上現有的 credential 是 `324037322642` / `ocr-cdk-deploy-user`,名字看起來是別的專案用的,部署前要確認是否沿用) | 第一次 `cdk deploy` 前 |
| Region | 影響 Bedrock 模型可用性與延遲,預設先用 `us-east-1`,可指定其他 | 寫 CDK 設定時 |
| 網域 | 掛 ALB 的 ACM 憑證用,例如 `hermes.yourdomain.com` | 第一次 `cdk deploy` 前 |
| Bedrock model access | 到 Bedrock console 手動開通目標 Claude 模型的存取權(帳號層級一次性手動步驟,CDK 無法自動化) | 第一次 `cdk deploy` 前 |
| LINE 官方帳號 + Messaging API channel | 取得 `Channel Secret`、`Channel Access Token`(步驟見 `docs/LINE_INTEGRATION.md`) | 第一次 `cdk deploy` 前 |
| 白名單 bootstrap | 部署後,暫開 `LINE_ALLOW_ALL_USERS=true` → 請家人各傳一則訊息 → 從 CloudWatch Logs 撈 `userId` → 填入 `LINE_ALLOWED_USERS` → 關閉暫開、重新部署 | 第一次部署完成後 |

`cdk bootstrap`、`cdk deploy` 這類會在 AWS 上建立實際資源(會計費、不易復原)的操作,我不會自己執行,會先跟你確認。

## 6. CDK 專案結構(草案)

```
bin/hermes.ts                — 讀 tenants.json,對每個租戶產生一份 TenantStack
lib/
  shared-stack.ts             — VPC、ECS Cluster、EFS FileSystem、S3 bucket、ALB(HTTPS listener)、
                                 WAF WebACL(rate-based rule)、ACM 憑證、Route53 record、
                                 AWS Budgets 警報、EventBridge(備份 + 月報排程)、ReportingLambda
  tenant-stack.ts              — 每租戶一份:EFS Access Point、IAM Task Role/Execution Role、
                                 Fargate TaskDefinition + Service、ALB target group + 路由規則、
                                 該租戶的 SSM SecureString 參數(LINE secret/token/白名單)
lambda/
  reporting/                  — 月報 Lambda(讀各租戶 EFS 上的 state.db,彙總,CSV to S3,LINE push)
  efs-backup/                 — 或用 ECS Scheduled Task 取代(尚待實作時決定用哪種)
  write-tenant-config/        — CDK Custom Resource,把 model.default 寫進租戶 EFS 上的 config.yaml
                                 (每租戶各一份,部署時自動跑,理由見上面的表格)
docs/
  DESIGN.md                   — 本文件
  LINE_INTEGRATION.md         — LINE Developers Console + 租戶上線教學(尚未寫)
tenants.example.json          — 租戶 manifest 範本
tenants.json                  — 實際租戶清冊(不進版控,或用 .gitignore 排除敏感欄位)
test/                         — CDK assertion 測試
```

## 7. 實作步驟(打算依序執行)

1. **CDK 專案初始化**:`cdk init app --language typescript`,補上 README、`.gitignore`(排除 `tenants.json` 內的敏感欄位或整份檔案)
2. **本機驗證 Hermes image 行為**:`docker run` 官方 image,填 `LINE_CHANNEL_ACCESS_TOKEN`/`LINE_CHANNEL_SECRET`/Bedrock 相關設定,確認 port 8646、有無健康檢查 endpoint、`~/.hermes` 內容結構 — 這一步的結果會回頭修正第 4、5 步的細節
3. **`tenants.json` schema 設計 + 範本**:欄位包含 channelId(=tenantId)、顯示名稱、LINE 憑證存放的 SSM 路徑、月度預算(給報表用,非強制擋停)、管理者 LINE userId、允許的 Bedrock model ID 清單
4. **`SharedStack`**:VPC(2 AZ、S3/ECR/CloudWatch Logs/SSM 用 VPC Endpoint 省 NAT 費用)、ECS Cluster、EFS FileSystem(加密)、S3 bucket(版本控制 + lifecycle)、ALB(HTTPS listener,綁 ACM 憑證)、WAF WebACL(rate-based rule,掛 ALB)、AWS Budgets 警報
5. **`TenantStack`**(對 manifest 中每個租戶迴圈產生):EFS Access Point(獨立路徑+POSIX 權限)、IAM Task Role/Execution Role(最小權限,如第 3 節表格)、Fargate TaskDefinition(image 指到 Docker Hub 官方 tag、環境變數/Secrets 注入,預設 `LINE_ALLOW_ALL_USERS=false`)、ECS Service、ALB target group + listener rule
6. **EFS → S3 備份機制**:排程任務,逐租戶同步(用 ECS Scheduled Task 還是 DataSync,實作時依第 5 節第 2 點的驗證結果決定)
7. **`ReportingLambda`**:VPC 內、掛載每租戶 EFS access point,查 `session_model_usage`,產出 CSV,LINE Push 推播
8. **CDK assertion 測試**:每個 stack 至少驗證關鍵資源存在(IAM 權限邊界、S3 阻擋公開存取、ALB HTTPS-only、WAF 已掛載、Fargate 綁對 image/port)
9. **`docs/LINE_INTEGRATION.md`**:LINE Developers Console 設定步驟、怎麼把新租戶寫進 `tenants.json` 並部署、白名單 bootstrap 流程(暫開 `LINE_ALLOW_ALL_USERS` → 撈 userId → 填白名單 → 關閉重部署)
10. **端對端測試**:部署到你的 AWS 帳號,用一個測試 LINE 官方帳號走完整流程,確認訊息進得去、Hermes 有回覆、白名單擋非允許使用者、月報邏輯手動觸發一次能正確產出

## 8. 這次不會做的部分

- 不修改 Hermes 原始碼或 fork 它 — 一切客製化都在 CDK/我們自己的 Lambda,image 直接吃官方 Docker Hub 發布
- Hermes 的 agent 人格/skills/system prompt 內容 — 由你自己在租戶的 config 裡設定
- 動態(zero-redeploy)租戶上線 API — 目前是 manifest + `cdk deploy`,量大了之後可以再考慮
- API Gateway 這層(見第 4 節,先用 ALB;WAF 已經是起步就內建,不是「之後」)
- LINE 專用的動態配對(pairing)流程 — Hermes 目前沒有幫 LINE 接這個機制,只能用靜態白名單 + 手動 bootstrap
