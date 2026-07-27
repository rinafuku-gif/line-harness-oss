import type {
  SatoyamaAreaCode,
  SatoyamaIssueCode,
  SatoyamaOnboardingTagDefinition,
  SatoyamaRoleCode,
} from '@line-crm/db';

export const SATOYAMA_ONBOARDING_KEY = 'satoyama_b2b_v1';
export const SATOYAMA_ONBOARDING_TITLE = 'いまの状況に近い進め方を、3問で整理します';
export const SATOYAMA_ONBOARDING_INTRO =
  '回答は任意です。答えなくても、AI相談やリッチメニューはそのまま利用できます。';

export interface OnboardingOption<T extends string> {
  code: T;
  label: string;
}

export interface OnboardingQuestion<T extends string> {
  id: 'issue' | 'role' | 'area';
  title: string;
  help: string;
  options: readonly OnboardingOption<T>[];
}

export const ISSUE_OPTIONS = [
  { code: 'key_person', label: '仕事が特定の人に集中している' },
  { code: 'handoff', label: 'チームの引き継ぎ・標準化を整えたい' },
  { code: 'unsure_start', label: 'AIを何から始めるか迷っている' },
  { code: 'safe_rules', label: '安全な利用ルールと進め方を整えたい' },
  { code: 'automation', label: '具体的な業務を自動化・仕組み化したい' },
] as const satisfies readonly OnboardingOption<SatoyamaIssueCode>[];

export const ROLE_OPTIONS = [
  { code: 'owner', label: '経営者・代表' },
  { code: 'internal_lead', label: '社内で業務改善・AI活用を担当' },
  { code: 'frontline', label: '現場担当者（自分や周囲の仕事を楽にしたい）' },
  { code: 'supporter_solo', label: '支援者・個人事業主' },
] as const satisfies readonly OnboardingOption<SatoyamaRoleCode>[];

export const AREA_OPTIONS = [
  { code: 'admin', label: '事務・管理業務' },
  { code: 'sales', label: '営業・顧客対応' },
  { code: 'hiring_training', label: '採用・教育' },
  { code: 'content', label: '情報発信' },
  { code: 'undecided', label: 'まだ決まっていない' },
] as const satisfies readonly OnboardingOption<SatoyamaAreaCode>[];

export const ONBOARDING_QUESTIONS = [
  {
    id: 'issue',
    title: 'いま、一番近い状況はどれですか？',
    help: '会社の大きさではなく、仕事の状態で選んでください。',
    options: ISSUE_OPTIONS,
  },
  {
    id: 'role',
    title: 'あなたの立場に一番近いものはどれですか？',
    help: '複数当てはまる場合は、今回LINEを使う立場で選んでください。',
    options: ROLE_OPTIONS,
  },
  {
    id: 'area',
    title: '最初に改善したい領域はどれですか？',
    help: 'まだ決まっていなくても問題ありません。',
    options: AREA_OPTIONS,
  },
] as const;

export const SATOYAMA_ONBOARDING_TAGS = [
  { axis: 'role', code: 'owner', name: '[SB][立場] 経営者・代表', color: '#2F6B4F' },
  { axis: 'role', code: 'internal_lead', name: '[SB][立場] 社内推進担当', color: '#2F6B4F' },
  { axis: 'role', code: 'frontline', name: '[SB][立場] 現場担当者', color: '#2F6B4F' },
  { axis: 'role', code: 'supporter_solo', name: '[SB][立場] 支援者・個人事業主', color: '#2F6B4F' },
  { axis: 'issue', code: 'key_person', name: '[SB][課題] 特定の人に集中', color: '#B85C38' },
  { axis: 'issue', code: 'handoff', name: '[SB][課題] 引き継ぎ・標準化', color: '#B85C38' },
  { axis: 'issue', code: 'unsure_start', name: '[SB][課題] 何から始めるか未定', color: '#B85C38' },
  { axis: 'issue', code: 'safe_rules', name: '[SB][課題] 利用ルール・推進体制', color: '#B85C38' },
  { axis: 'issue', code: 'automation', name: '[SB][課題] 自動化・仕組み化', color: '#B85C38' },
  { axis: 'area', code: 'admin', name: '[SB][領域] 事務・管理', color: '#356E9A' },
  { axis: 'area', code: 'sales', name: '[SB][領域] 営業・顧客対応', color: '#356E9A' },
  { axis: 'area', code: 'hiring_training', name: '[SB][領域] 採用・教育', color: '#356E9A' },
  { axis: 'area', code: 'content', name: '[SB][領域] 情報発信', color: '#356E9A' },
  { axis: 'area', code: 'undecided', name: '[SB][領域] 未定', color: '#356E9A' },
] as const satisfies readonly SatoyamaOnboardingTagDefinition[];

