# Koqentra — 作業ガイド

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
  **依存も DB も足さずに**届くようになった。現在の到達範囲は `lib/schedule.ts` /
  `lib/scheduler.ts` / `lib/dispatcher.ts` / `lib/health.ts` / `lib/overview.ts` /
  `lib/runs.ts` / `lib/execution-lease.ts` / `lib/session.ts` /
  `lib/worker-input.ts` / `lib/prompt.ts` / `lib/ai/claude-provider.ts` /
  `lib/beta-access.ts` / `lib/rate-limit.ts` / cron route / **server action 5つ
  すべて**(run / create / edit / timezone / delete)。
  **Test Files 62 / Tests 1930**(Node v24.16.0 のローカル実測。CI は Node 22)。
- **テストが1つも無いもの**を把握しておくこと: 全 component、
  `lib/schedule-label.ts`、**`auth.ts` 本体**(admission の判定ロジックは
  `lib/beta-access.ts` へ分離してテスト済みだが、callback の結線自体は未テスト)。
  **「1647件通った」は「全部カバーした」ではない。**
- **server action をテストするときは、末端だけを mock して境界は実物を使う。**
  `@/auth` / `@/lib/users` / `@/lib/routines` / `next/cache` / `next/navigation`
  を `vi.mock` し、`@/lib/session` は実物のまま通す。こうすると
  「authentication → validation → provisioning → write」の順序そのものを
  `invocationCallOrder` で固定できる。`redirect` の mock は**必ず throw させる** —
  返してしまうと、本番なら到達しない行がテストでは動く。
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

  **これは環境の話であって Koqentra の制約ではない。** `gh` が使える環境では
  `gh run list` でよく、どちらで確認したかはリポジトリに影響しない。
  「`gh` がないから CI は確認できない」で止めないこと。

- **Git Bash から Railway へ POSIX path や URL を含む文字列を渡すと壊れる。**
  MSYS の path conversion が実際に起きた(Sprint 41):

  ```
  /bin/sh        → C:\Program Files\Git\usr\bin\sh
  https://       → https;\
  Authorization: → Authorization;
  ```

  必要なら `MSYS_NO_PATHCONV=1` と `MSYS2_ARG_CONV_EXCL='*'` を使う。ただし
  **機械的に常用せず、対象コマンドの引数の意味を確認してから**。
  **Railway の設定を変更したら必ず read-back して保存値を検証すること** —
  上の破損はデプロイ前の読み直しで見つかった。

