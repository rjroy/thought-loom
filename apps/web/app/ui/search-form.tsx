"use client";

import { useSearchParams } from "next/navigation";

export function SearchFields({ query = "" }: { query?: string }) {
  return (
    <form action="/search" method="get" className="shell-search" role="search" aria-label="Find a thought">
      <div className="search-field"><label htmlFor="thought-search">Search thoughts</label><input key={query} id="thought-search" type="search" name="q" defaultValue={query} placeholder="A word, a fragment, an idea" maxLength={512} /></div>
      <button type="submit" className="button secondary">Search</button>
    </form>
  );
}

export default function SearchForm() {
  const parameters = useSearchParams();
  return <SearchFields query={parameters.get("q") ?? ""} />;
}
