# 週次の改善ループ — 仕組みと初期設定（任意）

自分の学習データとフィードバックを毎週集計し、教材の改善につなげる仕組みです。**設定しなくてもアプリは使えます。** 設定しない間は、Actions のワークフローは「シークレットが未設定のためスキップ」で終わります。

## 仕組み

```
アプリ ─👎・ご意見・発音記録─▶ 自分の Table（learning）
                                   │ ① 毎週日曜 21:17（GitHub Actions「Weekly report」）
                                   ▼
          reports ブランチの reports/ に週次レポートを書き出す（latest.md / latest.json / 日付.md）
                                   │ ② 毎週月曜 早朝（任意：Claude の定期タスク。指示文の雛形は CLAUDE-TASK.md）
                                   ▼
             改善案をプルリクエストで作成（本文に Fixes-feedback: <ID>）
                                   │ ③ オーナーが確認して取り込む
                                   ▼
  本番に自動デプロイ ＋ ④ 教材を Table に反映（Sync content） ＋ ⑤ 対応したフィードバックを「対応済み」に（Close feedback）
```

| ワークフロー | いつ動くか | やること | 必要な権限 |
|---|---|---|---|
| Weekly report | 毎週日曜 21:17（日本時間）／手動 | 未対応のフィードバック、直近7日の学習量・点数の低い文・苦手な音素・つまずいた単語を集計 | 読み取り |
| Sync content | `src/seed/words.json`・`sentences.json` が main に入ったとき／手動 | 単語と文を Table に反映（復習状態・設定・記録には触れない） | 追加・更新 |
| Close feedback | プルリクエストを取り込んだとき（本文に `Fixes-feedback:` がある場合だけ） | そのフィードバックを「対応済み」にする | 読み取り・更新 |

- レポートは `reports` ブランチに書くので、本番のデプロイ（main への push）は起きません
- 週次レポートには、メールアドレスやユーザー ID は含まれません（Table に保存していないため）

## 初期設定（最初に1回だけ・約15分）

### 1. テーブル専用のキー（SAS）を発行する

ストレージの接続文字列（全権限）ではなく、**テーブル `learning` だけ・読み取り／追加／更新だけ・期限付き**のキーを GitHub に渡します。

1. Azure ポータル上部の **Cloud Shell** アイコン（`>_`）を選び、**Bash** を選ぶ
   - 初回の「作業の開始」画面では **ストレージ アカウントは不要**（No storage account required）を選び、サブスクリプションに使うサブスクリプションを選んで **適用**（公式の手順）
   - 開かない場合は、サブスクリプションでリソース プロバイダー **Microsoft.CloudShell** の登録が必要なことがあります（公式）
2. ストレージがあるサブスクリプションに切り替え、ストレージが見えることを確認する
   - Cloud Shell は既定のサブスクリプションで動くため、別のサブスクリプションを見ていると「Storage account ... not found」になります

   `<サブスクリプション ID>` と `<ストレージアカウント名>` は自分のものに置き換えてください（サブスクリプション ID は、Azure ポータルの「サブスクリプション」で確認できます）

   ```bash
   SUB="<サブスクリプション ID>"
   ST="<ストレージアカウント名>"
   az account set --subscription "$SUB"
   az storage account show -n "$ST" -g rg-english-trainer --query name -o tsv
   ```

   ストレージアカウント名が表示されれば OK

3. 同じ画面で、次のコマンドを貼り付けて実行する（有効期限は1年後）

   ```bash
   az storage table generate-sas \
     --account-name "$ST" \
     --name learning \
     --permissions rau \
     --expiry "$(date -u -d '+1 year' +%Y-%m-%dT00:00Z)" \
     --https-only \
     --output tsv
   ```

   - `rau` は r=読み取り、a=追加、u=更新。削除（d）は付けません
   - キーの取得はサインイン中のアカウントで自動的に行われます。最初に出る「There are no credentials provided…」は、その案内なので問題ありません
4. 表示された1行の文字列（`se=...&sp=rau&...&sig=...` のような形）をコピーする
   - パスワードと同じ扱いです。チャットやファイルには貼らないでください

✅ 確認：出力に `sp=rau` が含まれている

### 2. GitHub のシークレットに登録する

1. GitHub の自分のリポジトリ →**Settings** →**Secrets and variables** →**Actions**
2. **New repository secret** で次の2つを登録する

   | Name | Secret |
   |---|---|
   | `TABLE_ACCOUNT_URL` | `https://<ストレージアカウント名>.table.core.windows.net` |
   | `TABLE_SAS` | 手順1でコピーした文字列 |

✅ 確認：Repository secrets に2つの名前が並んでいる

### 3. 動作を確かめる

1. **Actions** タブ →左の **Weekly report** →**Run workflow** →**Run workflow**
2. 緑のチェックになったら、ブランチを `reports` に切り替えて `reports/latest.md` を開く
3. **Actions** →**Sync content** →**Run workflow**（教材が Table に反映されることの確認）

うまくいかないとき：

| 表示 | 確認すること |
|---|---|
| シークレット TABLE_ACCOUNT_URL と TABLE_SAS が設定されていません | 手順2の名前のつづり |
| アクセスが拒否されました | SAS の権限（`sp=rau`）、有効期限、URL のストレージアカウント名 |

## 運用

- **毎週月曜**（Claude の定期タスクを使う場合）：Claude が作ったプルリクエストを確認して取り込む。不要な案は閉じるか、コメントで直してほしい点を書く
- **使わない場合**：`reports` ブランチの `reports/latest.md` を自分で読み、教材（`src/seed/`）を直して main に入れれば、Sync content が反映します
- **SAS の有効期限が近づいたら**：手順1・2をやり直して `TABLE_SAS` を上書きする（期限切れになると Weekly report が「アクセスが拒否されました」で失敗します）
- 手でプルリクエストを作るときも、本文に `Fixes-feedback: <ID>, <ID>` と書けば、取り込み時に「対応済み」になります（ID は週次レポートの表にあります）
- プルリクエスト以外で対応した場合は、Actions →**Close feedback** →**Run workflow** で ID を入力すると「対応済み」にできます

## 参考（公式）

- [Get started with Azure Cloud Shell ephemeral sessions](https://learn.microsoft.com/azure/cloud-shell/get-started/ephemeral)
- [az storage table generate-sas](https://learn.microsoft.com/cli/azure/storage/table#az-storage-table-generate-sas)
- [Secure your Azure Table Storage（必要な操作だけを SAS で許可する）](https://learn.microsoft.com/azure/storage/tables/secure-tables#identity-and-access-management)
- [Events that trigger workflows（schedule）- GitHub Docs](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
