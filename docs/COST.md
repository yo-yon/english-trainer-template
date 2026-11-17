# Azure の費用をアプリに表示する（Cost report）

アプリの「設定」タブ →「💴 Azure の費用」に、今月と先月の Azure の費用（サービス別）を表示します。

- GitHub Actions の「Cost report」が **1日1回**（日本時間 5:37）、Azure Cost Management の Query API から費用を読み、Table に書きます。アプリはそれを表示するだけです
- サインインは **OpenID Connect（フェデレーション資格情報）** です。Azure のパスワード（クライアント シークレット）を作らないので、期限切れの更新や漏えいの心配がありません
- 付けるロールは **Cost Management Reader**（費用を見るだけ。リソースは変更できない）です
- 設定しなければ、ワークフローは何もしないで終わります

## 注意（公式の情報）

- 表示されるのは Cost Management の**推定額**です。税・クレジットは含みません。従量課金のサブスクリプションでは、反映まで最大72時間かかることがあります（Microsoft Learn「Understand Cost Management data」）
- データの更新は4時間ごとで、API の呼び出しは1日1回までが推奨です（Microsoft Learn「Manage costs with automation」）
- スポンサー プランと、従来の CSP のサブスクリプションは Cost Management に対応していません（Microsoft Learn「What is Microsoft Cost Management」）
- 新しく作ったサブスクリプションでは、使えるようになるまで最大48時間かかります

## 手順

### 1. アプリの登録を作る（Microsoft Entra ID）

1. Azure ポータルで **Microsoft Entra ID** →「アプリの登録」→「新規登録」
2. 名前は例えば `english-trainer-cost`。ほかは既定のままで登録
3. 「概要」の **アプリケーション (クライアント) ID** と **ディレクトリ (テナント) ID** を控える

### 2. GitHub Actions を信頼させる（フェデレーション資格情報）

1. 作ったアプリの「証明書とシークレット」→「フェデレーション資格情報」→「資格情報の追加」
2. シナリオで **GitHub Actions** を選ぶ
3. 組織：自分の GitHub のユーザー名、リポジトリ：このリポジトリの名前、エンティティ型：**ブランチ**、ブランチ名：`main`
4. 名前は例えば `cost-report-main` にして追加

定期実行と手動実行（Run workflow）はどちらも main ブランチで動くので、この1つで足ります。
詳しくは Microsoft Learn「Use the Azure Login action with OpenID Connect」を参照してください。

### 3. 費用を見る権限を付ける（Cost Management Reader）

費用を見たい**リソース グループ**ごとに付けます。English Trainer のリソース グループに加えて、Speech や Foundry を別のリソース グループに作った場合はそちらにも付けてください。

1. リソース グループ →「アクセス制御 (IAM)」→「追加」→「ロールの割り当ての追加」
2. ロールの検索で `Cost Management Reader` を選ぶ
3. メンバーで「ユーザー、グループ、またはサービス プリンシパル」を選び、手順1のアプリ（`english-trainer-cost`）を選んで割り当て

サブスクリプション全体の費用を見たいときは、サブスクリプションに付けても構いません（ほかのリソースの費用も合計に入ります）。

### 4. GitHub に設定する

リポジトリの Settings → Secrets and variables → Actions

**Secrets**（New repository secret）

| 名前 | 値 |
|---|---|
| `AZURE_CLIENT_ID` | 手順1のアプリケーション (クライアント) ID |
| `AZURE_TENANT_ID` | 手順1のディレクトリ (テナント) ID |
| `AZURE_SUBSCRIPTION_ID` | サブスクリプション ID |

**Variables**（Variables タブ → New repository variable）

| 名前 | 値 |
|---|---|
| `COST_SCOPES` | 費用を見る範囲。カンマ区切り。例 `/subscriptions/<サブスクリプションID>/resourceGroups/rg-english-trainer,/subscriptions/<サブスクリプションID>/resourceGroups/<Speechのリソースグループ>` |

`COST_SCOPES` を設定しないと、サブスクリプション全体の費用を取得します（その場合はロールもサブスクリプションに付けてください）。

`TABLE_ACCOUNT_URL`・`TABLE_SAS` は、週次レポートと同じものを使います（docs/FEEDBACK-LOOP.md）。

### 5. 動作確認

1. Actions →「Cost report」→「Run workflow」
2. 成功したら、アプリの「設定」タブで「表示を更新」を押す
3. 失敗したら、ログの赤いエラーと下の表を見比べる。アプリにも「最後の取得に失敗しました」と表示されます

| エラー | 主な原因 |
|---|---|
| `AADSTS700213` など、azure/login で失敗 | フェデレーション資格情報の組織・リポジトリ・ブランチ名が違う |
| `Cost Management 401` / `403` / `AuthorizationFailed` | Cost Management Reader が、その範囲に付いていない（付けてから反映まで数分かかることがある） |
| `Cost Management 400` / `404` | `COST_SCOPES` の書き方が違う、または対応していないサブスクリプションの種類 |
| `Cost Management 429` | 呼び出しが多すぎる。時間をおいて再実行 |

## 費用

- Cost Management の API の利用料金：公式の料金の記載は確認できていません（分からない）
- GitHub Actions：1回1分ほど。GitHub Free の非公開リポジトリは月2,000分まで無料（公開リポジトリは無料）
- Table への書き込み：1日1行
