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

- 純粋関数(`lib/schedule.ts` / `lib/health.ts` / `lib/overview.ts`)は Vitest で
  そのまま検証できる。`lib/scheduler.ts` と `lib/dispatcher.ts` も Sprint 38 から
  検証できる — `server-only` の alias(下の Sprint 38 の節)と `vi.mock` で、
  **依存も DB も足さずに**届くようになった。
- **ただし届くのは「どう振る舞うか」までで、「本当に排他できているか」ではない。**
  `claimRoutineSlot` が atomic であること、catch-up が実データでどう動くかは
  実 DB と実 cron が要り、**CI では検証されない**。dispatcher のテストが押さえて
  いるのは claim の**結果への反応**(勝者だけ hand-off する、1件の失敗が後続を
  止めない)であって、claim そのものではない。CI が緑でも「全部動く」とは言えない。
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
- **`gh` CLI が入っていない環境がある。** その場合でも public リポジトリなら
  GitHub REST API の Actions Runs API を読めば、認証なしで結果が分かる:

  ```
  https://api.github.com/repos/<owner>/<repo>/actions/runs?per_page=5
  ```

  見るのは **`head_sha` と `conclusion` の2つ**。`conclusion` が `success` でも、
  それが今の HEAD の SHA でなければ、今のコードは検証されていない。

  **これは環境の話であって AutoOps の制約ではない。** `gh` が使える環境では
  `gh run list` でよく、どちらで確認したかはリポジトリに影響しない。
  「`gh` がないから CI は確認できない」で止めないこと。

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
| Node は **22.x**。CI も本番に合わせる(逆は**しない**) | 揃える先は動いている方。CI を最新に上げると、誰も動かさないランタイムについて緑になる。`package.json` の `engines.node` が唯一の宣言で、Railpack も CI もそこから読む |
| pnpm のバージョンは **`packageManager` だけ**が持つ。`ci.yml` に `version:` を**書かない** | `pnpm/action-setup` は両方に書かれていると「どちらの意味か」を推測せずエラーにする。実際 Sprint 28 でこれが起き、CI は Day 4 まで赤のままだった |
| 「stuck」は `RunHistory.status` の値では**ない** | `status` は `running`/`completed`/`failed` のまま変えない。`running` が長時間続いている状態は表示側(`lib/health.ts`)が `startedAt` と現在時刻から都度導出する派生状態。本当に実行中のケースと区別がつかないため、断定的な表現(「stuck」「failed」)ではなく "Running for longer than expected" と表示する |
| stuck検知は Prisma schema 変更**なし**で実現する | `WorkerHealth.stuck` は読み取り時の計算のみ。DBに新しいカラム・ステータス値・バッチ処理を追加しない。Sprint 31 Day 2の監視設計調査で「UIだけで対応可能」と判断した方針をそのまま採用 |
| Scheduled overdue detection uses existing `nextRunAt` data. It is a derived UI state and does not represent Cron service failure. No schema change is required | `nextRunAt`はclaim成功時にのみ前進する(手動実行では動かない)ため、activeワーカーの`nextRunAt`が過去のままという事実だけは既存データから安全に読み取れる。ただし「なぜ」claimされていないか(Cron停止・claim失敗・直前に成功等)は区別できないため、UI文言は原因を断定しない("overdue"のみ) |
| `calculateNextRunAt` の計算経路は **1本だけ**。frequency 別・時刻の有無別に実装を分けない | 分岐していた頃、時刻なしの経路だけが月末クランプを受け取っておらず、1/31 が 3/3 に固定される不具合を生んだ(Sprint 35 P0-A)。同じ方針を2箇所に書けば、片方だけ直る日が必ず来る |
| `runAtMinutes = null` は「**オーナーの時計上の時刻**を保つ」。UTC インスタントの時刻ではない | スキーマのコメントが最初からそう定義していたのに、実装だけが UTC の時刻を保っていた。固定オフセットの zone では一致するため DST 境界でしか露見しない。時刻は人が自分の時計で読むもの |
| 時刻未指定でも `runAtDay` は**効く** | 以前は時刻を選ばない限り月の日付指定が無視されていた。経路が1本になったことで意図が常に読まれる |
| ドリフトした `nextRunAt` は**自動復元しない** | `runAtDay` がない worker では「本来の日」がどこにも記録されていない。クランプは不可逆で、再計算しても戻らない。**記録されていない意図は復元できない** — 直せるのは編集か `runAtDay` の設定だけ |
| provider SDK の型・例外・文言は **`lib/ai/` の外へ出さない** | 境界の外に `APIError` が漏れれば、全呼び出し元がどの SDK を使っているかを知ることになる。分類は境界で行い、外へ出るのは `ProviderError`(kind + 元の message + `cause`)だけ |
| 失敗の分類(`ProviderErrorKind`)と `RunHistory.status` は**別の概念**。`failed` の意味を拙速に広げない | `status` は `running`/`completed`/`failed` の3値のまま。`failed` は dispatcher の hand-off 失敗にも使われており、語の再定義なしに値を増やせば3つ目の意味が増えるだけ。Sprint 36 第1段階が kind をログに出すのは、その再定義を**データに基づいて**行うため |
| retry 方針は**観測データと失敗の語彙が揃うまで決めない** | 上の「dispatcher は retry 方針を持たない」を撤回するものではない。再試行に意味がある失敗(429 / 5xx / timeout)と無意味な失敗(拒否 / 認証)を区別できるようになって初めて、方針を根拠付きで選べる |
| scheduler の index は **`(status, nextRunAt)` の順**。逆にしない | 等値を先・範囲を後に置くのが B-tree の原則で、この順なら `ORDER BY nextRunAt` も同じ index で満たせる。逆順では範囲条件から先の列が絞り込みに使えない |
| Queue 契約・並行度(take / batch)・実行ロックは**まとめて決める** | 3つとも cron API か手動実行 UI のどちらかに波及する。個別に入れると契約を3回変えることになる |
| 実行は **inline のまま**。常駐 Worker 化(B0)は**保留**であって却下ではない | Sprint 37 の判断。B0 が解く問題(実行が HTTP request lifecycle に縛られる)は本番で発生実績ゼロ、B0 が作る問題(graceful shutdown)は導入した瞬間から確定する。この非対称が理由のすべて。再検討の条件は下の Sprint 37 の節にある |
| `duration_ms` は **観測であって policy ではない** | 閾値を超えても実行を止めず、retry せず、DB に書かず、B0 へ自動で切り替えない。決めるのは `console.warn` か `console.log` かだけ。`lib/health.ts` の `STUCK_THRESHOLD_MS` と同じ立場 — **観測が観測対象を書き換えては意味がない** |
| `claimRoutineSlot` は **slot lock であって execution lock ではない** | 条件は `nextRunAt` にかかるので、保証されるのは「同じ scheduled slot が二度 dispatch されない」ことだけ。手動実行は `nextRunAt` を読み書きせず claim を通らないため、scheduled と手動、手動同士は重なりうる。**これを許容すると決めたわけではない** — execution exclusion の方針は未決 |
| 実行の重複を **`RunHistory.status === "running"` の事前確認で防ぐ方式(E-2)は採らない** | check-then-act の隙間が残るうえ、2回目の write が失敗して `running` のまま残った行が1つあれば、その worker は二度と実行できなくなる。README Backlog の既知項目と正面衝突する。E-3(部分 unique index)/ advisory lock / lease は**未決** |
| enqueue 時に `RunHistory` を作って id を返す方式(C2)は、**現行の `RunHistory` semantics のままでは採らない** | 行は execution 開始時に作られ、`startedAt` は実行開始時刻。Rendered Prompt の再構成(`promptVariables(run.startedAt)`)、実行時間の表示、stuck 判定の3つがすべてその意味に依存している。前倒しすれば3つが同時にずれる。**`RunHistory` 自体を将来再設計することを禁じるものではない** |
| `take` は **未採用**。ただし scheduler に置くことを永久に禁じたわけでもない | 本番 Routine 0件で行数の実害がなく、catch-up と組み合わせるとバックログが1 interval を超えた時点でスロットを静かに失う。tenant fairness の論点も未解決。**根拠が揃うまで入れない**、が理由のすべて |