- **Railway の service instance 設定は、既存 deployment の manifest に自動では
  反映されない。** UI 上で新しい値が見えていても Apply / Deploy が出ないことが
  あり、deployment 側は古い値のまま動き続ける。Sprint 41 の Docker image service
  では

  ```
  railway redeploy --service <name> --from-source
  ```

  で現在の設定から新しい deployment が作られることを実測した。フラグなしの
  `redeploy` は「既存 deployment の再実行」で、設定変更は載らない見込み。
  **この実測を全 Railway service へ一般化しないこと。**

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
| **execution ownership は correctness state**。observability ではないので DB に持ってよい | 判定基準は「読まれ方」。`stuck` は表示のためだけに読まれ、何の分岐にも使われないから DB に持たない。execution ownership は**実行するかしないかの分岐に使われる**。書いた値が振る舞いを変えるものは状態であって観測ではない |
| **execution lease は無条件の at-most-once を保証しない** | 保証するのは「execution が lease TTL より長引かない限り、同一 Routine の同時実行を抑止する」まで。TTL を超えて生き残った実行と、乗っ取った実行は**現に重なる**。総実行時間に理論上の上界がない(接続待ちが無期限)以上、定数では保証できない。**owner token が守るのは「古い所有者が新しい所有者の lease を消さない」ことだけ** — ここを at-most-once と誤読して上に何かを積むと、再現しにくい形で壊れる |
| **`User` 行は sign-in では作らない。** provisioning は「行を新たに存在させる必要がある write」の境界でだけ行う | 3案を比較した結果。`auth.ts` に DB を入れる案は「adapter を入れない = middleware を Edge で動かす」根拠を消すうえ、**JWT は sign-in 時にしか発行されないので既存セッションには効かない**。`requireUserId()` に入れる案は read path 5箇所が全て write になり、DB 障害が認証障害として見える。**読み取りが行を作ってはいけない** |
| **`requireUserId()` に provisioning を足さない。** read-safe 契約はテストで固定してある | 足した瞬間、ページ表示ごとに upsert が走る。Koqentra 全体の「読み取りは書かない」性質(scheduler は read-only、health / overview は導出)を初めて破ることになる |
| 有効な write で `auth()` が2回走ることは**許容する** | authentication と provisioning の責務分離を優先した結果。`requireUserId({ provision: true })` のような flag API や、session を広く配る abstraction は作らない。性能最適化はこの分離を壊す理由にならない |
| Manual Run の per-user guard は **manual entry point だけ**に置く。`enqueueRoutine` / `runRoutine` の共通 path には入れない | scheduled は tick 側(`MAX_DISPATCHES_PER_TICK` / tick budget / 逐次 hand-off)で別に bounded されている。共通 path に入れれば、cron の実行が「所有者が手で何かを走らせていたから」という理由で落ちる。**スケジュールが人の操作に依存してはいけない** |
| `MANUAL_RUN_SLOT_TTL_MS` は `EXECUTION_LEASE_MS` から**導出も共有もしない**(現在たまたま同じ15分) | 前者は「crash 後にアカウントを何分待たせるか」という product の判断、後者は「worker をいつまで実行中とみなすか」という platform の判断。片方を動かしたときにもう片方が黙って動くのは、`STUCK_THRESHOLD_MS` と `EXECUTION_LEASE_MS` を分けたのと同じ理由で避ける |
| **`ManualRunSlot` は concurrency、`RateLimitBucket` は rate。両者を混ぜない** | `ManualRunSlot` は「今1本走っているか」で、終われば解放される。`RateLimitBucket` の `count` は「固定 window 内の回数」で、解放という概念を持たない。片方をもう片方に流用すると、TTL 失効が回数もリセットするのか、という答えのない問いが生まれる。**Sprint 2 で「rate ではない」と書いた残課題は Sprint 4 で別機構として解決した**(下行) |
| Manual Run の rate limit は `RateLimitBucket` の **`manual-run` scope**。20回 / fixed 1 hour / user。consume は **slot 取得後・execution 前**。消費後は**返却しない** | scope 付き table は元からその用途(`@@unique([userId, scope])`)。slot の前に consume すると二度押しが課金され、execution の中で consume すると scheduled にも混入する。website が unchanged で AI を呼ばなくても1消費 — bound しているのは「手動実行を開始したこと」であって「Anthropic を使ったこと」ではない。**quota 判定は slot の release を持つ `try` の内側**に置く(そうしないと拒否だけで slot が15分残る) |
| `lib/rate-limit.ts` の公開 API は**用途別の薄い関数だけ**。任意 scope / 任意 limit を渡せる汎用 quota API を作らない | 内部の `consumeFixedWindowQuota` を共有するのは重複を避けるためであって、設定可能にするためではない。呼び出し側が scope を名乗れると、誰も決めていない allowance を発明できる |
| Worker quota の atomicity は **`User` 行を per-user の serialization point** にして得る。counter table は作らない | 個数条件は conditional `UPDATE` の WHERE に書けないため、既存3 guard の pattern が使えない。counter を別に持てば `Routine` と二重の真実になり、pause / delete / cascade でズレたときに自然回復しない。**行が数そのもの**なら、止めるのも消すのも次の count に自動で反映される |
| quota lock の `tx.user.update({ data: { id: userId } })` を **`data: {}` に変えない** | Technical Spike の実測: `data: {}` では Prisma が `UPDATE` を発行せず `SELECT` になり、**ロックを取らずに素通りする**。自己代入は偶然ではなく locking contract。呼び出し側へ散らさず `lib/worker-quota.ts` に閉じ込める。**将来 `User.updatedAt` を足すなら、この lock が account を毎回打刻することになるので再評価する** |
| Active quota は **`status === "active"` の行数**で数える。`frequency !== "manual"` を条件に足さない | scheduler が実際に拾うのは `active` かつ定期だが、それを quota の条件にすると「cadence を manual に変えただけで枠が空く」挙動になり、dashboard から読み取れない規則になる。**負荷の実体と、人が見て分かる規則は別**でよい |
| Website の domain throttle は **`DomainThrottle`(host が PK / `nextAllowedAt` のみ)で global**。`RateLimitBucket` / `ManualRunSlot` と混ぜない | 守る対象が「Koqentra の請求」ではなく「他人のサイト」なので、per-user では user 数だけ掛け算される。`RateLimitBucket` は `userId` が NOT NULL で global 行を表現できず、`ManualRunSlot` は「進行中か」を問う lease で意味が違う。**時刻を前進させるだけなので解放も TTL も不要** |
| throttle の key は **exact hostname**(URL parser の正規化済み)。eTLD+1 に集約しない。PSL 依存を足さない | `www` と `news` を別 host として数えるのは取りこぼす方向の誤り。PSL なしの近似は `co.jp` / `github.io` を誤り、**無関係なサイト同士が互いを待たせる**という悪い方向に失敗する |
| throttle の待機は **`FETCH_BUDGET_MS`(20秒)の内側**。retry は **1回だけ**。2回目も拒否なら `WatcherErrorKind = "throttled"` | budget 外に出すと 1 worker の最悪が 140s → 180s になり、逐次 dispatch の tick 最悪値が Railway の 300s edge を超える(Spike で実算)。待った後は残り budget を**読み直して**hop へ渡す |
| throttle 拒否は **RunHistory `failed`**。行を作らない案(create を fetch の後ろへ移す)は採らない | 移すと timeout / blocked-address / http-error など**全 fetch 失敗の行が消える**。Sprint 39 で `errorMessage` を分離した意味を失う。Snapshot は不変(既存「失敗は baseline を動かさない」を維持) |
| `lib/watcher` に **Prisma を import しない**。throttle は `FetchDeps` で注入する | resolver / transport と同じ注入境界。DB を入れると watcher の全規則が DB なしでテストできなくなる |
| `RunHistory.output` のうち **Koqentra 自身が書いた2文だけ**を表示時に i18n する。保存値は英語のまま変えない | `output` には「モデルの生成物」と「Koqentra の報告」が同居している。前者は利用者の素材で翻訳禁止、後者は画面の言葉。**判定は `routine.kind === "website"` かつ完全一致の2条件**で、前方一致・部分一致・正規表現は使わない — prompt worker は同じ文を意図的に出力できるため。保存時に訳す案は language 変更に追随できないので不採用。`errorMessage` は補間つき `WatcherError` が多く、一部だけ訳すと不揃いになるため**今回は対象外** |
| **通知するかどうかは semantic state から決める。`RunHistory.output` の文字列を見て判定しない** | `output` には「モデルの生成物」と「Koqentra の報告」が同居しており、prompt worker は Koqentra の2文と同じ文字列を意図的に出力できる。判定に使うのは `WebsiteChangeState`(`initial`/`unchanged`/`changed`)、`RunHistory.status`、`WatcherErrorKind` の3つだけ。どれも run が終わる時点で消えるので、内部の `ExecutionOutcome` に **`RunNotificationKind \| null` を1つ足して**運ぶ。**`runRoutine` の戻り値は `RunHistory` のまま** — queue 契約も dispatcher も手動実行 action も無変更 |
| Website の `initial` と `unchanged` は**通知しない**。`throttled` の failure も**通知しない** | 前2つは「報告することが何もない成功」で、通知すればページが動かない限り毎 cadence 届く。`throttled` は他人のサイトの障害ではなく **Koqentra 自身の politeness** で、所有者に打つ手がない。**除外するのは通知だけ** — run は `failed` のままで `errorMessage` も持ち、`latestExecutionFailureAt` の対象でもある。`RunHistory` の failed semantics と `last_failed_at` semantics は**変更していない** |
| 通知先は **`Routine.userId` → `User.email` の鎖だけ**。FormData からも session からも取らない | 宛先がフォームに現れないなら、注入も誤配も表現できない。session を使うと scheduled 実行(誰もサインインしていない)と手動実行で宛先が変わりうる。**worker にアドレス列は無い** |
| 順序は **execution → final RunHistory persistence → email**。`RunPersistenceError` は通知0 | 逆順だと「メールは届いたが Run Detail が存在しない」に到達できる。リンク先が無いメールは、その人自身のアカウントについて嘘を伝えることになる |
| **メール送信の失敗は Run を一切変えない。** ログ1行だけ | 変えるものが1つでもあれば、通知は observability ではなく policy になる。status / errorMessage / Snapshot / `nextRunAt` / lease のどれも触らない。ログは固定 prefix `[notify] could not send` と run id / routine id / **closed set の reason** のみ。**アドレス・API キー・provider の応答・output・ページ内容は出さない** |
| **Resend SDK を依存に追加しない。** Node の `fetch` で JSON を1回 POST する | 送信は「JSON 1個を POST する」だけで、SDK を入れれば retry / timeout / エラー整形の方針がもう1組できる。そのどれもここが自分で決めなければならないもの。**JSON API なので件名の header injection は構造的に存在しない** — 件名から control character を除くのは「壊れて見える件名」を防ぐためで、防御ではない。**誇張しないこと** |
| `EMAIL_SEND_TIMEOUT_MS`(5秒)は **AI の timeout から導出しない** | あちらは run の結果そのものを待つ時間、こちらは既にある結果についての連絡。根拠は待たせる相手の側 — 手動実行は HTTP レスポンスを開けたまま待たせ、tick は最大5件 × 5秒 = 25秒で `MAX_TICK_EXECUTION_MS`(240秒)の約1/10 |
| **retry 0 / `NotificationDelivery` table なし / `notificationSentAt` なし / provider idempotency なし** | 二重送信を防いでいるのは「1回しか試さない」こと。既存の claim / lease / manual slot が「1 run = 1 通」を成立させている。retry queue を入れる日に `RunHistory.id` を idempotency key の候補として設計し直す |
| メールは **lease を解放した後**に送る | 送信に数秒かかる間、worker が実行中に見えてはいけない。`RunPersistenceError` は `finally` の前で抜けるので、その経路は通知に到達しない |
| 通知設定は **`Routine` の Boolean 1列**。`notifyOnSuccess` / `notifyOnFailure` に分けない | 分ければ組み合わせが4通りになり、UI も文言も4通り説明することになる。**MVP が答える問いは「この worker について知らせるか」の1つだけ** |
| `RESEND_API_KEY` / `EMAIL_FROM` は **送信のたびに読む** | `ANTHROPIC_API_KEY` と `BETA_ALLOWED_EMAILS` が起動時1回なのは、起動時に**何かを作る**から(client / parse 済みリスト)。ここは何も作らないので、早く読んだ値の置き場所が無い。変数を足した deployment が再起動で送り始める |
| edit は `emailNotificationsEnabled` を**毎回書く** | checkbox は OFF のとき何も送信しない。届いた時だけ書く実装にすると、**ON にはできても OFF に戻せない** |
| 通知の宛先 helper は `email` / `language` に加えて **`timezone` も読む** | 同じ行・同じクエリで、追加の read は0。他の全ての時刻表示がその zone なので、リンク先の Run Detail と食い違うメールを送ることになるのを避ける。**Focused Design Investigation の記述からの意図的な逸脱**で、報告済み |
| **テンプレートの文言(name / description / prompt)は3つとも i18n 対象**。「name と prompt は worker の中身になるから訳さない」という以前の判断は**撤回した** | 適用した瞬間から利用者の素材になるのはそのとおりだが、**適用するまでは Koqentra が差し出す例**であって、読めない例は例として機能しない。訳さない対象は「適用した後に人が書いたもの」に線を引き直した。en/ja parity は `TranslationKey` の型で従来どおり担保する。**新しい i18n framework は作っていない** |
| テンプレートは **`kind` を持ち、選ぶと kind も切り替わる** | 以前は「テンプレート = prompt worker」を前提に、website を選ぶとテンプレート欄ごと隠していた。website の例を出す以上その前提は成り立たない。切り替えは AI draft 適用時の `setKind(draft.kind)` と同じ既存パターンで、**新しい UI architecture は作っていない** |
| グループ表示は **見出し + 既存カードの2回描画**だけ。group registry も per-group の振る舞いも作らない | 「グループ化のためだけに汎用 UI を作らない」の直接の帰結。テンプレート追加は配列に1件足すだけで、どのグループに出すかは `kind` が決める |
| **website テンプレートは URL を持たない** | どのページを見るかは選ぶ人しか知らない。`validateWorkerFormForKind` の「website には URL 必須」はそのままなので、空欄のまま保存はできない |
| **テンプレートの `defaultFrequency` は kind で分ける。「全件 manual」は website には適用しない** | Documentation Sprint が全件 manual にした理由は「prompt に素材を抱えているので cadence で回しても同じ結果」。website worker はページ自身が変わるので、その理由が**成り立たない**。prompt 側3件も定期前提の題材(標準テーマ)に書き換えたため daily / weekly にした — **これは Documentation Sprint の判断の更新であり、報告済み** |
| **テンプレートは `emailNotificationsEnabled` を設定しない** | 既定は schema の false のまま。カードを1回押しただけの人の代わりにメール送信を有効化しない。Email Notification の default semantics は今回**変更していない** |
| **Production の主 origin は `https://app.koqentra.com`**。root の `koqentra.com` にアプリを載せない | Auth.js の cookie は host-only(`__Host-` prefix、domain 属性を持てない)なので、`app.` に閉じれば LP や将来の別サブドメインへセッションが漏れる経路が**構造的に存在しない**。root を SaaS にすると cookie スコープと LP が同一 origin に同居する。`/dashboard` は全て認証必須で SEO 価値が無く、root は LP に譲るのが正しい。**逆(root → app)へ後から動かすのはサインイン URL の変更を伴うため高くつく — 非対称なので `app.` から始める** |
| **旧 Railway generated domain は削除しない** | 切替前に送信済みのメール内 Run Detail リンクが旧 origin を指しており、消すとリンク切れになる。切り戻し先としても機能する。**両 origin が同一ビルドを配信していることは実測済み** |
| **ブランド移行を理由に内部識別子を rename しない** | repository 名 `autoops` / Railway service 名 / generated domain / `package.json` の name / ローカル DB 識別子 / migration history / env 変数名。**利用者から見えるブランド**と**インフラ内部識別子**は別物で、後者を変えても得るものは一貫性の見た目だけ。User-Agent `AutoOpsWatcher/1.0` も同じ扱いで、変更するなら別 Phase の独立判断 |
| **`AUTH_URL` は Production origin の唯一の供給源**。2つ目を作らない | Auth.js が内部で読み、アプリ側は `lib/notify/run-notification.ts` の Run Detail URL 生成が読む。**この2つは同じ変数を読むので分離できない** — 切り替えるとサインイン origin とメール内リンクが同時に動く。`AUTH_TRUST_HOST` / `NEXTAUTH_URL` / `NEXTAUTH_URL_INTERNAL` は**設定しない**(いずれも ABSENT のまま) |
| **timezone について「未設定です」と表示しない** | `User.timezone` は `@default("UTC")` で、`ensureUser` は timezone に触らない。したがって **「一度も設定していない UTC」と「明示的に選んだ UTC」は DB 上で識別不能**。区別できないものを断定すると、UTC を意図して選んだ利用者に誤った表示をすることになる。**言ってよいのは「いまこのアカウントは {zone} である」という事実と、変更先(Settings)まで** |
| 問い合わせ先は **`SUPPORT_EMAIL` env の1箇所だけ**。source に住所を書かない | secret ではないが**コードについての事実でもない**。そして推測した住所は無いより悪い — 行き止まりを出口の形で見せることになる。**未設定の deployment では Support 節ごと出さない**(`RESEND_API_KEY` と同じ「欠けている env は機能を壊すのではなく無くす」の形)。空白・制御文字・`@` なしは未設定と同じ扱い |
| **「正常なのに壊れて見える」は UI と表示文言で直す。実行 semantics は触らない** | 初回実行は成功なのにモデルも呼ばずメールも送らないため「何も起きていない」ように見える。**直し方は「初回にもメールを送る」ではなく「先に言っておく」**。同じ理由で、`RunHistory.output` の**保存値と表示値は食い違ってよい** — 保存値は `lib/run-display.ts` の完全一致判定と既存行が依存するので不変、表示は各言語で「その run が何をしたか」を言う(英語の `run.system.websiteBaseline` が実例)。**表示が保存値と一字一句同じであることは要件ではない** |
| `take` は **未採用**。ただし scheduler に置くことを永久に禁じたわけでもない | 本番 Routine 0件で行数の実害がなく、catch-up と組み合わせるとバックログが1 interval を超えた時点でスロットを静かに失う。tenant fairness の論点も未解決。**根拠が揃うまで入れない**、が理由のすべて |

