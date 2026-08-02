import type { OnboardingPayload } from '../lib/onboarding-api.js';

export function onboardingPreviewPayload(): OnboardingPayload {
  return {
    program: {
      key: 'satoyama_b2b_v1',
      version: 1,
      title: 'いまの状況に近い進め方を、3問で整理します',
      intro:
        '回答は任意です。答えなくても、AI相談やリッチメニューはそのまま利用できます。',
      questions: [
        {
          id: 'issue',
          title: 'いま、一番近い状況はどれですか？',
          help: '会社の大きさではなく、仕事の状態で選んでください。',
          options: [
            { code: 'key_person', label: '仕事が特定の人に集中している' },
            { code: 'handoff', label: 'チームの引き継ぎ・標準化を整えたい' },
            { code: 'unsure_start', label: 'AIを何から始めるか迷っている' },
            { code: 'safe_rules', label: '安全な利用ルールと進め方を整えたい' },
            { code: 'automation', label: '具体的な業務を自動化・仕組み化したい' },
          ],
        },
        {
          id: 'role',
          title: 'あなたの立場に一番近いものはどれですか？',
          help: '複数当てはまる場合は、今回LINEを使う立場で選んでください。',
          options: [
            { code: 'owner', label: '経営者・代表' },
            { code: 'internal_lead', label: '社内で業務改善・AI活用を担当' },
            { code: 'frontline', label: '現場担当者（自分や周囲の仕事を楽にしたい）' },
            { code: 'supporter_solo', label: '支援者・個人事業主' },
          ],
        },
        {
          id: 'area',
          title: '最初に改善したい領域はどれですか？',
          help: 'まだ決まっていなくても問題ありません。',
          options: [
            { code: 'admin', label: '事務・管理業務' },
            { code: 'sales', label: '営業・顧客対応' },
            { code: 'hiring_training', label: '採用・教育' },
            { code: 'content', label: '情報発信' },
            { code: 'undecided', label: 'まだ決まっていない' },
          ],
        },
      ],
      commonBonus: {
        version: 'common-preview',
        title: '回答内容に合った AI活用スタートキット',
        summary:
          '最初に整理する1業務、30日間の進め方、安全に使うための最小ルール、すぐ試せるAI指示文をひとつにまとめました。',
        note: '個人情報、顧客機密、パスワード、APIキーなどは入力しないでください。',
        starterPlan: [
          {
            period: '1週目',
            title: '対象を1業務に絞る',
            action: '頻度、所要時間、入力、完成形、例外を書き出します。',
          },
          {
            period: '2週目',
            title: '人の確認を残して3回試す',
            action: 'AIの出力をそのまま使わず、事実と宛先を毎回確認します。',
          },
          {
            period: '3週目',
            title: '迷った点を手順に残す',
            action: '直した箇所と、人が判断する条件を1枚に追記します。',
          },
          {
            period: '4週目',
            title: '続ける・直す・やめるを決める',
            action: '時間、品質、負担を見て次の30日へ進むか判断します。',
          },
        ],
        usageRules: [
          {
            label: '入力しない',
            detail: '個人情報、顧客機密、契約前の情報、パスワードやAPIキー',
          },
          {
            label: '必ず人が確認する',
            detail: '社外への送信・公開、金額や契約、採用などの重要な判断',
          },
          {
            label: '小さく試す',
            detail: '1業務から始め、止めても元の手作業へ戻せる状態を残す',
          },
        ],
        templates: [
          {
            id: 'reply',
            title: 'メール・問い合わせ返信',
            useCase: '伝えたい要点から返信文のたたき台を作る時',
            prompt: '相手との関係、返信の目的、必ず伝える要点をもとに、丁寧で簡潔な返信文のたたき台を作ってください。不明な事実は [要確認] と表示してください。',
          },
          {
            id: 'meeting',
            title: '会議メモを要点と次の行動に整理',
            useCase: '決定事項と担当を短時間で確認したい時',
            prompt: '会議メモを、決まったこと・未決定のこと・次の行動・確認が必要な矛盾に分けてください。内容は作り足さないでください。',
          },
          {
            id: 'guide',
            title: '社内向け案内文・手順書のたたき台',
            useCase: '毎回口頭で説明している作業を1枚にする時',
            prompt: '作業メモを、目的・開始条件・必要なもの・手順・完了確認・確認先に分けてください。ない情報は [担当者に確認] と表示してください。',
          },
        ],
      },
    },
    state: null,
    outcome: {
      issue: 'handoff',
      role: 'internal_lead',
      area: 'admin',
      initialReply:
        '回答ありがとうございます。社内で引き継げる形を作りたい状況なのですね。現行手順を正解と決めつけず、実際に行っている流れと例外を集めると、使われる標準になります。',
      areaExample:
        '事務・管理業務では、たとえば「会議メモ、問い合わせ返信、社内手順」から1つ選べます。',
      nextStep: '担当者2人のやり方と例外を並べる',
      deliveryThemes: ['聞き取り', '手順書のたたき台', '試行と修正'],
      cta: {
        label: 'AIと手順のたたき台を作る',
        message: '社内で引き継げる手順のたたき台を、1業務から作りたいです。',
      },
      issueBonus: {
        version: 'issue-preview',
        issue: 'handoff',
        title: '引き継ぎ1枚テンプレート',
        summary: '次の担当者が迷う場所を減らすための型です。',
        worksheet: [
          '作業名と目的',
          '開始するタイミング',
          '使う画面・資料',
          '完了の基準',
          'よくある例外と確認先',
        ],
      },
    },
  };
}
