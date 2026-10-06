import { FormEvent, useCallback, useEffect, useState } from "react";

type Acc = { id: string; username: string };
type Reel = {
  id: string;
  username: string;
  video_url: string;
  cover_url: string | null;
  caption: string;
  scheduled_at: string;
  status: string;
  error: string | null;
};
type Lib = {
  items: { id: string; video_url: string }[];
  caption: string;
  coverUrl: string | null;
  accounts: number;
  plan: { slots: string[]; batch: number; tz: string };
};
type Sig = { cloudName: string; apiKey: string; timestamp: number; folder: string; signature: string };
type Uploaded = { url: string; publicId: string };

const MAX_VIDEO = 100 * 1024 * 1024;
const MAX_COVER = 8 * 1024 * 1024;

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

function uploadFile(file: File, kind: "video" | "image", sig: Sig, onProgress: (p: number) => void): Promise<Uploaded> {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("api_key", sig.apiKey);
    fd.append("timestamp", String(sig.timestamp));
    fd.append("folder", sig.folder);
    fd.append("signature", sig.signature);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `https://api.cloudinary.com/v1_1/${sig.cloudName}/${kind}/upload`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      try {
        const d = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve({ url: d.secure_url, publicId: d.public_id });
        else reject(new Error(d.error?.message ?? "Upload failed"));
      } catch {
        reject(new Error("Upload failed"));
      }
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.send(fd);
  });
}

const jpg = (url: string) => url.replace(/\.[^./]+$/, ".jpg");

export default function Reels({ accounts }: { accounts: Acc[] }) {
  const [lib, setLib] = useState<Lib | null>(null);
  const [reels, setReels] = useState<Reel[] | null>(null);

  // shared caption + cover
  const [caption, setCaption] = useState<string | null>(null);
  const [cover, setCover] = useState<File | null>(null);
  const [cKey, setCKey] = useState(0);
  const [cStatus, setCStatus] = useState("");
  const [cError, setCError] = useState("");
  const [cBusy, setCBusy] = useState(false);

  // video upload
  const [files, setFiles] = useState<File[]>([]);
  const [fKey, setFKey] = useState(0);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

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
    const t = setInterval(loadReels, 20_000);
    return () => clearInterval(t);
  }, [loadLib, loadReels]);

  async function saveSettings(e: FormEvent) {
    e.preventDefault();
    setCError("");
    if (cover && cover.size > MAX_COVER) return setCError("Cover image must be under 8 MB");
    setCBusy(true);
    try {
      let c: Uploaded | null = null;
      if (cover) {
        const sig = await api<Sig>("/api/reels/upload-signature");
        c = await uploadFile(cover, "image", sig, (p) => setCStatus(`Uploading cover ${p}%`));
      }
      await api("/api/reels/library/settings", {
        method: "PUT",
        body: JSON.stringify({
          caption: caption ?? lib?.caption ?? "",
          coverUrl: c?.url ?? null,
          coverPublicId: c?.publicId ?? null,
        }),
      });
      setCover(null);
      setCKey((k) => k + 1);
      setCStatus("Saved");
      loadLib();
    } catch (err) {
      setCError((err as Error).message);
      setCStatus("");
    } finally {
      setCBusy(false);
    }
  }

  async function addVideos(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (!lib) return;
    if (files.length === 0) return setError("Please choose videos");
    if (files.some((f) => f.size > MAX_VIDEO)) return setError("Each video must be under 100 MB");
    const max = lib.plan.slots.length * lib.plan.batch;
    const room = max - lib.items.length;
    if (files.length > room) return setError(`Only ${room} more video(s) fit. Maximum is ${max}.`);

    setBusy(true);
    let done = 0;
    try {
      for (const f of files) {
        const sig = await api<Sig>("/api/reels/upload-signature");
        const v = await uploadFile(f, "video", sig, (p) =>
          setStatus(`Video ${done + 1} of ${files.length}: uploading ${p}%`)
        );
        await api("/api/reels/library", {
          method: "POST",
          body: JSON.stringify({ videoUrl: v.url, videoPublicId: v.publicId }),
        });
        done++;
        loadLib();
      }
      setFiles([]);
      setFKey((k) => k + 1);
    } catch (err) {
      setError(`${(err as Error).message} (${done} of ${files.length} added. Choose only the remaining videos again.)`);
    } finally {
      setBusy(false);
      setStatus("");
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
    if (!window.confirm("Sab delete ho jayega: saare videos, cover, caption, posts aur Cloudinary storage. Continue?")) return;
    if (!window.confirm("Pakka? Ye wapas nahi aayega.")) return;
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

      <h2>Caption and Cover (sabke liye ek)</h2>
      <form className="form" onSubmit={saveSettings} key={`c${cKey}`}>
        {lib?.coverUrl && <img className="thumb" src={lib.coverUrl} alt="" />}
        <label className="field">
          Cover image (JPG/PNG, naya chunoge to purana replace hoga)
          <input type="file" accept="image/jpeg,image/png" onChange={(e) => setCover(e.target.files?.[0] ?? null)} />
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
      <form className="form" onSubmit={addVideos} key={`f${fKey}`}>
        <label className="field">
          Videos (select many, MP4/MOV, max 100 MB each)
          <input
            type="file"
            multiple
            accept="video/mp4,video/quicktime"
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
          />
        </label>
        {files.length > 0 && <p className="muted">{files.length} video(s) selected</p>}
        {error && <p className="msg bad">{error}</p>}
        {status && <p className="msg good">{status}</p>}
        <button className="btn" disabled={busy}>{busy ? "Uploading... keep this page open" : "Add videos"}</button>
      </form>

      {lib && lib.items.length > 0 && (
        <ul className="status">
          {lib.items.map((v, i) => (
            <li key={v.id} className="reel">
              <img className="thumb" src={jpg(v.video_url)} alt="" />
              <div className="info">
                <b>Video {i + 1}</b>
                <small>
                  Slot {lib.plan.slots[Math.floor(i / lib.plan.batch)] ?? "-"}
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
              <img className="thumb" src={r.cover_url ?? jpg(r.video_url)} alt="" />
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
        Delete everything (videos, posts, storage)
      </button>
    </section>
  );
}
