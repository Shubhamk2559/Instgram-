import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env";
import { pool } from "../db/pool";
import { destroyAsset, destroyByPrefix, signUpload } from "../lib/cloudinary";
import { PLAN, release } from "../lib/publisher";
import { requireAuth, wrap } from "./auth";

export const reelsRouter = Router();
reelsRouter.use(requireAuth);

const BASE = `https://res.cloudinary.com/${env.CLOUDINARY_CLOUD_NAME}/`;
const CAP = PLAN.slots.length * PLAN.batch; // max videos in the library

// Each user uploads only into their own folder.
reelsRouter.get("/upload-signature", (req, res) => {
  res.json(signUpload(`reels/${req.user!.id}`));
});

// ---- Library ----
reelsRouter.get(
  "/library",
  wrap(async (req, res) => {
    const uid = req.user!.id;
    const items = await pool.query("SELECT id, video_url FROM library WHERE user_id = $1 ORDER BY created_at, id", [uid]);
    const st = await pool.query("SELECT caption, cover_url FROM queue_settings WHERE user_id = $1", [uid]);
    const acc = await pool.query(
      "SELECT count(*)::int AS n FROM instagram_accounts WHERE user_id = $1 AND status = 'active'",
      [uid]
    );
    res.json({
      items: items.rows,
      caption: st.rows[0]?.caption ?? "",
      coverUrl: st.rows[0]?.cover_url ?? null,
      accounts: acc.rows[0].n,
      plan: PLAN,
    });
  })
);

const addSchema = z.object({ videoUrl: z.string().url(), videoPublicId: z.string().min(1).max(300) });

reelsRouter.post(
  "/library",
  wrap(async (req, res) => {
    const parsed = addSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
    const d = parsed.data;
    const uid = req.user!.id;
    if (!d.videoUrl.startsWith(`${BASE}video/upload/`) || !d.videoPublicId.startsWith(`reels/${uid}/`)) {
      return res.status(400).json({ error: "Invalid video" });
    }
    const count = await pool.query("SELECT count(*)::int AS n FROM library WHERE user_id = $1", [uid]);
    if (count.rows[0].n >= CAP) return res.status(400).json({ error: `Library is full (max ${CAP} videos)` });
    const { rows } = await pool.query<{ id: string }>(
      "INSERT INTO library (user_id, video_url, video_public_id) VALUES ($1, $2, $3) RETURNING id",
      [uid, d.videoUrl, d.videoPublicId]
    );
    res.status(201).json({ id: rows[0].id });
  })
);

const settingsSchema = z.object({
  caption: z.string().max(2200, "Caption can be at most 2200 characters").default(""),
  coverUrl: z.string().url().nullable().optional(),
  coverPublicId: z.string().min(1).max(300).nullable().optional(),
});

reelsRouter.put(
  "/library/settings",
  wrap(async (req, res) => {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
    const d = parsed.data;
    const uid = req.user!.id;
    if (d.coverUrl) {
      if (!d.coverUrl.startsWith(`${BASE}image/upload/`) || !d.coverPublicId?.startsWith(`reels/${uid}/`)) {
        return res.status(400).json({ error: "Invalid cover image" });
      }
    }
    const old = await pool.query<{ cover_public_id: string | null }>(
      "SELECT cover_public_id FROM queue_settings WHERE user_id = $1",
      [uid]
    );
    await pool.query(
      `INSERT INTO queue_settings (user_id, caption, cover_url, cover_public_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET
         caption = EXCLUDED.caption,
         cover_url = COALESCE(EXCLUDED.cover_url, queue_settings.cover_url),
         cover_public_id = COALESCE(EXCLUDED.cover_public_id, queue_settings.cover_public_id),
         updated_at = now()`,
      [uid, d.caption, d.coverUrl ?? null, d.coverPublicId ?? null]
    );
    const oldId = old.rows[0]?.cover_public_id;
    if (d.coverUrl && oldId && oldId !== d.coverPublicId) await destroyAsset(oldId, "image");
    res.json({ ok: true });
  })
);

// Delete EVERYTHING of this user: library, settings, all reels, and every file in Cloudinary.
reelsRouter.post(
  "/library/reset",
  wrap(async (req, res) => {
    const uid = req.user!.id;
    await pool.query("DELETE FROM reels WHERE user_id = $1", [uid]);
    await pool.query("DELETE FROM library WHERE user_id = $1", [uid]);
    await pool.query("DELETE FROM queue_settings WHERE user_id = $1", [uid]);
    await destroyByPrefix(`reels/${uid}/`);
    res.json({ ok: true });
  })
);

// Test: post the first N library videos right now (to every connected account).
reelsRouter.post(
  "/library/test",
  wrap(async (req, res) => {
    const parsed = z.object({ count: z.number().int().min(1).max(PLAN.batch) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid count" });
    const n = await release(0, parsed.data.count, req.user!.id);
    res.json({ created: n });
  })
);

reelsRouter.delete(
  "/library/:id",
  wrap(async (req, res) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: "Invalid id" });
    const { rows } = await pool.query<{ video_public_id: string }>(
      "DELETE FROM library WHERE id = $1 AND user_id = $2 RETURNING video_public_id",
      [id.data, req.user!.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Not found" });
    await destroyAsset(rows[0].video_public_id, "video");
    res.json({ ok: true });
  })
);

// ---- Posts (one row per video per account) ----
reelsRouter.get(
  "/",
  wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT r.id, r.video_url, r.cover_url, r.caption, r.scheduled_at, r.status, r.error, a.username
       FROM reels r JOIN instagram_accounts a ON a.id = r.instagram_account_id
       WHERE r.user_id = $1
       ORDER BY r.scheduled_at DESC, r.created_at ASC LIMIT 100`,
      [req.user!.id]
    );
    res.json({ reels: rows });
  })
);

// Removes a waiting or failed post only. The video stays in the library.
reelsRouter.delete(
  "/:id",
  wrap(async (req, res) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: "Invalid id" });
    const r = await pool.query(
      "DELETE FROM reels WHERE id = $1 AND user_id = $2 AND status IN ('scheduled', 'failed')",
      [id.data, req.user!.id]
    );
    if (!r.rowCount) return res.status(409).json({ error: "This post can't be deleted right now" });
    res.json({ ok: true });
  })
);
