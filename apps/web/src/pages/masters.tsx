import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Allow } from "../components/shell";
import { Button, Field, Loading, Notice, Page, controlClass } from "../components/ui";
import { ApiError } from "../lib/api/client";
import { shopApi } from "../lib/api/shop";
import { asList, asRecord, asText } from "../lib/json";
import { useToast } from "../stores/toast";

export function MastersPage() {
  return (
    <Allow action="catalog.manage">
      <Page title="Categories and brands">
        <NameList kind="category" />
        <NameList kind="brand" />
      </Page>
    </Allow>
  );
}

function NameList({ kind }: { kind: "category" | "brand" }) {
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: [kind],
    queryFn: () => (kind === "category" ? shopApi.categories() : shopApi.brands()),
  });
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="rounded-2xl bg-card p-4">
      <h2 className="text-lg font-semibold">{kind === "category" ? "Category" : "Brand"}</h2>
      {list.isLoading ? <Loading label="Loading..." /> : null}
      {asList(list.data?.data).map((item) => {
        const row = asRecord(item);
        return (
          <p key={asText(row?.id)} className="mt-2">
            {asText(row?.name)} · {row?.isActive === false ? "Inactive" : "Active"}
          </p>
        );
      })}
      <form
        className="mt-3 flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const create = kind === "category" ? shopApi.createCategory({ name: name.trim() }) : shopApi.createBrand({ name: name.trim() });
          void create
            .then(() => {
              setName("");
              useToast.getState().show(kind === "category" ? "Category added" : "Brand added");
              void queryClient.invalidateQueries({ queryKey: [kind] });
            })
            .catch((caught: unknown) => setError(caught instanceof ApiError ? caught.shopText() : "Something went wrong."));
        }}
      >
        <Field label={kind === "category" ? "New category" : "New brand"}>
          <input className={controlClass} value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        {error ? <Notice>{error}</Notice> : null}
        <Button type="submit" disabled={name.trim().length === 0}>
          Add
        </Button>
      </form>
    </section>
  );
}
