# English Trainer — Azure 構築手順

所要時間の目安：60〜90分（初めての場合）。PC のブラウザで進めてください。**PC にソフトを入れる必要はありません**（GitHub と Azure ポータルの画面だけで進められます）。

- このアプリは、**あなた自身の Azure** に構築して、あなた1人で使う前提です。費用もあなたのサブスクリプションにかかります（手順0）
- 会社の Azure・Microsoft アカウントで構築する場合は、先に README の「会社の環境で使うとき」を読んでください

- 各手順の最後にある **「✅ 確認」** ができてから、次の手順に進んでください
- **「控える」** と書いた値は、手順8でまとめて使います。下の「控えメモ」にメモしながら進めると楽です
- キーや接続文字列はパスワードと同じです。チャットやメール、GitHub のファイルには貼らないでください

## 控えメモ（手順の途中で埋める）

| # | 項目 | 控える手順 | 例 |
|---|---|---|---|
| A | ストレージの接続文字列 | 手順4 | `DefaultEndpointsProtocol=https;AccountName=...` |
| B | Speech のキー | 手順5 | 英数字32文字程度 |
| C | Speech のリージョン | 手順5 | `japaneast` |
| D | Foundry のエンドポイント（任意。会話タブに必要） | 手順6 | `https://<リソース名>.openai.azure.com` |
| E | Foundry のキー（任意。会話タブに必要） | 手順6 | 英数字 |
| F | gpt-5.4-mini のデプロイ名（任意。会話タブに必要） | 手順6 | `gpt-5.4-mini` |
| G | サイトの URL | 手順7 | `https://xxxx-xxxx-xxxx.azurestaticapps.net` |

---

## 0. 全体像と費用

| リソース | プラン | 用途 | 月額の見込み |
|---|---|---|---|
| リソースグループ `rg-english-trainer` | — | まとめて管理・削除するための入れ物 | 0円 |
| ストレージアカウント | Standard / LRS | 単語・文・復習状態・発音記録・フィードバック | ごく少額（単価は未確認） |
| Speech | **Free (F0)** / Japan East | 発音評価・お手本の読み上げ・会話と瞬間作文の音声認識 | 0円（無料枠内） |
| Static Web Apps | **Free** | 画面と API | 0円 |
| Foundry（任意） | gpt-5.4-mini を Global Standard でデプロイ | 会話ロールプレイ（相手役・振り返り・言いたいことのヒント・訳）、瞬間作文とクイズの判定 | 使った分だけ（単価は未確認）。会話は1日60回、瞬間作文の判定は1日100回までに制限（手順8で変更可） |

- 料金は変わることがあります。最新の料金は、各サービスの公式料金ページで確認してください
- Speech は無料のプラン（F0）で作る前提です。F0 は月の無料枠を使い切ると、課金されるのではなく、翌月まで使えなくなります（Microsoft Q&A の回答による。公式ドキュメントでは未確認）。S0 は従量課金です
- Speech F0 の音声認識の無料枠（月5時間）は、シャドーイング・単語の発音練習・会話・瞬間作文で共通です。1日30分の使い方なら、話している時間は枠に収まる見込みです
- AI（Foundry）の1回の応答は、会話の返事で最大700トークン、振り返りで最大1,500トークン、判定で最大400トークンに抑えています
- 予算アラート（手順12）を設定しておくと、想定外の課金にすぐ気づけます

## 1. 事前に用意するもの

- [ ] Azure サブスクリプション（ポータル https://portal.azure.com にサインインできること）
- [ ] GitHub アカウント（無料で作れます）
- [ ] アプリにサインインするときに使う **Microsoft アカウントのメールアドレス**（手順9の招待で使う）

---

## 2. テンプレートから自分のリポジトリを作る

