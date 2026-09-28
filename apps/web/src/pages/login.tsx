import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { Button, Field, Notice, controlClass } from "../components/ui";
import { ApiError } from "../lib/api/client";
import { shopApi } from "../lib/api/shop";
import { asRecord, asText } from "../lib/json";
import { useSession } from "../stores/session";

export function LoginPage() {
  const navigate = useNavigate();
  const token = useSession((state) => state.token);
  const setLogin = useSession((state) => state.setLogin);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [wait, setWait] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (token) {
      navigate("/shops", { replace: true });
    }
  }, [token, navigate]);

  useEffect(() => {
    if (wait <= 0) {
      return;
    }
    const timer = window.setTimeout(() => setWait((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [wait]);

  async function sendCode() {
    setError(null);
    setBusy(true);
    try {
      await shopApi.requestOtp(phone.trim());
      setSent(true);
      setWait(30);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.shopText() : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setError(null);
    setBusy(true);
    try {
      const body = await shopApi.verifyOtp(phone.trim(), code.trim());
      const data = asRecord(body.data);
      const user = asRecord(data?.user);
      const tokenValue = asText(data?.token);
      if (!tokenValue || !user) {
        setError("Something went wrong.");
        return;
      }
      setLogin(tokenValue, {
        id: asText(user.id),
        name: asText(user.name),
        phone: asText(user.phone),
      });
      navigate("/shops");
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.shopText() : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-5 px-4">
      <div>
        <p className="text-sm font-semibold tracking-wide text-accent uppercase">DukaanOS</p>
        <h1 className="mt-1 text-3xl font-semibold">Sign in</h1>
        <p className="mt-1 text-muted">Use the mobile number for this shop.</p>
      </div>
      <Field label="Mobile number" required>
        <input
          className={controlClass}
          inputMode="tel"
          autoComplete="tel"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
        />
      </Field>
      {sent ? (
        <Field label="OTP" required>
          <input
            className={controlClass}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
          />
        </Field>
      ) : null}
      {error ? <Notice>{error}</Notice> : null}
      {sent ? (
        <div className="flex flex-col gap-2">
          <Button disabled={busy || code.length !== 6} onClick={() => verify()}>
            {busy ? "Checking..." : "Verify"}
          </Button>
          <Button tone="quiet" disabled={busy || wait > 0} onClick={() => void sendCode()}>
            {wait > 0 ? `Resend in ${wait}s` : "Resend OTP"}
          </Button>
        </div>
      ) : (
        <Button disabled={busy || phone.trim().length < 10} onClick={() => void sendCode()}>
          {busy ? "Sending..." : "Send OTP"}
        </Button>
      )}
    </main>
  );
}