## 現在地

**ここに commit hash は書きません** — このファイル自体が git 管理下にあるため、書いた瞬間に1つ古くなります。
進捗の実際は git が持っています(冒頭の手順2)。

**現在地点: Sprint 45 まで正式 CLOSED。Sprint 46 Day 1 の Backlog 再評価では
「実装しない」(Option 0)を選び、Closed Beta Observation Phase に入っている。**
Test Files 62 / Tests 1930(ローカル実測)。**この節の残りは Sprint 46 時点の
記述のまま古い** — 以降のスプリントは下の各節と git log を正とすること。

**Observation Phase は継続中で、Documentation Sprint はその上で走っている。**
Documentation Sprint の成果物(`docs/` 3点、README の導線と Backlog、
`lib/worker-templates.ts` の修正、このファイル)は**ローカル完了・未 commit**。

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
  `server-only` を含むモジュールのテスト境界の確立、**P1-E execution lease**。
  詳細は下の節。
- Sprint 39 — **`RunHistory` の失敗データを `output` から分離**(`errorMessage`)。
  詳細は下の節。
- Sprint 40 — **本番で初めて実行が起きた。** 通常の UI から Worker を1件作り、
  手動実行し、削除した。**Claude API は成功**(約5秒)。あわせて
  `lib/ai/claude-provider.test.ts` と `app/api/cron/run/route.test.ts` を追加。
  詳細は下の節。
