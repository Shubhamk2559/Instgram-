import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env";
import { pool } from "../db/pool";
import { encryptToken, newToken, sha256 } from "../lib/security";
import { requireAuth, wrap } from "./auth";

const SCOPES = ["instagram_business_basic", "instagram_business_content_publish"];
const REDIRECT_URI = `${env.APP_BASE_URL}/api/instagram/callback`;

async function igJson<T>(r: Response): Promise<T> {
  const data = (await r.json().catch(() => ({}))) as T;
  if (!r.ok) throw new Error(`Instagram API error ${r.status}: ${JSON.stringify(data)}`);
  return data;
}

export const instagramRouter = Router();
instagramRouter.use(requireAuth);

// Step 1: send the user to Instagram's official login screen.
instagramRouter.get(
  "/connect",
  wrap(async (req, res) => {
    const state = newToken();
    await pool.query("DELETE FROM oauth_states WHERE expires_at < now()");
    await pool.query(
      "INSERT INTO oauth_states (user_id, state_hash, expires_at) VALUES ($1, $2, now() + interval '10 minutes')",
      [req.user!.id, sha256(state)]
    );
    const url = new URL("https://www.instagram.com/oauth/authorize");
    url.searchParams.set("client_id", env.INSTAGRAM_APP_ID);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", SCOPES.join(","));
    url.searchParams.set("state", state);
    res.redirect(url.toString());
  })
);

// Step 2: Instagram sends the user back here with a code.
instagramRouter.get(
  "/callback",
  wrap(async (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : undefined;
    const state = typeof req.query.state === "string" ? req.query.state : undefined;
    if (req.query.error || !code || !state) return res.redirect("/?instagram=denied");

    // State is single-use and must belong to the logged-in user.
    const used = await pool.query(
      "DELETE FROM oauth_states WHERE state_hash = $1 AND user_id = $2 AND expires_at > now() RETURNING id",
      [sha256(state), req.user!.id]
    );
    if (!used.rows[0]) return res.redirect("/?instagram=error");

    try {
      // Code -> short-lived token
      const short = await igJson<{ access_token: string }>(
        await fetch("https://api.instagram.com/oauth/access_token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: env.INSTAGRAM_APP_ID,
            client_secret: env.INSTAGRAM_APP_SECRET,
            grant_type: "authorization_code",
            redirect_uri: REDIRECT_URI,
            code,
          }),
        })
      );

      // Short-lived -> long-lived token (about 60 days)
      const longUrl = new URL("https://graph.instagram.com/access_token");
      longUrl.searchParams.set("grant_type", "ig_exchange_token");
      longUrl.searchParams.set("client_secret", env.INSTAGRAM_APP_SECRET);
      longUrl.searchParams.set("access_token", short.access_token);
      const long = await igJson<{ access_token: string; expires_in: number }>(await fetch(longUrl));

      // Who is this account?
      const meUrl = new URL("https://graph.instagram.com/v21.0/me");
      meUrl.searchParams.set("fields", "user_id,username,account_type");
      meUrl.searchParams.set("access_token", long.access_token);
      const me = await igJson<{ user_id?: string; id?: string; username: string; account_type?: string }>(
        await fetch(meUrl)
      );
      const igUserId = String(me.user_id ?? me.id);

      // Save (encrypted). An IG account can belong to only one user.
      const saved = await pool.query(
        `INSERT INTO instagram_accounts
           (user_id, instagram_user_id, username, account_type, access_token_encrypted, token_expires_at, scopes, status)
         VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' seconds')::interval, $7, 'active')
         ON CONFLICT (instagram_user_id) DO UPDATE SET
           username = EXCLUDED.username,
           account_type = EXCLUDED.account_type,
           access_token_encrypted = EXCLUDED.access_token_encrypted,
           token_expires_at = EXCLUDED.token_expires_at,
           scopes = EXCLUDED.scopes,
           status = 'active'
         WHERE instagram_accounts.user_id = EXCLUDED.user_id
         RETURNING id`,
        [
          req.user!.id,
          igUserId,
          me.username,
          me.account_type ?? null,
          encryptToken(long.access_token),
          String(long.expires_in),
          SCOPES.join(","),
        ]
      );
      if (!saved.rows[0]) return res.redirect("/?instagram=taken");
      res.redirect("/?instagram=connected");
    } catch (err) {
      console.error("Instagram connect failed:", err);
      res.redirect("/?instagram=error");
    }
  })
);

// List the user's connected accounts (tokens are never returned).
instagramRouter.get(
  "/accounts",
  wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT id, username, account_type, status, token_expires_at, connected_at
       FROM instagram_accounts WHERE user_id = $1 ORDER BY connected_at DESC`,
      [req.user!.id]
    );
    res.json({ accounts: rows });
  })
);

// Disconnect = delete the saved account and its token.
instagramRouter.delete(
  "/accounts/:id",
  wrap(async (req, res) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: "Invalid id" });
    await pool.query("DELETE FROM instagram_accounts WHERE id = $1 AND user_id = $2", [id.data, req.user!.id]);
    res.json({ ok: true });
  })
);