export interface WorkTemplate {
  id: string;
  title: string;
  useCase: string;
  prompt: string;
}

export interface StarterPlanStep {
  period: string;
  title: string;
  action: string;
}

export interface UsageRule {
  label: string;
  detail: string;
}

export interface BonusContent {
  version: string;
  title: string;
  summary: string;
  note: string;
  starterPlan: readonly StarterPlanStep[];
  usageRules: readonly UsageRule[];
  templates: readonly WorkTemplate[];
}

export const COMMON_BONUS: BonusContent = {
  version: 'common-2026-07-v2',
  title: '回答内容に合った AI活用スタートキット',
  summary:
    '最初に整理する1業務、30日間の進め方、安全に使うための最小ルール、すぐ試せるAI指示文をひとつにまとめました。',
  note:
    '顧客の個人情報、未公開の契約情報、パスワード、APIキーなどは入力しないでください。',
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
      id: 'reply_draft',
      title: 'メール・問い合わせ返信',
      useCase: '伝えたい内容はあるが、文章を整える時間を減らしたい時',
      prompt:
        '次の要点をもとに、相手に失礼のない返信文のたたき台を作ってください。\n\n相手との関係: [例: 既存のお客様]\n返信の目的: [例: 日程の再調整]\n必ず伝えること:\n- [要点1]\n- [要点2]\n避けたい表現: [あれば]\n文体: 丁寧で簡潔\n\n不明な事実は補わず、確認が必要な箇所を [要確認] と表示してください。',
    },
    {
      id: 'meeting_actions',
      title: '会議メモを要点と次の行動に整理',
      useCase: '会議後に、決まったことと担当を短時間で確認したい時',
      prompt:
        '次の会議メモを、内容を作り足さずに整理してください。\n\n出力形式:\n1. 決まったこと\n2. 未決定のこと\n3. 次の行動（担当・期限。メモにない場合は「未定」）\n4. 確認が必要な矛盾\n\n会議メモ:\n[ここに個人情報や機密情報を除いたメモを貼る]',
    },
    {
      id: 'internal_guide',
      title: '社内向け案内文・手順書のたたき台',
      useCase: '毎回口頭で説明している内容を、まず1枚にしたい時',
      prompt:
        '次の作業メモを、初めて担当する人向けの手順書のたたき台にしてください。\n\n含める項目:\n- この作業の目的\n- 始める条件\n- 必要なもの\n- 手順\n- 完了の確認方法\n- 判断に迷った時の確認先\n\n元のメモにない判断基準は作らず、[担当者に確認] と表示してください。\n\n作業メモ:\n[ここに貼る]',
    },
  ],
};

export interface IssueBonusContent {
  version: string;
  issue: SatoyamaIssueCode;
  title: string;
  summary: string;
  worksheet: readonly string[];
}

