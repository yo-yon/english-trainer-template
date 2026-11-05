# テンプレートの更新を取り込む

GitHub のテンプレートから作ったリポジトリは、元のテンプレートと履歴がつながっていません（GitHub の仕様）。そのため、フォークの「Sync fork」のようなボタンはありません。更新は次のどちらかの方法で取り込みます。

何が変わったかは、テンプレートの [CHANGELOG.md](../CHANGELOG.md) に書いてあります。

## 方法1：変わったファイルだけ手で直す（かんたん）

1. テンプレートの CHANGELOG.md で、変わったファイルを確認する
2. テンプレート側のそのファイルを開き、内容をコピーする
3. 自分のリポジトリで同じファイルを開き、鉛筆アイコン（Edit）で貼り替えて **Commit changes**
4. main に入ると自動でデプロイされる

- `src/seed/words.json`・`sentences.json`（教材）を自分で直している場合は、貼り替えると自分の直しが消えます。必要な行だけ足してください

## 方法2：git でまとめて取り込む（PC に Git がある人向け）

最初の1回だけ、自分のリポジトリとテンプレートを「つなぐ」作業をします。2回目からは、最後の2行だけで取り込めます。

```bash
cd english-trainer   # 自分のリポジトリを clone したフォルダー
git remote add template https://github.com/yo-yon/english-trainer-template.git
git fetch template

# --- 最初の1回だけ ---
# 自分のリポジトリを作った時点のテンプレートのコミットを、「取り込み済み」として記録する（ファイルは変わらない）
# <作成日時> は自分のリポジトリを作った日時（例：2026-11-10 21:00）。リポジトリの最初のコミットの日時で分かる
base=$(git log template/main --before="<作成日時>" -1 --format=%H)
git merge --allow-unrelated-histories -s ours "$base" -m "テンプレートとつなぐ"

# --- 毎回 ---
git fetch template
git merge template/main -m "テンプレートの更新を取り込む"
git push
```

- 自分で直したファイルと、テンプレートの更新が同じ場所を変えていると、「CONFLICT」と表示されます。表示されたファイルを開いて、`<<<<<<<` から `>>>>>>>` の間を、残したい内容に直してから `git add .` →`git commit` →`git push` してください
- Azure が追加したデプロイ用のファイル（`.github/workflows/azure-static-web-apps-*.yml`）は、テンプレートには入っていないので、そのまま残ります