## 現在地

**ここに commit hash は書きません** — このファイル自体が git 管理下にあるため、書いた瞬間に1つ古くなります。
進捗の実際は git が持っています(冒頭の手順2)。

**現在地点: Sprint 38 Day 3 まで完了。CI 緑。**

完了済み:

- Sprint 31 — stuck derived state(`lib/health.ts`)、`nextRunAt` overdue detection(`lib/overview.ts`)
- Sprint 32 — Execution Reliability Review、Error Boundary Review、Documentation Review(いずれも調査のみ、コード変更なし)
- Sprint 33 — Production Readiness / Security / Dependency & CI のレビュー。
  そこで見つかった Node・pnpm のバージョン不一致を直した(上の「決定済み」2行)。
  **CI は Sprint 28 以降ずっと赤で、誰も結果を見ていなかった。** Day 4 で復旧。
  push したら Actions の結果まで見ること — 緑を確認して初めて検証されたと言える。
- Sprint 34 — `app/error.tsx` / `app/not-found.tsx` の追加と、`/api/cron/run` が
  **なぜ**拒否したかを4種類に分けて記録するログ。401 の3経路(ヘッダなし / Bearer
  でない / 値の不一致)とレスポンスの同一性、秘密情報が出ないことを実測確認した。
- Sprint 35 — **monthly の月末ドリフト(P0-A)を修正。** `calculateNextRunAt` が
  `runAtMinutes` の有無で2経路に分かれており、時刻なしの経路は月末クランプも
  `runAtDay` も持たないまま UTC インスタントを進めていた。1/31 が 3/3 へ移り、
  以後 3日に固定される。経路を1本に統合し、`addInterval` を削除した。
  再発防止は `runAtDay` の有無それぞれをテストで固定してある(26 → 37 件)。
