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

const thumb = (r: Reel) => r.cover_url ?? r.video_url.replace(/\.[^./]+$/, ".jpg");

export default function Reels({ accounts }: { accounts: Acc[] }) {
  const [reels, setReels] = useState<Reel[] | null>(null);
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");

  // single scheduled reel
  const [video, setVideo] = useState<File | null>(null);
  const [cover, setCover] = useState<File | null>(null);
  const [caption, setCaption] = useState("");
  const [when, setWhen] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [formKey, setFormKey] = useState(0);

  // daily queue
  const [qFiles, setQFiles] = useState<File[]>([]);
  const [qCover, setQCover] = useState<File | null>(null);
  const [qCaption, setQCaption] = useState("");
  const [qStatus, setQStatus] = useState("");
  const [qError, setQError] = useState("");
  const [qBusy, setQBusy] = useState(false);
  const [qKey, setQKey] = useState(0);

  const load = useCallback(() => {
    api<{ reels: Reel[] }>("/api/reels")
      .then((d) => setReels(d.reels))
      .catch(() => setReels([]));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!accounts.find((a) => a.id === accountId)) setAccountId(accounts[0]?.id ?? "");
  }, [accounts, accountId]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (!video) return setError("Please choose a video");
    if (video.size > MAX_VIDEO) return setError("Video must be under 100 MB");
    if (cover && cover.size > MAX_COVER) return setError("Cover image must be under 8 MB");
    if (!when) return setError("Please choose a date and time");

    setBusy(true);
    try {
      const sig = await api<Sig>("/api/reels/upload-signature");
      const v = await uploadFile(video, "video", sig, (p) => setStatus(`Uploading video ${p}%`));
      let c: Uploaded | null = null;
      if (cover) c = await uploadFile(cover, "image", sig, (p) => setStatus(`Uploading cover ${p}%`));
      setStatus("Saving...");
      await api("/api/reels", {
        method: "POST",
        body: JSON.stringify({
          instagramAccountId: accountId,
          videoUrl: v.url,
          videoPublicId: v.publicId,
          coverUrl: c?.url ?? null,
          coverPublicId: c?.publicId ?? null,
          caption,
          scheduledAt: new Date(when).toISOString(),
        }),
      });
      setVideo(null);
      setCover(null);
      setCaption("");
      setWhen("");
      setFormKey((k) => k + 1);
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setStatus("");
    }
  }

  async function submitQueue(e: FormEvent) {
    e.preventDefault();
    setQError("");
    if (qFiles.length === 0) return setQError("Please choose one or more videos");
    if (qFiles.some((f) => f.size > MAX_VIDEO)) return setQError("Each video must be under 100 MB");
    if (qCover && qCover.size > MAX_COVER) return setQError("Cover image must be under 8 MB");

    setQBusy(true);
    let done = 0;
    try {
      let c: Uploaded | null = null;
      if (qCover) {
        const sig = await api<Sig>("/api/reels/upload-signature");
        c = await uploadFile(qCover, "image", sig, (p) => setQStatus(`Uploading cover ${p}%`));
      }
      for (const f of qFiles) {
        const sig = await api<Sig>("/api/reels/upload-signature");
        const v = await uploadFile(f, "video", sig, (p) =>
          setQStatus(`Video ${done + 1} of ${qFiles.length}: uploading ${p}%`)
        );
        await api("/api/reels/queue", {
          method: "POST",
          body: JSON.stringify({
            instagramAccountId: accountId,
            videoUrl: v.url,
            videoPublicId: v.publicId,
            coverUrl: c?.url ?? null,
            coverPublicId: c?.publicId ?? null,
            caption: qCaption,
          }),
        });
        done++;
        load();
      }
      setQFiles([]);
      setQCover(null);
      setQKey((k) => k + 1);
    } catch (err) {
      setQError(`${(err as Error).message} (${done} of ${qFiles.length} added to queue)`);
    } finally {
      setQBusy(false);
      setQStatus("");
    }
  }

  const queuedCount = reels?.filter((r) => r.status === "queued").length ?? 0;

  async function publishAll() {
    if (!window.confirm(`${queuedCount} reels abhi publish hongi. Continue?`)) return;
    try {
      const d = await api<{ released: number }>("/api/reels/queue/publish-now", { method: "POST" });
      window.alert(`${d.released} reel(s) publish hone lagi`);
    } catch (err) {
      window.alert((err as Error).message);
    }
    load();
  }

  async function remove(id: string) {
    if (!window.confirm("Delete this reel?")) return;
    try {
      await api(`/api/reels/${id}`, { method: "DELETE" });
    } catch (err) {
      window.alert((err as Error).message);
    }
    load();
  }

  return (
    <section>
      <h2>Daily Queue</h2>
      <p className="muted">Add many videos once. They post automatically at the daily slots, one after another.</p>
      <form className="form" onSubmit={submitQueue} key={`q${qKey}`}>
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>@{a.username}</option>
          ))}
        </select>
        <label className="field">
          Videos (select many, MP4/MOV, max 100 MB each)
          <input
            type="file"
            multiple
            accept="video/mp4,video/quicktime"
            onChange={(e) => setQFiles(Array.from(e.target.files ?? []))}
          />
        </label>
        {qFiles.length > 0 && <p className="muted">{qFiles.length} video(s) selected</p>}
        <label className="field">
          Cover image for all (optional, JPG/PNG)
          <input type="file" accept="image/jpeg,image/png" onChange={(e) => setQCover(e.target.files?.[0] ?? null)} />
        </label>
        <textarea
          placeholder="Caption for all"
          rows={4}
          maxLength={2200}
          value={qCaption}
          onChange={(e) => setQCaption(e.target.value)}
        />
        {qError && <p className="msg bad">{qError}</p>}
        {qStatus && <p className="msg good">{qStatus}</p>}
        <button className="btn" disabled={qBusy}>{qBusy ? "Uploading... keep this page open" : "Add to Queue"}</button>
      </form>
      <p className="muted">In queue: {queuedCount}</p>
      {queuedCount > 0 && (
        <button type="button" className="btn" onClick={publishAll}>
          Publish all now ({queuedCount})
        </button>
      )}

      <h2>Schedule one Reel</h2>
      <form className="form" onSubmit={submit} key={formKey}>
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>@{a.username}</option>
          ))}
        </select>
        <label className="field">
          Video (MP4/MOV, max 100 MB)
          <input type="file" accept="video/mp4,video/quicktime" onChange={(e) => setVideo(e.target.files?.[0] ?? null)} />
        </label>
        <label className="field">
          Cover image (optional, JPG/PNG)
          <input type="file" accept="image/jpeg,image/png" onChange={(e) => setCover(e.target.files?.[0] ?? null)} />
        </label>
        <textarea
          placeholder="Caption"
          rows={4}
          maxLength={2200}
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
        />
        <label className="field">
          Publish at
          <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        </label>
        {error && <p className="msg bad">{error}</p>}
        {status && <p className="msg good">{status}</p>}
        <button className="btn" disabled={busy}>{busy ? "Please wait..." : "Schedule Reel"}</button>
      </form>

      <h2>Your Reels</h2>
      {reels === null ? (
        <p className="muted">Loading...</p>
      ) : reels.length === 0 ? (
        <p className="muted">No reels yet.</p>
      ) : (
        <ul className="status">
          {reels.map((r) => (
            <li key={r.id} className="reel">
              <img className="thumb" src={thumb(r)} alt="" />
              <div className="info">
                <b>@{r.username}</b>
                <small>{r.status === "queued" ? "Waiting in queue" : new Date(r.scheduled_at).toLocaleString()}</small>
                <small className="cap">{r.caption || "(no caption)"}</small>
                <span className={`badge ${r.status}`}>{r.status}</span>
                {r.error && <small className="bad">{r.error}</small>}
              </div>
              {(r.status === "queued" || r.status === "scheduled" || r.status === "failed") && (
                <button type="button" className="link" onClick={() => remove(r.id)}>Delete</button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
