import { useEffect, useState } from "react";

type State = "loading" | "up" | "down";

async function check(path: string): Promise<State> {
  try {
    const res = await fetch(path);
    return res.ok ? "up" : "down";
  } catch {
    return "down";
  }
}

export default function App() {
  const [api, setApi] = useState<State>("loading");
  const [db, setDb] = useState<State>("loading");

  useEffect(() => {
    check("/api/health").then(setApi);
    check("/api/ready").then(setDb);
  }, []);

  return (
    <main className="wrap">
      <h1>Reel Scheduler</h1>
      <p className="muted">Foundation is running.</p>
      <ul className="status">
        <li><span>API</span><b className={api}>{api}</b></li>
        <li><span>Database</span><b className={db}>{db}</b></li>
      </ul>
    </main>
  );
}