- Sprint 36 — **P1-D 第1段階**と **P1-A**。詳細は下の2節。
- Sprint 37 — **Execution Architecture の決定**(A 採用 / B0 保留)と、
  tick duration の観測。詳細は下の節。
- Sprint 38 — **P1-B の分解**、`getDueWorkers` の query shape 改善(P1-B1a)、
  `server-only` を含むモジュールのテスト境界の確立。詳細は下の節。

### Sprint 36 — 失敗の分類(第1段階)と scheduler の index、完了

**P1-D 第1段階 — 観測だけを足した。**

- `lib/ai/provider.ts` に `ProviderErrorKind`(`timeout` / `rate-limited` /
  `unavailable` / `unreachable` / `unauthorized` / `invalid-request` /
  `refused` / `unknown`)と `ProviderError` を定義。
- `ClaudeProvider` が SDK の例外を分類する。判定は**エラークラスの列挙ではなく
  `status`** で行い、接続系2クラスだけ先に見る(`APIConnectionTimeoutError` は
  `APIConnectionError` の子なので順序が逆だと潰れる)。
- **kind は現時点でログにしか出ない。** `RunHistory` の schema も保存契約も
  変更していない。
- `ProviderError.message` は **SDK の `error.message` をそのまま**保持する。
  `RunHistory.output` に入る文字列は従来と byte 単位で同一 — 拒否時の
  `"Claude declined to answer this prompt."` も、Error でない値の rethrow も
  そのために維持している。**観測が観測対象を書き換えては意味がない。**
- `safeMessage` は kind から導出して持つが、**DB にも UI にも使っていない**。
  置き場所(列 / 画面 / どちらでもない)を決める前に文言だけ用意してある状態。

**P1-A — scheduler のクエリに index を付けた。**

- `Routine` に `@@index([status, nextRunAt])` と対応する migration。
- scheduler の `where { status, nextRunAt }` は**全テナント横断**で毎ティック
  走る唯一のクエリで、index がなければコストが「due な worker 数」ではなく
  「存在する worker 数」に比例していた。
- テーブルが小さいうちに入れたのは意図的。Web Service の起動は
  `prisma migrate deploy` を挟むため、行が増えてからの index 構築は起動を待たせる。

### Sprint 36 時点で未着手の P1 項目

Sprint 36 Pre-Sprint Review で洗い出し、**着手していない**もの。優先順位も
そのとき決めたまま:

- **P1-D 第2段階** — `errorKind` / `errorMessage` 等の schema 設計。
  第1段階のログから「実際に起きている失敗」を見てから列を決める前提。
- **P1-B** — 1ティックの上限。**この一行は当時「scheduler の `take`」と書いて
  いたが、Sprint 38 でそれが問題の名前として不正確だと分かった。**
  現在の整理は下の Sprint 38 の節にある。
- **P1-E** — 実行ロック(manual と scheduled の重複実行対策)。
- **P1-C** — Queue 契約(`enqueueRoutine` の戻り値)。
- retry policy。
- manual / scheduled 重複対策(P1-E と同じ問題の別の面)。

