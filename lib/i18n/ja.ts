import type { TranslationKey } from "@/lib/i18n/en";

/**
 * The Japanese copy.
 *
 * **`Record<TranslationKey, string>` is what keeps the two in step.** Leaving a
 * key out fails to compile, and inventing one that English does not have fails
 * too — so "the Japanese file is missing a line" cannot reach a screen, and
 * cannot reach a test either. It is caught where it is cheapest.
 *
 * **`Worker` stays `Worker`.** It is what the product calls the thing it makes,
 * on both sides of the switch;「作業員」would be a different noun about a
 * different subject. `Koqentra` is a name and is never translated either.
 *
 * **The language names are not both translated.** English readers choosing
 * between languages read "Japanese"; Japanese readers read「日本語」, because
 * that is what the language calls itself and what somebody looking for it will
 * scan for.
 */
export const ja: Record<TranslationKey, string> = {
  "nav.dashboard": "ダッシュボード",
  "nav.creator": "クリエイター",
  "nav.settings": "設定",
  "nav.signOut": "サインアウト",
  "nav.signedIn": "サインイン中",

  "dashboard.title": "私の AI チーム",
  "dashboard.description": "AI Worker を管理し、状況を確認します。",
  "dashboard.hireWorker": "Worker を作成",
  "dashboard.overview": "概要",
  "dashboard.workers": "Worker 一覧",
  "dashboard.empty": "Worker がまだありません。",
  "dashboard.hireFirstWorker": "最初の Worker を作成",
  "dashboard.activity": "実行履歴",
  "dashboard.activityEmpty":
    "実行履歴はまだありません。Worker の「実行」から動かせます。",

  "overview.total": "Worker 総数",
  "overview.active": "稼働中",
  "overview.paused": "一時停止",
  "overview.nextScheduledRun": "次回の予定実行",
  "overview.noneScheduled": "予定なし",
  "overview.overdue": "予定時刻を過ぎています",
  "overview.lastExecution": "最終実行",
  "overview.neverExecuted": "未実行",

  "worker.nextRun": "次回実行",
  "worker.manual": "手動",
  "worker.view": "詳細",
  "worker.run": "実行",
  "worker.running": "実行中…",

  "common.status.active": "稼働中",
  "common.status.paused": "一時停止",
  "common.status.draft": "下書き",

  "common.runStatus.running": "実行中",
  "common.runStatus.completed": "完了",
  "common.runStatus.failed": "失敗",

  "health.title": "状態",
  "health.success": "成功",
  "health.failed": "失敗",
  "health.running": "実行中",
  "health.neverRun": "未実行",
  "health.stuck": "想定より長く実行が続いています",
  // Japanese does not inflect for number, so both forms are the same sentence.
  // They stay two keys because English needs two, and the shape of a dictionary
  // is decided by the language that needs the most from it.
  "health.runs.one": "実行 {count} 回",
  "health.runs.other": "実行 {count} 回",
  "health.failures.one": "失敗 {count} 回",
  "health.failures.other": "失敗 {count} 回",

  "schedule.manual": "手動実行",
  "schedule.daily": "毎日",
  "schedule.weekly": "毎週",
  "schedule.monthly": "毎月",
  "schedule.everyWeekday": "毎週{day}",
  // The plain number, not the ordinal: 「毎月3日」rather than「毎月3rd」.
  "schedule.onDay": "毎月{day}日",
  "schedule.atTime": "{cadence} {time}",

  "common.weekday.sunday": "日曜日",
  "common.weekday.monday": "月曜日",
  "common.weekday.tuesday": "火曜日",
  "common.weekday.wednesday": "水曜日",
  "common.weekday.thursday": "木曜日",
  "common.weekday.friday": "金曜日",
  "common.weekday.saturday": "土曜日",

  "common.save": "保存",
  "common.saving": "保存中\u2026",
  "common.cancel": "キャンセル",
  "common.edit": "編集",
  "common.statusLabel": "ステータス",

  "worker.kind.prompt": "プロンプト",
  "worker.kind.website": "Web ページ監視",
  "worker.kind.promptOption": "AI に依頼する",
  "worker.kind.promptOptionDescription":
    "スケジュールに沿って、あなたの指示を AI に送ります。",
  "worker.kind.websiteOption": "Web ページを監視する",
  "worker.kind.websiteOptionDescription":
    "ページを確認し、変更があったときだけ AI を使います。",

  "worker.frequency.daily": "毎日",
  "worker.frequency.weekly": "毎週",
  "worker.frequency.monthly": "毎月",

  "worker.status.draftDescription":
    "下書きの Worker は自動実行されません。自動で動かすには、ステータスを「稼働中」にしてください。",
  "worker.status.activeDescription": "スケジュールに沿って自動的に実行されます。",
  "worker.status.pausedDescription":
    "予定された実行を停止しています。手動実行はできます。",

  "worker.prompt": "プロンプト",
  "worker.changeInstructions": "変更時の指示",

  "worker.field.name": "名前",
  "worker.field.namePlaceholder": "毎日のサイト更新チェック",
  "worker.field.description": "説明",
  "worker.field.descriptionPlaceholder": "この Worker の役割は?",
  "worker.field.websiteUrl": "Web ページのアドレス",
  "worker.field.promptPlaceholder": "毎回の実行で AI に送る指示。",
  "worker.field.changePrompt": "ページが変わったとき",
  "worker.field.changePromptPlaceholder":
    "このページが変わったら、AI に何をさせますか?",
  "worker.field.frequency": "実行頻度",
  "worker.field.weekday": "曜日",
  "worker.field.sameWeekday": "保存した曜日と同じ",
  "worker.field.monthDay": "日付",
  "worker.field.sameMonthDay": "保存した日と同じ",
  /** 「3rd」は英語の規則なので、日本語は素の数字を受け取る。 */
  "worker.field.monthDayOption": "{day}日",
  "worker.field.monthDayNote": "月末を超える日は、その月の最終日に実行されます。",
  "worker.field.emailNotifications": "メール通知",
  "worker.field.emailNotificationsWebsite":
    "このページの変更を検出したときにメールで通知します。",
  "worker.field.emailNotificationsPrompt":
    "この Worker の実行が完了したときにメールで通知します。",
  "worker.field.emailNotificationsFailure": "実行に失敗した場合も通知します。",
  "worker.field.runAt": "実行時刻",
  "worker.field.timezoneNote":
    "時刻はアカウントのタイムゾーン({timezone})で扱われます。空欄にすると、保存したときの時刻に実行されます。",
  /** 「未設定です」とは言わない — DB は既定の UTC と明示的な UTC を区別できない。 */
  "worker.field.timezoneSettingsLink": "設定から変更できます",

  "worker.create.description":
    "Worker は一度定義すれば、あとは Koqentra がスケジュールどおりに実行します。",
  "worker.create.draftHeading": "Koqentra に何を任せますか?",
  "worker.create.draftPlaceholder":
    "このページを毎日チェックして、重要な変更があれば要約して。",
  "worker.create.createDraft": "下書きを作成",
  "worker.create.drafting": "作成中\u2026",
  "worker.create.draftWatches": "{url} を監視します",
  "worker.create.draftSendsPrompt": "指示を AI に送信します",
  "worker.create.draftManual": "依頼したときに実行",
  /** 中黒は日本語の並記記号。値そのものは英語版と同じものが入る。 */
  "worker.create.draftSummary": "{what}\u30fb{cadence}",
  "worker.create.applyToForm": "フォームに反映",
  "worker.create.kindHeading": "この Worker は何をしますか?",
  /**
   * 初回チェックは成功していて、しかも「何も起きていない」ように見える。
   * baseline / snapshot / hash などの内部用語は使わず、
   * 「最初は記録するだけ」「そのときは通知しない」「次回から比べる」の3点だけを言う。
   */
  "worker.create.websiteFirstRunNote":
    "最初のチェックでは、いまのページの状態を記録するだけで通知は送りません。比べる相手がまだないためです。次回以降は記録した状態と比べて、変わったところがあればお知らせします。",

  "worker.create.templatesHeading": "テンプレートを選ぶ",
  "worker.create.templatesHelp":
    "テンプレートから始めるか、下のフォームに自分で入力してください。",

  "template.group.website": "Web を見ておいてもらう",
  "template.group.prompt": "AI に定期的に仕事をしてもらう",

  /**
   * テンプレートは名前・説明・指示の3つとも訳す。**適用した後に人が書いたものは
   * 訳さない** — 訳す対象は「AutoOps が例として差し出す文言」であって、
   * 利用者の素材ではない。
   *
   * `{{today}}` / `{{now}}` は**そのまま残す**。`t()` は values を渡したときしか
   * 置換せず、これらは values なしで呼ばれる。解決するのは `lib/prompt.ts`。
   *
   * Website の説明は「指定した1ページを見に行く」以上のことを示唆しないこと。
   * 検索・収集・巡回はどれも実装に無い。
   */
  "template.municipalNotices.name": "自治体のお知らせをチェック",
  "template.municipalNotices.description":
    "自治体のページを定期的に確認します。募集・イベント・手続きなどに変更があれば、AI が変更点を分かりやすくまとめます。",
  "template.municipalNotices.prompt": `このページで変わったところを、簡潔に分かりやすくまとめてください。

特に次の点に注目します。
- 募集の開始・終了
- 開催日時と場所
- 対象者
- 申込期限と手続き
- 追加・差し替え・削除された資料

変わっていない項目には触れないでください。ページに書かれていないことを補わないでください。`,

  "template.productPage.name": "商品価格・内容をチェック",
  "template.productPage.description":
    "商品ページを定期的に確認します。価格や商品内容が変わったら、AI が何が変わったかを分かりやすくまとめます。",
  "template.productPage.prompt": `この商品ページで変わったところを、簡潔に分かりやすくまとめてください。

特に次の点に注目します。
- 価格と、その変動幅
- 在庫や取り扱いの表示
- 仕様・内容・同梱物
- キャンペーンや割引と、その終了日
- 送料・保証などの販売条件

変わっていない項目には触れないでください。ページに書かれていないことを補わないでください。`,

  "template.careersPage.name": "会社の採用情報をチェック",
  "template.careersPage.description":
    "採用ページを定期的に確認します。新しい求人や募集内容に変更があれば、AI が職種・勤務地・条件などをまとめます。",
  "template.careersPage.prompt": `この採用ページで変わったところを、簡潔に分かりやすくまとめてください。

特に次の点に注目します。
- 追加された求人と、取り下げられた求人
- 職種と配属先
- 勤務地と、リモート可否
- 雇用形態・給与・応募条件
- 募集期間と応募締切

変わっていない項目には触れないでください。ページに書かれていないことを補わないでください。`,

  "template.newsPage.name": "ニュースページの更新をチェック",
  "template.newsPage.description":
    "指定したニュースページを定期的に確認します。新しい内容が追加されたら、AI が変更内容を簡潔にまとめます。",
  "template.newsPage.prompt": `このページで変わったところを、簡潔に分かりやすくまとめてください。

特に次の点に注目します。
- 追加された項目と、その内容
- 削除された項目
- 残っているが、文面や日付が変わった項目

新しく追加されたものから先に挙げてください。変わっていない項目には触れず、ページに書かれていないことを補わないでください。`,

  "template.grantInfo.name": "補助金・助成金情報をチェック",
  "template.grantInfo.description":
    "補助金などのページを定期的に確認します。募集開始や内容変更があれば、AI が対象・期限・変更点などをまとめます。",
  "template.grantInfo.prompt": `このページで変わったところを、簡潔に分かりやすくまとめてください。

特に次の点に注目します。
- 募集の開始・終了
- 対象者
- 対象経費
- 補助額や補助率
- 申請期限と必要書類

変わっていない項目には触れないでください。ページに書かれていないことを補わないでください。`,

  "template.dailyWorkPlan.name": "毎日の仕事を整理",
  "template.dailyWorkPlan.description":
    "登録した内容をもとに、AI が毎日の確認事項や作業を優先順位付きで整理します。",
  "template.dailyWorkPlan.prompt": `今日は {{today}} です。

下に書かれた内容だけを使って、今日の確認事項と作業を優先度の高い順に並べてください。
それぞれに「なぜその順番か」を一行添え、最後に「他の人に決めてもらう必要があること」をまとめてください。

下に書かれていないことは足さないでください。はっきりしない点は、埋めずに「不明」と書いてください。

--- 今日の予定・依頼・気になっていること ---
(ここに書いてください)`,

  "template.ideaGenerator.name": "定期的にアイデアを考える",
  "template.ideaGenerator.description":
    "登録したテーマについて、AI が実行のたびに新しいアイデアや改善案を考えます。",
  "template.ideaGenerator.prompt": `下のテーマについて、アイデアと改善案を5つ考えてください。
それぞれに「ねらい」と「最初の一歩」を一行ずつ添えてください。

同じ内容の言い換えにならないよう、5つは互いに違う方向のものにしてください。

下に書かれたことだけを前提にし、そこに無いことを事実として書かないでください。

--- テーマ ---
(ここに書いてください)`,

  "template.recurringReport.name": "定期レポートを作成",
  "template.recurringReport.description":
    "登録した情報やテーマをもとに、AI が毎回同じ形式でレポートを作成します。",
  "template.recurringReport.prompt": `作成日時: {{now}}

下の材料だけを使って、次の4つの見出しでレポートを作成してください。

1. 要約(3行)
2. 材料から分かること
3. 気になること
4. 次にやること

材料に無いことは書かないでください。書くことが無い見出しには「情報なし」と書いてください。

--- 材料 ---
(ここに書いてください)`,

  "worker.draft.notConfigured":
    "Koqentra に AI が設定されていないため、下書きを作成できません。",
  "worker.draft.empty": "Koqentra に任せたい内容を入力してください。",
  "worker.draft.tooLong": "内容は {limit} 文字以内にしてください。",
  "worker.draft.timeout":
    "下書きの作成に時間がかかりすぎました。もう一度お試しください。",
  "worker.draft.unavailable":
    "AI サービスに接続できませんでした。もう一度お試しください。",
  "worker.draft.unreadable":
    "Koqentra が回答を読み取れませんでした。内容を書き直してお試しください。",
  "worker.draft.limitReached":
    "AI 下書きの利用上限に達しました。しばらくしてからもう一度お試しください。",
  "worker.draft.failed":
    "現在、AI 下書きを作成できません。しばらくしてからもう一度お試しください。",

  // Creator 側では「下書き」を使わない。Worker の設定案を指す語として既に
  // 使われており、投稿本文を同じ語で呼ぶと、どちらの話か読み手に分からなく
  // なる。こちらが作るのは「投稿文」。
  "creator.analysis.notConfigured":
    "Koqentra に AI が設定されていないため、文章を読み取れません。",
  "creator.analysis.empty": "読み取りたい文章を貼り付けてください。",
  "creator.analysis.tooLong": "文章が長すぎるため、一度に読み取れません。",
  "creator.analysis.limitReached":
    "1 時間あたりの上限に達しました。しばらくしてからもう一度お試しください。",
  "creator.analysis.timeout":
    "読み取りに時間がかかりすぎました。もう一度お試しください。",
  "creator.analysis.unavailable":
    "AI サービスに接続できませんでした。もう一度お試しください。",
  "creator.analysis.unreadable":
    "AI の回答を読み取れませんでした。もう一度お試しください。",
  "creator.analysis.failed":
    "現在この処理を実行できません。しばらくしてからもう一度お試しください。",
  "creator.analysis.done": "文章を読み取りました。",

  "creator.feedback.saved": "ご回答を記録しました。",
  "creator.feedback.alreadyRecorded": "この提案にはすでに回答済みです。",
  "creator.feedback.invalid": "この提案に対しては、その回答を記録できません。",
  "creator.feedback.failed":
    "現在は保存できませんでした。もう一度お試しください。",

  // Creator 画面。「下書き」と「実行」はここでは使わない — 前者は Worker の
  // 設定案、後者は Worker の1回の実行を既に指しており、同じ語を二重に使うと
  // どちらの話か読み手に分からなくなる。ここで作るのは「投稿文」、行うのは
  // 「分析」。
  "creator.inbox.title": "レビュー待ち",
  "creator.inbox.description":
    "Koqentra からの提案です。このまま使うか、書き直すか、見送るかを選んでください。",
  "creator.inbox.analyzeCta": "コンテンツを分析",
  "creator.inbox.emptyTitle": "レビュー待ちはありません",
  "creator.inbox.emptyBody":
    "コンテンツを分析すると、X・Reddit・長文向けの提案がここに届きます。",
  "creator.inbox.untitled": "タイトルなし",
  "creator.inbox.pending": "{count} 件待ち",

  "creator.channel.x": "X",
  "creator.channel.reddit": "Reddit",
  "creator.channel.longform": "長文",

  "creator.verdict.recommend": "おすすめ",
  "creator.verdict.skip": "見送り",

  "creator.postText": "投稿文",

  "creator.feedback.useAsIs": "このまま採用",
  "creator.feedback.editAndUse": "編集して採用",
  "creator.feedback.reject": "却下",
  "creator.feedback.agreeWithSkip": "見送りに同意",
  "creator.feedback.wouldPost": "投稿したい",
  "creator.feedback.save": "保存",
  "creator.feedback.cancel": "キャンセル",
  "creator.feedback.editLabel": "あなたの文章",
  "creator.feedback.sending": "保存中…",

  "creator.new.title": "コンテンツを分析",
  "creator.new.description":
    "Koqentra が貼り付けた文章を読み、X・Reddit・長文それぞれについて投稿する価値があるかを判断し、ある場合は投稿文を作ります。見送りという答えも正常な結果です。",
  "creator.new.titleLabel": "タイトル",
  "creator.new.titleOptional": "任意",
  "creator.new.bodyLabel": "本文",
  "creator.new.bodyPlaceholder": "読み取ってほしい文章を貼り付けてください。",
  "creator.new.submit": "分析する",
  "creator.new.submitting": "分析中…",
  "creator.new.learningNote":
    "過去の採用・編集・却下は、次回以降の分析の参考として使われます。",
  "creator.new.privacyNote":
    "入力した内容は、分析のため Anthropic に送信されます。",
  "creator.new.privacyLink": "プライバシー",

  // 次の分析に渡るものを、渡る前に見せる。ここに出るのは本人が設定した内容と
  // 本人が実際に選んだ結果だけで、「AI が学習したあなたの好み」ではない —
  // Koqentra はそういう要約をまだ作っていないので、作ったように書かない。
  "creator.learning.title": "今回の分析で参考にする内容",
  "creator.learning.description":
    "あなたが設定した発信の前提と、最近の回答を参考にします。",
  "creator.learning.profileHeading": "発信の前提",
  "creator.learning.audience": "届けたい相手",
  "creator.learning.goals": "発信の目的",
  "creator.learning.voice": "文体・書き方",
  "creator.learning.notSet": "未設定",
  "creator.learning.answersHeading": "最近の回答",
  "creator.learning.answerCount": "{count} 件 / 最大 {limit} 件",
  "creator.learning.noAnswers": "まだ回答履歴はありません。",
  "creator.learning.youLabel": "あなた",
  "creator.learning.untitled": "タイトルなし",
  "creator.learning.detailNote":
    "分析時には、過去の判断理由・提案された投稿文・あなたが編集した文章・元のコンテンツの短い抜粋も参考にすることがあります。",

  // 保存値（approve / edit / reject）をそのまま出さない。同じ approve でも
  // 「おすすめに従って投稿する」と「見送りに同意する」では意味が違い、
  // 内部語を読み手に翻訳させることになる。skip + edit は repository が
  // 弾くので存在しない。
  "creator.learning.action.usedAsIs": "このまま採用",
  "creator.learning.action.editedAndUsed": "編集して採用",
  "creator.learning.action.rejected": "却下",
  "creator.learning.action.agreedWithSkip": "見送りに同意",
  "creator.learning.action.wouldPost": "投稿したい",

  "worker.detail.noDescription": "説明はありません。",
  "worker.detail.workerType": "Worker の種類",
  "worker.detail.unrecognised": "不明",
  "worker.detail.lastRun": "前回の実行",
  "worker.detail.createdAt": "作成日時",
  "worker.detail.updatedAt": "更新日時",
  "worker.detail.watchedPage": "監視中のページ",
  "worker.detail.runHistory": "実行履歴",
  "worker.detail.runHistoryEmpty": "この Worker はまだ実行されていません。",
  "worker.detail.dangerZone": "危険な操作",
  "worker.detail.deleteWarning":
    "この Worker を削除すると、実行履歴も削除されます。元に戻せません。",

  "worker.delete.button": "削除",
  "worker.delete.deleting": "削除中\u2026",
  "worker.delete.confirmTitle": "「{name}」を削除しますか?",
  "worker.delete.confirmBody": "実行履歴も削除されます。元に戻せません。",

  "worker.edit.title": "Worker を編集",
  "worker.edit.description": "変更は次回の実行から反映されます。",
  /**
   * 英語版と同じ3点を保つこと。弱めると、目に見えない仕組みについて
   * 事実と違うことを言うことになる。
   *
   * - 「次にチェックが成功した時点で」— 「次回のチェック」ではない。
   *   取得に失敗したチェックは基準を作らない。
   * - 「変更が検出された」として扱わない — 「変更なし」ではない。
   * - 過去の実行履歴は残る — 捨てられるのは比較の基準だけ。
   */
  "worker.edit.baselineReset":
    "アドレスを変更すると、比較の基準はリセットされます。次にチェックが成功した" +
    "時点で、Koqentra は新しいページを「変更が検出された」として扱わず、新しい" +
    "基準を作り直します。過去の実行履歴はそのまま残ります。",

  "run.detail.title": "実行の詳細",
  "run.detail.back": "ダッシュボードに戻る",
  /** 製品固有の語なので、日本語でもそのまま。 */
  "run.detail.worker": "Worker",
  "run.detail.executionTime": "実行時間",
  "run.detail.startedAt": "開始日時",
  "run.detail.finishedAt": "終了日時",
  "run.detail.renderedPrompt": "展開後のプロンプト",
  "run.detail.output": "出力",
  "run.detail.error": "エラー",

  "worker.validation.nameRequired": "名前は必須です。",
  "worker.validation.promptRequiredForScheduled":
    "稼働中で定期実行する Worker にはプロンプトが必要です。",
  "worker.validation.tooLong": "{label}は{limit}文字以内で入力してください。",
  "worker.validation.websiteUrlRequired":
    "Web ページのアドレスは必須です。",
  "worker.validation.changePromptRequired":
    "ページが変わったときに何をするかを入力してください。",
  /** 例に出すアドレスは URL なので、日本語版でもそのまま。 */
  "worker.validation.websiteUrlInvalid":
    "https://example.com/news のような完全なアドレスを入力してください。",
  "worker.validation.summary": "{count} 件の入力を確認してください。",

  "worker.validation.totalLimitReached":
    "Worker の数が上限（{limit}）に達しています。追加するには既存の Worker を削除してください。",
  "worker.validation.activeLimitReached":
    "同時に Active にできる Worker は {limit} 個までです。別の Worker を Active にするには、どれかを一時停止してください。",

  "worker.action.kindRequired":
    "この Worker がプロンプトを実行するのか、ページを監視するのかを選んでください。",
  "worker.action.notFound": "Worker が見つかりません。",
  "worker.action.createFailed": "Worker を作成できませんでした。",
  "worker.action.created": "Worker「{name}」を作成しました。",
  "worker.action.noWatchedPage":
    "この Worker には監視するページがないため、保存できません。",
  "worker.action.saveFailed": "Worker を保存できませんでした。",
  "worker.action.saved": "Worker「{name}」を保存しました。",
  "worker.action.deleteFailed": "Worker を削除できませんでした。",
  "worker.action.deleted": "Worker を削除しました。",

  "run.system.websiteBaseline": "サイトの初回状態を記録しました。",
  "run.system.websiteUnchanged": "サイトの内容に変更はありませんでした。",

  /**
   * 括弧は日本語の引用記号。`{name}` は利用者が入力した名前がそのまま入り、
   * 本文に載る AI の要約や出力も翻訳しない。訳すのは AutoOps 自身の文言だけ。
   */
  "notify.email.changedSubject": "[Koqentra]「{name}」で変更を検出しました",
  "notify.email.completedSubject": "[Koqentra]「{name}」が完了しました",
  "notify.email.failedSubject": "[Koqentra]「{name}」の実行に失敗しました",
  "notify.email.worker": "Worker: {name}",
  "notify.email.detectedAt": "検出日時: {time}",
  "notify.email.executedAt": "実行日時: {time}",
  "notify.email.failedBody":
    "実行に失敗しました。詳しい内容は Koqentra で確認してください。",
  "notify.email.truncated": "続きは Koqentra で確認できます。",
  "notify.email.viewRun": "この実行の詳細は Koqentra で確認できます:",

  "run.action.noWorkerSelected": "Worker が選択されていません。",
  "run.action.alreadyRunning": "「{name}」は実行中です。",
  "run.action.userBusy":
    "別の実行がまだ進行中です。完了してからもう一度お試しください。",
  "run.action.rateLimited":
    "手動実行の利用上限に達しました。しばらくしてからもう一度お試しください。",
  "run.action.couldNotStart":
    "「{name}」を開始できませんでした。しばらくしてからもう一度お試しください。",
  "run.action.outcomeNotRecorded":
    "「{name}」は開始しましたが、結果を記録できませんでした。",
  "run.action.failed": "「{name}」の実行に失敗しました。",
  "run.action.succeeded": "「{name}」を実行しました。",

  "settings.title": "設定",
  "settings.description":
    "Koqentra がこのアカウントの時刻をどう読み、いつ実行するか。",
  "settings.timezone.title": "タイムゾーン",
  /**
   * 英語版と同じ2点だけを言うこと。
   *
   * - 表示と「09:00 に実行」がこのタイムゾーンで読まれる
   * - すでに予定されている次回実行は変わらない
   *
   * その次の実行がどうなるかは、Run at の有無で挙動が分かれるため
   * 英語版と同じく**書かない**。
   */
  "settings.timezone.note":
    "タイムスタンプはこのタイムゾーンで表示され、09:00 に実行する Worker は" +
    "ここでの 09:00 に実行されます。タイムゾーンを変更しても、すでに予定されて" +
    "いる次回実行は変わりません。",
  "settings.timezone.invalid": "一覧からタイムゾーンを選んでください。",
  "settings.timezone.failed": "タイムゾーンを保存できませんでした。",
  "settings.timezone.saved": "タイムゾーンを保存しました。",

  "settings.language.title": "言語",
  "settings.language.description":
    "Koqentra の画面に使う言語です。Worker と、その出力には影響しません。",
  "settings.language.label": "言語",
  "settings.language.english": "English",
  "settings.language.japanese": "日本語",
  "settings.language.saved": "言語を保存しました。",
  "settings.language.invalid": "一覧から言語を選んでください。",
  "settings.language.failed": "言語を保存できませんでした。",

  /** 問い合わせ先が未設定の deployment では、この節ごと表示されない。 */
  "settings.support.title": "サポート",
  "settings.support.description":
    "Koqentra は Closed Beta です。思ったとおりに動かないとき、そもそも動いているのか分からないときは、お気軽にご連絡ください。ベータはそのためのものです。",
  "settings.support.action": "メールで問い合わせる",
  "settings.support.subject": "Koqentra サポート",
};