1. https://github.com/yo-yon/english-trainer-template を開き、右上の **Use this template** →**Create a new repository** を選ぶ
2. 次のとおり入力する

   | 項目 | 値 |
   |---|---|
   | Include all branches | **チェックしない** |
   | Owner | 自分の GitHub ユーザー名 |
   | Repository name | `english-trainer` |
   | 公開範囲 | **Private**（おすすめ。学習の記録は Azure 側に保存され、リポジトリには入りませんが、自分用の設定を書き込むことがあるため） |

3. **Create repository** を選ぶ

- テンプレートから作ったリポジトリは、元のリポジトリと履歴がつながっていません。更新を取り込む方法は [docs/UPDATING.md](docs/UPDATING.md) にあります

✅ 確認：自分のアカウントに `english-trainer` ができ、`src`、`api`、`README.md`、`SETUP.md` が表示される。`src` の中に `staticwebapp.config.json` がある

---

## 3. リソースグループを作る

1. Azure ポータル上部の検索欄に「リソース グループ」と入力して開く
2. **＋ 作成** を選ぶ
3. 次のとおり入力する

   | 項目 | 値 |
   |---|---|
   | サブスクリプション | 使うサブスクリプション |
   | リソースグループ | `rg-english-trainer` |
   | リージョン | **Japan East（東日本）** |

4. **確認および作成** →**作成**

✅ 確認：リソースグループの一覧に `rg-english-trainer` が出る

---

## 4. ストレージアカウントを作る（データの保存先）

### 4-1. 作成

1. 検索欄に「ストレージ アカウント」と入力して開き、**＋ 作成** を選ぶ
2. 「基本」タブを次のとおり入力する

   | 項目 | 値 |
   |---|---|
   | リソースグループ | `rg-english-trainer` |
   | ストレージアカウント名 | 例：`stenglishtrainer` ＋自分用の数字（**英小文字と数字のみ・3〜24文字・世界で重複不可**） |
   | リージョン | Japan East |
   | プライマリ サービス（優先するストレージの種類） | **テーブル**（「その他（テーブルとキュー）」と表示される場合もある）。作成画面の案内が変わるだけで、ほかのサービスも使える |
   | パフォーマンス | **Standard** |
   | 冗長性 | **ローカル冗長ストレージ (LRS)** |

3. ほかのタブは既定のままで、**確認および作成** →**作成**
4. 完了したら **リソースに移動**

### 4-2. 接続文字列を控える

1. 左のメニューの **セキュリティとネットワーク** →**アクセス キー** を開く
2. **キーの表示** を選ぶ
3. **key1** の **接続文字列** の右にあるコピーボタンでコピーし、**控えメモ A** に貼る

- テーブル（`learning`）は、アプリが初めてデータを保存するときに自動で作られます。ここで作る必要はありません

✅ 確認：控えメモ A が `DefaultEndpointsProtocol=https;AccountName=` で始まっている

---

## 5. Speech リソースを作る（発音評価と読み上げ）

### 5-1. 作成

1. 検索欄に「Speech」と入力し、「サービス」の中の **音声サービス**（キーワード：Speech Services）を選んで **＋ 作成**
   - **Microsoft Foundry は選ばないでください**。Foundry リソースは価格レベルを選ぶ画面がなく、S0（従量課金）で作られるという報告があります（Microsoft Q&A の回答。公式ドキュメントでは未確認）
2. 次のとおり入力する

   | 項目 | 値 |
   |---|---|
   | リソースグループ | `rg-english-trainer` |
   | リージョン | **Japan East** |
   | 名前 | 例：`speech-english-trainer` ＋自分用の数字 |
   | 価格レベル | **Free F0** |

3. **確認および作成** →**作成** →完了したら **リソースに移動**

> ⚠️ **価格レベルに Free F0 が出てこない場合は、いったん止めてください。** 有料（S0）で作ると従量課金になり、月額の見込みが変わります。手順の「音声サービス」を選んでいるか（Foundry ではないか）を確認してください。すでに同じサブスクリプションに F0 の Speech がある場合は、それを使えます（手順5-2 だけ行う）。

### 5-2. キーとリージョンを控える