後ろの4つは互いに波及するため、上の「決定済み」のとおり**まとめて決める**。

### Sprint 37 — Execution Architecture の決定と tick duration の観測、完了

**決定: A(inline execution)を正式採用。B0(常駐 Worker 化)は保留。**

論点は「Queue を導入するかどうか」ではなく、**「AI execution を HTTP request
lifecycle から切り離すかどうか」**だった。切り離す形態として B0 — 既存の
scheduler / dispatcher / `runRoutine` をそのまま維持し、実行主体だけを常駐
プロセスへ移す構成、Queue ライブラリなし — を検討し、**今は採らないと決めた**。

理由は非対称性の一点に尽きる。**B0 が解く問題は本番で発生実績がゼロで、B0 が
作る問題は導入した瞬間から確定する。** 後者の中身は下の Railway 実測にある
graceful shutdown で、猶予は 0 秒。

#### B0 を再検討する条件

**「execution が存在するようになったこと」は理由にならない。** 条件は
**「HTTP 実行方式が実際に制約になったこと」**であって、実行の有無ではない。

| 段階 | 条件 |
|---|---|
| **警戒**(再検討を始める) | tick duration ≥ 150秒 / 単一 execution ≥ 150秒 |
| **導入検討**(必要と判断する) | 単一 execution ≥ 300秒 / cron の HTTP が失敗する(200 以外・レスポンス欠落) / HTTP lifecycle が実際の制約になった |

150秒(=300秒の半分)である理由は、単なる割合ではない。dispatcher は due な
worker を**1件ずつ順に**処理するので、**tick duration は平均ではなく和**になる。
1件で150秒かかっているなら、2件目を迎えた瞬間に300秒へ届く。300秒は cron の
interval でもあるため、**レスポンス切断とティックの重複が同時に始まる**。

再検討する日が来たら、**B0-a(独立 Worker Service)から評価する。** B0-b
(`instrumentation.ts` 内で常駐)は Next.js の SIGTERM ハンドラが
`server.close()` の後に `process.exit(0)` を呼ぶため、**実行中の AI 呼び出しを
待つ設計が原理的に作れない**(公開の cleanup API も存在しない)。B0-b の利点は
監視のしやすさだが、監視は設計で解ける — `process.exit(0)` は解けない。

#### tick duration logging

`/api/cron/run` が **1ティックにつき1行**、`duration_ms` / `dispatched` /
`failed` をログに出す。150,000ms 以上なら `warn`、未満は通常ログ。

- 計測は **`app/api/cron/run/route.ts` の中だけ**。自分が呼んだ処理の所要時間を
  自分で測っている。
- **`lib/dispatcher.ts` は変更していない。** `DispatchResult` に duration を
  足せば「Queue 契約はまとめて決める」に反し、契約を単独で1回変えることになる。
- **レスポンスの JSON 形状は変更していない。** `duration_ms` はログにしか出ない。
- **これは observability であって policy ではない**(上の「決定済み」参照)。

Sprint 34(拒否の理由をログへ)、Sprint 36(失敗の kind をログへ)と同じ形。
**観測を足すときは、観測対象を書き換えない。**

#### Railway 実測 — 2026-08-09 時点

| 値 | 出どころ |
|---|---|
| **edge idle timeout = 300秒** | Railway 公式(無通信のまま300秒で切断。通信が続けば最大15分) |
| **provider timeout = 600秒** | `lib/ai/claude-provider.ts`。**edge 制限の2倍**で、1回の呼び出しだけで切断されうる |
| **`drainingSeconds = null`** | Railway のデフォルトは猶予 **0秒**。SIGTERM の直後に SIGKILL |
| **`numReplicas = 1`** | `healthcheckPath` も `overlapSeconds` も null |
| cron interval = 300秒 | `*/5 * * * *`。**edge の制限と同じ値** |

`/api/cron/run` は dispatcher が返るまで1バイトも送らないので、**300秒は
「1 worker あたり」ではなく「そのティックの合計」**にかかる。

#### Production 実測 — 2026-08-09 時点

| 項目 | 実測 |
|---|---|
| tick duration | **median 約35ms / max 111ms**(45ティック。max はデプロイ直後の初回) |
| `dispatched` / `failed` | 45ティックすべて **0 / 0** |
| warn の発火 | **0件** |
| `Routine` | **0件**(active も 0) |
| `RunHistory` | **0件**。本番で execution が発生した実績はない |
| `User` | 1件 |