- Sprint 41 — **cron の沈黙を外部から検知できるようにした**(Healthchecks.io の
  dead man's switch)。あわせて due 件数のログ。詳細は下の節。
- Sprint 42 — **User provisioning 境界の正式化**(`requireProvisionedUserId`)。
  **実装は完了**し、Closed Beta blocker だった「Worker を持たないアカウントが
  timezone を保存できない」を解消。詳細は下の節。
- Sprint 43 — **入力契約の締め直し。** 無人で繰り返し実行される Worker に
  prompt を必須化(NEW-1)、prompt 変数が継承プロパティに答えるのをやめた
  (NEW-6)、edit が「1行も更新していないのに success」を返すのをやめた
  (NEW-3)。詳細は下の節。
- Sprint 44 — **Failure Observability & Action Consistency Hardening。**
  delete だけに欠けていた DB 例外処理を既存 action 契約へ揃え(NEW-7)、
  実行失敗の存在を運営者が cron ログ1行で確認できるようにした。詳細は下の節。
- Sprint 45 — **Closed Beta Access & Privacy Readiness。** sign-in を招待制に
  し(`BETA_ALLOWED_EMAILS`)、`/privacy` を追加した。詳細は下の節。
- Documentation Sprint — **利用者向けドキュメント3点の新規作成と、能力の
  誇張を取り除く template 修正。** 詳細は下の節。

### Sprint 36 — 失敗の分類(第1段階)と scheduler の index、完了

**P1-D 第1段階 — 観測だけを足した。**

- `lib/ai/provider.ts` に `ProviderErrorKind`(`timeout` / `rate-limited` /
  `unavailable` / `unreachable` / `unauthorized` / `invalid-request` /
  `refused` / `unknown`)と `ProviderError` を定義。
- `ClaudeProvider` が SDK の例外を分類する。判定は**エラークラスの列挙ではなく
  `status`** で行い、接続系2クラスだけ先に見る(`APIConnectionTimeoutError` は
  `APIConnectionError` の子なので順序が逆だと潰れる)。
- **kind は今もログにしか出ない。** Sprint 36 時点では `RunHistory` の schema も
  保存契約も変更していない(**列の分離は Sprint 39。下の節を参照**)。
- `ProviderError.message` は **SDK の `error.message` をそのまま**保持する。
  当時 `RunHistory.output` に入っていた文字列は従来と byte 単位で同一だった —
  拒否時の `"Claude declined to answer this prompt."` も、Error でない値の
  rethrow もそのために維持している。**観測が観測対象を書き換えては意味がない。**
  **その文字列自体は今も同じで、Sprint 39 で入る列が変わっただけ**
  (`output` → `errorMessage`)。
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
| **provider fallback timeout = 600秒** | `lib/ai/claude-provider.ts`。**本番の caller はどれもここへ落ちない** — prompt worker 180秒 / website AI 120秒 / draft 30秒を各自明示する |
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

### Sprint 38 — P1-B の分解、query shape の改善、テスト境界、execution lease

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
最悪の tick は `budget + 最後に始めた1件` ≒ budget + その1件の timeout になる。
**この2つ目の項は 2026-08-25 に 600秒から 180秒へ縮んだ**(prompt worker が自分の
deadline を明示するようになった)。**それでも 300秒は保証されない** — budget
240秒の直前に始まった1件が 180秒使えば 420秒になる。**縮んだのは最悪値であって、
hard limit になったわけではない。** よって P1-B2 は単独課題ではなく、
cancellation / execution ownership と同じ **P1-D の execution lifecycle** 側で
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

#### P1-E — execution lease(`runRoutine` に統合済み)

**方式は E-5(Routine lease)を採用した。** 候補から外したのは E-2(`RunHistory.status`
の事前確認)、E-3A(部分 unique index)、E-4(advisory lock)、E-7(Queue backend 単独)。
E-6(別テーブル)は第二候補として残っている。

**`runRoutine` が lease を取ってから実行する。** scheduled と manual の唯一の
合流点がそこなので、**両経路が同じ lease を共有する** — 片方だけに掛けたのでは
「scheduled × manual」の穴が閉じない。

```
scheduled: claimRoutineSlot → enqueueRoutine → runRoutine → acquire → 実行
manual:    所有者確認        → enqueueRoutine → runRoutine → acquire → 実行
```

| 場面 | 挙動 |
|---|---|
| lease 取得成功 | `RunHistory` を `running` で作り、実行し、`completed`/`failed` に更新し、`finally` で release |
| **lease 競合** | `ExecutionSuppressedError` を投げる。**`RunHistory` を作らず、provider も呼ばず、retry もしない** |
| **dispatcher から見た競合** | **`dispatched` にも `failed` にも入れない。** ログのみ。「hand-off できなかった」でも「実行が失敗した」でもないため |
| **競合時の scheduled slot** | **消費済みのまま。** claim は lease より前に済んでおり、`nextRunAt` を戻すことはしない |
| **manual から見た競合** | 「既に実行中」として区別して伝える。`ActionResult` の形は変えていない |
| release の失敗 | 実行結果を上書きしない。lease は失効で自己回復する |

**`runRoutine` は Routine の読み取りを lease 取得より前に行う。** 削除済みの
worker は acquire でも `count === 0` になり、**競合と区別がつかなくなる**ため。
dispatcher は消えた worker を `failed` に数える設計なので、それが黙って
「何も起きなかった」に変わってはいけない。

| | |
|---|---|
| schema | `Routine` に nullable 2列。`executionOwner String?` / `executionLeaseUntil DateTime?`。**default なし**(NULL が「誰も持っていない」を正しく表す)、index なし |
| owner token | acquire ごとの `randomUUID()`。**job identity でも execution id でもない。** UI にも `RunHistory` にも出さない |
| acquire | `updateMany`(`id` 一致 かつ `leaseUntil` が NULL または `now` より前)→ `count === 1` が成功。`claimRoutineSlot` と同じ形。**transaction なし** |
| release | `updateMany`(`id` と **`executionOwner` の両方**が一致)→ `count === 0` はエラーではなくログ対象。**例外を投げない** |
| TTL | `EXECUTION_LEASE_MS = 900_000`。**provider timeout からは導出しない** — あちらは1つの provider の1リクエストの方針、こちらはプラットフォームの1実行の方針 |
| heartbeat | **なし。** 理由は「失効が起きないから」ではなく、起きても owner token が状態を守るから |

**失効判定には app clock を使う。** DB clock なら raw SQL が要り、Koqentra にはまだ
1つもない。差が出るのは**書き込むプロセスが2つ以上あるとき**で、今は1つ。
**Worker Service か replica 追加の前に再検討すること** — 時計がずれる相手と
失効時刻を比べることになる。「app clock が永久に正解」と決めたわけではない。

**`STUCK_THRESHOLD_MS`(`lib/health.ts`)と同じ15分だが、共有しない。** 片方は
画面の文言を決め、もう片方は実行するかを決める。一度値が一致しただけの2つを
同じ定数にすると、表示の都合で下げた閾値が実行を変える。

**`toRoutine` は全フィールドを名指しで組み立てる。** スプレッドのままだと
`executionOwner` / `executionLeaseUntil` が `Routine` に乗ってクライアントまで
届く。名指しなら**列の公開は opt-in** になり、足し忘れは型エラーになる。

#### 小さな負債 — frequency の fallback が2箇所にある

`toRoutine` と `getDueWorkers` の両方に `isRoutineFrequency(...)` で読めなければ
`"manual"`、という fallback がある。**認識しているが今は共通化しない** — 値域
判定自体は `isRoutineFrequency` に集約済みで、重複しているのは適用側だけ。
共通化すると `types` / `routines` / `scheduler` に変更が広がる。

**恒久的に許容すると決めたわけではない。** 3箇所目が必要になったとき、
`"manual"` という fallback の意味を変えるとき、DB の string → ドメイン型の変換を
体系的に整理するとき、同種の projection が増えたときに再評価する。

### Sprint 39 — `RunHistory` の失敗データを `output` から分離

**`errorMessage String?` を追加した。** `output` は `String @default("")` のまま
— **nullable にしていない**。

| status | `output` | `errorMessage` |
|---|---|---|
| `running` | `""`(schema default) | `null` |
| `completed` | モデルの生成結果 | `null` |
| `failed` | **`""`** | 失敗の文言 |

**分離した理由は「1列が2つの意味を持つから」だけではない。** 読み手が2箇所
(Activity 一覧と Execution 詳細)あり、**どちらも `status` を見ずに描画していた**。
失敗した run では SDK 由来の診断文が一覧にインライン表示され、詳細では見出し
"Output" の下に出ていた。**意味は誰も解釈していなかった。**

- **保存する文字列は変えていない。** `error instanceof Error ? error.message :
  "Execution failed."` のまま。入る列が変わっただけ。
- **`safeMessage` は今回も使っていない。** DB 保存用に切り替えていない。
  provider-facing / user-facing の文言設計は**別判断として未決**。
- **`ProviderErrorKind` は保存していない。** ログのみ継続。
- 表示は **Activity には出さず、Execution 詳細だけに出す**。診断文は一覧性の
  ための場所ではない。`status === "failed"` のとき見出しは "Error"。
- **Activity のコードは1行も変えていない。** 失敗時の `output` が `""` になった
  ことで、既存の `run.output ? ... : null` が自動的に何も出さなくなる。
- `toRun` を `toRoutine` と同じく**全フィールド名指し**にした。列の公開を
  opt-in にするため。

**本番 `RunHistory` は0件だったので backfill も dual-read も不要だった。**
この機会は行が生まれた時点で失われる。

#### 今回解決していないこと(重要)

- **`errorKind` の永続化は未決。** 本番の失敗が**1件も起きていない**ので、
  値域も retryability も観測なしに固定できない。「`errorMessage` を足すなら
  ついでに `errorKind` も」は**禁止された思考**。
- **retry も未決。** 上の既存決定をすべて維持。
- **completed 書き込み失敗**は Day 2 時点では未解決だった。**Sprint 39 Day 4 で
  境界を分離した**(下の節)。

### Sprint 39 — execution result と persistence result の分離

**「実行が失敗した」と「結果を書けなかった」を別の事象として扱う。**

以前は `update(completed)` が実行と同じ `try` の中にあり、DB がそれを拒否すると
catch に落ちて **`failed` 行に DB の苦情が入り、モデルの出力は消えていた**。
2つの原因は事後に区別できなかった。

```
create(running)   失敗 → 実行は始まっていない。tick は failed に数える(既存どおり)
run               失敗 → failed 行 + errorMessage(既存どおり)
write outcome     失敗 → 何も書かず RunPersistenceError を投げる
```

| | 実装 |
|---|---|
| 型 | `RunPersistenceError`(`phase` は `"completed"` / `"failed"`、`runId`、`cause`)と `isRunPersistenceError`。**`ExecutionSuppressedError` と同じ最小構成**。framework は作っていない |
| **成功後の書き込み失敗** | **`failed` 行を一切書かない。** 投げるだけ |
| 失敗の書き込み失敗 | 同じく投げる。**`failed` 行が無いのに `failed` を返すことはしない**。実行失敗のログは先に出ているので**両方が追える** |
| 残る行 | 最後に確実に書けた状態 = **`running`**。`STUCK_THRESHOLD_MS` の既存導出が拾いうる |
| dispatcher | **`dispatched` に入れる**(start はできたため)。`failed` の意味は拡張しない。`DispatchResult` の形も Cron API も未変更 |
| `nextRunAt` | **戻さない**(Sprint 18 の決定を維持) |
| manual | 「started, but its outcome could not be recorded.」`ActionResult` の形は未変更 |
| ログ | **`ProviderErrorKind` は provider の失敗にしか使わない。** DB のエラーを `kind=unknown` として記録していた問題は解消 |

**書けたかどうかは判定できない。** サーバに到達してから応答を失った場合、
`UPDATE` は適用済みかもしれない(Prisma の P1002 は "reached but timed out")。
**読み直して確かめる recovery も、書き込みの retry も入れていない。**

- **stuck = persistence failure ではない。** persistence failure は `running` が
  残る**原因の1つ**にすぎず、行からは区別できない。
- **DB persistence retry は Backlog。** 一度 throw した書き込みが実は成功して
  いた可能性があるため、単純な再試行は「どちらか分からないものを上書きする」
  ことになる。
- `errorKind` の永続化、retry policy、`output` の保全はいずれも**未決のまま**。

### Sprint 40 — 本番での初回実行と、境界のテスト

**本番で実行が起きたのはこれが初めて。** PM が通常の UI から Worker を1件作り、
手動実行し、削除した。実装担当は read-only の確認のみ。

- **Claude API は成功した(約5秒)。** これで `ANTHROPIC_API_KEY` が「設定されて
  いる」から「通る」に変わった。**失敗時の挙動は依然未観測。**
- `lib/ai/claude-provider.test.ts`(27件)と `app/api/cron/run/route.test.ts`
  (19件)を追加。前者は `classify()` の8 kind と境界の非漏洩、後者は 401 の
  4経路と duration 閾値の境界。
- **`refused` は `classify()` からは出ない** — 成功応答の `stop_reason ===
  "refusal"` から来る。テストを読むときに間違えやすい。

**この Sprint で事故を1件起こした。** `afterEach(vi.restoreAllMocks())` が
`Anthropic.Messages.prototype.create` のスパイまで戻し、2件目以降のテストが
実際に `api.anthropic.com` を叩いた(全て 401、`ANTHROPIC_API_KEY` は未使用、
本番影響なし)。対処は `mockClear` への変更と、モジュール先頭で `globalThis.fetch`
を投げるようにするガード + `afterAll` での復元。**「通信していないことを確かめる
ために通信する」ことは禁止。**

### Sprint 41 — cron の沈黙を検知する

**解いたのは「tick が動かなくなったこと」だけ。** 実行の失敗は対象外で、それは
今も誰にも届かない(下の Backlog)。

- Healthchecks.io の dead man's switch。**Period 5分 / Grace 15分** なので、
  最後に成功した tick からおよそ20分で通知対象になる。
- Railway cron の Start Command は **`A && (B || true)`**。A が Koqentra の
  cron API、B が heartbeat。
  - **A が失敗したら heartbeat を送らない** — `--fail-with-body` があるので
    4xx/5xx が curl の失敗になる。**このフラグが無いと curl は HTTP エラーでも
    exit 0 になり、失敗した tick でも ping が飛ぶ。**
  - **B の失敗は A の失敗にしない** — `|| true` で吸収し、`--max-time 10` を
    heartbeat 側にだけ付ける。監視が実行の意味を書き換えてはいけない。
  - **`(A && B) || true` は禁止。** それだと A の失敗まで吸収される。
- `[dispatcher] due workers — count=N` を追加。「tick が動いていない」
  「dispatcher に届いていない」「届いたが due が0」を切り分けられる。
- **Ping URL は secret 扱い。** repo にも docs にも command literal にも書かない。
- **STUCK_THRESHOLD_MS / EXECUTION_LEASE_MS / TICK_WARN_THRESHOLD_MS とは
  別概念。** 値が近くても混同しない。

### Sprint 42 — User provisioning 境界の正式化

**Auth identity と DB `User` は別物**で、この設計はそれを意図的に分けている。
`User` 行は「認証の結果」ではなく **Koqentra 側の application entity**(timezone を
持ち、`Routine` の FK 親になる)。**sign-in では作られない。**

| | 責務 | DB write |
|---|---|---|
| `requireUserId()` | 認証済み identity を要求する | **なし** |
| `requireProvisionedUserId()` | それに加えて `User` 行の存在を保証する | upsert 1回 |

**User-owned write の処理順は固定:**

```
authentication → validation → provisioning → business write
```

- **認証は入力の妥当性より先。** 未認証なら、入力が不正でも redirect する。
- **provisioning は validation より後。** 弾かれる submission が、保存に必要
  だったはずの行を作ってはいけない。
- invalid input では **provisioning も persistence write も 0回**。

**適用先は「行を新たに存在させる必要がある write」だけ。** 現在は Worker create
と Settings の timezone 更新の2つ。delete / run / edit は既存 `Routine` を対象に
するので、FK 親として行が既にあることが前提 — **機械的に全 write path を
`requireProvisionedUserId()` にしない。**

| | |
|---|---|
| 依存方向 | `session → provisioning → users persistence`。**`lib/users.ts` から session/auth を参照しない**(逆方向依存を作らない) |
| `ensureUser` | upsert。id / email / name / image を扱い、**`timezone` には触れない** — provider profile の refresh が設定を上書きしてはいけない |
| session に email が無い場合 | **provisioning を成立させない。** `User.email` は NOT NULL かつ unique で、dummy / synthetic email は捏造された identity を制約に本物として扱わせる |
| `UserProvisioningError` | `ExecutionSuppressedError` / `RunPersistenceError` と同じ最小構成(1クラス + 1述語)。**taxonomy ではない** — `redirect()` も throw で抜けるため、包括 catch が `NEXT_REDIRECT` を飲むのを防ぐためだけに存在する。これ以上広げない |
| `getUserTimezone` の UTC fallback | **維持。** これは read-side fallback であって provisioning ではない。**読み取りが行を作ってはいけない** |
| `nextRunAt` | timezone 保存で**再計算しない**。既存の「frequency 変更なし → slot 保持」を維持 |
| 有効な write での `auth()` 2回 | **許容する。** authentication と provisioning の責務分離を優先した。`requireUserId({ provision: true })` のような flag API は作らない |

### Sprint 43 — 入力契約の締め直し

#### NEW-1 — 無人で繰り返す Worker には prompt が要る

**問題は「空 prompt を保存できること」ではない。** Run ボタンは status で
制限されておらず、`draft` / `paused` / `active` のすべてで手動実行できる
(UI 自身が paused について "Manual runs still work." と書いている)。よって
「実行可能なら prompt 必須」にすると**全 Worker が必須**になり、下書き導線が
壊れる。

**契約は「Koqentra が無人で繰り返し実行する ⇒ prompt が要る」。**

```
effectiveStatus === "active" && effectiveFrequency !== "manual" && prompt === ""
  → invalid: "Prompt is required for scheduled active workers."
```

| status | frequency | 空 prompt |
|---|---|---|
| draft | 任意 | 許可 |
| paused | 任意 | 許可 |
| active | manual | **許可**(`nextRunAt` が null で scheduler が選ばない) |
| active | daily / weekly / monthly | **拒否** |

**「prompt は常に required」と書かないこと。**

| | |
|---|---|
| 判定する値 | **実際に保存される実効値**。`validateWorkerForm(input, { status, frequency })` に渡す。`input.status` を直接見ると、**status を含まない POST → `input.status = null` → `existing.status`(active) へ fallback** で迂回できてしまう |
| fallback の位置 | **検証の前**。create は `?? "draft"` / `?? "manual"`、edit は `?? existing.*`。**純粋計算のみ**なので Sprint 42 の `authentication → validation → provisioning → write` を壊さない |
| 空判定 | `input.prompt === ""`。`readWorkerForm` が trim 済みなので空白のみもここに落ちる。**既存の `!input.name` と同じ前提**に乗せてあり、validator 側で二重に trim しない |
| 適用範囲 | **write-time のみ。** 既に保存されている `active` + 定期 + 空 prompt の行は**自動修復されない**。直るのは次に編集して保存したとき。**本番にその行があるかは確認していない** |

#### NEW-6 — prompt 変数は own property だけ

`name in variables` はプロトタイプチェーンを辿るため、`{{constructor}}` /
`{{toString}}` / `{{__proto__}}` 等が展開されていた。documented contract は
「unknown はそのまま残す」なので**矛盾**。`Object.hasOwn(variables, name)` に
変更。

**correctness の修正であって security 修正ではない。** 読み取りのみで
prototype 汚染はなく、混入先はモデルへ送る prompt 本文だけ。ユーザーは元々
prompt に任意の文字列を書けるので新しい権限は生まれない。**誇張しないこと。**

#### NEW-3 — 1行も更新していないなら success ではない

`updateRoutine` は `updateMany` の `count === 0` で `null` を返す(例外は
投げない)。edit action がその戻り値を捨てていたため、**read と write の間に
Worker が削除されると「保存しました」と表示していた**。

戻り値を確認し、`null` なら `"Worker not found."` を返して `revalidatePath` も
行わない。`deleteWorkerAction` が既にやっている判断を edit にも入れただけ。

**これは optimistic locking ではない。** `updateRoutine` の contract も変えて
いない。**行が見つかった2つの save は今も last-write-wins** で、その Backlog は
未解決のまま(上の「決定済み」を参照)。

### Sprint 44 — Failure Observability & Action Consistency Hardening

#### NEW-7 — delete だけが DB 例外を握っていなかった

`deleteWorkerAction` にだけ try/catch が無く、`deleteRoutine` が throw すると
**server action の外へ伝播**していた。しかも詳細ページからの削除は `await` の
**前**に `router.push()` するため、例外はもう離れたページに向かって出ていた。

他4つの action(create / edit / run / timezone)は**すべて自分の write を
catch している**。**delete だけが例外だった**ので、同じ形に揃えただけ。

| ケース | 返す値 | revalidate |
|---|---|---|
| 削除された | `"Worker deleted."` | `/dashboard` |
| 一致する行なし(存在しない / 他人のもの) | `"Worker not found."` | **なし** |
| **DB 例外** | **`"Could not delete the worker."`** + `console.error("[worker] delete failed", error)` | **なし** |

**navigation の順序は変更していない。** `components/delete-worker-button.tsx`
は無変更。**閉じたのは server action の unhandled persistence exception であって、
削除失敗時の UX 全面再設計ではない。**

#### execution failure observation — pull 型の観測1行

**解いた問題:** 実行が失敗しても運営者に届く手段が**1つも無かった**。
`RunHistory` を全テナント横断で読む query は存在せず、role も admin route も
無い(今も無い)。ユーザーは Activity / Health で見えるが、運営者は見えない。

```
[cron] execution failures — last_failed_at=none
[cron] execution failures — last_failed_at=<ISO8601>
```

| | |
|---|---|
| query | `latestExecutionFailureAt()` — `findFirst({ where:{status:"failed", finishedAt:{not:null}}, orderBy:{finishedAt:"desc"}, select:{finishedAt:true} })` |
| 範囲 | **全テナント横断**(`getDueWorkers` と同じ立場)。1行 / 1列 |
| コスト | cron tick あたり **read-only query +1** |
| 出力 | timestamp のみ。**prompt / output / errorMessage / runId / routineId / userId / email は一切出さない** |
| 頻度 | **毎ティック出す。** `due workers — count=` と同じ理由 — 出たり出なかったりする行は「失敗が無い」と「チェックが動いていない」を区別できない |

**これは notification ではない。** alert でも threshold 判定でも count でも
window 集計でもない。**自動で届くものは何も無く、人がログを読む必要がある。**

| 決定 | 理由 |
|---|---|
| **window を持たない** | 導出できる定数が無い。cron interval は Railway の設定でリポジトリに存在せず、application code へ書くと**同じ値が2箇所に分かれて同期されない**。最新1件なら window 不要で **miss が構造的にゼロ** |
| **duplicate を許容する** | 次の失敗が起きるまで同じ timestamp が毎ティック出続ける。**これは意図した挙動で、直す対象ではない**。観測ログなので副作用が小さく、miss を作らない方を優先した |
| **件数(magnitude)を出さない** | window 値が要る。**「必須」ではない** |
| **manual / scheduled を区別しない** | `RunHistory` に trigger 列が無い。**schema を足して区別しない。** 手動失敗も候補に入るが、provider が壊れていれば検知が早まる面もある |
| **queue に依存しない** | `enqueueRoutine` の戻り値・dispatcher の局所変数・inline 実行のいずれにも依存せず、`RunHistory` の failed 行だけを読む。**ただし「将来の queue 実装で動作保証済み」とは言えない** |
| **観測が観測対象を変えない** | 読み取り失敗は**その場で catch**。tick は 200 のまま、heartbeat も飛ぶ。落とすと監視が監視対象の結果を決めることになる |

**Cron API の `{success, dispatched, failed}` は変更していない。**
`failed` は今も「開始できなかった worker の数」で、実行失敗の件数ではない。
`last_failed_at` を response に入れていない。

**Healthchecks の意味も変更していない。** heartbeat は今も
「cron container が動き、cron API が HTTP 2xx を返した」という infrastructure
health で、**実行失敗を heartbeat 失敗にしない**。

**errorKind の永続化は Sprint 44 でも実装していない。**
`ProviderErrorKind` を `RunHistoryErrorKind` として扱わない。本番の provider
failure が未観測のまま schema / taxonomy を先に固定しない。

**本番実測の境界:** 2026-08-11 の自然 tick で `last_failed_at=none` を確認した。
これは**その時点で `status="failed"` の行が見つからなかった**ことだけを意味する。
「本番で失敗が起きない」「provider failure が存在しない」「失敗経路を本番で
実測した」とは**言えない**。**failed>0 側は unit test のみで、人工 failure は禁止。**

### Sprint 45 — Closed Beta Access & Privacy Readiness

#### admission control — `BETA_ALLOWED_EMAILS`

**Production URL の秘匿ではなく、明示的に許可した Google アカウントだけが
sign-in できる状態にした。** 判定は `auth.ts` の `signIn` callback から
`lib/beta-access.ts` の純粋関数2つを呼ぶだけ。

| 決定 | 理由 |
|---|---|
| **環境変数(comma-separated)。DB でも repository でもない** | repository に実ユーザーの email を書くと **git 履歴から消せない**。DB 方式は `auth.ts` に DB import が要り、**「adapter を入れない = middleware を Edge で動かす」という根拠を壊す** |
| **fail-closed。** 未設定 / 空 / 空白のみ / カンマのみ / parse 後0件 → **全員 deny** | 目的は「許可していない利用者を本番へ入れない」こと。**設定漏れで無制限 sign-in に戻る fail-open はその目的と矛盾する。** `CRON_SECRET` の fail-closed と設計思想を揃えた |
| **判定は3条件の AND** | `profile.email` が存在 / **`email_verified === true`** / trim + lowercase 後に allowlist に一致 |
| **正規化は trim + lowercase だけ** | Gmail のドット無視や `+alias` を再現すると **provider の代理で推測することになる**。広く推測すれば誰も書いていない address が入り、狭く推測すれば招待した人が締め出される。**書いたとおりに比較する** |
| **`lib/beta-access.ts` に分離** | `auth.ts` を薄く保ち Edge 互換を維持。**純粋関数なので Vitest で直接テストできる**(`auth.ts` 自体にはテストが無い)。Public Beta 移行時は**ファイルごと消せる** |
| **拒否のログを一切追加しない** | email も allowlist も、出せば**ログがそれを保持することになる**。拒否された本人は landing の1文で結果を知る。件数ログも追加しない |
| **`pages.error = "/"`** | Auth.js が `?error=AccessDenied` を付けて landing へ戻す。**付くのは型名だけで address も list も載らない**。landing は「招待制である」ことしか言わない |

**拒否は何も残さない。** `signIn` が false を返すと `jwt` に到達せず、token も
cookie も `User` row も作られない(row は provisioning 境界で作られ、そこへは
session が要る)。

**allowlist はプロセス起動時に1度だけ parse する**(provider factory が
`ANTHROPIC_API_KEY` を1度読むのと同じ)。**変更には再起動 / redeploy が必要。**

**rollout の順序を守ること: 変数設定 → コード deploy。** 逆順にすると
fail-closed により**全員が sign-in できなくなる**。

**既存 JWT は即時失効できない**(NEW-12)。JWT にサーバ側ストアが無いため、
発行済み token は期限まで有効。**allowlist が制御するのは「次に誰が入れるか」で
あって「今誰が入っているか」ではない。** Sprint 45 では拡張しない。

#### `/privacy`

公開ページ。**現在の実装から言えることだけを書いた。** 「保存しない」「一定期間で
自動削除する」「アカウント削除を依頼できる」等、**実装に存在しないことは書かない**。

**Contact section は作っていない** — 正式な support contact が未確定で、
**placeholder や推測した連絡先を production に入れない**ため。不要という判断では
なく、確定後の future work。

**Terms of Service は Sprint 45 対象外。** 技術判断ではなく法務・事業判断のため。
**不要と判断したわけではない。**

**landing が static → dynamic になったのは意図した変更。** `searchParams` を
Server Component で読むため。Client Component / `useSearchParams` / Suspense は
追加していない。

### Documentation Sprint — 利用者向けドキュメントと template の能力整合

> **この節のテンプレート5件は Template Refresh Sprint で全件置き換えられた**
> (下の節)。**残しているのは経緯の記録** — 「実装にない能力を約束していた」
> という失敗と、その検知が人の再読でしかできなかったという事実は、
> 新しいテンプレートにも同じだけ当てはまる。現在の8件については下の節を見ること。

**ドキュメントを書き始めた時点で、現在のコードを source of truth として
確認した結果、`lib/worker-templates.ts` が実装にない能力を約束していた。**
実装せずに報告し、PM の判断で「能力整合の修正」として先に直した
(**feature sprint ではない**)。

- 5件中3件が、Koqentra ができないことを前提に書かれていた —
  「今日の重要ニュース」「受信箱の未返信メール」「追跡中トピックを出典付きで
  調査」。**worker は prompt 1本のモデル呼び出し**で、browsing / search /
  inbox / calendar / files / tool use / MCP / 前回実行の記憶はどれも無い。
- **しかもそういう run は success として記録される。** 出力が根拠に基づくか
  捏造かを判定できる箇所がパイプラインに1つも無いため。
- 修正は5件すべてを「利用者が material を貼る」形にし、**`defaultFrequency` を
  全件 `manual`** にした。prompt が入力を抱えている以上、cadence で回しても
  同じことを繰り返して課金するだけになる。**id / name は変更していない。**
- 変数は `{{today}}` / `{{now}}` のみ。**新しい変数は追加していない。**
- **template の "Use only what is written below" はモデルへの指示であって、
  プラットフォームの保証ではない。** 誇張しないこと。

**能力の欠落そのものは直していない。** 文言は直せるが、外部データに触れる
手段が無いという事実は残る。README Backlog に **Product** として2項目
(能力境界 / 捏造が success になること)を記録した。
**次スプリントで外部連携を実装すると決まってはいない** — 選択肢も範囲も未決。

新規ドキュメントは `docs/USER_GUIDE.md` / `docs/USE_CASES.md` /
`docs/TROUBLESHOOTING.md` の3点で、**利用者向け**(README は開発者向けのまま)。
TROUBLESHOOTING には運営者向けの節があり、Healthchecks は infrastructure の
heartbeat、`last_failed_at` は**読みに行く観測であって通知ではない**ことを
そこに明記してある。README は導線の追加と Backlog の追記だけで、
**Architecture / Roadmap / 履歴の構成は変更していない。**

### Email Notification MVP — worker ごとの opt-in メール通知

**Koqentra が外へ何かを送るのは、これが初めて。** 判断の中身は上の「決定済み」に
13行入れた。ここには、そこに収まらない事実だけ書く。

- **schema は `Routine` に Boolean 1列 (`emailNotificationsEnabled`)、migration 1本。**
  `RunHistory` / `User` / `RateLimitBucket` / `ManualRunSlot` / `DomainThrottle` は
  **無変更**。通知用の table も、送信済みを記録する列も**作っていない**。
- **通知の判定表**(これが policy のすべて):

  | | website | prompt |
  |---|---|---|
  | initial(初回 baseline) | **送らない** | — |
  | unchanged | **送らない** | — |
  | changed | **送る** | — |
  | completed | — | **送る**(output が空でも) |
  | failed | **送る** | **送る** |
  | `WatcherErrorKind === "throttled"` | **送らない** | — |
  | `RunPersistenceError` | **送らない** | **送らない** |
  | `emailNotificationsEnabled === false` | **送らない** | **送らない** |

- **境界は2枚。** `lib/notify/email.ts` が provider(Resend REST / `fetch` /
  timeout / 分類)、`lib/notify/run-notification.ts` が構成と best-effort 送信。
  後者は**絶対に throw しない** — 呼び元の `runRoutine` は、そこに到達した時点で
  outcome の記録が終わっている。
- **failure の分類語彙は3層で別々のまま。** `ProviderErrorKind`(モデル)、
  `WatcherErrorKind`(fetch)、`EmailDeliveryFailure`(送信)。混ぜない。
  ログに出る `reason=` は `EmailDeliveryFailure` + `recipient-unknown` /
  `link-unavailable` / `unknown` の3つ。
- **本文に `RunHistory.errorMessage` を入れない。** あの列は「届いた文言そのまま」で、
  provider の生の言葉が入りうる。失敗メールは固定文 + Run Detail へのリンクだけ。
- **リンクは `AUTH_URL` から `URL` API で作る。** 文字列連結だと `//dashboard` が
  作れてしまう。`AUTH_URL` が無い / http(s) でないなら **delivery failure** であって
  run failure ではない。
- **本文の切り詰めは 2,000 文字**(`MAX_NOTIFIED_OUTPUT_CHARS`)。超えたら定型文を足す。
  **AI の出力と worker 名は翻訳しない** — 訳すのは Koqentra 自身の文言(9キー)だけ。
- **翻訳の parity 検査に1行足した。** `notify.email.worker` は en/ja で同一文字列
  (`Worker: {name}`)なので、`lib/i18n/index.test.ts` の「同一を許すキー」一覧に
  明示的に加えてある。**黙って同一になったのではない。**
- **`/privacy` に1節足した。** 送信は新しい外部データフロー(宛先アドレスと出力の
  一部が送信サービスへ渡る)で、書かなければあのページの記述が不完全になる。
  **`app/privacy/page.tsx` の「すべての文が実装を説明する」という前提を守るための修正**
  であって、feature の一部ではない。
- **`.env.example` に `EMAIL_FROM` / `RESEND_API_KEY` を追記した**(BOM と CRLF、
  末尾改行なしを保存)。README が「`.env.example` は Koqentra が読む変数をすべて挙げる」
  と書いているため。

**Production E2E — 実測済み(2026-09-01 〜 2026-09-02)。**

Resend の送信ドメイン `send.koqentra.com` を Verified にし、Railway web service に
`RESEND_API_KEY` と `EMAIL_FROM` を設定したうえで、Production UI からの通常操作
(Website Worker 新規作成 + 手動実行)で3状態すべてを通した。

| # | 状態 | 実測結果 |
|---|---|---|
| 1 | **initial** | Manual Run 成功 → baseline 作成 → output「サイトの初回状態を記録しました。」→ **メール通知なし** |
| 2 | **changed** | fixture `https://takarazuka-today.jp/autoops-e2e` を VERSION 1 → VERSION 2 に変更 → change 検知成功 → **AI による日本語要約成功** → RunHistory 保存成功 → **Resend 送信成功** → **Gmail 受信トレイへ実到達** |
| 3 | **unchanged** | VERSION 2 のまま再実行 → output「サイトの内容に変更はありませんでした。」→ Run 成功 → **メール通知なし** |

これで
**initial → 通知なし / changed → AI 要約 + メール通知 / unchanged → 通知なし**
が Production で実証された。設計どおりであり、この3行はもう推測ではない。

**受信メールの Subject は
`[AutoOps]「Email通知 E2Eテスト」で変更を検出しました`
だった** — E2E 実施はブランド移行前なので、**これは歴史的事実としてそのまま記録する**。
Brand Migration Phase 1 以降に送られるメールの Subject は `[Koqentra]` になる。

**なお未確認のまま残るもの:**

- **失敗経路は本番未観測。** `rejected` / `unreadable` / `timeout` は unit test のみで、
  本番で失敗した送信は1件も無い。
- 実測したのは website worker の3状態のみ。**prompt worker の completed 通知は
  本番未実施**(判定経路は同一だが、実測ではない)。

### Template Refresh — Closed Beta 向けテンプレート刷新

**「何を AI Worker に任せられるか」がテンプレートだけで分かる状態を作るスプリント。**
判断の中身は上の「決定済み」に6行入れた。ここには残りの事実だけ書く。

- **8件 = website 5 + prompt 3。** 旧5件(News Reporter / X Post Writer /
  Email Assistant / Meeting Assistant / Research Analyst)は**全件置き換えた**。
  id はどこにも永続化されていない(テンプレート用の table も列も無い)ので、
  差し替えても既存 worker には一切影響しない。
- **`WorkerTemplate` の形が変わった。** `name` / `description` / `defaultPrompt`
  の生文字列 → `nameKey` / `descriptionKey` / `promptKey`(`TranslationKey`)と
  `kind`。`injectTemplate(template, language, token)` に language が増えた。
- **`{{today}}` / `{{now}}` は辞書の中でもそのまま生き残る。** `t()` は values を
  渡したときしか置換せず、テンプレートは values なしで引く。**ここは暗黙の前提なので
  テストで固定してある**(`lib/worker-templates.test.ts`)。
- **schema 変更なし / migration なし / 依存追加なし。** Email Notification MVP の
  commit には一切触れていない。
- **テストは「文言が実装の能力を超えていないこと」を検査する。** website 側は
  検索・巡回・収集を示唆する語を禁止、prompt 側はメール・カレンダー・Slack・検索・
  取得を示唆する語を禁止し、素材の貼り付け位置があることを要求する。
  **前回テンプレートが実装にない能力を約束したとき、落ちるテストは1つも無かった** —
  それを繰り返さないための検査。

**未確認:**

- **ブラウザでの実操作は行っていない。** 検証したのは静的レンダリング
  (`renderToStaticMarkup`)までで、「カードを押す → kind が変わる → フォームが
  remount して値が入る」は**クリックを伴うため到達していない**。これは
  `injectTemplate` / `templatesOfKind` を純関数として切り出してある理由そのもので、
  関数側は固定済み。
- **テンプレートから作った worker を実行していない。** Anthropic 呼び出し・
  外部サイト取得はいずれも行っていない。

### Custom Domain Migration — AutoOps から Koqentra へ

**正式名称が Koqentra に決まり、Production の主 origin を
`https://app.koqentra.com` へ移した。** 判断は上の「決定済み」に4行入れた。
ここには経緯と実測だけ書く。

**段階移行の順序と、その順序でなければならなかった理由:**

| Phase | 内容 | 実測 |
|---|---|---|
| 1 | user-facing の `AutoOps` → `Koqentra`(commit `e560796`) | CI success / deploy SUCCESS / landing・privacy とも切替確認 |
| 2 | Railway に custom domain 追加 + DNS + TLS | `Verified: yes` / `CERTIFICATE_STATUS_TYPE_VALID` / 証明書は `CN=app.koqentra.com`(Let's Encrypt) |
| 3 | Google OAuth に新 redirect URI を**追加**(旧は残す) | authorization request で `redirect_uri_mismatch` なし。**未登録 URI を使った陰性対照では実際に mismatch を検出**しており、手法の妥当性まで確認済み |
| 4 | `AUTH_URL` を新 origin へ切替 | 自動 deployment SUCCESS。`/api/auth/providers` の callbackUrl が新 origin へ |
| 5 | 実 Google サインイン + Website Watcher / Email E2E | 下表 |

**Phase 1 が先で、Phase 3 が Phase 4 より先でなければならない。**
Phase 1 は URL に一切触れないので独立。Phase 3 → 4 の順を逆にすると、Google が
新 URI を知らない状態で Auth.js が送出し、**全員がサインイン不能になる**。

**Custom Domain 移行後の Production E2E(実測):**

| # | 状態 | 実測結果 |
|---|---|---|
| 1 | **initial** | fixture `https://takarazuka-today.jp/koqentra-e2e` VERSION 1 で初回 Manual Run → completed →「サイトの初回状態を記録しました。」→ **メール通知なし** |
| 2 | **changed** | fixture を VERSION 1 → VERSION 2 → Manual Run → completed → **AI 日本語要約成功** → **Gmail 実受信**。From `Koqentra <notifications@send.koqentra.com>` / Subject `[Koqentra]「Koqentra Email通知 E2E」で変更を検出しました` / **user-facing AutoOps 0件** / メール内リンク `https://app.koqentra.com/dashboard/runs/<run-id>` から**正しい Run Detail へ到達** |
| 3 | **unchanged** | VERSION 2 のまま Manual Run → completed →「サイトの内容に変更はありませんでした。」→ **メール通知なし** |

**上の「Email Notification MVP」節にある E2E 記録は移行前のもので、
Subject が `[AutoOps]` になっている。あれは歴史的事実として残してある** —
機械的に Koqentra へ書き換えないこと。

**E2E fixture が2つあるのは意図的:**

- `https://takarazuka-today.jp/autoops-e2e` — 移行前 E2E の証跡。**VERSION 2 固定**
- `https://takarazuka-today.jp/koqentra-e2e` — 移行後の回帰資産。**VERSION 2**

既存 fixture を VERSION 3 に上げる案(案A)ではなく**新 fixture を足す案(案B)を
採った**。既存の「VERSION 2 固定」制約を一つも破らず、戻し忘れが原理的に起きず、
専用ページが将来の回帰資産として残るため。**Snapshot を人工的に操作する案は
検討したうえで却下** — 「変更を検知した」ではなく「検知したことにした」状態になり、
E2E の検証価値そのものが消える。

**未確認:**

- **メール送信の失敗経路は本番未観測**(`rejected` / `unreadable` / `timeout` は
  unit test のみ)。
- **prompt worker の completed 通知は本番未実施**。判定経路は website と同一だが、
  実測ではない。
- **Production の Worker / Snapshot / RunHistory を Claude Code 側から読んでいない。**
  Postgres は内部ドメインのみで公開 proxy が無く、開けるには service 設定変更が要る。
  上の E2E 表は**ユーザーが UI で実施し報告した実測**であって、DB 照会ではない。

### 未確認 — 別途扱う

CI が緑でも検証されていないもの。**「動作確認済み」と言わないこと。**

- `classify()` の実 API による挙動(401 / 429 等)。型と SDK のクラス階層を
  実物のファイルで確認し、27件のテストで分類そのものは固定したが、**実際の
  エラー応答は一度も受けていない**。本番の provider failure は今も0件。
- **`ANTHROPIC_API_KEY` は Sprint 40 で有効性が確認済み**(成功実行1件)。
  ただし**確認できたのは「通る」ことだけ**で、失敗時の挙動・rate limit・
  長時間実行はいずれも未観測。
- **B-1(Sprint 42 で修正した provisioning の穴)を本番で再現確認していない。**
  correctness は unit test と Node 22 の CI で固定してある。本番で新規アカウント
  を人工的に作って再現した、という事実は**ない** — 両者を混同しないこと。
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
