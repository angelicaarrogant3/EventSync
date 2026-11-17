// Safe, repeatable tool to find and void attendance records recorded outside
// the event's attendance window. Defaults to --dry-run; pass --apply to write.
// Usage:
//   $env:PGURL = '<postgres-url>'
//   node tools/fix-early-checkins.js          # dry-run (default)
//   node tools/fix-early-checkins.js --apply  # void out-of-window rows

const { Client } = require('pg');

const fmtManila = d => new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Manila', year: 'numeric', month: 'short', day: 'numeric',
  hour: 'numeric', minute: '2-digit'
}).format(new Date(d));

async function run({ connectionString = process.env.PGURL, apply = process.argv.includes('--apply') } = {}) {
  if (!connectionString) {
    console.error('Missing PGURL environment variable.');
    process.exit(1);
  }
  const c = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    const { rows } = await c.query(`
      select a.id, a.event_id, a.checked_in_at,
             e.title as event_title, e.starts_at, e.ends_at,
             coalesce(e.early_grace_minutes, 60) as early_grace,
             coalesce(e.late_grace_minutes, 60) as late_grace,
             (e.starts_at - make_interval(mins => coalesce(e.early_grace_minutes, 60))) as opens_at,
             (e.ends_at   + make_interval(mins => coalesce(e.late_grace_minutes, 60)))  as closes_at,
             p.full_name, p.school_id
        from public.attendance a
        join public.events e on e.id = a.event_id
        join public.profiles p on p.id = a.user_id
       where not a.voided
         and not a.is_test
         and (
           a.checked_in_at < (e.starts_at - make_interval(mins => coalesce(e.early_grace_minutes, 60)))
           or a.checked_in_at > (e.ends_at + make_interval(mins => coalesce(e.late_grace_minutes, 60)))
         )
       order by a.checked_in_at asc
    `);

    console.log(`[fix-early-checkins] Mode: ${apply ? 'APPLY' : 'DRY-RUN'}`);
    console.log(`[fix-early-checkins] Found ${rows.length} out-of-window attendance record(s).`);

    for (const r of rows) {
      const early = new Date(r.checked_in_at) < new Date(r.opens_at);
      const reason = early ? 'Checked in before attendance window' : 'Checked in after attendance window';
      console.log(` - ${r.event_title} | ${r.full_name} (${r.school_id || 'no ID'}) | Checked in: ${fmtManila(r.checked_in_at)} | Window: ${fmtManila(r.opens_at)} – ${fmtManila(r.closes_at)} | ${reason}`);
    }

    let voided = 0;
    if (apply && rows.length > 0) {
      await c.query('begin');
      try {
        for (const r of rows) {
          const early = new Date(r.checked_in_at) < new Date(r.opens_at);
          const reason = early ? 'Checked in before attendance window' : 'Checked in after attendance window';
          await c.query(
            `update public.attendance
                set voided = true,
                    void_reason = $2,
                    voided_at = now()
              where id = $1 and not voided`,
            [r.id, reason]
          );
          await c.query(
            `insert into public.activity_logs(actor_id, action, entity, entity_id, details)
             values (null, 'attendance.voided', 'attendance', $1, $2::jsonb)`,
            [r.id, JSON.stringify({ event: r.event_title, participant: r.full_name, reason, tool: 'fix-early-checkins' })]
          );
          voided++;
        }
        await c.query('commit');
      } catch (e) {
        await c.query('rollback');
        throw e;
      }
    }

    console.log(`[fix-early-checkins] Summary: found=${rows.length}, voided=${voided}`);
    return { found: rows.length, voided };
  } finally {
    await c.end();
  }
}

if (require.main === module) {
  run().catch(e => { console.error('ERR:', e.message); process.exit(1); });
}

module.exports = { run };
