import { FormEvent, useCallback, useEffect, useState } from "react";

type Acc = { id: string; username: string };
type Reel = {
  id: string;
  username: string;
  cover_url: string | null;
  caption: string;
  scheduled_at: string;
  status: string;
  error: string | null;
};
type Lib = {
  items: { id: string; tg_size: number | null }[];
  caption: string;
  coverUrl: string | null;
  accounts: number;
  plan: { slots: string[]; batch: number; tz: string };
  telegram: { enabled: boolean; linked: boolean; code: string; bot: string | null };
};

const MAX_COVER = 5 * 1024 * 1024;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? "Something went wrong");
  return data as T;
}

export default function Reels({ accounts: _accounts }: { accounts: Acc[] }) {
  const [lib, setLib] = useState<Lib | null>(null);
  const [reels, setReels] = useState<Reel[] | null>(null);

  const [caption, setCaption] = useState<string | null>(null);
  const [cover, setCover] = useState<File | null>(null);
  const [cKey, setCKey] = useState(0);
  const [cStatus, setCStatus] = useState("");
  const [cError, setCError] = useState("");
  const [cBusy, setCBusy] = useState(false);

  const [testCount, setTestCount] = useState(1);

  const loadLib = useCallback(() => {
    api<Lib>("/api/reels/library").then(setLib).catch(() => {});
  }, []);
  const loadReels = useCallback(() => {
    api<{ reels: Reel[] }>("/api/reels")
      .then((d) => setReels(d.reels))
      .catch(() => setReels([]));
  }, []);

  useEffect(() => {
    loadLib();
    loadReels();
    const t1 = setInterval(loadReels, 20_000);
    const t2 = setInterval(loadLib, 10_000);
    return () => {
      clearInterval(t1);
      clearInterval(t2);
    };
  }, [loadLib, loadReels]);

  async function saveSettings(e: FormEvent) {
    e.preventDefault();
    setCError("");
    setCStatus("");
    if (cover && cover.type !== "image/jpeg") return setCError("Cover JPG hona chahiye");
    if (cover && cover.size > MAX_COVER) return setCError("Cover 5 MB se chhota hona chahiye");
    setCBusy(true);
    try {
      if (cover) {
        const res = await fetch("/api/reels/library/cover", {
          method: "PUT",
          headers: { "Content-Type": "image/jpeg" },
          credentials: "same-origin",
          body: cover,
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error((d as { error?: string }).error ?? "Cover upload failed");
        }
      }
      await api("/api/reels/library/settings", {
        method: "PUT",
        body: JSON.stringify({ caption: caption ?? lib?.caption ?? "" }),
      });
      setCover(null);
      setCKey((k) => k + 1);
      setCStatus("Saved");
      loadLib();
    } catch (err) {
      setCError((err as Error).message);
    } finally {
      setCBusy(false);
    }
  }

  async function removeVideo(id: string) {
    if (!window.confirm("Remove this video from the library?")) return;
    try {
      await api(`/api/reels/library/${id}`, { method: "DELETE" });
    } catch (err) {
      window.alert((err as Error).message);
    }
    loadLib();
  }

  async function resetAll() {
    if (!window.confirm("Library, caption, cover aur saari posts delete ho jayengi. Continue?")) return;
    try {
      await api("/api/reels/library/reset", { method: "POST" });
      setCaption(null);
    } catch (err) {
      window.alert((err as Error).message);
    }
    loadLib();
    loadReels();
  }

  async function testPost() {
    if (!window.confirm(`Library ke pehle ${testCount} video(s) abhi sab accounts par post honge. Continue?`)) return;
    try {
      const d = await api<{ created: number }>("/api/reels/library/test", {
        method: "POST",
        body: JSON.stringify({ count: testCount }),
      });
      window.alert(d.created === 0 ? "Kuch nahi bana. Library khali hai ya koi active account nahi." : `${d.created} post shuru hui`);
    } catch (err) {
      window.alert((err as Error).message);
    }
    loadReels();
  }

  async function removePost(id: string) {
    if (!window.confirm("Delete this post?")) return;
    try {
      await api(`/api/reels/${id}`, { method: "DELETE" });
    } catch (err) {
      window.alert((err as Error).message);
    }
    loadReels();
  }

  const max = lib ? lib.plan.slots.length * lib.plan.batch : 0;
  const tgl = lib?.telegram;

  return (
    <section>
      <h2>Daily Plan</h2>
      {lib ? (
        <p className="muted">
          Roz {lib.plan.slots.join(", ")} par har account pe {lib.plan.batch} reels. Connected accounts: {lib.accounts}.
          Agle din wahi videos dobara shuru se.
        </p>
      ) : (
        <p className="muted">Loading...</p>
      )}

      <h2>Telegram (videos yahan se aayengi)</h2>
      {tgl && !tgl.enabled && <p className="msg bad">Koyeb mein TELEGRAM_BOT_TOKEN set nahi hai.</p>}
      {tgl && tgl.enabled && (
        <>
          <p className="muted">
            {tgl.linked ? "Telegram linked. Videos bot ko bhejte jao (max 20 MB each)." : "Link karne ke liye:"}
          </p>
          {!tgl.linked && (
            <p className="muted">
              1) Telegram mein @{tgl.bot ?? "apna bot"} kholo. 2) Ye message bhejo: <b>/start {tgl.code}</b> 3) Phir videos bhejo.
            </p>
          )}
        </>
      )}

      <h2>Cover and Caption (sabke liye ek)</h2>
      <form className="form" onSubmit={saveSettings} key={`c${cKey}`}>
        {lib?.coverUrl && <img className="thumb" src={lib.coverUrl} alt="" />}
        <label className="field">
          Cover image (sirf JPG, 9:16 best, naya chunoge to purana replace hoga)
          <input type="file" accept="image/jpeg" onChange={(e) => setCover(e.target.files?.[0] ?? null)} />
        </label>
        <textarea
          placeholder="Caption"
          rows={4}
          maxLength={2200}
          value={caption ?? lib?.caption ?? ""}
          onChange={(e) => setCaption(e.target.value)}
        />
        {cError && <p className="msg bad">{cError}</p>}
        {cStatus && <p className="msg good">{cStatus}</p>}
        <button className="btn" disabled={cBusy}>{cBusy ? "Please wait..." : "Save caption and cover"}</button>
      </form>

      <h2>Videos ({lib?.items.length ?? 0} / {max})</h2>
      {lib && lib.items.length === 0 && <p className="muted">Abhi koi video nahi. Telegram bot ko videos bhejo.</p>}
      {lib && lib.items.length > 0 && (
        <ul className="status">
          {lib.items.map((v, i) => (
            <li key={v.id} className="reel">
              <div className="info">
                <b>Video {i + 1}</b>
                <small>
                  Slot {lib.plan.slots[Math.floor(i / lib.plan.batch)] ?? "-"}
                  {v.tg_size ? ` · ${(v.tg_size / 1048576).toFixed(1)} MB` : ""}
                </small>
              </div>
              <button type="button" className="link" onClick={() => removeVideo(v.id)}>Remove</button>
            </li>
          ))}
        </ul>
      )}

      <h2>Test</h2>
      <p className="muted">Pehle {testCount} video abhi sab accounts par post hoga. Ye video aaj apne slot par dobara post hoga.</p>
      <div className="row">
        <input
          type="number"
          min={1}
          max={lib?.plan.batch ?? 10}
          value={testCount}
          onChange={(e) => setTestCount(Math.max(1, Number(e.target.value) || 1))}
        />
        <button type="button" className="btn" onClick={testPost}>Test post now</button>
      </div>

      <h2>Recent posts</h2>
      {reels === null ? (
        <p className="muted">Loading...</p>
      ) : reels.length === 0 ? (
        <p className="muted">No posts yet.</p>
      ) : (
        <ul className="status">
          {reels.map((r) => (
            <li key={r.id} className="reel">
              {r.cover_url ? <img className="thumb" src={r.cover_url} alt="" /> : <div className="thumb" />}
              <div className="info">
                <b>@{r.username}</b>
                <small>{new Date(r.scheduled_at).toLocaleString()}</small>
                <span className={`badge ${r.status}`}>{r.status}</span>
                {r.error && <small className="bad">{r.error}</small>}
              </div>
              {(r.status === "scheduled" || r.status === "failed") && (
                <button type="button" className="link" onClick={() => removePost(r.id)}>Delete</button>
              )}
            </li>
          ))}
        </ul>
      )}

      <h2>Danger zone</h2>
      <button type="button" className="btn" style={{ background: "#dc2626" }} onClick={resetAll}>
        Delete library and posts
      </button>
    </section>
  );
}
