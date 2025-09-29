import { pool } from '../db';

const printTable = (rows: Record<string, unknown>[], columns: string[]) => {
  if (rows.length === 0) {
    console.log('(нет данных)');
    return;
  }

  const widths = columns.map((column) =>
    Math.max(column.length, ...rows.map((row) => String(row[column] ?? '').length)),
  );

  const printLine = (values: string[]) => {
    console.log(values.map((value, index) => value.padEnd(widths[index])).join('  '));
  };

  printLine(columns);
  printLine(widths.map((width) => '-'.repeat(width)));
  for (const row of rows) {
    printLine(columns.map((column) => String(row[column] ?? '')));
  }
};

async function main(): Promise<void> {
  const overall = await pool.query('SELECT * FROM ui_ctr_overall ORDER BY ctr DESC NULLS LAST LIMIT 50');
  console.log('\n=== CTR (overall) ===');
  printTable(overall.rows, ['target', 'exposures', 'clicks', 'ctr']);

  const byVariant = await pool.query(
    "SELECT experiment, variant, target, exposures, clicks, ctr FROM ui_ctr_by_variant WHERE experiment <> '-' ORDER BY experiment, variant, ctr DESC NULLS LAST LIMIT 100",
  );
  console.log('\n=== CTR by variant ===');
  printTable(byVariant.rows, ['experiment', 'variant', 'target', 'exposures', 'clicks', 'ctr']);

  const daily = await pool.query(
    "SELECT day::date AS day, target, exposures, clicks, ctr FROM ui_ctr_daily WHERE day >= now() - interval '14 days' ORDER BY day DESC, target LIMIT 200",
  );
  console.log('\n=== CTR (last 14 days, daily) ===');
  printTable(daily.rows, ['day', 'target', 'exposures', 'clicks', 'ctr']);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
