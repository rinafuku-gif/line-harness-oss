import type { SatoyamaIssueCode } from '@line-crm/db';

export const SATOYAMA_FOLLOWUP_RESULT_URL =
  'https://liff.line.me/2010452980-ng2A6Rna/onboarding/satoyama?liffId=2010452980-ng2A6Rna';
export const SATOYAMA_PRICING_URL = 'https://www.satoyama-ai-base.com/pricing';

export interface SatoyamaFollowupStepDefinition {
  offsetDays: number;
  deliveryTime: string;
  message: string;
}

export interface SatoyamaFollowupScenarioDefinition {
  id: string;
  issue: SatoyamaIssueCode;
  name: string;
  description: string;
  steps: readonly SatoyamaFollowupStepDefinition[];
}

export const SATOYAMA_FOLLOWUP_SCENARIOS = {
  key_person: {
    id: 'satoyama-onboarding-v1-key-person',
    issue: 'key_person',
    name: 'SATOYAMA｜3問回答後｜特定の人に集中',
    description: '3問回答後の課題別フォロー。特定の人に仕事が集中している方向け。',
    steps: [
      {
        offsetDays: 1,
        deliveryTime: '10:00',
        message:
          '先日は3問への回答をありがとうございました。\n\n「仕事が特定の人に集中している」と答えた方は、まず、その人が休むと止まる仕事を1つだけ選んでみてください。\n\n書き出すのは次の4つで十分です。\n・いつ始まる仕事か\n・何を受け取って始めるか\n・何ができたら完了か\n・本人の判断が必要なのはどこか\n\n全部を手順書にする前に、止まる場所を1つ見つけるのが最初の一歩です。',
      },
      {
        offsetDays: 3,
        deliveryTime: '10:00',
        message:
          `仕事が一人に集まっている時は、「作業」と「判断」を分けると整理しやすくなります。\n\n誰でも同じようにできる作業は共有し、経験が必要な判断には確認先を残します。最初から全部をAIに任せる必要はありません。\n\n回答内容に合った整理シートは、こちらからもう一度確認できます。\n${SATOYAMA_FOLLOWUP_RESULT_URL}`,
      },
      {
        offsetDays: 7,
        deliveryTime: '10:00',
        message:
          `1業務を書き出してみて、「どこから手を付ければよいか分からない」と感じたら、このトークに「集中している仕事を整理したい」と送ってください。\n\n状況を聞きながら、手順化する部分、人が判断する部分、AIを試せる部分を一緒に分けます。できることと料金の目安はこちらです。\n${SATOYAMA_PRICING_URL}`,
      },
    ],
  },
  handoff: {
    id: 'satoyama-onboarding-v1-handoff',
    issue: 'handoff',
    name: 'SATOYAMA｜3問回答後｜引き継ぎ・標準化',
    description: '3問回答後の課題別フォロー。引き継ぎと標準化を整えたい方向け。',
    steps: [
      {
        offsetDays: 1,
        deliveryTime: '10:00',
        message:
          '先日は3問への回答をありがとうございました。\n\n「引き継ぎ・標準化を整えたい」と答えた方は、厚いマニュアルを作る前に、1つの仕事について次の3つだけ残してみてください。\n\n・使う画面や資料\n・何ができたら完了か\n・迷いやすい例外と確認先\n\n実際の作業で迷う場所から書く方が、使われる手順になりやすいです。',
      },
      {
        offsetDays: 3,
        deliveryTime: '10:00',
        message:
          `引き継ぎ資料は、最初から完成させなくて大丈夫です。\n\nまず別の人に1回使ってもらい、「説明が足りなかった場所」だけを追記すると、現場に合った手順へ近づきます。AIは、作業メモを読みやすい形へ整える下書き役として使えます。\n\n回答内容に合ったテンプレートはこちらから確認できます。\n${SATOYAMA_FOLLOWUP_RESULT_URL}`,
      },
      {
        offsetDays: 7,
        deliveryTime: '10:00',
        message:
          `引き継ぎたい仕事はあるものの、担当者への聞き取りや手順の整理が進まない場合は、このトークに「引き継ぎを整えたい」と送ってください。\n\n1業務から、実際に使って直せる形まで一緒に整理します。できることと料金の目安はこちらです。\n${SATOYAMA_PRICING_URL}`,
      },
    ],
  },
  unsure_start: {
    id: 'satoyama-onboarding-v1-unsure-start',
    issue: 'unsure_start',
    name: 'SATOYAMA｜3問回答後｜何から始めるか未定',
    description: '3問回答後の課題別フォロー。AIを何から始めるか迷っている方向け。',
    steps: [
      {
        offsetDays: 1,
        deliveryTime: '10:00',
        message:
          '先日は3問への回答をありがとうございました。\n\n「AIを何から始めるか迷っている」と答えた方は、ツールを選ぶ前に、候補の仕事を3つ挙げてみてください。\n\n比べるポイントは次の4つです。\n・繰り返す頻度\n・かかっている時間\n・人が結果を確認できるか\n・失敗しても元の方法に戻せるか\n\n最初は、短期間で小さく試せる仕事が向いています。',
      },
      {
        offsetDays: 3,
        deliveryTime: '10:00',
        message:
          `最初のAI活用は、1部署・1業務・2週間くらいに絞ると確認しやすくなります。\n\n「何分減ったか」だけでなく、直す回数、確認の負担、続けられそうかも見てください。合わなければ、AIを使わない判断も問題ありません。\n\n候補を選ぶためのシートはこちらから確認できます。\n${SATOYAMA_FOLLOWUP_RESULT_URL}`,
      },
      {
        offsetDays: 7,
        deliveryTime: '10:00',
        message:
          `候補を出しても1つに絞れない場合は、このトークに「最初の1業務を決めたい」と送ってください。\n\nいまの仕事を聞きながら、試しやすさと期待できる効果を一緒に整理します。できることと料金の目安はこちらです。\n${SATOYAMA_PRICING_URL}`,
      },
    ],
  },
  safe_rules: {
    id: 'satoyama-onboarding-v1-safe-rules',
    issue: 'safe_rules',
    name: 'SATOYAMA｜3問回答後｜利用ルール・推進体制',
    description: '3問回答後の課題別フォロー。安全な利用ルールと進め方を整えたい方向け。',
    steps: [
      {
        offsetDays: 1,
        deliveryTime: '10:00',
        message:
          '先日は3問への回答をありがとうございました。\n\n「安全な利用ルールと進め方を整えたい」と答えた方は、最初から厚い規程を作らなくても大丈夫です。\n\nまずは次の3つに分けてみてください。\n・使ってよい情報や用途\n・責任者の確認が必要なもの\n・入力してはいけない情報\n\n現場が迷った時の確認先も、1人または1窓口だけ決めておきます。',
      },
      {
        offsetDays: 3,
        deliveryTime: '10:00',
        message:
          `AIのルールは、禁止事項だけでは現場が止まりやすくなります。\n\n「公開済み情報の整理は使ってよい」「顧客情報や契約情報は入力しない」「社外へ出す文章は人が確認する」のように、使える範囲も一緒に示すのがポイントです。\n\n最小ルールの整理シートはこちらから確認できます。\n${SATOYAMA_FOLLOWUP_RESULT_URL}`,
      },
      {
        offsetDays: 7,
        deliveryTime: '10:00',
        message:
          `自社の業務に合わせた線引きが難しい場合は、このトークに「AI利用ルールを整理したい」と送ってください。\n\n実際に扱う情報や仕事を見ながら、使ってよい範囲と人が確認する範囲を一緒に整理します。できることと料金の目安はこちらです。\n${SATOYAMA_PRICING_URL}`,
      },
    ],
  },
  automation: {
    id: 'satoyama-onboarding-v1-automation',
    issue: 'automation',
    name: 'SATOYAMA｜3問回答後｜自動化・仕組み化',
    description: '3問回答後の課題別フォロー。具体的な業務を自動化・仕組み化したい方向け。',
    steps: [
      {
        offsetDays: 1,
        deliveryTime: '10:00',
        message:
          '先日は3問への回答をありがとうございました。\n\n「具体的な業務を自動化・仕組み化したい」と答えた方は、作り始める前に1業務について次の6点を確認してみてください。\n\n・開始条件\n・入力する情報\n・処理の流れ\n・完成するもの\n・例外と人の判断\n・止まった時に手作業へ戻す方法\n\nこの6点が見えると、必要な仕組みを判断しやすくなります。',
      },
      {
        offsetDays: 3,
        deliveryTime: '10:00',
        message:
          `自動化は、最初からすべてをつなげるより、1つの入力から1つの成果物を作る短い流れで試す方が確認しやすくなります。\n\nうまく動かなかった時の戻し方と、人が確認する場所を残してから広げます。\n\n自動化候補の6点整理シートはこちらから確認できます。\n${SATOYAMA_FOLLOWUP_RESULT_URL}`,
      },
      {
        offsetDays: 7,
        deliveryTime: '10:00',
        message:
          `業務の流れを書き出したものの、どこまで自動化するか判断しにくい場合は、このトークに「自動化候補を整理したい」と送ってください。\n\n小さく試す部分と、本実装が必要な部分を一緒に分けます。できることと料金の目安はこちらです。\n${SATOYAMA_PRICING_URL}`,
      },
    ],
  },
} as const satisfies Record<SatoyamaIssueCode, SatoyamaFollowupScenarioDefinition>;

export const SATOYAMA_FOLLOWUP_SCENARIO_IDS = Object.values(
  SATOYAMA_FOLLOWUP_SCENARIOS,
).map((scenario) => scenario.id);