export const ISSUE_BONUSES = {
  key_person: {
    version: 'issue-key-person-2026-07-v1',
    issue: 'key_person',
    title: '仕事が止まるポイント整理シート',
    summary: '特定の人に集まっている仕事を、作業と判断に分けるための1枚です。',
    worksheet: [
      'その人が休むと止まる仕事を1つ書く',
      '開始条件・入力・完了形を書く',
      '誰でもできる作業と、本人の判断が必要な箇所を分ける',
      '最初に共有する1項目だけ決める',
    ],
  },
  handoff: {
    version: 'issue-handoff-2026-07-v1',
    issue: 'handoff',
    title: '引き継ぎ1枚テンプレート',
    summary: '厚いマニュアルの前に、次の担当者が迷う場所を減らすための型です。',
    worksheet: [
      '作業名と目的',
      '開始するタイミング',
      '使う画面・資料',
      '完了の基準',
      'よくある例外と確認先',
    ],
  },
  unsure_start: {
    version: 'issue-unsure-2026-07-v1',
    issue: 'unsure_start',
    title: '最初に試す1業務の選定シート',
    summary: 'ツールから決めず、小さく試せる仕事を比較するための1枚です。',
    worksheet: [
      '候補業務を3つ挙げる',
      '頻度と1回あたりの時間を書く',
      '人が最終確認できるかを見る',
      '失敗しても元の方法に戻せるかを見る',
      '2週間だけ試す1業務を決める',
    ],
  },
  safe_rules: {
    version: 'issue-safe-rules-2026-07-v1',
    issue: 'safe_rules',
    title: 'AI利用ルールの最小3分類',
    summary: '最初から厚い規程を作らず、現場が止まらない最低限の線引きを作ります。',
    worksheet: [
      '使ってよい: 公開済み情報、一般的な文章の下書き',
      '確認が必要: 社内限定情報、対外回答、重要な判断',
      '入力しない: 個人情報、顧客機密、認証情報',
      '迷った時の確認先を1人または1窓口決める',
    ],
  },
  automation: {
    version: 'issue-automation-2026-07-v1',
    issue: 'automation',
    title: '自動化候補の6点整理シート',
    summary: '実装前に、入口・出口・例外・戻し方をそろえるための1枚です。',
    worksheet: [
      '開始条件',
      '入力データ',
      '処理の流れ',
      '完成する成果物',
      '例外と人が判断する箇所',
      '停止した時に手作業へ戻す方法',
    ],
  },
} as const satisfies Record<SatoyamaIssueCode, IssueBonusContent>;

interface ReplyTemplate {
  initialReply: string;
  nextStep: string;
  deliveryThemes: readonly string[];
  ctaLabel: string;
  ctaMessage: string;
}

