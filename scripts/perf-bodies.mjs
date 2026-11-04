// Where do the megabytes live? Per-agent body composition on a roster copy (read-only).
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const ACTIVE = "('creating','running','awaiting_input','awaiting_report','reconnecting','delivery_pending','cleaning')";
const keys = ['history', 'observation', 'task.reports', 'task.result', 'task.childSnapshots',
  'task.dispatches', 'task.questionNotices', 'task', 'log', 'events'];
const rows = db.prepare(`SELECT id, json_extract(body,'$.name') name, json_extract(body,'$.state') state,
    json_type(json_extract(body,'$.sleep')) sleep, length(body) len,
    ${keys.map(key => `length(json_extract(body,'$.${key}')) AS k_${key.replace(/\./g, '_')}`).join(',\n    ')}
  FROM agents ORDER BY len DESC`).all();
const totals = Object.fromEntries(keys.map(key => [key, 0]));
let grand = 0;
for (const row of rows) {
  grand += row.len;
  for (const key of keys) totals[key] += row[`k_${key.replace(/\./g, '_')}`] ?? 0;
}
const kb = value => `${Math.round((value || 0) / 1024)}KB`;
console.log(`rows=${rows.length} total=${Math.round(grand / 1024)}KB`);
for (const key of keys) console.log(`  ${key}: ${kb(totals[key])} (${(100 * totals[key] / grand).toFixed(1)}%)`);
console.log('\ntop 6 by size (name | state | sleep | total | history | task | observation | reports):');
for (const row of rows.slice(0, 6)) {
  console.log(`  ${row.name} | ${row.state} | ${row.sleep ?? '-'} | ${kb(row.len)} | ${kb(row.k_history)} | ${kb(row.k_task)} | ${kb(row.k_observation)} | ${kb(row.k_task_reports)}`);
}
const awake = rows.filter(row => !row.sleep && ACTIVE.includes(`'${row.state}'`));
console.log('\nawake-polled rows:');
for (const row of awake) {
  console.log(`  ${row.name} | ${row.state} | ${kb(row.len)} | history ${kb(row.k_history)} | task ${kb(row.k_task)} | obs ${kb(row.k_observation)}`);
}
const awakeTotal = awake.reduce((sum, row) => sum + row.len, 0);
const awakeHistory = awake.reduce((sum, row) => sum + (row.k_history ?? 0), 0);
console.log(`awake total=${kb(awakeTotal)} history=${kb(awakeHistory)}`);