median 35ms は警戒閾値の **0.023%**、edge 制限の **0.012%**。桁が4つ違う。
**A を維持する判断は、推測ではなくこの数値に基づく。**

**この表は 2026-08-09 時点の値であって、現在の値ではない。** 再確認するなら
`railway logs --service autoops --deployment` の `tick finished` 行と、
Postgres への read-only 照会から。

### Sprint 38 — P1-B の分解、query shape の改善、テスト境界の確立

#### P1-B は1つの問題ではなかった

「P1-B = scheduler の `take`」は**問題の名前として不正確だった**。実際には別々の
2問題が1つの名前に入っていて、**片方の道具でもう片方は解けない**。

| | 問題 | 状態 |
|---|---|---|
| **P1-B1** | due result set / query volume | ↓ さらに2つに分かれる |
| **P1-B1a** | 使わない列まで取得する query shape | **Sprint 38 で改善済み** |
| **P1-B1b** | due 行数そのものが無制限 | **保留**(`take` 未採用 — 上の「決定済み」参照) |
| **P1-B2** | inline execution による tick duration | **保留**。下記 |

**`take` は tick duration を bound しない。** 5件 × 各10分 = 50分。件数の上限は
所要時間の上限にならない。

**dispatcher の time budget も hard limit にはならない。** 「経過が閾値を超えたら
新規着手をやめる」は soft limit で、保証されるのは *新しく始めない* ことだけ。
最悪の tick は `budget + 最後に始めた1件` ≒ budget + 600秒(provider timeout)に
なる。**provider timeout が edge の 300秒を上回っている限り、budget をいくつに
しても 300秒は保証できない。** よって P1-B2 は単独課題ではなく、provider timeout
/ cancellation / execution ownership と同じ **P1-D の execution lifecycle** 側で
扱う。

**150秒は observability の閾値であって、execution control の値ではない。**
同じ数を両方に使うと、`warn` が出るティックは常に切り詰められたティックになり、
「遅かった」と「切り詰めた」がログ上で区別できなくなる。

#### P1-B1a — `getDueWorkers` の query shape、完了

- 変更前は `Routine` の全列。dispatcher が使わない `prompt`(上限1万文字)まで、
  due な worker の数だけ毎ティック読んでいた。
- 変更後は dispatcher が実際に読む7列だけ — `id` / `userId` / `nextRunAt` /
  `frequency` / `runAtMinutes` / `runAtWeekday` / `runAtDay`。
  全参照行を列挙して確定した最小集合で、過不足はない。
- 戻り値は `DueWorker` — **`Routine` の `Pick` projection**。独立した型にすると
  同じ列が2箇所で別の型に書かれうる。`as` も `any` も使っていない。
- **変えていないもの:** `where`(`status = "active"` / `nextRunAt <= now`)、
  `orderBy`(`nextRunAt` 昇順)、schedule semantics、claim semantics、
  dispatcher の実行順序、API 契約。**取得する列だけが変わった。**
- `prompt` は execution が実行時に自分で読み直すので、dispatch 経路では最初から
  一度も参照されていなかった。

#### Queue 契約 — 変更していない

`enqueueRoutine(routineId): Promise<RunHistory>` のまま。inline 実行の**完了結果**
を返しており、同期実行では成立するが、**transport queue や Worker Service へ
そのまま移送できる契約ではない**(完了済みの run を transport は返せない)。

- Queue identity と `RunHistory` identity を**分けるのが有力な方向**。ただし
  実装方式は**未決**。
- **retry / attempt / 冪等キーを Queue 契約に先に載せない。** 載せた時点で
  retry policy を暗黙に決めたことになる。
- C2(enqueue 時に行を作る)を採らない理由は上の「決定済み」に書いた。

なお **scheduled 側は今日この時点でも契約変更に耐える** — dispatcher は
`enqueueRoutine` の戻り値を捨てている。依存しているのは手動実行だけで、
そちらは `status` を読んでトーストを出し分けている。

#### retry — 変わっていない

dispatcher は retry 方針を持たない。SDK は `maxRetries: 0`。`ProviderErrorKind`
は今も observability 専用。**本番の provider failure は依然0件**で、方針を
根拠付きで選ぶための材料がない。claim 後の失敗がスロットを消費する既定も維持。

