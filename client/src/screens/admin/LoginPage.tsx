import { useState, type FormEvent } from 'react';
import { ApiError, login } from '../../lib/api';
import { Button, Field, Input, Notice } from './ui';

export interface LoginPageProps {
  onLoggedIn: (token: string) => void;
  /** Shown above the form, e.g. "Session expired". */
  notice?: string | null;
}

export function LoginPage({ onLoggedIn, notice = null }: LoginPageProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await login(username.trim(), password);
      onLoggedIn(res.token);
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 401) setError('Wrong username or password.');
      else if (err instanceof ApiError && err.status === 0) setError('Cannot reach the server. Is the API running?');
      else setError(err instanceof Error ? err.message : 'Login failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="adm adm-login">
      <form className="adm-panel adm-login__card adm-stack" onSubmit={submit}>
        <div>
          <h1 className="adm-login__title">Only Connect</h1>
          <p className="adm-login__sub">Game master console</p>
        </div>
        {notice && <Notice tone="warn">{notice}</Notice>}
        <Field label="Username" htmlFor="adm-login-user">
          <Input
            id="adm-login-user"
            name="username"
            autoComplete="username"
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </Field>
        <Field label="Password" htmlFor="adm-login-pass">
          <Input
            id="adm-login-pass"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </Field>
        {error && <Notice tone="bad">{error}</Notice>}
        <Button type="submit" tone="primary" size="lg" block busy={busy}>
          Log in
        </Button>
      </form>
    </div>
  );
}

export default LoginPage;
