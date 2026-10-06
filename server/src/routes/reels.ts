import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env";
import { pool } from "../db/pool";
import { destroyAsset, signUpload } from "../lib/cloudinary";
import { requireAuth, wrap } from "./auth";

export const reelsRouter = Router();
reelsRouter.use(requireAuth);

const BASE = `https://res.cloudinary.com/${env.CLOUDINARY_CLOUD_NAME}/`;

// Each user uploads only into their own folder.
reelsRouter.get("/upload-signature", (req, res) => {
  res.json(signUpload(`reels/${req.user!.id}`));
});

const createSchema = z.object({
  instagramAccountId: z.string().uuid(),
  videoUrl: z.string().url(),
  videoPublicId: z.string().min(1).max(300),
  coverUrl: z.string().url().nullable().optional(),
  coverPublicId: z.string().min(1).max(300).nullable().optional(),
  caption: z.string().max(2200, "Caption can be at most 2200 characters").default(""),
  scheduledAt: z.string().datetime({ offset: true }),
});

reelsRouter.post(
  "/",
  wrap(async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
    const d = parsed.data;
    const prefix = `reels/${req.user!.id}/`;

    if (!d.videoUrl.startsWith(`${BASE}video/upload/`) || !d.videoPublicId.startsWith(prefix)) {
      return res.status(400).json({ error: "Invalid video" });
    }
    if (d.coverUrl && (!d.coverUrl.startsWith(`${BASE}image/upload/`) || !d.coverPublicId?.startsWith(prefix))) {
      return res.status(400).json({ error: "Invalid cover image" });
    }

    const when = new Date(d.scheduledAt).getTime();
    const now = Date.now();
    if (when < now + 60_000) return res.status(400).json({ error: "Schedule time must be at least 1 minute from now" });
    if (when > now + 365 * 86_400_000) return res.status(400).json({ error: "Schedule time is too far ahead" });

    const acc = await pool.query(
      "SELECT id FROM instagram_accounts WHERE id = $1 AND user_id = $2 AND status = 'active'",
      [d.instagramAccountId, req.user!.id]
    );
    if (!acc.rows[0]) return res.status(404).json({ error: "Instagram account not found" });

    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO reels
         (user_id, instagram_account_id, video_url, video_public_id, cover_url, cover_public_id, caption, scheduled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        req.user!.id,
        d.instagramAccountId,
        d.videoUrl,
        d.videoPublicId,
        d.coverUrl ?? null,
        d.coverPublicId ?? null,
        d.caption,
        new Date(d.scheduledAt),
      ]
    );
    res.status(201).json({ id: rows[0].id });
  })
);

reelsRouter.get(
  "/",
  wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT r.id, r.video_url, r.cover_url, r.caption, r.scheduled_at, r.status, r.error, a.username
       FROM reels r JOIN instagram_accounts a ON a.id = r.instagram_account_id
       WHERE r.user_id = $1 ORDER BY r.scheduled_at DESC LIMIT 100`,
      [req.user!.id]
    );
    res.json({ reels: rows });
  })
);

// Only scheduled or failed reels can be deleted.
reelsRouter.delete(
  "/:id",
  wrap(async (req, res) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: "Invalid id" });
    const { rows } = await pool.query<{ video_public_id: string; cover_public_id: string | null }>(
      `DELETE FROM reels WHERE id = $1 AND user_id = $2 AND status IN ('scheduled', 'failed')
       RETURNING video_public_id, cover_public_id`,
      [id.data, req.user!.id]
    );
    if (!rows[0]) return res.status(409).json({ error: "This reel can't be deleted right now" });
    await destroyAsset(rows[0].video_public_id, "video");
    if (rows[0].cover_public_id) await destroyAsset(rows[0].cover_public_id, "image");
    res.json({ ok: true });
  })
);
