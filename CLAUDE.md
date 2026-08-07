# AutoOps — 作業ガイド

これは **`autoops/CLAUDE.md`** — このリポジトリ専用のファイルです。
`~/.claude/CLAUDE.md`(全プロジェクト共通の個人設定)は別に存在し、**そちらも同時に適用されます**。
片方だけでは足りません。

**着手する前に、この順で確認してください。**

1. **[README.md](./README.md) を読む** — 設計・アーキテクチャ・Backlog・環境変数は
   すべてそちらが唯一の情報源で、このファイルには書いてありません。
2. **`git log --oneline -10` と `git status` を確認する** — 前のセッションが未コミットの
   変更を残していることがあります。**clean でなければ、まず何が残っているかを報告する。**
   その上に新しい作業を積まない。

ここにあるのは README に書かれていないこと — 進め方と、蒸し返さない決定 — だけです。

## 進め方

1. **調査 → 設計提案 → 承認 → 実装 → commit 前報告 → 承認 → commit / push**
   この順序を飛ばさない。調査フェーズではコードを変更しない。
2. **commit / push は必ず承認を取ってから。** 報告には変更ファイル一覧・変更理由・影響範囲・検証結果・未解決事項を含める。
3. **実測と推測を分けて書く。** 確認していないことを「動作確認済み」と言わない。検証できなかった項目は明示する。
4. 実装後は毎回:
   `pnpm test` / `pnpm lint` / `pnpm exec tsc --noEmit` / `pnpm build`
5. **迎合より一貫性。** 指示が既存の設計判断と矛盾する場合は、実装せずに先に矛盾を報告する。
   「一般的だから」「将来必要そうだから」は採用理由にならない。
6. スコープを勝手に広げない。ただし変更によって**事実と異なる記述が生まれた場合、その修正は同じ変更に含める**。

## 検証のしかた

- スケジュール計算(`lib/schedule.ts`)は純粋関数なので Vitest で検証できる。
  **それ以外(claim / catch-up / 失敗分離)は実 DB と実 cron が必要で、CI では検証されない。**
  CI が緑でも「全部動く」とは言えない。
- 変更の効果は**変更前後で実測して比較する**。`git stash` で旧コードに戻して測り、
  復元後に差分の md5 が一致することを確認する。
- 検証用データは必ず削除する(`User` 行は実アカウントなので残す)。
- 障害を再現したいときは PostgreSQL のトリガで注入できる。使い終わったら `DROP` する。

## 環境の癖

- **`pnpm dev` 実行中に `pnpm build` すると `.next` が壊れる。** 先に dev を止める。
  壊れたら `rm -rf .next`。
- `TaskStop` では Node の子プロセスが残ることがある。ポート 3000 / 3001 を確認して落とす。
- Docker Desktop は停止していることが多い。`docker` の実体は
  `~/AppData/Local/Programs/DockerDesktop/resources/bin/docker`。
- **`.env` と `.env.example` は Read / Bash で権限拒否される。**
  編集が必要なら PowerShell の `System.IO.File`(BOM 保持に注意)か、ユーザーに依頼する。
- `.env.example` は先頭に **UTF-8 BOM** があり、末尾に改行がない。grep が1行目を取りこぼす。
- ファイル削除は許可制。削除せず `削除用/` へ移動する(自分がその場で作った中間ファイルは除く)。

## 決定済み — 蒸し返さない

| 決定 | 理由 |
|---|---|
| `version` カラムによる Optimistic Locking は**入れない** | 実害は `nextRunAt` の1点のみで、それは「変えないものは書かない」で解決済み。複数人編集(Team Workspaces)まで保留 |
| Catch-up は**案B**(取りこぼしは1回で復帰、backlog は再実行しない) | 過去スロットを再実行しても `{{today}}` は実行時に解決され、同じ結果が複数回できるだけ |
| claim 後の失敗は**スロットを消費する** | 二重実行より取りこぼしが安全。実行は課金と副作用を伴う |
| 実行失敗を cron レスポンスに載せ**ない** | 実キュー導入後は `enqueueRoutine` が RunHistory を返さなくなり、成立しなくなる |
| `lib/repositories/` を**新設しない** | `routines.ts` / `runs.ts` / `users.ts` / `scheduler.ts` が既に Repository。二重化になる |
| dispatcher は retry 方針を**持たない** | Sprint 25 で SDK 側の暗黙リトライも `maxRetries: 0` で無効化済み |
| Cloudflare Workers は**採用しない** | `pg` が Node の `net` を要求するため現構成では動かない |
| 「stuck」は `RunHistory.status` の値では**ない** | `status` は `running`/`completed`/`failed` のまま変えない。`running` が長時間続いている状態は表示側(`lib/health.ts`)が `startedAt` と現在時刻から都度導出する派生状態。本当に実行中のケースと区別がつかないため、断定的な表現(「stuck」「failed」)ではなく "Running for longer than expected" と表示する |
| stuck検知は Prisma schema 変更**なし**で実現する | `WorkerHealth.stuck` は読み取り時の計算のみ。DBに新しいカラム・ステータス値・バッチ処理を追加しない。Sprint 31 Day 2の監視設計調査で「UIだけで対応可能」と判断した方針をそのまま採用 |
| Scheduled overdue detection uses existing `nextRunAt` data. It is a derived UI state and does not represent Cron service failure. No schema change is required | `nextRunAt`はclaim成功時にのみ前進する(手動実行では動かない)ため、activeワーカーの`nextRunAt`が過去のままという事実だけは既存データから安全に読み取れる。ただし「なぜ」claimされていないか(Cron停止・claim失敗・直前に成功等)は区別できないため、UI文言は原因を断定しない("overdue"のみ) |

## 現在地

**ここに commit hash は書きません** — このファイル自体が git 管理下にあるため、書いた瞬間に1つ古くなります。
進捗の実際は git が持っています(冒頭の手順2)。

### Sprint 28 — Railway への初回デプロイ、完了

構成は **Web Service + Cron Service + PostgreSQL**(Railway)。詳細は README の
Roadmap / Backlog(Deployment)を参照。

実測で確認・解消済み:

- `AUTH_URL` を本番ドメインに設定し、Google サインインを本番で実測確認した。
- `prisma migrate deploy && next start` を Web Service の Start Command に設定し、
  マイグレーションが正常に適用されることを確認した。`package.json` は変更していない。
- `prisma` が devDependency のままでも問題ないことを確認した。Railway のビルドは
  devDependencies を含めてインストールするため、`postinstall`(`prisma generate`)は
  成功する。
- pnpm のバージョンを `package.json` の `packageManager` で固定した(実際に固定なしで
  ビルドが失敗し、修正した)。
- Cron Service(Dockerイメージ直接指定)は Start Command が exec form で実行され、
  `$CRON_SECRET` が展開されないという Railway 固有の落とし穴があった。
  `/bin/sh -c "..."` でシェルを明示的に挟んで解消した。
- E2E(Routine作成 → Cron dispatch → RunHistory / Worker Health / Dashboard 反映)を
  実測確認した。

未着手:

- デプロイ後の監視(HTTP ≠ 200 / `failed > 0` / `dispatched` が常時 0)は、
  仕組みとしてはまだ設定していない。今回は手動でログを確認しただけ。
  **AI 実行の失敗はレスポンスに現れない**(README の Cron API 参照)。

> このセクションは作業が進むたびに古くなります。スプリント完了時に更新してください。
