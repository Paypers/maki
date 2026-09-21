/**
 * Cloud sync setup.
 *
 * Everything here is optional. The app works fully without it; this buys you a
 * backup that survives losing the phone, and a second device. The screen says
 * so plainly rather than implying the app is broken until you connect it.
 */

import { useEffect, useState } from "react";
import * as cloud from "../lib/cloud";
import * as store from "../lib/store";
import { Icon } from "../components/Icon";

interface Props {
  onBack: () => void;
  onChanged: () => void;
}

export function Cloud({ onBack, onChanged }: Props) {
  const [config, setConfig] = useState(cloud.getConfig());
  const [session, setSession] = useState(cloud.getSession());
  const [email, setEmail] = useState(session?.email ?? "");
  const [url, setUrl] = useState(config?.url ?? "");
  const [key, setKey] = useState(config?.anonKey ?? "");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [pending, setPending] = useState(0);

  useEffect(() => {
    void store.getQueue().then((q) => setPending(q.length));
    const restored = cloud.completeSignInFromUrl();
    if (restored) {
      setSession(restored);
      setStatus(`Signed in as ${restored.email}.`);
      cloud.install();
    }
  }, []);

  async function saveConfig() {
    const next = { url: url.trim().replace(/\/+$/, ""), anonKey: key.trim() };
    if (!next.url || !next.anonKey) return;
    cloud.setConfig(next);
    setConfig(next);
    cloud.install();
    setStatus("Project saved. Now sign in with your email.");
  }

  async function sendLink() {
    setBusy(true);
    setStatus(null);
    try {
      await cloud.requestMagicLink(email.trim());
      setStatus(`Link sent to ${email.trim()}. Open it on this device.`);
    } catch (err) {
      setStatus(`Could not send the link: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function syncNow() {
    setBusy(true);
    setStatus(null);
    try {
      const pushed = await store.sync();
      const pulled = await cloud.pull();
      setStatus(`Sent ${pushed.pushed}, received ${pulled.applied}.`);
      setPending((await store.getQueue()).length);
      onChanged();
    } catch (err) {
      setStatus(`Sync failed: ${(err as Error).message}. Your data is safe on this device.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <header className="bar">
        <button className="ghost" onClick={onBack} aria-label="Back"><Icon name="back" size={20} /></button>
        <h1>Cloud backup<span className="sub">optional</span></h1>
      </header>

      <div className="banner info">
        <Icon name="cloud" size={16} className="ico" />
        <span>
          The app works fully without this. Connecting a free Supabase project
          gives you an off-device backup and lets a second phone or a laptop see
          the same data.
        </span>
      </div>

      {!config && (
        <div className="card">
          <h2>1 · Point it at your project</h2>
          <p className="hint">
            Supabase → Project Settings → API. Both values are safe to paste
            here: the key grants nothing until you sign in, and each account can
            only ever read its own rows.
          </p>
          <label className="field">
            <span>Project URL</span>
            <input value={url} placeholder="https://xxxx.supabase.co"
                   autoCapitalize="off" autoCorrect="off"
                   onChange={(e) => setUrl(e.target.value)} />
          </label>
          <label className="field">
            <span>Anon public key</span>
            <input value={key} placeholder="eyJhbGciOi…"
                   autoCapitalize="off" autoCorrect="off"
                   onChange={(e) => setKey(e.target.value)} />
          </label>
          <button className="primary" disabled={!url.trim() || !key.trim()}
                  onClick={saveConfig}>
            Save project
          </button>
        </div>
      )}

      {config && !session && (
        <div className="card">
          <h2>2 · Sign in</h2>
          <p className="hint">
            We email you a link — no password to forget at 5am, and none to leak.
          </p>
          <label className="field">
            <span>Email</span>
            <input type="email" value={email} inputMode="email"
                   autoCapitalize="off" autoCorrect="off"
                   placeholder="you@example.com"
                   onChange={(e) => setEmail(e.target.value)} />
          </label>
          <div className="actions">
            <button className="primary" disabled={busy || !email.includes("@")}
                    onClick={sendLink}>
              {busy ? "Sending…" : "Email me a link"}
            </button>
            <button className="ghost" onClick={() => { cloud.setConfig(null); setConfig(null); }}>
              Change project
            </button>
          </div>
        </div>
      )}

      {config && session && (
        <div className="card">
          <h2>Connected</h2>
          <p className="hint">
            Signed in as <strong>{session.email}</strong>.
            {pending > 0
              ? ` ${pending} change${pending > 1 ? "s" : ""} waiting to upload.`
              : " Everything here has been sent."}
          </p>
          <div className="actions">
            <button className="primary" disabled={busy} onClick={syncNow}>
              {busy ? "Syncing…" : "Sync now"}
            </button>
            <button className="ghost" onClick={() => { cloud.signOut(); setSession(null); }}>
              Sign out
            </button>
          </div>
          <p className="hint">
            Signing out leaves every entry on this device. It only stops the
            copy going to the server.
          </p>
        </div>
      )}

      {status && (
        <div className="banner info"><Icon name="cloud" size={16} className="ico" /><span>{status}</span></div>
      )}

      <details className="card">
        <summary>How it handles two devices</summary>
        <p className="hint">
          Every change carries an ID the device generated, and the log is
          append-only. Send the same change twice and the second is ignored;
          edit the same day on two phones and both are kept, with the later one
          winning. There is no merge step to get wrong, and nothing is ever
          overwritten in place.
        </p>
      </details>
    </div>
  );
}
