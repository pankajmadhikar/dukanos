import type { ReactNode } from "react";
import { usePosOnline } from "../offline/connectivity";

export function InternetGate({ sentence, children }: { sentence: string; children: ReactNode }) {
  const online = usePosOnline();
  if (!online) {
    return (
      <section className="mx-auto max-w-lg">
        <h1 className="text-2xl font-semibold">{sentence}</h1>
      </section>
    );
  }
  return children;
}