const REPLIES = {
  key_person: {
    owner: {
      initialReply:
        '回答ありがとうございます。いまは「仕事が特定の人に集中している」ことが一番近いのですね。いきなり全体を変えず、その人が休むと止まる仕事を1つだけ選ぶのが最初の一歩です。',
      nextStep: '1業務について「頻度・所要時間・入力・完了形・代われる人」を書く',
      deliveryThemes: ['止まる業務の見つけ方', '引き継ぎ1枚', '小さなAI化の事例'],
      ctaLabel: 'AIと1業務を整理する',
      ctaMessage: '特定の人に集中している業務を1つ整理したいです。',
    },
    internal_lead: {
      initialReply:
        '回答ありがとうございます。推進担当として、特定の人に集まった仕事をほどきたい状況なのですね。本人を責めず、まず1つの仕事の流れを一緒に見える化すると進めやすくなります。',
      nextStep: '対象者と15分で、開始条件から完了までを並べる',
      deliveryThemes: ['聞き取りの進め方', '標準化の最小単位', '社内合意の作り方'],
      ctaLabel: 'AIと業務の流れを整理する',
      ctaMessage: '推進担当として、特定の人に集中している業務の流れを整理したいです。',
    },
    frontline: {
      initialReply:
        '回答ありがとうございます。自分や周囲に仕事が集まり、日々の負担を軽くしたい状況なのですね。完璧な手順書ではなく、毎回説明している仕事を1つメモするところからで大丈夫です。',
      nextStep: '「毎回同じ説明をしている仕事」を1つ選ぶ',
      deliveryThemes: ['負担の言語化', 'メモから手順化', 'AIで下書きを作る方法'],
      ctaLabel: 'この仕事をAIに話してみる',
      ctaMessage: '毎回同じ説明をしている仕事を1つ、整理したいです。',
    },
    supporter_solo: {
      initialReply:
        '回答ありがとうございます。支援先やご自身の仕事が一人に寄りやすい状況なのですね。まず、止まると困る仕事と、本人にしか判断できない部分を分けると整理しやすくなります。',
      nextStep: '作業と判断を分けて書く',
      deliveryThemes: ['属人化の見分け方', '顧客ごとの差分', '再利用できる型'],
      ctaLabel: 'AIと作業・判断を切り分ける',
      ctaMessage: '一人に寄っている仕事を、作業と判断に切り分けたいです。',
    },
  },
  handoff: {
    owner: {
      initialReply:
        '回答ありがとうございます。「引き継ぎ・標準化を整えたい」ことが一番近いのですね。まずは、担当者が替わると品質が変わる仕事を1つ選び、終わった状態を決めるところから始めます。',
      nextStep: '「何ができたら完了か」を1文にする',
      deliveryThemes: ['標準化する仕事の選び方', '完了基準', '定着の確認'],
      ctaLabel: '標準化する1業務を決める',
      ctaMessage: '引き継ぎしやすい形にする業務を1つ決めたいです。',
    },
    internal_lead: {
      initialReply:
        '回答ありがとうございます。社内で引き継げる形を作りたい状況なのですね。現行手順を正解と決めつけず、実際に行っている流れと例外を集めると、使われる標準になります。',
      nextStep: '担当者2人のやり方と例外を並べる',
      deliveryThemes: ['聞き取り', '手順書のたたき台', '試行と修正'],
      ctaLabel: 'AIと手順のたたき台を作る',
      ctaMessage: '社内で引き継げる手順のたたき台を、1業務から作りたいです。',
    },
    frontline: {
      initialReply:
        '回答ありがとうございます。誰かに渡せる形にして、毎回の説明を減らしたい状況なのですね。画面、使う資料、つまずく場所の3つだけ残すところからで十分です。',
      nextStep: '1回分の作業を、画面・資料・注意点で記録する',
      deliveryThemes: ['簡単な記録方法', 'メモから手順書', '更新しやすい型'],
      ctaLabel: 'メモを手順書にする',
      ctaMessage: '作業メモを、引き継ぎやすい手順書にしたいです。',
    },
    supporter_solo: {
      initialReply:
        '回答ありがとうございます。支援内容やご自身の仕事を、再現できる形にしたい状況なのですね。共通部分と案件ごとの差分を分けると、硬すぎない標準化ができます。',
      nextStep: '共通手順と個別判断を2列に分ける',
      deliveryThemes: ['共通化', '品質チェック', '顧客ごとの差分管理'],
      ctaLabel: 'AIと再利用できる型を作る',
      ctaMessage: '支援や自分の仕事を、再利用できる型に整理したいです。',
    },
  },
  unsure_start: {
    owner: {
      initialReply:
        '回答ありがとうございます。「AIを何から始めるか迷っている」ことが一番近いのですね。ツール選びより、毎週繰り返し、時間がかかり、失敗しても戻せる仕事を1つ探す方が先です。',
      nextStep: '候補業務を3つ出し、頻度と時間で比べる',
      deliveryThemes: ['候補の選び方', '小さな試行', '投資判断'],
      ctaLabel: '最初の候補業務をAIと絞る',
      ctaMessage: 'AIを最初に試す候補業務を、経営の視点から絞りたいです。',
    },
    internal_lead: {
      initialReply:
        '回答ありがとうございます。社内で始めたい一方、最初の題材を決めきれていない状況なのですね。1部署・1業務・2週間の小さな試行にすると、説明と検証がしやすくなります。',
      nextStep: '試行対象、担当、期間、比較指標を1つずつ決める',
      deliveryThemes: ['小さな実証', '社内説明', '効果の見方'],
      ctaLabel: 'AIと試行候補を決める',
      ctaMessage: '1部署・1業務・2週間で試すAI活用の候補を決めたいです。',
    },
    frontline: {
      initialReply:
        '回答ありがとうございます。まず自分の仕事で、無理なくAIを試したい状況なのですね。メールや案内文、会議メモなど、元に戻せる小さな仕事からで大丈夫です。',
      nextStep: '10〜30分かかる文章・整理作業を1つ選ぶ',
      deliveryThemes: ['すぐ試せる3例', '安全な入力', '続ける判断'],
      ctaLabel: '自分の仕事で試す1つを決める',
      ctaMessage: '自分の仕事でAIを最初に試す、小さな作業を決めたいです。',
    },
    supporter_solo: {
      initialReply:
        '回答ありがとうございます。支援先やご自身に合う最初の使いどころを探している状況なのですね。繰り返しが多く、成果物を人が確認できる仕事から始めると安全です。',
      nextStep: '毎週繰り返す成果物を1つ選ぶ',
      deliveryThemes: ['用途選定', '顧客情報の扱い', '再利用できる指示'],
      ctaLabel: 'AIと最初の1業務を決める',
      ctaMessage: '支援先や自分に合う、AIを最初に試す1業務を決めたいです。',
    },
  },
  safe_rules: {
    owner: {
      initialReply:
        '回答ありがとうございます。「安全な利用ルールと進め方」を整えたいことが一番近いのですね。最初から厚い規程を作らず、入力禁止情報・人の確認が必要な用途・試してよい範囲の3つを決めます。',
      nextStep: '3分類を1枚にする',
      deliveryThemes: ['最低限のルール', '責任と確認', '段階的な展開'],
      ctaLabel: 'ルールのたたき台を作る',
      ctaMessage: '社内で安全にAIを使うための、最低限のルールを整理したいです。',
    },
    internal_lead: {
      initialReply:
        '回答ありがとうございます。現場が迷わず使えるルールと、社内で進める体制を作りたい状況なのですね。禁止事項だけでなく「ここまでは使ってよい」を明記すると運用しやすくなります。',
      nextStep: 'OK・要確認・入力禁止の3列を作る',
      deliveryThemes: ['1ページルール', '問い合わせ先', '部署展開'],
      ctaLabel: 'AIと1ページ案を作る',
      ctaMessage: '現場向けに、OK・要確認・入力禁止の1ページ案を作りたいです。',
    },
    frontline: {
      initialReply:
        '回答ありがとうございます。使ってよい情報や確認方法が分からず、安心して使える基準がほしい状況なのですね。迷ったら止められる、簡単な3分類から始めれば大丈夫です。',
      nextStep: '実際に迷った例を1つ書く',
      deliveryThemes: ['入力してよい情報', '出力の確認', '困った時の戻し方'],
      ctaLabel: '迷っている例をAIに相談する',
      ctaMessage: 'AIに入力してよいか迷っている仕事の例を整理したいです。',
    },
    supporter_solo: {
      initialReply:
        '回答ありがとうございます。顧客情報や成果物を扱う上で、安心できる線引きを作りたい状況なのですね。自分の情報と預かった情報を分け、後者はより厳しく扱うところから始めます。',
      nextStep: '情報を「自分・公開済み・顧客機密」に分ける',
      deliveryThemes: ['顧客データ', '委託先説明', '納品前確認'],
      ctaLabel: '顧客情報の利用ルールを整理する',
      ctaMessage: '顧客情報を扱う時のAI利用ルールを整理したいです。',
    },
  },
  automation: {
    owner: {
      initialReply:
        '回答ありがとうございます。「具体的な業務を自動化・仕組み化したい」ことが一番近いのですね。効果が大きく、例外が少なく、止めても手作業に戻せる業務を1つ選ぶのが安全です。',
      nextStep: '頻度・時間・例外・戻し方を確認する',
      deliveryThemes: ['自動化候補の選定', '費用対効果', '停止・復旧'],
      ctaLabel: '自動化候補を整理する',
      ctaMessage: '効果と戻しやすさを見ながら、自動化候補を1つ整理したいです。',
    },
    internal_lead: {
      initialReply:
        '回答ありがとうございます。社内の具体業務を、実運用できる仕組みにしたい状況なのですね。開始条件・入力・処理・出力・例外・担当者の6点を先にそろえると、実装の手戻りを減らせます。',
      nextStep: '6点を1業務分だけ埋める',
      deliveryThemes: ['業務フロー', '例外処理', '小規模テスト'],
      ctaLabel: 'AIと業務フローを作る',
      ctaMessage: '自動化したい1業務を、開始条件から例外まで整理したいです。',
    },
    frontline: {
      initialReply:
        '回答ありがとうございます。繰り返し作業を減らし、本来の仕事に時間を戻したい状況なのですね。毎回同じ手順と、途中で人が判断している場所を分けてみましょう。',
      nextStep: '同じ手順と人の判断に印を付ける',
      deliveryThemes: ['自動化できる部分', '人が残る部分', '失敗時の戻し方'],
      ctaLabel: '作業をAIに説明する',
      ctaMessage: '減らしたい繰り返し作業を、AIに説明しながら整理したいです。',
    },
    supporter_solo: {
      initialReply:
        '回答ありがとうございます。支援先やご自身の具体業務を、小さく仕組みにしたい状況なのですね。最初は1つの入力から1つの成果物を作る、短い流れに絞ると検証しやすくなります。',
      nextStep: '入口と出口が明確な流れを1つ選ぶ',
      deliveryThemes: ['小さな自動化', '再利用性', '保守と手動代替'],
      ctaLabel: 'AIと小さな自動化案を整理する',
      ctaMessage: '1つの入力から1つの成果物を作る、小さな自動化案を整理したいです。',
    },
  },
} as const satisfies Record<SatoyamaIssueCode, Record<SatoyamaRoleCode, ReplyTemplate>>;

