import { FormEvent, useCallback, useEffect, useState } from "react";

type User = { id: string; email: string };
type Account = {
  id: string;
  username: string;
  account_type: string | null;
  status: string;
  token_expires_at: string | null;
  connected_at: string;
};

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

const NOTICES: Record<string, { text: string; ok: boolean }> = {
  connected: { text: "Instagram account connected.", ok: true },
  denied: { text: "Instagram connection was cancelled.", ok: false },
  taken: { text: "That Instagram account is already linked to another user.", ok: false },
  error: { text: "Could not connect Instagram. Please try again.", ok: false },
};

function AuthForm({ onDone }: { onDone: (u: User) => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { user } = await api<{ user: User }>(`/api/auth/${mode}`, {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      onDone(user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="wrap">
      <h1>Reel Scheduler</h1>
      <p className="muted">{mode === "login" ? "Log in to your account" : "Create your account"}</p>
      <form className="form" onSubmit={submit}>
        <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        <input
          type="password"
          placeholder="Password (min 10 characters)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete={mode === "login" ? "current-password" : "new-password"}
        />
        {error && <p className="msg bad">{error}</p>}
        <button className="btn" disabled={busy}>{busy ? "Please wait..." : mode === "login" ? "Log in" : "Sign up"}</button>
      </form>
      <button className="link" onClick={() => { setMode(mode === "login" ? "signup" : "login"); setError(""); }}>
        {mode === "login" ? "New here? Create an account" : "Already have an account? Log in"}
      </button>
    </main>
  );
}

function Dashboard({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);

  const load = useCallback(() => {
    api<{ accounts: Account[] }>("/api/instagram/accounts")
      .then((d) => setAccounts(d.accounts))
      .catch(() => setAccounts([]));
  }, []);

  useEffect(() => {
    load();
    const key = new URLSearchParams(window.location.search).get("instagram");
    if (key && NOTICES[key]) setNotice(NOTICES[key]);
    if (key) window.history.replaceState({}, "", "/");
  }, [load]);

  async function disconnect(id: string) {
    if (!window.confirm("Disconnect this Instagram account?")) return;
    await api(`/api/instagram/accounts/${id}`, { method: "DELETE" }).catch(() => {});
    load();
  }

  return (
    <main className="wrap">
      <div className="row">
        <h1>Reel Scheduler</h1>
        <button className="link" onClick={onLogout}>Log out</button>
      </div>
      <p className="muted">{user.email}</p>
      {notice && <p className={`msg ${notice.ok ? "good" : "bad"}`}>{notice.text}</p>}

      <h2>Instagram accounts</h2>
      {accounts === null ? (
        <p className="muted">Loading...</p>
      ) : accounts.length === 0 ? (
        <p className="muted">No account connected yet.</p>
      ) : (
        <ul className="status">
          {accounts.map((a) => (
            <li key={a.id}>
              <span>
                @{a.username}
                <small> {a.account_type ?? ""} · {a.status}</small>
              </span>
              <button className="link" onClick={() => disconnect(a.id)}>Disconnect</button>
            </li>
          ))}
        </ul>
      )}
      <a className="btn" href="/api/instagram/connect">Connect Instagram account</a>
    </main>
  );
}

export default function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    api<{ user: User }>("/api/auth/me")
      .then((d) => setUser(d.user))
      .catch(() => setUser(null));
  }, []);

  async function logout() {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    setUser(null);
  }

  if (user === undefined) return <main className="wrap"><p className="muted">Loading...</p></main>;
  return user ? <Dashboard user={user} onLogout={logout} /> : <AuthForm onDone={setUser} />;
}
