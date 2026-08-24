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
 * different subject. `AutoOps` is a name and is never translated either.
 *
 * **The language names are not both translated.** English readers choosing
 * between languages read "Japanese"; Japanese readers read「日本語」, because
 * that is what the language calls itself and what somebody looking for it will
 * scan for.
 */
export const ja: Record<TranslationKey, string> = {
  "nav.dashboard": "ダッシュボード",
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
  "worker.field.runAt": "実行時刻",
  "worker.field.timezoneNote":
    "時刻はアカウントのタイムゾーン({timezone})で扱われます。空欄にすると、保存したときの時刻に実行されます。",

  "worker.create.description":
    "Worker は一度定義すれば、あとは AutoOps がスケジュールどおりに実行します。",
  "worker.create.draftHeading": "AutoOps に何を任せますか?",
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
  "worker.create.templatesHeading": "テンプレートを選ぶ",
  "worker.create.templatesHelp":
    "テンプレートから始めるか、下のフォームに自分で入力してください。",

  "worker.draft.notConfigured":
    "AutoOps に AI が設定されていないため、下書きを作成できません。",
  "worker.draft.empty": "AutoOps に任せたい内容を入力してください。",
  "worker.draft.tooLong": "内容は {limit} 文字以内にしてください。",
  "worker.draft.timeout":
    "下書きの作成に時間がかかりすぎました。もう一度お試しください。",
  "worker.draft.unavailable":
    "AI サービスに接続できませんでした。もう一度お試しください。",
  "worker.draft.unreadable":
    "AutoOps が回答を読み取れませんでした。内容を書き直してお試しください。",

  "worker.detail.noDescription": "説明はありません。",
  "worker.detail.workerType": "Worker の種類",
  "worker.detail.unrecognised": "不明",
  "worker.detail.lastRun": "前回の実行",
  "worker.detail.createdAt": "作成日時",
  "worker.detail.updatedAt": "更新日時",
  "worker.detail.watchedPage": "監視中のページ",
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
    "時点で、AutoOps は新しいページを「変更が検出された」として扱わず、新しい" +
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

  "run.action.noWorkerSelected": "Worker が選択されていません。",
  "run.action.alreadyRunning": "「{name}」は実行中です。",
  "run.action.outcomeNotRecorded":
    "「{name}」は開始しましたが、結果を記録できませんでした。",
  "run.action.failed": "「{name}」の実行に失敗しました。",
  "run.action.succeeded": "「{name}」を実行しました。",

  "settings.title": "設定",
  "settings.description":
    "AutoOps がこのアカウントの時刻をどう読み、いつ実行するか。",
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
    "AutoOps の画面に使う言語です。Worker と、その出力には影響しません。",
  "settings.language.label": "言語",
  "settings.language.english": "English",
  "settings.language.japanese": "日本語",
  "settings.language.save": "保存",
  "settings.language.saving": "保存中…",
  "settings.language.saved": "言語を保存しました。",
  "settings.language.invalid": "一覧から言語を選んでください。",
  "settings.language.failed": "言語を保存できませんでした。",
};
