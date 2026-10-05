"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { RequirementsReviewCard } from "./components/requirements-review";
import type { RequirementsReview } from "@/src/requirements-review";

type Row = { who: "You" | "Assistant"; text: string; error?: boolean; trace?: unknown[]; requirementsReview?: RequirementsReview };

function createSessionId() {
  // getRandomValues also works when the dev app is opened over LAN HTTP.
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export default function Home() {
  const [userId, setUserId] = useState("u-pm-1");
  const [identity, setIdentity] = useState("");
  const [message, setMessage] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [sessionId, setSessionId] = useState("");
  const [copied, setCopied] = useState<number | null>(null);
  const [copyError, setCopyError] = useState("");
  const [review, setReview] = useState<RequirementsReview | null>(null);
  const [reviewNeedsRefresh, setReviewNeedsRefresh] = useState(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { setSessionId(createSessionId()); }, []);
  useEffect(() => {
    const element = messagesRef.current;
    if (element) element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  }, [rows, busy]);
  useEffect(() => {
    if (copied === null) return;
    const timer = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  function newChat() {
    setRows([]);
    setMessage("");
    setSessionId(createSessionId());
    setCopyError("");
    setReview(null);
    setReviewNeedsRefresh(false);
    composerRef.current?.focus();
  }

  async function send() {
    const query = message.trim();
    if (!query || busy || !identity || !sessionId) return;
    const reviewWasStale = reviewNeedsRefresh;
    setMessage("");
    setRows((current) => [...current, { who: "You", text: query }]);
    setBusy(true);
    if (review) setReviewNeedsRefresh(true);
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: identity, sessionId, message: query, requirementsReview: review ?? undefined }),
      });
      const json = await response.json();
      if (response.ok && json.requirementsReview) {
        setReview(json.requirementsReview);
        setReviewNeedsRefresh(false);
      } else if (response.ok && json.requirementsReviewUnchanged === true) {
        // An unrelated detour cannot make an already-stale review approvable.
        setReviewNeedsRefresh(reviewWasStale);
      } else if (review && (response.status === 409 || response.status === 403)) {
        setReview(null);
        setReviewNeedsRefresh(false);
      }
      setRows((current) => [...current, {
        who: "Assistant",
        text: json.response || json.error || "No response received. Please try again.",
        error: !response.ok || json.ok === false,
        trace: Array.isArray(json.trace) ? json.trace : undefined,
        requirementsReview: json.requirementsReview,
      }]);
    } catch {
      setRows((current) => [...current, { who: "Assistant", text: "We couldn't connect. Check your connection and try sending your message again.", error: true }]);
      setMessage(query);
    } finally { setBusy(false); composerRef.current?.focus(); }
  }

  async function decideReview(action: "approve" | "discard") {
    if (!review || busy || !identity || (action === "approve" && reviewNeedsRefresh)) return;
    setBusy(true);
    try {
      const response = await fetch("/api/requirements/review", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: identity, sessionId, action, review }),
      });
      const json = await response.json();
      setRows((current) => [...current, {
        who: "Assistant", text: json.response || json.error || "Could not confirm the review result.",
        error: !response.ok || json.ok === false,
      }]);
      if (response.ok && json.ok) { setReview(null); setReviewNeedsRefresh(false); }
      else if (response.status === 409 || response.status === 403) { setReview(null); setReviewNeedsRefresh(false); }
    } catch {
      setRows((current) => [...current, { who: "Assistant", text: "Could not confirm the result. Retry this same review to check whether it was saved.", error: true }]);
    } finally { setBusy(false); }
  }

  return (
    <main className="workspace">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Product Engineering home"><span className="brand-mark">p.</span><span>Product<br /><strong>Engineering</strong></span></a>
        <div className="sidebar-intro"><span className="eyebrow">YOUR WORKSPACE, CONNECTED</span><h1>Less searching.<br />More doing.</h1><p>A single conversation for your team's work.</p></div>
        <section className="account-card" aria-labelledby="account-heading">
          <div className="account-icon" aria-hidden="true">◎</div>
          <h2 id="account-heading">{identity ? "Your account" : "Welcome back"}</h2>
          <p>{identity ? "You're chatting with this account." : "Enter your work email or user ID to get started."}</p>
          <form onSubmit={(event) => { event.preventDefault(); if (!userId.trim() || busy) return; setIdentity(userId.trim()); newChat(); }}>
            <label htmlFor="userId">Work email or user ID</label>
            <input id="userId" autoComplete="username" value={userId} disabled={!!identity || busy} onChange={(event) => setUserId(event.target.value)} placeholder="you@company.com" required />
            {identity ? <button className="primary account-submit" type="button" disabled={busy} onClick={() => { setIdentity(""); newChat(); }}>Switch account</button> : <button className="primary account-submit" disabled={!userId.trim() || !sessionId}>Continue <span aria-hidden="true">→</span></button>}
          </form>
          <small>Uses your existing workspace identity. Your access is checked when you send a message.</small>
        </section>
        <div className="sidebar-footer">Product Engineering AI <span>Workspace assistant</span></div>
      </aside>
      <section className="chat-shell" aria-label="Chat workspace">
        <header className="chat-header"><div><div className="chat-title"><span className="assistant-symbol" aria-hidden="true">✳</span><h2>Workspace assistant</h2></div><p>Make progress, one conversation at a time.</p></div><button className="secondary" disabled={busy} onClick={newChat}><span aria-hidden="true">＋</span> New chat</button></header>
        <div className="messages" ref={messagesRef} role="log" aria-label="Conversation" aria-live="polite" aria-relevant="additions text">
          {rows.length === 0 && <div className="empty-state"><div className="welcome-symbol" aria-hidden="true">✳</div><span className="eyebrow">A LITTLE CLARITY GOES A LONG WAY</span><h2>What can we move<br />forward today?</h2><p>Ask a question, check on progress, or update your work.<br />Start with whatever's on your mind.</p><div className="suggestions">{["Show my active tasks", "Am I overloaded this sprint?", "Show open critical bugs"].map((prompt) => <button key={prompt} disabled={!identity} onClick={() => { setMessage(prompt); composerRef.current?.focus(); }}>{prompt}<span aria-hidden="true">↗</span></button>)}</div></div>}
          {rows.map((row, index) => <article key={index} className={`message ${row.who === "You" ? "me" : "ai"} ${row.error ? "message-error" : ""}`}>
            <div className="message-label"><span className="avatar" aria-hidden="true">{row.who === "You" ? "Y" : "✳"}</span><strong>{row.who === "You" ? "You" : "Workspace assistant"}</strong>{row.error && <span className="error-label">Request unsuccessful</span>}</div>
            {row.who === "You" ? <div className="user-text">{row.text}</div> : <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ children, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>, table: ({ children }) => <div className="table-scroll"><table>{children}</table></div> }}>{row.text}</ReactMarkdown></div>}
            {row.requirementsReview && <RequirementsReviewCard
              review={row.requirementsReview} active={review?.id === row.requirementsReview.id}
              busy={busy} needsRefresh={reviewNeedsRefresh}
              onApprove={() => { void decideReview("approve"); }}
              onDiscard={() => { void decideReview("discard"); }}
              onEdit={() => { setReviewNeedsRefresh(true); composerRef.current?.focus(); }}
            />}
            {row.who !== "You" && <div className="message-actions"><button onClick={async () => { try { await navigator.clipboard.writeText(row.text); setCopied(index); setCopyError(""); } catch { setCopyError("Copy is unavailable here. Select the response text to copy it."); } }}>{copied === index ? "Copied ✓" : "Copy response"}</button>{!!row.trace?.length && <details><summary>Action details</summary><pre className="trace">{JSON.stringify(row.trace, null, 2)}</pre></details>}</div>}
          </article>)}
          {busy && <div className="thinking" role="status"><span className="assistant-symbol" aria-hidden="true">✳</span><span>Working on your request</span><span className="thinking-dots" aria-hidden="true">•••</span></div>}
        </div>
        <div className="composer-area">
          {copyError && <p className="copy-status" role="status">{copyError}</p>}
          <form className="composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
            <label className="sr-only" htmlFor="message">Your message</label>
            <textarea id="message" ref={composerRef} value={message} disabled={!identity} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} placeholder={identity ? "Ask about your work…" : "Enter your account details to start chatting…"} rows={2} />
            <div className="composer-bottom"><span>{identity ? "Enter to send · Shift + Enter for a new line" : "Your workspace, in one conversation"}</span><button className="send-button" type="submit" disabled={busy || !identity || !message.trim() || !sessionId} aria-label="Send message">↑</button></div>
          </form>
          <p className="composer-note">Review important details before making decisions.</p>
        </div>
      </section>
    </main>
  );
}