1. 左のメニューの **リソース管理** →**キーとエンドポイント** を開く（画面によっては「概要」にあります）
2. **キー 1** をコピーして **控えメモ B** に貼る
3. **場所/リージョン** の値（`japaneast`）を **控えメモ C** に書く

✅ 確認：B と C が埋まっている。C は表示名の「Japan East」ではなく、**小文字・スペースなしの `japaneast`**

---

## 6. Foundry（gpt-5.4-mini）を用意する（任意）

次の機能で使います。**飛ばしても、単語・シャドーイング・ディクテーション・苦手な音などは動きます**。

| 機能 | Foundry が無いとき |
|---|---|
| 会話タブ（場面別のロールプレイ・振り返り・フレーズ帳への追加） | **使えません**（「AI の設定がない」と表示） |
| 練習タブの瞬間作文・今週のまとめの判定 | お手本とほぼ同じなら自動で正解。それ以外は自分で判定 |
| 練習タブのクイズ「意味を答える」 | 自分で正誤を判定 |

すでに gpt-5.4-mini をデプロイした Foundry リソースがあれば、6-1 を飛ばして 6-2 に進んでください。

### 6-1. プロジェクトを作ってモデルをデプロイする

公式のクイックスタート（[Set up Microsoft Foundry resources](https://learn.microsoft.com/azure/foundry/tutorials/quickstart-create-foundry-resources)）の手順です。

1. https://ai.azure.com にサインインし、**New Foundry** の切り替えがオンになっていることを確認する
2. **Create a new project**（新しいプロジェクトを作成）を選び、名前（例：`english-trainer`）を入れる
3. **Advanced options** で、リソースグループに `rg-english-trainer`、場所に近いリージョンを選び、**Create project**
4. 右上の **Build** →左の **Models** →**Deploy** →**Deploy a base model**
5. **gpt-5.4-mini** を検索し、**Deploy** →**Default settings**
6. 表示されたデプロイ名（例：`gpt-5.4-mini`）を **控えメモ F** に書く

- 選んだリージョンでモデルが選べない場合は、別のリージョンでプロジェクトを作ります。リージョンごとの対応は [Region availability](https://learn.microsoft.com/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure-region-availability) にあります

### 6-2. エンドポイントとキーを控える

1. Azure ポータルで、6-1 で作られた Foundry リソース（リソースグループ `rg-english-trainer` の中）を開く
2. **キーとエンドポイント** を開く
3. エンドポイントを **控えメモ D** に書く
   - `https://<リソース名>.openai.azure.com` または `https://<リソース名>.services.ai.azure.com` の形
   - 末尾の `/` や `/openai/...`、`/api/projects/...` は付けない
4. **キー 1** を **控えメモ E** に貼る

✅ 確認：D・E・F が埋まっている（手順6を飛ばす場合は空欄のまま）

---

## 7. Static Web Apps を作る（画面と API）

### 7-1. 作成

1. 検索欄に「Static Web Apps」と入力し、「サービス」の中の **静的 Web アプリ**（キーワード：Azure Static Web Apps）を選んで **＋ 作成**
   - 「App Services」は別のサービスなので選ばない
2. 「基本」タブを次のとおり入力する

   | 項目 | 値 |
   |---|---|
   | リソースグループ | `rg-english-trainer` |
   | 名前 | `english-trainer` |
   | プランの種類 | **Free** |
   | Azure Functions とステージングの詳細（表示された場合） | 一覧から選ぶ（Japan East が無ければ **East Asia**） |
   | ソース | **GitHub** |

3. **GitHub アカウントでサインイン** を選び、Azure Static Web Apps へのアクセスを許可する
4. リポジトリ情報を選ぶ

   | 項目 | 値 |
   |---|---|
   | 組織 | 自分の GitHub ユーザー名 |
   | リポジトリ | `english-trainer` |
   | 分岐（ブランチ） | `main` |

   - リポジトリが一覧に出ない場合（公式の対処）：GitHub の **Settings →Applications →Authorized OAuth Apps** で **Azure Static Web Apps** を選び、**Grant** を押してから選び直す

5. 「ビルドの詳細」を次のとおり入力する（**ここを間違えると動きません**）

   | 項目 | 値 |
   |---|---|
   | ビルドのプリセット | **Custom** |
   | アプリの場所 | `src` |
   | API の場所 | `api` |
   | 出力先 | **空欄のまま** |

6. **確認および作成** →**作成** →完了したら **リソースに移動**

### 7-2. 最初のデプロイが終わるのを待つ

1. 作成すると、Azure が GitHub のリポジトリに **デプロイ用の設定ファイル（`.github/workflows/azure-static-web-apps-....yml`）を自動で追加** し、デプロイが始まります
2. GitHub のリポジトリ →**Actions** タブを開き、一番上の実行が **緑のチェック** になるまで待つ（数分）
3. Azure ポータルの Static Web Apps の **概要** にある **URL** を **控えメモ G** に書く

- 赤い × になった場合は、失敗した実行を開き、赤くなっている行のメッセージを教えてください
- PC でファイルを直して push する場合は、その前に **`git pull` を1回実行** してください（Azure が追加した設定ファイルを取り込むため）。GitHub の画面で直す場合は不要です

✅ 確認：Actions が緑のチェック。URL を開くと、Microsoft のサインイン画面に移動する（まだ中には入れなくて正常です）

---

## 8. 環境変数（キー類）を登録する

1. Static Web Apps の左のメニューの **設定** →**環境変数** を開く
2. 環境が **運用（Production）** になっていることを確認する
3. **＋ 追加** で、次の6つを1つずつ登録する（名前は**大文字・小文字も含めて正確に**。手順6を飛ばした場合は、`FOUNDRY_` で始まる3つは不要）

   | 名前 | 値 |
   |---|---|
   | `STORAGE_CONNECTION_STRING` | 控えメモ A |
   | `SPEECH_KEY` | 控えメモ B |
   | `SPEECH_REGION` | 控えメモ C（`japaneast`） |
   | `FOUNDRY_ENDPOINT` | 控えメモ D |
   | `FOUNDRY_API_KEY` | 控えメモ E |
   | `FOUNDRY_DEPLOYMENT` | 控えメモ F |

   任意：読み上げの声を変えたい場合だけ `TTS_VOICE` を追加（未設定なら女性の `en-US-AvaNeural`）

   任意：会話ロールプレイの1日の上限回数を変えたい場合だけ `ROLEPLAY_DAILY_LIMIT` を追加（未設定なら 60。AI の利用料の使いすぎ防止）

   任意：瞬間作文の AI 判定の1日の上限回数を変えたい場合だけ `COMPOSE_DAILY_LIMIT` を追加（未設定なら 100）

   任意：フレーズ帳の訳を AI で後から付ける1日の上限回数を変えたい場合だけ `TRANSLATE_DAILY_LIMIT` を追加（未設定なら 100。1件につき1回だけ呼びます）

   任意：アプリの作者にフィードバックを届けて改善に協力してくれる場合は、`FEEDBACK_HUB_URL` を追加します。値は次のとおりです。

   ```
   https://black-wave-0080aa600.4.azurestaticapps.net/api/collect
   ```

   - **未設定なら、この機能は表示されず、何も送られません**
   - 設定しても、送るのは **あなたが「作者にも送る」を選んだフィードバックだけ** です（初期設定は送らない）。送る内容と送らない内容は README の「フィードバックの扱い」にあります

   > 接続文字列は、ポータルに貼り付けるときに崩れることがあります。「データを読み込めませんでした」が直らないときは、Cloud Shell（ポータル上部の `>_`）で次のように直接入れると確実です。
   >
   > ```bash
   > conn=$(az storage account show-connection-string -n <ストレージアカウント名> -g rg-english-trainer --query connectionString -o tsv)
   > az staticwebapp appsettings set -n english-trainer -g rg-english-trainer --setting-names STORAGE_CONNECTION_STRING="$conn" --query "keys(properties)" -o tsv
   > ```

4. 最後に画面下の **適用** を押して保存する（追加ごとの「適用」と、最後の「適用」の2回が必要です）

✅ 確認：一覧に6つの名前が並んでいる。値の前後に空白が入っていない

---

## 9. 自分だけに `owner` ロールを付ける（招待）

このアプリは全ページが `owner` ロール限定です。この手順をしないと、自分も中に入れません。

1. Static Web Apps の左のメニューの **設定** →**ロール管理** を開く
2. **招待** を選び、次のとおり入力する

   | 項目 | 値 |
   |---|---|
   | 認証プロバイダー | **Microsoft Entra ID**（GitHub はアプリ側でブロック済み） |
   | 招待先の詳細 | サインインに使う Microsoft アカウントの**メールアドレス** |
   | ドメイン | 既定のドメイン（控えメモ G と同じもの） |
   | ロール | `owner`（小文字） |
   | 有効期限（時間） | `24`（最大168） |

3. **生成** を選び、表示された **招待リンク** をコピーする
4. 招待リンクを、**サインインに使うのと同じブラウザ** で開き、そのアカウントでサインインする
   - 会社と個人など複数の Microsoft アカウントを使っている場合は、シークレットウィンドウで開くと取り違えを防げます

✅ 確認：ロール管理の一覧に自分が表示され、ロールが `anonymous, authenticated, owner` などになっている

---

## 10. アプリを開いて初期データを取り込む

1. 控えメモ G の URL を開く（サインインを求められたら、手順9と同じアカウントで）
2. 画面上部の **一覧** タブ →一番下の **データ管理** を開く
3. **初期データを取り込む** を選ぶ
4. 「取り込みました：単語20語、文30文」と表示されれば完了

✅ 確認：**単語** タブで、新しい単語が表示される

---

## 11. 動作確認チェックリスト

PC で：

- [ ] **単語**：「答えを見る」→評価ボタンを押すと、次の単語に進む
- [ ] **読み上げ**：「発音を聞く」で女性のニューラル音声が流れる。画面上部に「ブラウザの読み上げで代わりに再生」と出ないこと
- [ ] **シャドーイング**：「話す」→マイクの使用を許可 →言い終わったら「■ 話し終わった」→点数と単語の色分け、総評が出る
- [ ] **会話**：場面を1つ選び、2〜3回やり取りする →「訳を見る」で相手の発言の訳が出る →終えると振り返りが出る（手順6を飛ばした場合は「AI の設定がない」と出るのが正常）
- [ ] **練習**：「瞬間作文」で日本語を見て英語で話すと判定が出る。「ディクテーション」で音声が流れ、書き取りの答え合わせができる
- [ ] **クイズ**（練習タブ）：「意味を答える」で日本語を入力すると、AI の判定とコメントが返る（手順6を飛ばした場合は、自分で正誤を選ぶ画面になる）
- [ ] **フィードバック**：「ご意見・要望」から送った内容が、**一覧 →送ったフィードバック** に出る
- [ ] **自分だけ**：シークレットウィンドウで別の Microsoft アカウントでサインインすると、「このアカウントではアクセスできません」になる

スマホで：

- [ ] 同じ URL を開いてサインインし、PC と同じ学習状況が見える（ホーム画面に追加しておくと便利です）
- [ ] シャドーイングでマイクが使える

---

## 12.（任意・推奨）予算アラート

想定外の課金にすぐ気づけるようにします。予算を作ること自体は無料です。

1. 検索欄に「コストの管理と請求」と入力して開き、**コスト管理** →**予算** を開く
2. スコープがこのサブスクリプション（または `rg-english-trainer`）になっていることを確認して **＋ 追加**
3. 名前（例：`english-trainer-monthly`）、リセット期間 **毎月**、金額（例：`500` 円）を入力して **次へ**
4. アラートの条件を「実際の金額」**80%** などにし、通知先のメールアドレスを入力して **作成**

- サブスクリプションの種類によっては、ポータルから予算を作れない場合があります（公式）。その場合は教えてください

---

## 困ったとき

| 症状 | 確認すること |
|---|---|
| サインイン後に「アクセスできません」 | 手順9の招待を、サインインと同じアカウントで受けたか。ロール名が `owner`（小文字）か |
| 誰でも中に入れてしまう | `src/staticwebapp.config.json` があるか。手順7の「アプリの場所」が `src` か |
| 画面は出るが「データを読み込めませんでした」 | `STORAGE_CONNECTION_STRING`。手順8の最後の「適用」を押したか |
| 「評価できませんでした」 | `SPEECH_KEY` / `SPEECH_REGION`。F0 は同時に1件までなので、連打していないか |
| 読み上げがブラウザの声になる | `SPEECH_KEY` / `SPEECH_REGION`。F0 は60秒あたり20回までなので、短時間に新しい音声を続けて鳴らすと一時的に切り替わる |
| クイズや瞬間作文が「自分で判定」になる・会話で「AI の設定がない」と出る | `FOUNDRY_ENDPOINT` / `FOUNDRY_API_KEY` / `FOUNDRY_DEPLOYMENT` |
| 会話で「今日の会話の上限に達しました」と出る | `ROLEPLAY_DAILY_LIMIT`（既定 60回／日。日本時間の0時に戻る） |
| 録音が止まらない・点数が出ない | 「■ 話し終わった」を押す。聞き取れないときは「一覧」→**音声の診断情報** を開き、声の音量・前後の無音・音割れを確認。マイクの感度も同じ場所で変えられる |
| マイクが使えない | ブラウザのサイト設定でマイクを許可。スマホは OS の設定でブラウザのマイク許可も確認 |
| push すると拒否される | 先に `git pull` を実行（Azure が追加した設定ファイルを取り込む） |
| サインインで「管理者の承認が必要」と出る | 会社のテナントで、利用者によるアプリの同意が止められています。README の「会社の環境で使うとき」を参照 |

どの手順でも、つまずいたら **手順の番号と、画面に表示されたメッセージ** を控えておくと、調べるときや人に聞くときに役立ちます。キーや接続文字列は、人に見せないでください。

## やめるとき（片付け）

Azure ポータルでリソースグループ `rg-english-trainer` を開き、**リソース グループの削除** を選ぶと、この手順で作ったものがまとめて消え、以降の課金も止まります。学習の記録も消えます。

## 参考（公式ドキュメント）

- [Quickstart: Build your first static web app（Azure ポータル）](https://learn.microsoft.com/azure/static-web-apps/get-started-portal)
- [Build configuration（app_location / output_location）](https://learn.microsoft.com/azure/static-web-apps/build-configuration)
- [Configure Azure Static Web Apps（設定ファイルの置き場所）](https://learn.microsoft.com/azure/static-web-apps/configuration)
- [Configure application settings（環境変数）](https://learn.microsoft.com/azure/static-web-apps/application-settings)
- [Custom authentication（ロール管理・招待）](https://learn.microsoft.com/azure/static-web-apps/authentication-custom#manage-roles)
- [Manage storage account access keys（接続文字列）](https://learn.microsoft.com/azure/storage/common/storage-account-keys-manage#view-account-access-keys)
- [Quotas and limits for Azure Speech](https://learn.microsoft.com/azure/ai-services/speech-service/speech-services-quotas-and-limits)
- [Quickstart: Set up Microsoft Foundry resources](https://learn.microsoft.com/azure/foundry/tutorials/quickstart-create-foundry-resources)
- [Authenticate and authorize Static Web Apps（既定の Entra ID サインイン）](https://learn.microsoft.com/azure/static-web-apps/authentication-authorization)
- [Tutorial: Create and manage budgets](https://learn.microsoft.com/azure/cost-management-billing/costs/tutorial-acm-create-budgets)
