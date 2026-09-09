import { useState, type FormEvent } from "react";
import { ApiError, api, setAuthToken } from "../lib/api";

interface Props {
  onSuccess: () => void;
}

/**
 * Gates the whole app behind APP_PASSWORD. Shown instead of the landing page
 * or board whenever the server has a password configured and this browser
 * doesn't already hold a valid token.
 */
export function Login({ onSuccess }: Props) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const { token } = await api.login(password);
      setAuthToken(token);
      onSuccess();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? "Incorrect password" : (err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="landing">
      <div className="landing-card">
        <h1 className="landing-title">Job Application Tracker</h1>
        <p className="landing-lede">This tracker is password-protected on this machine.</p>

        <form className="setting" onSubmit={handleSubmit}>
          <label htmlFor="login-password">Password</label>
          <div className="setting-row">
            <input
              id="login-password"
              type="password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
            />
          </div>
          {error && <p className="notice notice-bad">{error}</p>}
          <button className="btn btn-primary btn-lg" type="submit" disabled={submitting || !password}>
            {submitting ? "Checking…" : "Unlock"}
          </button>
        </form>
      </div>
    </div>
  );
}