const AREA_EXAMPLES = {
  admin: {
    label: '事務・管理業務',
    example: '会議メモ、問い合わせ返信、社内手順',
  },
  sales: {
    label: '営業・顧客対応',
    example: '商談メモ、提案準備、顧客への案内',
  },
  hiring_training: {
    label: '採用・教育',
    example: '求人文、面接記録、引き継ぎ教材',
  },
  content: {
    label: '情報発信',
    example: '記事の下書き、SNS案、社内外の案内文',
  },
  undecided: {
    label: '未定の領域',
    example: '毎週繰り返す文章作成や情報整理',
  },
} as const satisfies Record<SatoyamaAreaCode, { label: string; example: string }>;

export interface SatoyamaOnboardingOutcome {
  issue: SatoyamaIssueCode;
  role: SatoyamaRoleCode;
  area: SatoyamaAreaCode;
  initialReply: string;
  areaExample: string;
  nextStep: string;
  deliveryThemes: readonly string[];
  cta: {
    label: string;
    message: string;
  };
  issueBonus: IssueBonusContent;
}

export function buildSatoyamaOnboardingOutcome(
  issue: SatoyamaIssueCode,
  role: SatoyamaRoleCode,
  area: SatoyamaAreaCode,
): SatoyamaOnboardingOutcome {
  const reply = REPLIES[issue][role];
  const areaInfo = AREA_EXAMPLES[area];
  return {
    issue,
    role,
    area,
    initialReply: reply.initialReply,
    areaExample: `${areaInfo.label}では、たとえば「${areaInfo.example}」から1つ選べます。`,
    nextStep: reply.nextStep,
    deliveryThemes: reply.deliveryThemes,
    cta: {
      label: reply.ctaLabel,
      message: reply.ctaMessage,
    },
    issueBonus: ISSUE_BONUSES[issue],
  };
}

export function isSatoyamaIssueCode(value: unknown): value is SatoyamaIssueCode {
  return ISSUE_OPTIONS.some((option) => option.code === value);
}

export function isSatoyamaRoleCode(value: unknown): value is SatoyamaRoleCode {
  return ROLE_OPTIONS.some((option) => option.code === value);
}

export function isSatoyamaAreaCode(value: unknown): value is SatoyamaAreaCode {
  return AREA_OPTIONS.some((option) => option.code === value);
}

export function publicSatoyamaOnboardingContent() {
  return {
    key: SATOYAMA_ONBOARDING_KEY,
    version: 1,
    title: SATOYAMA_ONBOARDING_TITLE,
    intro: SATOYAMA_ONBOARDING_INTRO,
    questions: ONBOARDING_QUESTIONS,
    commonBonus: COMMON_BONUS,
  };
}
