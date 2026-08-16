# LINE 串接教學

這份教學帶你把一個 LINE 官方帳號接上這套系統,變成一個新的「租戶」。每個租戶都是獨立的 Fargate service,彼此的資料、IAM 權限完全隔離。

## 前置準備(整個專案只需要做一次)

1. **AWS 帳號 + 網域**:確認 `tenants.json` 的 `account`/`region`/`domainName`/`hostedZoneId` 已經填好(見 `tenants.example.json`),且該網域可以用 Route53 做 DNS 驗證,或你已經有一張涵蓋 `*.{domainName}` 的 ACM 憑證(`certificateArn`)。
2. **Bedrock model access**:到 [Bedrock Console → Model access](https://console.aws.amazon.com/bedrock/home#/modelaccess) 手動開通 `tenants.json` 裡 `defaultBedrockModelIds` 列出的模型(這是 AWS 帳號層級的一次性手動步驟,CDK 沒辦法幫你按這個按鈕)。
3. **共用基礎設施已部署**:`SharedStack`(VPC、ALB、EFS、S3、WAF...)要先 `cdk deploy HermesShared` 過一次。

## 每新增一個租戶,走以下步驟

### 1. 在 LINE Developers Console 建立官方帳號

1. 前往 [LINE Developers Console](https://developers.line.biz/console/),建立一個新的 Provider(或用現有的)。
2. 建立一個 **Messaging API channel**。
3. 在 channel 設定頁面找到:
   - **Channel secret**(Basic settings 分頁)
   - **Channel access token**(Messaging API 分頁,選長期有效的版本,不是短期的)
4. 把「自動回覆訊息」「加好友歡迎訊息」都關掉(Messaging API 分頁的 LINE Official Account features,會連到 LINE Official Account Manager 設定)——不關掉的話,使用者會同時收到 LINE 內建的罐頭回覆跟 Hermes 的回覆。

### 2. 決定這個租戶的 ID 跟存取政策

- **租戶 ID**:小寫英數字+連字號,例如 `family`、`shop-a`。會被拿來當子網域(`{id}.{domainName}`)、EFS 路徑、IAM role 名稱的一部分,32 字元以內。
- **存取政策**(見 `docs/DESIGN.md` 的存取控制設計):
  - 只給特定人用(例如家人、內部員工)→ `lineAllowAllUsers: false`,之後用第 4 步的 bootstrap 流程收集 userId
  - 對所有加好友的人開放(例如客服 bot)→ `lineAllowAllUsers: true`,不需要白名單

### 3. 把租戶寫進 `tenants.json`,部署

在 `tenants.json` 的 `tenants` 陣列加一筆:

```json
{
  "id": "family",
  "displayName": "Family Bot",
  "lineAllowAllUsers": false,
  "lineAllowedUsers": [],
  "lineAllowedGroups": [],
  "lineAllowedRooms": [],
  "adminLineUserId": "",
  "monthlyBudgetUsd": 10
}
```

先把 channel secret / access token 寫進 SSM(這一步用 `scripts/set-tenant-secret.sh`,見下方),再部署:

```bash
./scripts/set-tenant-secret.sh family
npx cdk deploy HermesTenant-family
```

部署完成後,CDK 輸出(`Outputs`)會印出這個租戶的 Webhook URL,格式是:

```
https://family.hermes.example.com/line/webhook
```

### 4. 把 Webhook URL 貼回 LINE Console

回到 LINE Developers Console 的 Messaging API 分頁:

1. 「Webhook URL」貼上第 3 步拿到的網址
2. 點 **Verify**,確認回應是成功(這時候 Hermes 容器要已經在跑,且 `LINE_CHANNEL_SECRET` 要正確,否則簽章驗證會失敗)
3. 打開「Use webhook」開關

### 5.(僅限白名單模式)收集允許使用者的 LINE userId

LINE 沒有辦法讓你用電話/帳號預先查到某人的 userId——只有他真的加好友、傳過訊息之後才拿得到。所以：

1. 暫時把 `tenants.json` 這個租戶的 `lineAllowAllUsers` 設成 `true`,`cdk deploy HermesTenant-family`
2. 請你要授權的人各自傳一則訊息給這個官方帳號(例如「hi」)
3. 到 CloudWatch Logs(log group `HermesTenant-family/.../hermes`)找 `LINE: rejecting unauthorized source` 或訊息事件的 log,裡面的 `source.userId`(`U` 開頭一串英數字)就是你要的
4. 把收集到的 userId 填進 `tenants.json` 的 `lineAllowedUsers`,把 `lineAllowAllUsers` 改回 `false`
5. 再次 `cdk deploy HermesTenant-family`

之後這個租戶就只有名單內的人能讓 bot 回應——不在名單內的訊息會在 Hermes 內部被直接丟棄,**不會**呼叫 Bedrock、不會產生費用。

### 6. 端對端測試

用被授權的 LINE 帳號傳一則訊息,確認:

- LINE app 收到 Hermes 的回覆
- CloudWatch Logs 看得到這個租戶的 Fargate task 有處理這則訊息(`HermesTenant-family` 的 log group)
- 如果想確認額度/報表邏輯,可以手動觸發一次 `UsageAggregatorFn` Lambda(Lambda console 的 Test 按鈕即可,不用等到月初)

## 關於回覆機制的重要提醒

Hermes 的 LINE adapter 會優先用免費的 **reply token** 回覆(但只在 1 分鐘內有效),超過時間或 LLM 回應比較慢時會自動改用計費的 **Push API**,並在對話中跳出一個按鈕讓使用者手動拉取答案。這是 Hermes 內建的行為,不需要我們額外處理,但代表 Push API 的費用是這套系統實際運作的一部分,月報裡看到的 token 用量之外,LINE 本身的 Push API 也有自己的計費(依 LINE 官方方案),不包含在這份月報裡。