#### テスト境界 — `server-only` は障害ではなくなった

**追加依存も DB も CI 変更もなしに、`server-only` を持つモジュールを Vitest から
テストできる。** `vitest.config.mts` で

```
server-only → node_modules/server-only/empty.js
```

に alias するだけ。**自作スタブではなく、Next.js が `react-server` 条件で実際に
解決するファイルそのもの**を指しているので、両者が食い違わない。

これで scheduler / dispatcher / health / overview が届くようになった
(Test Files 5 / Tests 85)。押さえたのは due query の契約(status / 範囲 / 順序 /
select 列)、claim の勝者と敗者、claim → hand-off の順序、worker 単位の失敗隔離、
`dispatched` と `failed` の意味、stuck と overdue の境界値。

**worker 間の逐次性は契約として固定していない。** 結果の集合は逐次でも並行でも
同じで、二重実行を防いでいるのは claim であって順番ではない。固定すれば、
並行度を検討する日にまずテストを壊さないと議論が始められなくなる。
**一方、1 worker 内の claim → enqueue の順序は契約なのでテストしてある** —
逆にすると「実行中のクラッシュ」が「重複実行」に変わる。

#### 小さな負債 — frequency の fallback が2箇所にある

`toRoutine` と `getDueWorkers` の両方に `isRoutineFrequency(...)` で読めなければ
`"manual"`、という fallback がある。**認識しているが今は共通化しない** — 値域
判定自体は `isRoutineFrequency` に集約済みで、重複しているのは適用側だけ。
共通化すると `types` / `routines` / `scheduler` に変更が広がる。

**恒久的に許容すると決めたわけではない。** 3箇所目が必要になったとき、
`"manual"` という fallback の意味を変えるとき、DB の string → ドメイン型の変換を
体系的に整理するとき、同種の projection が増えたときに再評価する。

### 未確認 — 別途扱う

CI が緑でも検証されていないもの。**「動作確認済み」と言わないこと。**

- `classify()` の実 API による挙動(401 / 429 等)。型と SDK のクラス階層を
  実物のファイルで確認しただけで、実際の応答は受けていない。
- **`ANTHROPIC_API_KEY` の有効性。** 本番の Web Service には設定されていて、
  stand-in の警告も出ていない — つまり `ClaudeProvider` を使う構成にはなって
  いる。ただし**成功した API 呼び出しが1件もない**ので、キーが通るかは不明。
- **`duration_ms` の warn 分岐(150,000ms 以上)。** 発火条件そのものが本番に
  存在しないため、実行が起きるまで検証できない。型検査とビルドは通っている。
- DST の他 zone。`America/New_York` のみ実測。
- 本番 index の**実効性能**。`Routine_status_nextRunAt_idx` が本番に実在する
  ことは 2026-08-09 に `pg_indexes` で確認したが、行が0件なので効いているか
  どうかは測っていない。migration の適用も同時に確認済み(`_prisma_migrations`
  の `20260807235724_add_scheduler_due_index` が rolled back なしで完了)。
- 本番 DB に残っている可能性のある monthly drift worker の監査は、2026-08-09
  時点では**該当なし**(`Routine` が0件)。worker が作られたら改めて要確認 —
  **修正しても過去は戻らない**(上の「決定済み」参照)。

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

### 将来検討 — Execution 結果分類の拡張

**今のスプリントの実装対象ではありません。** Execution Event なり structured
logging なりを入れるときに、まとめて設計し直す前提の課題です。

Sprint 32 Day 2 で確認した事実: `runRoutine` の catch 節で `status:"failed"`
を書く update 自体が失敗した場合、例外は dispatcher まで伝播し hand-off 失敗
として `failed` に数えられます — 実際には hand-off は成功していたケースです。
行は `running` のまま残り、15分後に stuck 表示が拾います。

つまり **persistence failure だけが専用の表現を持たず**、hand-off failure と
同じカウンタに合流します。これを分けるには `failed` という語の再定義が要る
ため、単独では直せません。発生条件も限定的です。

Sprint 36 の `ProviderErrorKind` は**この課題を解いていません。** あれが名前を
与えたのは provider の失敗だけで、persistence failure は `runRoutine` の catch
節そのものが失敗するケース — provider の外側です。両方を1つの語彙に載せるかは
第2段階(`errorKind` 列の設計)で決めることになります。
