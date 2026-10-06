import { env } from "../config/env";
import { pool } from "../db/pool";
import { decryptToken } from "./security";
import { downloadTelegramFile, startTelegram } from "./telegram";

const GRAPH = "https://graph.instagram.com/v21.0";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- Daily plan (change in Koyeb env vars; defaults below) ----
const TZ = process.env.POST_TZ || "Asia/Kolkata";
function toMinutes(value: string | undefined, fallback: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec((value ?? "").trim()) ?? /^(\d{1,2}):(\d{2})$/.exec(fallback)!;
  return Number(m[1]) * 60 + Number(m[2]);
}
const label = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

const SLOTS = (process.env.POST_SLOTS || "09:00,14:00,17:00,19:00,21:00")
  .split(",")
  .map((s) => toMinutes(s, "09:00"))
  .sort((a, b) => a - b);
const BATCH = Math.max(1, Math.floor(Number(process.env.POST_BATCH_SIZE) || 10));
const GRACE_MIN = 60;

export const PLAN = { slots: SLOTS.map(label), batch: BATCH, tz: TZ };

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

// Copies library videos [from, to) into posting jobs, one per active Instagram account.
export async function release(from: number, to: number, userId: string | null): Promise<number> {
  const r = await pool.query(
    `WITH ranked AS (
       SELECT l.*, row_number() OVER (PARTITION BY l.user_id ORDER BY l.created_at, l.id) - 1 AS pos
       FROM library l
     )
     INSERT INTO reels (user_id, instagram_account_id, video_url, video_public_id, tg_file_id, cover_url, caption, status, scheduled_at)
     SELECT k.user_id, a.id, k.video_url, k.video_public_id, k.tg_file_id,
            CASE WHEN s.cover_token IS NOT NULL THEN $4::text || s.cover_token || '.jpg' END,
            COALESCE(s.caption, ''), 'scheduled', now()
     FROM ranked k
     JOIN instagram_accounts a ON a.user_id = k.user_id AND a.status = 'active'
     LEFT JOIN queue_settings s ON s.user_id = k.user_id
     WHERE k.pos >= $1 AND k.pos < $2 AND ($3::uuid IS NULL OR k.user_id = $3::uuid)`,
    [from, to, userId, `${env.APP_BASE_URL}/api/public/cover/`]
  );
  return r.rowCount ?? 0;
}

async function promoteSlots() {
  const { date, minutes } = localNow();
  for (let i = 0; i < SLOTS.length; i++) {
    const s = SLOTS[i];
    if (minutes < s || minutes - s > GRACE_MIN) continue;
    const key = `${date} ${label(s)}`;
    const claimed = await pool.query(
      "INSERT INTO queue_runs (slot_key) VALUES ($1) ON CONFLICT DO NOTHING RETURNING slot_key",
      [key]
    );
    if (!claimed.rows[0]) continue;

    const n = await release(i * BATCH, (i + 1) * BATCH, null);
    console.log(`Slot ${key}: created ${n} post(s)`);

    await pool.query("DELETE FROM queue_runs WHERE ran_at < now() - interval '30 days'");
    await pool.query(
      "DELETE FROM reels WHERE status IN ('published', 'failed') AND created_at < now() - interval '7 days'"
    );
  }
}

// ---- Publishing ----
type Job = {
  id: string;
  video_url: string | null;
  tg_file_id: string | null;
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

// Video comes from Telegram: download it, then push the bytes straight to Instagram (resumable upload).
async function createFromTelegram(job: Job, token: string): Promise<string> {
  const bytes = await downloadTelegramFile(job.tg_file_id!);
  const params: Record<string, string> = {
    media_type: "REELS",
    upload_type: "resumable",
    caption: job.caption,
    share_to_feed: "true",
    access_token: token,
  };
  if (job.cover_url) params.cover_url = job.cover_url;
  const container = await post<{ id: string; uri?: string }>(`${job.instagram_user_id}/media`, params);

  const up = await fetch(container.uri ?? `https://rupload.facebook.com/ig-api-upload/v21.0/${container.id}`, {
    method: "POST",
    headers: { Authorization: `OAuth ${token}`, offset: "0", file_size: String(bytes.length) },
    body: bytes as unknown as BodyInit,
  });
  const d = (await up.json().catch(() => ({}))) as {
    debug_info?: { message?: string };
    error?: { message?: string };
  };
  if (!up.ok) throw new Error(`Instagram upload failed: ${d.debug_info?.message ?? d.error?.message ?? up.status}`);
  return container.id;
}

async function createFromUrl(job: Job, token: string): Promise<string> {
  const params: Record<string, string> = {
    media_type: "REELS",
    video_url: job.video_url!,
    caption: job.caption,
    share_to_feed: "true",
    access_token: token,
  };
  if (job.cover_url) params.cover_url = job.cover_url;
  return (await post<{ id: string }>(`${job.instagram_user_id}/media`, params)).id;
}

async function publishOne(job: Job): Promise<void> {
  if (job.account_status !== "active") throw new Error("Instagram account is not active. Reconnect it.");
  if (job.token_expires_at && new Date(job.token_expires_at).getTime() < Date.now()) {
    throw new Error("Instagram token expired. Reconnect the account.");
  }
  const token = decryptToken(job.access_token_encrypted);

  const containerId = job.tg_file_id ? await createFromTelegram(job, token) : await createFromUrl(job, token);
  await pool.query("UPDATE reels SET ig_container_id = $1 WHERE id = $2", [containerId, job.id]);

  let ready = false;
  for (let i = 0; i < 120; i++) {
    await sleep(5000);
    const s = await ig<{ status_code?: string; status?: string }>(
      `${GRAPH}/${containerId}?fields=status_code,status&access_token=${encodeURIComponent(token)}`
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
    creation_id: containerId,
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

    await promoteSlots();

    const { rows } = await pool.query<Job>(
      `WITH due AS (
         SELECT id FROM reels WHERE status = 'scheduled' AND scheduled_at <= now()
         ORDER BY scheduled_at, created_at LIMIT 5 FOR UPDATE SKIP LOCKED
       ), upd AS (
         UPDATE reels r SET status = 'publishing', attempts = r.attempts + 1, error = NULL
         FROM due WHERE r.id = due.id RETURNING r.*
       )
       SELECT upd.id, upd.video_url, upd.tg_file_id, upd.cover_url, upd.caption,
              a.instagram_user_id, a.access_token_encrypted, a.token_expires_at, a.status AS account_status
       FROM upd JOIN instagram_accounts a ON a.id = upd.instagram_account_id`
    );

    await Promise.all(
      rows.map(async (job) => {
        try {
          await publishOne(job);
          console.log(`Published reel ${job.id}`);
        } catch (err) {
          const msg = (err as Error).message.slice(0, 500);
          console.error(`Reel ${job.id} failed:`, msg);
          await pool.query("UPDATE reels SET status = 'failed', error = $1 WHERE id = $2", [msg, job.id]);
        }
      })
    );
  } catch (err) {
    console.error("Publisher tick error:", err);
  } finally {
    running = false;
  }
}

export function startPublisher(): () => void {
  console.log(`Plan: ${PLAN.slots.join(", ")} | ${BATCH} per account per slot | tz ${TZ}`);
  startTelegram(() => SLOTS.length * BATCH);
  const timer = setInterval(tick, 30_000);
  setTimeout(tick, 5_000);
  return () => clearInterval(timer);
}
