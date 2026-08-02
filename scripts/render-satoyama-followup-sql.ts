import {
  SATOYAMA_FOLLOWUP_SCENARIOS,
} from '../apps/worker/src/features/satoyama-onboarding/followup-content.js';
import {
  SATOYAMA_ONBOARDING_TAGS,
} from '../apps/worker/src/features/satoyama-onboarding/content.js';

function argument(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function sql(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

const accountId = argument('account-id');
const activeArg = argument('active') ?? 'false';

if (!accountId || !/^[A-Za-z0-9-]{8,80}$/.test(accountId)) {
  throw new Error('Pass a valid --account-id=<LINE Harness account id>');
}
if (activeArg !== 'true' && activeArg !== 'false') {
  throw new Error('--active must be true or false');
}

const isActive = activeArg === 'true' ? 1 : 0;
const now = "strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')";
const statements: string[] = [];

for (const definition of Object.values(SATOYAMA_FOLLOWUP_SCENARIOS)) {
  const tag = SATOYAMA_ONBOARDING_TAGS.find(
    (candidate) => candidate.axis === 'issue' && candidate.code === definition.issue,
  );
  if (!tag) throw new Error(`Missing issue tag for ${definition.issue}`);

  const tagId = `(SELECT id FROM tags WHERE name = ${sql(tag.name)} LIMIT 1)`;
  statements.push(
    `INSERT INTO scenarios (
       id, name, description, trigger_type, trigger_tag_id,
       is_active, delivery_mode, created_at, updated_at, line_account_id
     ) VALUES (
       ${sql(definition.id)}, ${sql(definition.name)}, ${sql(definition.description)},
       'tag_added', ${tagId}, ${isActive}, 'absolute_time', ${now}, ${now}, ${sql(accountId)}
     )
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       description = excluded.description,
       trigger_type = excluded.trigger_type,
       trigger_tag_id = excluded.trigger_tag_id,
       is_active = excluded.is_active,
       delivery_mode = excluded.delivery_mode,
       updated_at = excluded.updated_at,
       line_account_id = excluded.line_account_id`,
  );

  definition.steps.forEach((step, index) => {
    const stepId = `${definition.id}-step-${index + 1}`;
    statements.push(
      `INSERT INTO scenario_steps (
         id, scenario_id, step_order, delay_minutes,
         message_type, message_content,
         condition_type, condition_value, next_step_on_false,
         offset_days, offset_minutes, delivery_time,
         template_id, on_reach_tag_id, created_at
       ) VALUES (
         ${sql(stepId)}, ${sql(definition.id)}, ${index}, 0,
         'text', ${sql(step.message)},
         'tag_exists', ${tagId}, NULL,
         ${step.offsetDays}, 0, ${sql(step.deliveryTime)},
         NULL, NULL, ${now}
       )
       ON CONFLICT(id) DO UPDATE SET
         scenario_id = excluded.scenario_id,
         step_order = excluded.step_order,
         delay_minutes = excluded.delay_minutes,
         message_type = excluded.message_type,
         message_content = excluded.message_content,
         condition_type = excluded.condition_type,
         condition_value = excluded.condition_value,
         next_step_on_false = excluded.next_step_on_false,
         offset_days = excluded.offset_days,
         offset_minutes = excluded.offset_minutes,
         delivery_time = excluded.delivery_time,
         template_id = excluded.template_id,
         on_reach_tag_id = excluded.on_reach_tag_id`,
    );
  });
}

process.stdout.write(`${statements.join(';\n')};\n`);
