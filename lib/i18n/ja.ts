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
