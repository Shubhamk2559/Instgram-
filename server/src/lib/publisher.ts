import { pool } from "../db/pool";
import { decryptToken } from "./security";

const GRAPH = "https://graph.instagram.com/v21.0";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- Queue settings (change in Koyeb env vars; defaults below) ----
const TZ = process.env.POST_TZ || "Asia/Kolkata";
function toMinutes(value: string | undefined, fallback: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec((value ?? "").trim()) ?? /^(\d{1,2}):(\d{2})$/.exec(fallback)!;
  return Number(m[1]) * 60 + Number(m[2]);
}
const START = toMinutes(process.env.POST_START_TIME, "00:00");
const END = toMinutes(process.env.POST_END_TIME, "21:00");
const INTERVAL = Math.max(1, Math.round((Number(process.env.POST_INTERVAL_HOURS) || 3) * 60));
const BATCH = Math.max(1, Math.floor(Number(process.env.POST_BATCH_SIZE) || 1));
const GRACE_MIN = 30; // a missed slot is still run if the server was down for less than this

function localNow(): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

async function promoteQueue() {
  const { date, minutes } = localNow();
  if (minutes < START) return;
  const slot = START + Math.floor((Math.min(minutes, END) - START) / INTERVAL) * INTERVAL;
  if (minutes - slot > GRACE_MIN) return;

  const key = `${date} ${String(Math.floor(slot / 60)).padStart(2, "0")}:${String(slot % 60).padStart(2, "0")}`;
  const claimed = await pool.query("INSERT INTO queue_runs (slot_key) VALUES ($1) ON CONFLICT DO NOTHING RETURNING slot_key", [key]);
  if (!claimed.rows[0]) return;

  const moved = await pool.query(
    `WITH ranked AS (
       SELECT id, row_number() OVER (PARTITION BY instagram_account_id ORDER BY created_at, id) AS rn
       FROM reels WHERE status = 'queued'
     )
     UPDATE reels SET status = 'scheduled', scheduled_at = now()
     WHERE id IN (SELECT id FROM ranked WHERE rn <= $1)`,
    [BATCH]
  );
  console.log(`Queue slot ${key}: released ${moved.rowCount ?? 0} reel(s)`);
  await pool.query("DELETE FROM queue_runs WHERE ran_at < now() - interval '30 days'");
}

// ---- Publishing ----
type Job = {
  id: string;
  video_url: string;
  cover_url: string | null;
  caption: string;
  instagram_user_id: string;
  access_token_encrypted: string;
  token_expires_at: Date | null;
  account_status: string;
};

async function ig<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const data = (await r.json().catch(() => ({}))) as { error?: { message?: string } } & Record<string, unknown>;
  if (!r.ok || data.error) throw new Error(data.error?.message ?? `Instagram error ${r.status}`);
  return data as T;
}

function post<T>(path: string, params: Record<string, string>): Promise<T> {
  return ig<T>(`${GRAPH}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
}

async function publishOne(job: Job): Promise<void> {
  if (job.account_status !== "active") throw new Error("Instagram account is not active. Reconnect it.");
  if (job.token_expires_at && new Date(job.token_expires_at).getTime() < Date.now()) {
    throw new Error("Instagram token expired. Reconnect the account.");
  }
  const token = decryptToken(job.access_token_encrypted);

  const params: Record<string, string> = {
    media_type: "REELS",
    video_url: job.video_url,
    caption: job.caption,
    share_to_feed: "true",
    access_token: token,
  };
  if (job.cover_url) params.cover_url = job.cover_url;
  const container = await post<{ id: string }>(`${job.instagram_user_id}/media`, params);
  await pool.query("UPDATE reels SET ig_container_id = $1 WHERE id = $2", [container.id, job.id]);

  let ready = false;
  for (let i = 0; i < 120; i++) {
    await sleep(5000);
    const s = await ig<{ status_code?: string; status?: string }>(
      `${GRAPH}/${container.id}?fields=status_code,status&access_token=${encodeURIComponent(token)}`
    );
    if (s.status_code === "FINISHED") {
      ready = true;
      break;
    }
    if (s.status_code === "ERROR" || s.status_code === "EXPIRED") {
      throw new Error(`Instagram could not process the video (${s.status ?? s.status_code})`);
    }
  }
  if (!ready) throw new Error("Instagram took too long to process the video");

  const pub = await post<{ id: string }>(`${job.instagram_user_id}/media_publish`, {
    creation_id: container.id,
    access_token: token,
  });
  await pool.query(
    "UPDATE reels SET status = 'published', ig_media_id = $1, published_at = now(), error = NULL WHERE id = $2",
    [pub.id, job.id]
  );
}

let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    await pool.query(
      `UPDATE reels SET status = 'failed', error = 'Interrupted while publishing. Check Instagram before retrying.'
       WHERE status = 'publishing' AND updated_at < now() - interval '20 minutes'`
    );

    await promoteQueue();

    const { rows } = await pool.query<Job>(
      `WITH due AS (
         SELECT id FROM reels WHERE status = 'scheduled' AND scheduled_at <= now()
         ORDER BY scheduled_at LIMIT 3 FOR UPDATE SKIP LOCKED
       ), upd AS (
         UPDATE reels r SET status = 'publishing', attempts = r.attempts + 1, error = NULL
         FROM due WHERE r.id = due.id RETURNING r.*
       )
       SELECT upd.id, upd.video_url, upd.cover_url, upd.caption,
              a.instagram_user_id, a.access_token_encrypted, a.token_expires_at, a.status AS account_status
       FROM upd JOIN instagram_accounts a ON a.id = upd.instagram_account_id`
    );

    for (const job of rows) {
      try {
        await publishOne(job);
        console.log(`Published reel ${job.id}`);
      } catch (err) {
        const msg = (err as Error).message.slice(0, 500);
        console.error(`Reel ${job.id} failed:`, msg);
        await pool.query("UPDATE reels SET status = 'failed', error = $1 WHERE id = $2", [msg, job.id]);
      }
    }
  } catch (err) {
    console.error("Publisher tick error:", err);
  } finally {
    running = false;
  }
}

export function startPublisher(): () => void {
  console.log(`Queue: ${START}-${END} every ${INTERVAL} min, batch ${BATCH}, tz ${TZ}`);
  const timer = setInterval(tick, 30_000);
  setTimeout(tick, 5_000);
  return () => clearInterval(timer);
}
