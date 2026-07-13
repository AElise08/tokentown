"use client";

// PROFILE SEARCH — jump straight to a dev's city. A tiny client component (same
// family as LiveBoard / LiveRefresh): it sanitizes the handle the same way the
// server does ([a-z0-9-]) and navigates to /u/<handle>. No data fetching lives
// here.
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function ProfileSearch() {
  const router = useRouter();
  const [q, setQ] = useState("");

  const go = (e: React.FormEvent) => {
    e.preventDefault();
    const handle = q
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "");
    if (handle.length >= 2) router.push(`/u/${handle}`);
  };

  return (
    <form className="find" onSubmit={go} role="search" aria-label="Find a city">
      <span className="find-cap">Find a city</span>
      <input
        className="find-input"
        type="text"
        inputMode="text"
        placeholder="username"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label="username"
        maxLength={24}
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
      />
      <button className="find-go" type="submit" aria-label="Go to city">
        &rsaquo;
      </button>
    </form>
  );
}
